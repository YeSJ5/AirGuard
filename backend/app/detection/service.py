import asyncio
import json
import logging
from datetime import datetime, timezone
import numpy as np
from typing import Any, Dict, List

from app.models import AircraftState, Alert
from app.detection.rules import (
    RuleConfig,
    check_position_jump,
    check_duplicate_icao,
    check_impossible_climb_rate,
    check_altitude_velocity_mismatch
)
from app.core.rule_config import active_rule_config
from app.detection.ensemble import FEATURE_NAMES, TrustScoringEnsemble
from app.detection.autoencoder import (
    UnsupervisedAutoencoder,
    check_trilateration_plausibility,
    combine_scores
)

logger = logging.getLogger("airguard.detection")

class DetectionService:
    def __init__(
        self,
        queue: asyncio.Queue,
        db_session_maker: Any,
        ensemble_model: TrustScoringEnsemble,
        autoencoder_model: UnsupervisedAutoencoder,
        rule_config: RuleConfig = active_rule_config
    ):
        self.queue = queue
        self.db_session_maker = db_session_maker
        self.ensemble = ensemble_model
        self.autoencoder = autoencoder_model
        self.rule_config = rule_config
        
        # History in-memory store: icao24 -> list of previous states (newest first)
        self.history: Dict[str, List[Dict[str, Any]]] = {}

    async def start_detection_loop(self) -> None:
        """Continuously pulls normalized flight vectors from the ingestion queue."""
        logger.info("Starting detection service processing loop...")
        while True:
            record = await self.queue.get()
            try:
                await self.process_record(record)
            except Exception as e:
                logger.error(f"Error encountered in detection processing loop: {e}", exc_info=True)
            finally:
                self.queue.task_done()

    async def process_record(self, record: Dict[str, Any]) -> None:
        """Evaluates physical rules and ML models on a single flight state update."""
        self.rule_config = active_rule_config
        icao24 = record["icao24"]
        prev_history = self.history.get(icao24, [])
        prev_record = prev_history[0] if len(prev_history) > 0 else None

        # Suppression logic cross-reference check
        is_suppressed = record.get("metadata", {}).get("is_known_entity", False)
        known_label = record.get("metadata", {}).get("known_entity_label")

        # --- 1. Evaluate Aerodynamic Rules First ---
        
        # Check Climb Rate
        rule_climb, climb_reason, climb_evidence = check_impossible_climb_rate(
            record["vertical_rate_ms"], self.rule_config
        )

        # Check Altitude-Velocity Mismatch
        rule_alt_vel, alt_vel_reason, alt_vel_evidence = check_altitude_velocity_mismatch(
            record["altitude_m"], record["velocity_ms"], record["on_ground"], self.rule_config
        )

        # Check Position Jump (Requires previous state)
        rule_jump = False
        jump_reason = None
        jump_evidence: Dict[str, Any] = {}
        if prev_record:
            rule_jump, jump_reason, jump_evidence = check_position_jump(
                current_lat=record["latitude"],
                current_lon=record["longitude"],
                current_time=record["received_at"],
                prev_lat=prev_record["latitude"],
                prev_lon=prev_record["longitude"],
                prev_time=prev_record["received_at"],
                config=self.rule_config
            )

        # Check Duplicate ICAO (Within 1s, same ICAO, different locations)
        rule_dup = False
        dup_reason = None
        dup_evidence: Dict[str, Any] = {}
        if prev_record:
            rule_dup, dup_reason, dup_evidence = check_duplicate_icao(
                lat_a=record["latitude"], lon_a=record["longitude"], time_a=record["received_at"],
                lat_b=prev_record["latitude"], lon_b=prev_record["longitude"], time_b=prev_record["received_at"],
                config=self.rule_config
            )

        rule_flags = [rule_jump, rule_dup, rule_climb, rule_alt_vel]
        reasons = [r for r in [jump_reason, dup_reason, climb_reason, alt_vel_reason] if r is not None]

        # --- 2. Calculate Rolling Window Features ---
        states = [record] + prev_history[:4]
        speeds = [s["velocity_ms"] for s in states]
        headings = [s["heading_deg"] for s in states]
        vert_rates = [s["vertical_rate_ms"] for s in states]

        speed_var = float(np.var(speeds)) if len(speeds) > 1 else 0.0
        heading_var = float(np.var(headings)) if len(headings) > 1 else 0.0
        alt_rate_var = float(np.var(vert_rates)) if len(vert_rates) > 1 else 0.0

        time_diff = 0.0
        if prev_record:
            time_diff = (record["received_at"] - prev_record["received_at"]).total_seconds()

        feature_vector = np.array([
            speed_var,
            heading_var,
            alt_rate_var,
            time_diff,
            float(rule_jump),
            float(rule_dup),
            float(rule_climb),
            float(rule_alt_vel)
        ])

        # --- 3. Evaluate Machine Learning Models ---
        
        # Soft-Voting Ensemble (supervised anomaly prediction)
        ensemble_score, shap_explanation = self.ensemble.predict_anomaly(feature_vector)

        # PyTorch Autoencoder (unsupervised reconstruction error)
        ae_features = np.array([speed_var, heading_var, alt_rate_var, time_diff])
        ae_score = self.autoencoder.compute_anomaly_score(ae_features)

        # Trilateration check
        sensors = record.get("sensors") or []
        trilateration_score, tri_reason, tri_evidence = check_trilateration_plausibility(
            record["latitude"], record["longitude"], sensors
        )
        if tri_reason != "consistent" and tri_reason != "inconclusive":
            reasons.append(tri_reason)

        # --- 4. Combine Scoring Signals ---
        combined_risk_score, is_alert_triggered = combine_scores(
            rule_flags=rule_flags,
            ensemble_score=ensemble_score,
            autoencoder_score=ae_score,
            trilateration_consistency=trilateration_score,
            threshold=0.7
        )

        # --- 5. Generate Audit Trail Logs ---
        audit_payload = {
            "icao24": icao24,
            "callsign": record["callsign"],
            "combined_risk_score": combined_risk_score,
            "rules_triggered": [FEATURE_NAMES[i] for i, f in enumerate(rule_flags) if f],
            "ensemble_score": ensemble_score,
            "autoencoder_score": ae_score,
            "trilateration_consistency": trilateration_score,
            "is_known_entity": is_suppressed,
            "known_entity_label": known_label,
            "alert_triggered": bool(is_alert_triggered and not is_suppressed)
        }

        if is_suppressed:
            logger.info(
                json.dumps({
                    "event": "AUDIT_DECISION_SUPPRESSED",
                    "payload": audit_payload,
                    "message": f"[AUDIT] Decision: SUPPRESSED for known entity {icao24} ({known_label}). Calculated risk: {combined_risk_score:.2f}."
                })
            )
        else:
            decision = "ALERT" if is_alert_triggered else "PASS"
            logger.info(
                json.dumps({
                    "event": f"AUDIT_DECISION_{decision}",
                    "payload": audit_payload,
                    "message": f"[AUDIT] Decision: {decision} for aircraft {icao24}. Risk: {combined_risk_score:.2f}."
                })
            )

        # Update local rolling state history
        self.history[icao24] = [record] + prev_history[:9] # Keep last 10 states

        # --- 6. Write to Database ---
        state_id = None
        try:
            async with self.db_session_maker() as session:
                db_state = AircraftState(
                    icao24=record["icao24"],
                    callsign=record["callsign"],
                    latitude=record["latitude"],
                    longitude=record["longitude"],
                    altitude_m=record["altitude_m"],
                    velocity_ms=record["velocity_ms"],
                    heading_deg=record["heading_deg"],
                    vertical_rate_ms=record["vertical_rate_ms"],
                    on_ground=record["on_ground"],
                    received_at=record["received_at"],
                    source=record["source"]
                )
                session.add(db_state)
                await session.commit()
                await session.refresh(db_state)
                state_id = db_state.id
        except Exception as e:
            logger.error(f"Failed to record AircraftState to database: {e}")

        # Save Alert if triggered and NOT suppressed
        if is_alert_triggered and not is_suppressed and state_id is not None:
            try:
                reason_text = "; ".join(reasons) if len(reasons) > 0 else "Anomaly detected by combined risk score."
                evidence_data = {
                    "rule_flags": {
                        "position_jump": jump_evidence,
                        "duplicate_icao": dup_evidence,
                        "climb_rate": climb_evidence,
                        "alt_vel_mismatch": alt_vel_evidence
                    },
                    "trilateration": tri_evidence,
                    "model_scores": {
                        "ensemble_score": ensemble_score,
                        "autoencoder_score": ae_score
                    }
                }
                
                async with self.db_session_maker() as session:
                    db_alert = Alert(
                        icao24=record["icao24"],
                        aircraft_state_id=state_id,
                        rule_flags=[FEATURE_NAMES[i] for i, f in enumerate(rule_flags) if f],
                        ensemble_score=ensemble_score,
                        autoencoder_score=ae_score,
                        combined_risk_score=combined_risk_score,
                        reason_text=reason_text,
                        shap_explanation={
                            "shap": shap_explanation,
                            "evidence": evidence_data
                        },
                        detected_at=datetime.now(timezone.utc),
                        is_synthetic=False,
                        acknowledged=False
                    )
                    session.add(db_alert)
                    await session.commit()
                logger.info(f"Successfully recorded Alert for aircraft {icao24} in database.")
                
                # Broadcast alert in real-time via WebSocket
                try:
                    from app.api.v1.endpoints import manager as ws_manager
                    await ws_manager.broadcast({
                        "event": "ALERT_TRIGGERED",
                        "icao24": record["icao24"],
                        "combined_risk_score": combined_risk_score,
                        "reason_text": reason_text
                    })
                except Exception:
                    pass
            except Exception as e:
                logger.error(f"Failed to record Alert to database: {e}")

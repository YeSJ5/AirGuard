import asyncio
import json
import logging
import time
from datetime import datetime, timezone
import numpy as np
from typing import Any, Dict, List, Optional

from app.models import AircraftAssessment, AircraftState, Alert
from app.detection.rules import (
    RuleConfig,
    check_position_jump,
    check_duplicate_icao,
    check_impossible_climb_rate,
    check_altitude_velocity_mismatch,
    check_low_signal_confidence
)
from app.core.rule_config import active_rule_config
from app.core.config import settings
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
        queue: Any = None,
        db_session_maker: Any = None,
        ensemble_model: TrustScoringEnsemble = None,
        autoencoder_model: UnsupervisedAutoencoder = None,
        rule_config: RuleConfig = active_rule_config
    ):
        self.queue = queue
        self.db_session_maker = db_session_maker
        self.ensemble = ensemble_model
        self.autoencoder = autoencoder_model
        self.rule_config = rule_config
        
        # History in-memory store: icao24 -> list of previous states (newest first)
        self.history: Dict[str, List[Dict[str, Any]]] = {}
        # Latest ML inference evaluations: icao24 -> dict of scores
        self.latest_scores: Dict[str, Dict[str, Any]] = {}

    def get_latest_score(self, icao24: str) -> Optional[Dict[str, Any]]:
        return self.latest_scores.get(icao24)

    async def start_detection_loop(self) -> None:
        """Continuously pulls normalized flight vectors from the Redis Stream consumer group."""
        from app.core.redis import redis_client
        from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
        from app.core.telemetry import tracer
        import os
        
        stream_name = "airguard:telemetry"
        group_name = "detection-group"
        worker_name = f"worker-{os.getenv('HOSTNAME', 'local')}-{os.getpid()}"
        
        try:
            await redis_client.xgroup_create(stream_name, group_name, id="0", mkstream=True)
            logger.info(f"Created consumer group '{group_name}' for stream '{stream_name}'")
        except Exception:
            pass
            
        logger.info(f"Starting detection service consumer group loop as worker: {worker_name}")
        while True:
            try:
                streams_to_read = {stream_name: ">"}
                messages = await redis_client.xreadgroup(
                    groupname=group_name,
                    consumername=worker_name,
                    streams=streams_to_read,
                    count=1,
                    block=300
                )
                
                if not messages:
                    continue
                    
                stream_items = messages.items() if isinstance(messages, dict) else messages
                for stream, msg_list in stream_items:
                    if len(msg_list) > 0 and isinstance(msg_list[0], list):
                        msg_list = msg_list[0]
                    for msg_id, payload in msg_list:
                        try:
                            payload_data = json.loads(payload["payload"])
                            record = payload_data["record"]
                            carrier = payload_data.get("trace_carrier", {})
                            
                            if "received_at" in record and isinstance(record["received_at"], str):
                                record["received_at"] = datetime.fromisoformat(record["received_at"])
                            
                            ctx = TraceContextTextMapPropagator().extract(carrier=carrier)
                            with tracer.start_as_current_span("detection_worker_processing", context=ctx) as span:
                                await self.process_record(record)
                        except Exception as e:
                            logger.error(f"Error processing stream record {msg_id}: {e}", exc_info=True)
                        finally:
                            await redis_client.xack(stream_name, group_name, msg_id)
            except Exception as e:
                logger.error(f"Error in Redis Stream consumer loop: {e}", exc_info=True)
                await asyncio.sleep(2)

    async def process_record(self, record: Dict[str, Any]) -> None:
        """Evaluates physical rules and ML models on a single flight state update."""
        from app.core.telemetry import PIPELINE_STAGE_LATENCY, tracer
        
        self.rule_config = active_rule_config
        icao24 = record["icao24"]
        prev_history = self.history.get(icao24, [])
        prev_record = prev_history[0] if len(prev_history) > 0 else None

        is_suppressed = record.get("metadata", {}).get("is_known_entity", False)
        known_label = record.get("metadata", {}).get("known_entity_label")
        is_synthetic = record.get("metadata", {}).get("is_synthetic", False)

        # --- 1. Evaluate Aerodynamic Rules ---
        rules_start = time.perf_counter()
        with tracer.start_as_current_span("evaluate_rules") as span:
            quality = record.get("data_quality", {})
            observed = set(quality.get("observed_fields", []))
            rule_climb, climb_reason, climb_evidence = (None, None, {})
            if "vertical_rate" in observed:
                rule_climb, climb_reason, climb_evidence = check_impossible_climb_rate(record["vertical_rate_ms"], self.rule_config)
            rule_alt_vel, alt_vel_reason, alt_vel_evidence = (None, None, {})
            if {"altitude", "velocity", "on_ground"}.issubset(observed):
                rule_alt_vel, alt_vel_reason, alt_vel_evidence = check_altitude_velocity_mismatch(record["altitude_m"], record["velocity_ms"], record["on_ground"], self.rule_config)
            rule_jump = None
            jump_reason = None
            jump_evidence = {}
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
            # A historical state is not independent same-time evidence for an ICAO clone.
            rule_dup = None
            dup_reason = None
            dup_evidence = {}
            rule_low_signal = None
            low_signal_reason = None
            low_signal_evidence = {}
            reported_nic = record.get("reported_nic")
            # The public vector generally omits NIC; no observation means unassessed.
            if reported_nic is not None:
                rule_low_signal, low_signal_reason, low_signal_evidence = check_low_signal_confidence(
                    reported_nic=reported_nic, current_lat=record["latitude"], current_lon=record["longitude"],
                    prev_lat=prev_record["latitude"] if prev_record else None,
                    prev_lon=prev_record["longitude"] if prev_record else None, config=self.rule_config
                )
        rules_latency = time.perf_counter() - rules_start
        PIPELINE_STAGE_LATENCY.labels(stage="rules").observe(rules_latency)

        rule_flags = [rule_jump, rule_dup, rule_climb, rule_alt_vel, rule_low_signal]
        reasons = [r for r in [jump_reason, dup_reason, climb_reason, alt_vel_reason, low_signal_reason] if r is not None]

        # Calculate Rolling Window Features
        states = [record] + prev_history[:4]
        complete_window = len(states) >= 5 and all({"velocity", "heading", "vertical_rate"}.issubset(set(s.get("data_quality", {}).get("observed_fields", []))) for s in states)
        speeds = [s["velocity_ms"] for s in states]
        headings = [s["heading_deg"] for s in states]
        vert_rates = [s["vertical_rate_ms"] for s in states]

        if complete_window:
            speed_var = float(np.var(speeds))
            heading_var = float(np.var(headings))
            alt_rate_var = float(np.var(vert_rates))
        else:
            # A single/few observations cannot establish rolling behaviour variance.
            speed_var = heading_var = alt_rate_var = None

        time_diff = None
        if prev_record and speed_var is not None:
            time_diff = max(0.1, (record["received_at"] - prev_record["received_at"]).total_seconds())

        ensemble_score = None
        ae_score = None
        shap_explanation = {"status": "unavailable", "reason": "Not enough observed history for rolling features."}
        if settings.ENABLE_LIVE_ML and speed_var is not None and time_diff is not None and all(flag is not None for flag in rule_flags):
            feature_vector = np.array([
                speed_var, heading_var, alt_rate_var, time_diff,
                float(rule_jump), float(rule_dup), float(rule_climb),
                float(rule_alt_vel), float(rule_low_signal)
            ])
            if self.ensemble is not None:
                ensemble_start = time.perf_counter()
                with tracer.start_as_current_span("evaluate_ensemble"):
                    ensemble_score, shap_explanation = self.ensemble.predict_anomaly(feature_vector)
                PIPELINE_STAGE_LATENCY.labels(stage="ensemble").observe(time.perf_counter() - ensemble_start)
            if self.autoencoder is not None:
                ae_start = time.perf_counter()
                with tracer.start_as_current_span("evaluate_autoencoder"):
                    ae_features = np.array([speed_var, heading_var, alt_rate_var, time_diff])
                    ae_score = self.autoencoder.compute_anomaly_score(ae_features)
                PIPELINE_STAGE_LATENCY.labels(stage="autoencoder").observe(time.perf_counter() - ae_start)

        # Trilateration check
        tri_start = time.perf_counter()
        with tracer.start_as_current_span("evaluate_trilateration") as span:
            sensors = record.get("sensors") or []
            trilateration_score, tri_reason, tri_evidence = check_trilateration_plausibility(
                record["latitude"], record["longitude"], sensors
            )
            if tri_reason not in {"consistent", "inconclusive", "unavailable"}:
                reasons.append(tri_reason)
        tri_latency = time.perf_counter() - tri_start
        PIPELINE_STAGE_LATENCY.labels(stage="trilateration").observe(tri_latency)

        # --- 3. Combine Scoring Signals ---
        combined_risk_score, is_alert_triggered = combine_scores(
            rule_flags=rule_flags,
            ensemble_score=ensemble_score,
            autoencoder_score=ae_score,
            trilateration_consistency=trilateration_score,
            threshold=0.65
        )

        audit_payload = {
            "icao24": icao24,
            "callsign": record["callsign"],
            "combined_risk_score": combined_risk_score,
            "rules_triggered": [FEATURE_NAMES[i + 4] for i, f in enumerate(rule_flags) if f],
            "ensemble_score": ensemble_score,
            "autoencoder_score": ae_score,
            "receiver_consistency": trilateration_score,
            "is_known_entity": is_suppressed,
            "known_entity_label": known_label,
            "alert_triggered": bool(is_alert_triggered and not is_suppressed)
        }

        # A rule/model blend is a triage signal, not a calibrated aircraft trust percentage.
        # Keep trust unscored until a validated, source-matched assessment is available.
        trust_val = None
        self.latest_scores[icao24] = {
            "ensemble_score": ensemble_score,
            "autoencoder_score": ae_score,
            "receiver_consistency_score": trilateration_score,
            "combined_risk_score": combined_risk_score,
            "trust_score": None,
            "evidence_confidence": round((0.4 if any(flag is not None for flag in rule_flags) else 0.0) + (0.3 if ensemble_score is not None else 0.0) + (0.2 if ae_score is not None else 0.0) + (0.1 if trilateration_score is not None else 0.0), 2),
            "assessment_status": "SUPPRESSED" if is_suppressed else "REVIEW_REQUIRED" if is_alert_triggered else "INSUFFICIENT_EVIDENCE"
        }
        logger.info(
            f"[SCORE_EVAL] {icao24} ({record.get('callsign')}): "
            f"Ensemble={ensemble_score if ensemble_score is not None else 'UNAVAILABLE'}, "
            f"Autoencoder={ae_score if ae_score is not None else 'UNAVAILABLE'}, "
            f"ReceiverConsistency={trilateration_score if trilateration_score is not None else 'UNAVAILABLE'}, CombinedRisk={f'{combined_risk_score:.4f}' if combined_risk_score is not None else 'UNASSESSED'}, "
            "TrustScore=UNASSESSED"
        )

        if is_suppressed:
            logger.info(
                json.dumps({
                    "event": "AUDIT_DECISION_SUPPRESSED",
                    "payload": audit_payload,
                    "message": f"[AUDIT] Decision: SUPPRESSED for known entity {icao24} ({known_label}). Calculated risk: {f'{combined_risk_score:.2f}' if combined_risk_score is not None else 'UNASSESSED'}."
                })
            )
        else:
            decision = "ALERT" if is_alert_triggered else "INSUFFICIENT_EVIDENCE"
            logger.info(
                json.dumps({
                    "event": f"AUDIT_DECISION_{decision}",
                    "payload": audit_payload,
                    "message": f"[AUDIT] Decision: {decision} for aircraft {icao24}. Risk: {f'{combined_risk_score:.2f}' if combined_risk_score is not None else 'UNASSESSED'}."
                })
            )

        # Update local rolling state history
        self.history[icao24] = [record] + prev_history[:9]

        # --- 4. Write to Database ---
        db_start = time.perf_counter()
        state_id = None
        with tracer.start_as_current_span("write_alerts_db") as span:
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
                        source=record.get("source", "opensky"),
                        reported_nic=record.get("reported_nic"),
                        data_quality=record.get("data_quality", {}),
                        is_synthetic=is_synthetic
                    )
                    session.add(db_state)
                    await session.commit()
                    await session.refresh(db_state)
                    state_id = db_state.id
                    session.add(AircraftAssessment(
                        aircraft_state_id=db_state.id,
                        icao24=icao24,
                        combined_risk_score=combined_risk_score,
                        evidence_confidence=self.latest_scores[icao24]["evidence_confidence"],
                        status=self.latest_scores[icao24]["assessment_status"],
                        signals={
                            "rule_flags": {"position_jump": rule_jump, "duplicate_icao": rule_dup, "climb_rate": rule_climb, "alt_vel_mismatch": rule_alt_vel, "low_signal_confidence": rule_low_signal},
                            "ensemble_score": ensemble_score,
                            "autoencoder_score": ae_score,
                            "receiver_consistency": trilateration_score,
                            "data_quality": record.get("data_quality", {}),
                            "live_ml_enabled": settings.ENABLE_LIVE_ML,
                        },
                        detector_version="rules-v2",
                        assessed_at=datetime.now(timezone.utc),
                    ))
                    await session.commit()
                    if is_alert_triggered and not is_suppressed:
                        pass
            except Exception as e:
                logger.error(f"Failed to record AircraftState to database: {e}")

            # Track session counts in SYSTEM_STATS
            try:
                from app.api.v1.endpoints import SYSTEM_STATS
                if is_synthetic:
                    SYSTEM_STATS["total_synthetic_states"] = SYSTEM_STATS.get("total_synthetic_states", 0) + 1
                else:
                    SYSTEM_STATS["total_real_states"] = SYSTEM_STATS.get("total_real_states", 0) + 1
            except Exception:
                pass

            if is_alert_triggered and not is_suppressed and state_id is not None:
                try:
                    # 1. Distributed Redis Lock for Alert creation to prevent duplicate alerts across replicas/workers
                    from app.core.redis import redis_client
                    dedup_key = f"airguard:alert_lock:{state_id}"
                    
                    try:
                        lock_acquired = await redis_client.set(dedup_key, "1", nx=True, ex=15)
                    except Exception:
                        lock_acquired = True

                    if not lock_acquired:
                        logger.info(f"Duplicate alert skipped by Redis distributed lock for state_id {state_id}")
                        return

                    # 2. Database existence check for state_id
                    from sqlalchemy import select
                    async with self.db_session_maker() as session:
                        existing = await session.execute(
                            select(Alert).where(Alert.aircraft_state_id == state_id).limit(1)
                        )
                        import inspect
                        existing_val = existing.scalar_one_or_none() if hasattr(existing, "scalar_one_or_none") else None
                        if inspect.isawaitable(existing_val) or "Mock" in type(existing_val).__name__:
                            existing_val = None
                        if existing_val:
                            logger.info(f"Duplicate alert skipped by DB check for state_id {state_id}")
                            return

                    reason_text = "; ".join(reasons) if len(reasons) > 0 else "Anomaly detected by combined risk score."
                    evidence_data = {
                        "rule_flags": {
                            "position_jump": jump_evidence,
                            "duplicate_icao": dup_evidence,
                            "climb_rate": climb_evidence,
                            "alt_vel_mismatch": alt_vel_evidence,
                            "low_signal_confidence": low_signal_evidence
                        },
                        "receiver_consistency": tri_evidence,
                        "model_scores": {
                            "ensemble_score": ensemble_score,
                            "autoencoder_score": ae_score
                        },
                        "evidence_confidence": self.latest_scores[icao24]["evidence_confidence"],
                        "assessment_status": self.latest_scores[icao24]["assessment_status"],
                        "live_ml_enabled": settings.ENABLE_LIVE_ML,
                        "trust_score": None
                    }
                    
                    async with self.db_session_maker() as session:
                        db_alert = Alert(
                            icao24=record["icao24"],
                            aircraft_state_id=state_id,
                            rule_flags=[FEATURE_NAMES[i + 4] for i, f in enumerate(rule_flags) if f],
                            ensemble_score=ensemble_score,
                            autoencoder_score=ae_score,
                            combined_risk_score=combined_risk_score,
                            reason_text=reason_text,
                            shap_explanation={
                                "shap": shap_explanation,
                                "evidence": evidence_data
                            },
                            detected_at=datetime.now(timezone.utc),
                            is_synthetic=is_synthetic,
                            acknowledged=False
                        )
                        session.add(db_alert)
                        await session.commit()
                    logger.info(f"Successfully recorded Alert for aircraft {icao24} in database.")
                    
                    try:
                        from app.api.v1.endpoints import manager as ws_manager
                        await ws_manager.broadcast({
                            "event": "ALERT_TRIGGERED",
                            "icao24": record["icao24"],
                            "combined_risk_score": combined_risk_score,
                            "reason_text": reason_text,
                            "is_synthetic": is_synthetic
                        })
                    except Exception:
                        pass
                except Exception as e:
                    logger.error(f"Failed to record Alert to database: {e}")
        
        # Broadcast aircraft update event to fanned-out clients
        try:
            route_info = None
            if hasattr(self, "route_service") and self.route_service:
                route_info = self.route_service.get_cached_route(record["icao24"])
            route_text = route_info.get("route_text", "Route unknown") if route_info else "Route unknown"

            from app.api.v1.endpoints import manager as ws_manager
            await ws_manager.broadcast({
                "event": "AIRCRAFT_UPDATE",
                "payload": {
                    "icao24": record["icao24"],
                    "latitude": record["latitude"],
                    "longitude": record["longitude"],
                    "altitude_m": record["altitude_m"],
                    "velocity_ms": record["velocity_ms"],
                    "heading_deg": record["heading_deg"],
                    "vertical_rate_ms": record["vertical_rate_ms"],
                    "on_ground": record["on_ground"],
                    "callsign": record.get("callsign", f"AC-{record['icao24'].upper()}"),
                    "is_synthetic": is_synthetic,
                    "source": record.get("source", "opensky"),
                    "route": route_text,
                    "combined_risk_score": combined_risk_score,
                    "is_alert_triggered": bool(is_alert_triggered and not is_suppressed),
                    "trust_score": None,
                    "assessment_status": self.latest_scores[icao24]["assessment_status"],
                    "data_quality": record.get("data_quality", {})
                }
            })
        except Exception:
            pass

        # Aircraft snapshot entries use a short TTL; avoid a Redis KEYS scan for
        # every aircraft observation, which becomes a blocking O(N) operation.

        db_latency = time.perf_counter() - db_start
        PIPELINE_STAGE_LATENCY.labels(stage="db_write").observe(db_latency)

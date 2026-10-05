import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

import numpy as np
from sqlalchemy import select

from app.core.config import settings
from app.core.rule_config import active_rule_config
from app.detection.autoencoder import (
    UnsupervisedAutoencoder,
    check_trilateration_plausibility,
    combine_scores,
    compute_evidence_confidence,
)
from app.detection.ensemble import FEATURE_NAMES, TrustScoringEnsemble
from app.detection.rules import (
    RuleConfig,
    check_altitude_velocity_mismatch,
    check_impossible_climb_rate,
    check_low_signal_confidence,
    check_position_jump,
)
from app.detection.trust import derive_trust_score
from app.ingestion.opensky_auth import opensky_auth
from app.models import AircraftAssessment, AircraftState, Alert

logger = logging.getLogger("airguard.detection")


class DetectionService:
    def __init__(
        self,
        queue: Any = None,
        db_session_maker: Any = None,
        ensemble_model: TrustScoringEnsemble = None,
        autoencoder_model: UnsupervisedAutoencoder = None,
        rule_config: RuleConfig = active_rule_config,
    ):
        self.queue = queue
        self.db_session_maker = db_session_maker
        self.ensemble = ensemble_model
        self.autoencoder = autoencoder_model
        self.rule_config = rule_config
        self._uses_shared_rule_config = rule_config is active_rule_config

        # History in-memory store: icao24 -> list of previous states (newest first)
        self.history: dict[str, list[dict[str, Any]]] = {}
        # Latest ML inference evaluations: icao24 -> dict of scores
        self.latest_scores: dict[str, dict[str, Any]] = {}

    def get_latest_score(self, icao24: str) -> dict[str, Any] | None:
        return self.latest_scores.get(icao24)

    async def start_detection_loop(self) -> None:
        """Continuously pulls normalized flight vectors from the Redis Stream consumer group."""
        import os

        from opentelemetry.trace.propagation.tracecontext import (
            TraceContextTextMapPropagator,
        )

        from app.core.redis import redis_client
        from app.core.telemetry import tracer

        stream_name = "airguard:telemetry"
        group_name = "detection-group"
        worker_name = f"worker-{os.getenv('HOSTNAME', 'local')}-{os.getpid()}"

        try:
            await redis_client.xgroup_create(
                stream_name, group_name, id="0", mkstream=True
            )
            logger.info(
                f"Created consumer group '{group_name}' for stream '{stream_name}'"
            )
        except Exception:
            pass

        logger.info(
            f"Starting detection service consumer group loop as worker: {worker_name}"
        )
        reclaim_cursor = "0-0"
        next_reclaim_at = 0.0
        reclaim_supported = True
        while True:
            try:
                messages = None
                now = time.monotonic()
                if reclaim_supported and now >= next_reclaim_at:
                    next_reclaim_at = now + 5.0
                    try:
                        claim_result = await redis_client.xautoclaim(
                            stream_name,
                            group_name,
                            worker_name,
                            min_idle_time=60_000,
                            start_id=reclaim_cursor,
                            count=200,
                        )
                        reclaim_cursor = claim_result[0] or "0-0"
                        claimed_items = claim_result[1] if len(claim_result) > 1 else []
                        if claimed_items:
                            messages = [(stream_name, claimed_items)]
                    except (AttributeError, NotImplementedError) as exc:
                        reclaim_supported = False
                        logger.error(
                            "Redis client does not support pending-message reclaim: %s",
                            exc,
                        )
                    except Exception as exc:
                        logger.warning(
                            "Unable to inspect pending telemetry messages; will retry reclaim: %s",
                            exc,
                        )

                if not messages:
                    streams_to_read = {stream_name: ">"}
                    messages = await redis_client.xreadgroup(
                        groupname=group_name,
                        consumername=worker_name,
                        streams=streams_to_read,
                        count=200,
                        block=300,
                    )

                if not messages:
                    continue

                stream_items = (
                    messages.items() if isinstance(messages, dict) else messages
                )
                grouped: dict[str, list[tuple]] = {}
                for stream, msg_list in stream_items:
                    if len(msg_list) > 0 and isinstance(msg_list[0], list):
                        msg_list = msg_list[0]
                    for msg_id, payload in msg_list:
                        try:
                            payload_data = json.loads(payload["payload"])
                            record = payload_data["record"]
                            if "received_at" in record and isinstance(
                                record["received_at"], str
                            ):
                                record["received_at"] = datetime.fromisoformat(
                                    record["received_at"]
                                )
                            icao24 = str(record["icao24"])
                            grouped.setdefault(icao24, []).append(
                                (
                                    msg_id,
                                    record,
                                    payload_data.get("trace_carrier", {}),
                                    payload["payload"],
                                )
                            )
                        except Exception as exc:
                            logger.error(
                                "Invalid telemetry stream record %s: %s",
                                msg_id,
                                exc,
                                exc_info=True,
                            )
                            try:
                                await redis_client.xadd(
                                    f"{stream_name}:dead_letter",
                                    {
                                        "source_message_id": str(msg_id),
                                        "payload": payload.get("payload", ""),
                                        "error": str(exc),
                                    },
                                    maxlen=10000,
                                    approximate=True,
                                )
                                await redis_client.xack(stream_name, group_name, msg_id)
                            except Exception as dlq_error:
                                logger.error(
                                    "Could not dead-letter or acknowledge malformed telemetry %s; it remains pending: %s",
                                    msg_id,
                                    dlq_error,
                                )

                # Work on distinct ICAOs concurrently while retaining arrival order
                # for each aircraft's state history. Wait for this batch before
                # reading the next one so historical comparisons stay ordered.
                concurrency = asyncio.Semaphore(20)

                async def process_aircraft_batch(
                    items: list[tuple],
                ) -> list[dict[str, Any]]:
                    async with concurrency:
                        updates: list[dict[str, Any]] = []
                        for msg_id, record, carrier, raw_payload in items:
                            succeeded = False
                            last_error: Exception | None = None
                            for attempt in range(3):
                                try:
                                    ctx = TraceContextTextMapPropagator().extract(
                                        carrier=carrier
                                    )
                                    with tracer.start_as_current_span(
                                        "detection_worker_processing", context=ctx
                                    ):
                                        update = await self.process_record(record)
                                    if update is not None:
                                        updates.append(update)
                                    succeeded = True
                                    break
                                except Exception as exc:
                                    last_error = exc
                                    if attempt < 2:
                                        await asyncio.sleep(0.25 * (2**attempt))
                            if not succeeded:
                                logger.error(
                                    "Telemetry processing failed after retries for %s: %s",
                                    msg_id,
                                    last_error,
                                    exc_info=last_error,
                                )
                                try:
                                    await redis_client.xadd(
                                        f"{stream_name}:dead_letter",
                                        {
                                            "source_message_id": str(msg_id),
                                            "payload": raw_payload,
                                            "error": str(last_error),
                                        },
                                        maxlen=10000,
                                        approximate=True,
                                    )
                                except Exception as dlq_error:
                                    logger.error(
                                        "Could not dead-letter telemetry %s; it remains pending for retry: %s",
                                        msg_id,
                                        dlq_error,
                                    )
                                    continue
                            await redis_client.xack(stream_name, group_name, msg_id)
                        return updates

                group_updates = await asyncio.gather(
                    *(process_aircraft_batch(items) for items in grouped.values())
                )
                aircraft_updates = [
                    update for updates in group_updates for update in updates
                ]
                if aircraft_updates:
                    from app.api.v1.endpoints import manager as ws_manager

                    await ws_manager.broadcast(
                        {
                            "event": "AIRCRAFT_BATCH_UPDATE",
                            "payload": {"items": aircraft_updates},
                        }
                    )
            except Exception as e:
                logger.error(f"Error in Redis Stream consumer loop: {e}", exc_info=True)
                await asyncio.sleep(2)

    async def process_record(self, record: dict[str, Any]) -> dict[str, Any] | None:
        """Evaluates physical rules and ML models on a single flight state update."""
        from app.core.telemetry import PIPELINE_STAGE_LATENCY, tracer

        ingestion_id = record.get("ingestion_id")
        if ingestion_id:
            # Redis delivery is at-least-once: a process may commit evidence and
            # die before XACK. Treat that redelivery as successful without
            # creating duplicate state, assessment, or alert rows.
            async with self.db_session_maker() as session:
                persisted = await session.execute(
                    select(AircraftState.id)
                    .where(AircraftState.ingestion_id == ingestion_id)
                    .limit(1)
                )
                if persisted.scalar_one_or_none() is not None:
                    logger.info(
                        "Skipping already-persisted telemetry delivery %s", ingestion_id
                    )
                    return None

        # The production singleton is updated by the live configuration API.
        # Preserve explicitly injected configs for isolated workers and tests.
        if self._uses_shared_rule_config:
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
                rule_climb, climb_reason, climb_evidence = check_impossible_climb_rate(
                    record["vertical_rate_ms"], self.rule_config
                )
            rule_alt_vel, alt_vel_reason, alt_vel_evidence = (None, None, {})
            if {"altitude", "velocity", "on_ground"}.issubset(observed):
                rule_alt_vel, alt_vel_reason, alt_vel_evidence = (
                    check_altitude_velocity_mismatch(
                        record["altitude_m"],
                        record["velocity_ms"],
                        record["on_ground"],
                        self.rule_config,
                    )
                )
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
                    config=self.rule_config,
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
                rule_low_signal, low_signal_reason, low_signal_evidence = (
                    check_low_signal_confidence(
                        reported_nic=reported_nic,
                        current_lat=record["latitude"],
                        current_lon=record["longitude"],
                        prev_lat=prev_record["latitude"] if prev_record else None,
                        prev_lon=prev_record["longitude"] if prev_record else None,
                        config=self.rule_config,
                    )
                )
        rules_latency = time.perf_counter() - rules_start
        PIPELINE_STAGE_LATENCY.labels(stage="rules").observe(rules_latency)

        rule_flags = [rule_jump, rule_dup, rule_climb, rule_alt_vel, rule_low_signal]
        reasons = [
            r
            for r in [
                jump_reason,
                dup_reason,
                climb_reason,
                alt_vel_reason,
                low_signal_reason,
            ]
            if r is not None
        ]

        # Calculate Rolling Window Features
        states = [record] + prev_history[:4]
        complete_window = len(states) >= 5 and all(
            {"velocity", "heading", "vertical_rate"}.issubset(
                set(s.get("data_quality", {}).get("observed_fields", []))
            )
            for s in states
        )
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
            time_diff = max(
                0.1,
                (record["received_at"] - prev_record["received_at"]).total_seconds(),
            )

        ensemble_score = None
        ae_score = None
        shap_explanation = {
            "status": "unavailable",
            "reason": "Not enough observed history for rolling features.",
        }
        unavailable_reasons = []

        # 1. Evaluate Unsupervised Autoencoder independently when rolling kinematics exist
        if (
            settings.ENABLE_LIVE_ML
            and speed_var is not None
            and time_diff is not None
            and self.autoencoder is not None
        ):
            ae_start = time.perf_counter()
            with tracer.start_as_current_span("evaluate_autoencoder"):
                ae_features = np.array(
                    [speed_var, heading_var, alt_rate_var, time_diff]
                )
                ae_score = self.autoencoder.compute_anomaly_score(ae_features)
            PIPELINE_STAGE_LATENCY.labels(stage="autoencoder").observe(
                time.perf_counter() - ae_start
            )
        elif self.autoencoder is not None:
            unavailable_reasons.append(
                "Autoencoder unassessed: requires 5+ consecutive kinematic observations"
            )

        # 2. Evaluate Supervised Ensemble when its required features (kinematics + all rules) exist
        if (
            settings.ENABLE_LIVE_ML
            and speed_var is not None
            and time_diff is not None
            and all(flag is not None for flag in rule_flags)
        ):
            feature_vector = np.array(
                [
                    speed_var,
                    heading_var,
                    alt_rate_var,
                    time_diff,
                    float(rule_jump),
                    float(rule_dup),
                    float(rule_climb),
                    float(rule_alt_vel),
                    float(rule_low_signal),
                ]
            )
            if self.ensemble is not None:
                ensemble_start = time.perf_counter()
                with tracer.start_as_current_span("evaluate_ensemble"):
                    ensemble_score, shap_explanation = self.ensemble.predict_anomaly(
                        feature_vector
                    )
                PIPELINE_STAGE_LATENCY.labels(stage="ensemble").observe(
                    time.perf_counter() - ensemble_start
                )
        elif self.ensemble is not None:
            if speed_var is None or time_diff is None:
                unavailable_reasons.append(
                    "ML Ensemble unassessed: requires rolling kinematic history"
                )
            elif any(flag is None for flag in rule_flags):
                unavailable_reasons.append(
                    "ML Ensemble unassessed: feature vector incomplete (missing NIC/duplicate rule evidence)"
                )

        # 3. Trilateration / Receiver Consistency check
        tri_start = time.perf_counter()
        with tracer.start_as_current_span("evaluate_trilateration") as span:
            sensors = record.get("sensors") or []
            trilateration_score, tri_reason, tri_evidence = (
                check_trilateration_plausibility(
                    record["latitude"], record["longitude"], sensors
                )
            )
            if tri_reason not in {"consistent", "inconclusive", "unavailable"}:
                reasons.append(tri_reason)
            if trilateration_score is None:
                unavailable_reasons.append(
                    "Receiver consistency unavailable: calibrated station timing observations not provided"
                )
        tri_latency = time.perf_counter() - tri_start
        PIPELINE_STAGE_LATENCY.labels(stage="trilateration").observe(tri_latency)

        # Track unassessed physical rules
        if any(flag is None for flag in rule_flags):
            unassessed_rule_names = []
            if rule_jump is None:
                unassessed_rule_names.append(
                    "position_jump (requires previous observation)"
                )
            if rule_dup is None:
                unassessed_rule_names.append(
                    "duplicate_icao (single-stream observation)"
                )
            if rule_low_signal is None:
                unassessed_rule_names.append(
                    "low_signal_confidence (NIC unpopulated in source)"
                )
            if unassessed_rule_names:
                unavailable_reasons.append(
                    f"Unassessed rules: {', '.join(unassessed_rule_names)}"
                )

        # --- 4. Combine Scoring Signals & Derive Trust Score ---
        combined_risk_score, is_alert_triggered = combine_scores(
            rule_flags=rule_flags,
            ensemble_score=ensemble_score,
            autoencoder_score=ae_score,
            trilateration_consistency=trilateration_score,
            threshold=0.65,
        )
        evidence_confidence = compute_evidence_confidence(
            rule_flags=rule_flags,
            ensemble_score=ensemble_score,
            autoencoder_score=ae_score,
            trilateration_consistency=trilateration_score,
        )
        trust_val = derive_trust_score(combined_risk_score)

        # Determine canonical assessment status
        if is_suppressed:
            assessment_status = "SUPPRESSED"
        elif is_alert_triggered:
            assessment_status = "REVIEW_REQUIRED"
        elif combined_risk_score is not None:
            if (
                ensemble_score is not None
                and ae_score is not None
                and trilateration_score is not None
                and all(f is not None for f in rule_flags)
            ):
                assessment_status = "ASSESSED"
            else:
                assessment_status = "PARTIALLY_ASSESSED"
        else:
            assessment_status = "INSUFFICIENT_EVIDENCE"

        audit_payload = {
            "icao24": icao24,
            "callsign": record["callsign"],
            "combined_risk_score": combined_risk_score,
            "trust_score": trust_val,
            "evidence_confidence": evidence_confidence,
            "assessment_status": assessment_status,
            "rules_triggered": [
                FEATURE_NAMES[i + 4] for i, f in enumerate(rule_flags) if f
            ],
            "ensemble_score": ensemble_score,
            "autoencoder_score": ae_score,
            "receiver_consistency": trilateration_score,
            "is_known_entity": is_suppressed,
            "known_entity_label": known_label,
            "alert_triggered": bool(is_alert_triggered and not is_suppressed),
        }

        self.latest_scores[icao24] = {
            "ensemble_score": ensemble_score,
            "autoencoder_score": ae_score,
            "receiver_consistency_score": trilateration_score,
            "combined_risk_score": combined_risk_score,
            "trust_score": trust_val,
            "evidence_confidence": evidence_confidence,
            "rule_assessment_coverage": round(
                sum(flag is not None for flag in rule_flags) / len(rule_flags), 2
            ),
            "assessment_status": assessment_status,
            "unavailable_reasons": unavailable_reasons,
        }
        logger.debug(
            f"[SCORE_EVAL] {icao24} ({record.get('callsign')}): "
            f"Ensemble={ensemble_score if ensemble_score is not None else 'UNAVAILABLE'}, "
            f"Autoencoder={ae_score if ae_score is not None else 'UNAVAILABLE'}, "
            f"ReceiverConsistency={trilateration_score if trilateration_score is not None else 'UNAVAILABLE'}, "
            f"CombinedRisk={f'{combined_risk_score:.4f}' if combined_risk_score is not None else 'UNASSESSED'}, "
            f"TrustScore={f'{trust_val:.1f}' if trust_val is not None else 'UNASSESSED'}, "
            f"Status={assessment_status}"
        )

        if is_suppressed:
            logger.debug(
                json.dumps(
                    {
                        "event": "AUDIT_DECISION_SUPPRESSED",
                        "payload": audit_payload,
                        "message": f"[AUDIT] Decision: SUPPRESSED for known entity {icao24} ({known_label}). Calculated risk: {f'{combined_risk_score:.2f}' if combined_risk_score is not None else 'UNASSESSED'}.",
                    }
                )
            )
        else:
            decision = "ALERT" if is_alert_triggered else assessment_status
            decision_logger = logger.info if is_alert_triggered else logger.debug
            decision_logger(
                json.dumps(
                    {
                        "event": f"AUDIT_DECISION_{decision}",
                        "payload": audit_payload,
                        "message": f"[AUDIT] Decision: {decision} for aircraft {icao24}. Risk: {f'{combined_risk_score:.2f}' if combined_risk_score is not None else 'UNASSESSED'}, Trust: {f'{trust_val:.1f}' if trust_val is not None else 'UNASSESSED'}.",
                    }
                )
            )

        # --- 4. Write to Database ---
        db_start = time.perf_counter()
        state_id = None
        persisted_alert_id = None
        persisted_alert_detected_at = None
        reason_text = (
            "; ".join(reasons)
            if reasons
            else "Anomaly detected by combined risk score."
        )
        with tracer.start_as_current_span("write_alerts_db") as span:
            try:
                async with self.db_session_maker() as session:
                    db_state = AircraftState(
                        ingestion_id=ingestion_id,
                        icao24=record["icao24"],
                        callsign=record["callsign"],
                        squawk=record.get("squawk"),
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
                        is_synthetic=is_synthetic,
                    )
                    session.add(db_state)
                    await session.flush()
                    state_id = db_state.id
                    session.add(
                        AircraftAssessment(
                            aircraft_state_id=db_state.id,
                            icao24=icao24,
                            combined_risk_score=combined_risk_score,
                            rule_assessment_coverage=self.latest_scores[icao24][
                                "rule_assessment_coverage"
                            ],
                            status=self.latest_scores[icao24]["assessment_status"],
                            signals={
                                "rule_flags": {
                                    "position_jump": rule_jump,
                                    "duplicate_icao": rule_dup,
                                    "climb_rate": rule_climb,
                                    "alt_vel_mismatch": rule_alt_vel,
                                    "low_signal_confidence": rule_low_signal,
                                },
                                "ensemble_score": ensemble_score,
                                "autoencoder_score": ae_score,
                                "receiver_consistency": trilateration_score,
                                "trust_score": trust_val,
                                "evidence_confidence": evidence_confidence,
                                "unavailable_reasons": unavailable_reasons,
                                "data_quality": record.get("data_quality", {}),
                                "live_ml_enabled": settings.ENABLE_LIVE_ML,
                            },
                            detector_version="rules-v2",
                            assessed_at=datetime.now(timezone.utc),
                        )
                    )

                    if is_alert_triggered and not is_suppressed:
                        evidence_data = {
                            "rule_flags": {
                                "position_jump": jump_evidence,
                                "duplicate_icao": dup_evidence,
                                "climb_rate": climb_evidence,
                                "alt_vel_mismatch": alt_vel_evidence,
                                "low_signal_confidence": low_signal_evidence,
                            },
                            "receiver_consistency": tri_evidence,
                            "model_scores": {
                                "ensemble_score": ensemble_score,
                                "autoencoder_score": ae_score,
                            },
                            "rule_assessment_coverage": self.latest_scores[icao24][
                                "rule_assessment_coverage"
                            ],
                            "assessment_status": self.latest_scores[icao24][
                                "assessment_status"
                            ],
                            "live_ml_enabled": settings.ENABLE_LIVE_ML,
                            "trust_score": trust_val,
                            "evidence_confidence": evidence_confidence,
                            "unavailable_reasons": unavailable_reasons,
                        }
                        persisted_alert = Alert(
                            icao24=record["icao24"],
                            aircraft_state_id=state_id,
                            rule_flags=[
                                FEATURE_NAMES[i + 4]
                                for i, f in enumerate(rule_flags)
                                if f
                            ],
                            ensemble_score=ensemble_score,
                            autoencoder_score=ae_score,
                            combined_risk_score=combined_risk_score,
                            reason_text=reason_text,
                            shap_explanation={
                                "shap": shap_explanation,
                                "evidence": evidence_data,
                            },
                            detected_at=datetime.now(timezone.utc),
                            is_synthetic=is_synthetic,
                            acknowledged=False,
                        )
                        session.add(persisted_alert)
                        await session.flush()
                        persisted_alert_id = persisted_alert.id
                        persisted_alert_detected_at = persisted_alert.detected_at

                    # State, assessment, and any alert form one evidence
                    # transaction. A failed write must leave no partial record.
                    await session.commit()
            except Exception as e:
                logger.error(
                    "Failed to persist telemetry evidence for %s: %s", icao24, e
                )
                # The Redis consumer must retry or dead-letter this observation;
                # returning normally would cause it to acknowledge lost evidence.
                raise

            # Track session counts in SYSTEM_STATS
            try:
                from app.api.v1.endpoints import SYSTEM_STATS

                if is_synthetic:
                    SYSTEM_STATS["total_synthetic_states"] = (
                        SYSTEM_STATS.get("total_synthetic_states", 0) + 1
                    )
                else:
                    SYSTEM_STATS["total_real_states"] = (
                        SYSTEM_STATS.get("total_real_states", 0) + 1
                    )
            except Exception:
                pass

            if is_alert_triggered and not is_suppressed:
                logger.info(
                    "Persisted telemetry assessment and alert for aircraft %s", icao24
                )
                try:
                    from app.api.v1.endpoints import manager as ws_manager

                    await ws_manager.broadcast(
                        {
                            "event": "ALERT_TRIGGERED",
                            "id": persisted_alert_id,
                            "detected_at": (
                                persisted_alert_detected_at.isoformat()
                                if persisted_alert_detected_at
                                else None
                            ),
                            "icao24": record["icao24"],
                            "combined_risk_score": combined_risk_score,
                            "trust_score": trust_val,
                            "evidence_confidence": evidence_confidence,
                            "reason_text": reason_text,
                            "is_synthetic": is_synthetic,
                        }
                    )
                except Exception as e:
                    logger.warning(
                        "Persisted alert for %s but WebSocket notification failed: %s",
                        icao24,
                        e,
                    )

        # Only advance per-aircraft temporal history after the observation and
        # any triggered alert have been durably persisted.
        self.history[icao24] = [record] + prev_history[:9]

        # Return the realtime update; the worker groups these into a batch so
        # large global snapshots do not create one WebSocket/Redis publish per aircraft.
        route_info = None
        if hasattr(self, "route_service") and self.route_service:
            route_info = self.route_service.get_cached_route(record["icao24"])
        route_text = (
            route_info.get("route_text", "Route unknown")
            if route_info
            else "Route unknown"
        )
        observed_at = record["received_at"]
        if observed_at.tzinfo is None:
            observed_at = observed_at.replace(tzinfo=timezone.utc)
        age_seconds = max(
            0.0, (datetime.now(timezone.utc) - observed_at).total_seconds()
        )
        poll_interval = float(
            settings.OPENSKY_POLL_INTERVAL_SECONDS
            or (90.0 if opensky_auth.configured else 900.0)
        )
        db_latency = time.perf_counter() - db_start
        PIPELINE_STAGE_LATENCY.labels(stage="db_write").observe(db_latency)
        return {
            "icao24": record["icao24"],
            "latitude": record["latitude"],
            "longitude": record["longitude"],
            "altitude_m": record["altitude_m"],
            "velocity_ms": record["velocity_ms"],
            "heading_deg": record["heading_deg"],
            "vertical_rate_ms": record["vertical_rate_ms"],
            "on_ground": record["on_ground"],
            "callsign": record.get("callsign", f"AC-{record['icao24'].upper()}"),
            "squawk": record.get("squawk"),
            "is_synthetic": is_synthetic,
            "source": record.get("source", "opensky"),
            "route": route_text,
            "received_at": observed_at.isoformat(),
            "last_seen_seconds_ago": round(age_seconds, 1),
            "staleness_status": (
                "STALE" if age_seconds > max(20.0, poll_interval * 1.5) else "LIVE"
            ),
            "combined_risk_score": combined_risk_score,
            "is_alert_triggered": bool(is_alert_triggered and not is_suppressed),
            "trust_score": trust_val,
            "evidence_confidence": evidence_confidence,
            "assessment_status": self.latest_scores[icao24]["assessment_status"],
            "data_quality": record.get("data_quality", {}),
        }

import asyncio
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.detection.rules import RuleConfig
from app.detection.service import DetectionService


@pytest.mark.asyncio
async def test_detection_service_integration():
    queue = asyncio.Queue()

    # 1. Mock DB Session Maker
    db_session = MagicMock()
    async_db_session = AsyncMock()
    async_db_session.add = MagicMock()
    db_session.return_value = async_db_session

    async_db_session.commit = AsyncMock()
    async_db_session.refresh = AsyncMock()
    async_db_session.__aenter__.return_value = async_db_session

    # Mock refresh to inject database row ID
    def mock_refresh(obj):
        obj.id = 12345

    async_db_session.refresh.side_effect = mock_refresh

    # 2. Mock Machine Learning Estimators (Configured to exceed the 0.7 risk threshold when combined with rule triggers)
    ensemble = MagicMock()
    ensemble.predict_anomaly.return_value = (
        0.9,
        {"top_features": [], "base_value": 0.05},
    )

    autoencoder = MagicMock()
    autoencoder.compute_anomaly_score.return_value = 0.8

    # 3. Instantiate service
    service = DetectionService(
        queue=queue,
        db_session_maker=db_session,
        ensemble_model=ensemble,
        autoencoder_model=autoencoder,
        rule_config=RuleConfig(),
    )

    # Mock logger to verify structured log fields
    with patch("app.detection.service.logger") as mock_logger:
        t1 = datetime.now(timezone.utc) - timedelta(minutes=1)
        t2 = datetime.now(timezone.utc)

        # --- Test Sequence 1: Deliberate Position Jump (Trigger alert) ---
        state_1 = {
            "icao24": "a1b2c3",
            "callsign": "UAL824",
            "latitude": 37.7749,
            "longitude": -122.4194,
            "altitude_m": 10000.0,
            "velocity_ms": 250.0,
            "heading_deg": 180.0,
            "vertical_rate_ms": 0.0,
            "on_ground": False,
            "received_at": t1,
            "source": "opensky",
            "metadata": {"is_known_entity": False, "known_entity_label": None},
        }

        # Position jumps 560 km in 1 min (implied speed ~33,600 km/h)
        state_2 = {
            "icao24": "a1b2c3",
            "callsign": "UAL824",
            "latitude": 34.0522,
            "longitude": -118.2437,
            "altitude_m": 10000.0,
            "velocity_ms": 250.0,
            "heading_deg": 180.0,
            "vertical_rate_ms": 0.0,
            "on_ground": False,
            "received_at": t2,
            "source": "opensky",
            "metadata": {"is_known_entity": False, "known_entity_label": None},
        }

        await service.process_record(state_1)
        await service.process_record(state_2)

        # Assert correct Alert created in DB
        added_objects = [args[0] for args, _ in async_db_session.add.call_args_list]
        alerts_added = [
            obj for obj in added_objects if obj.__class__.__name__ == "Alert"
        ]

        assert len(alerts_added) == 1
        alert = alerts_added[0]
        assert alert.icao24 == "a1b2c3"
        assert "rule_position_jump" in alert.rule_flags
        assert "Implied speed" in alert.reason_text

        # Assert correct audit decision logged
        log_payloads = [
            json.loads(args[0])
            for args, _ in mock_logger.info.call_args_list
            if args and args[0].startswith("{")
        ]
        alert_log = next(
            (p for p in log_payloads if p.get("event") == "AUDIT_DECISION_ALERT"), None
        )

        assert alert_log is not None
        assert alert_log["payload"]["icao24"] == "a1b2c3"
        assert alert_log["payload"]["alert_triggered"] is True

        # Reset mocks for next sequence
        async_db_session.add.reset_mock()
        mock_logger.info.reset_mock()

        # --- Test Sequence 2: Known Entity (Suppressed alert) ---
        state_military = {
            "icao24": "d81234",
            "callsign": "MIL-1",
            "latitude": 37.7749,
            "longitude": -122.4194,
            "altitude_m": 5000.0,
            "velocity_ms": 150.0,
            "heading_deg": 90.0,
            "vertical_rate_ms": 80.0,  # Highly anomalous climb rate (>50 m/s)
            "on_ground": False,
            "received_at": t2,
            "source": "opensky",
            "metadata": {"is_known_entity": True, "known_entity_label": "MILITARY_F35"},
        }

        await service.process_record(state_military)

        # Assert NO Alert added to DB for suppressed target
        added_objects_mil = [args[0] for args, _ in async_db_session.add.call_args_list]
        alerts_added_mil = [
            obj for obj in added_objects_mil if obj.__class__.__name__ == "Alert"
        ]
        assert (
            len(alerts_added_mil) == 0
        ), "Alert was incorrectly written to database for suppressed entity"

        # Assert correct suppression logging
        # Per-track suppression decisions are intentionally DEBUG to keep live
        # global-feed polling from emitting one INFO record per aircraft.
        log_payloads_mil = [
            json.loads(args[0])
            for args, _ in mock_logger.debug.call_args_list
            if args and args[0].startswith("{")
        ]
        suppressed_log = next(
            (
                p
                for p in log_payloads_mil
                if p.get("event") == "AUDIT_DECISION_SUPPRESSED"
            ),
            None,
        )

        assert suppressed_log is not None
        assert suppressed_log["payload"]["icao24"] == "d81234"
        assert suppressed_log["payload"]["is_known_entity"] is True
        assert suppressed_log["payload"]["known_entity_label"] == "MILITARY_F35"


@pytest.mark.asyncio
async def test_detection_scoring_pipeline_end_to_end():
    """Verifies that 5 observations of normal telemetry produce legitimate combined risk,
    canonical trust score, evidence confidence, and persisted Assessment signals without NIC.
    """
    queue = asyncio.Queue()

    db_session = MagicMock()
    async_db_session = AsyncMock()
    async_db_session.add = MagicMock()
    db_session.return_value = async_db_session
    async_db_session.commit = AsyncMock()
    async_db_session.refresh = AsyncMock()
    async_db_session.__aenter__.return_value = async_db_session

    ensemble = MagicMock()
    # Ensemble cannot run without all features (returns None or raises)
    ensemble.predict_anomaly.return_value = (None, {})

    autoencoder = MagicMock()
    # Autoencoder produces 0.05 anomaly score for normal rolling kinematics
    autoencoder.compute_anomaly_score.return_value = 0.05

    service = DetectionService(
        queue=queue,
        db_session_maker=db_session,
        ensemble_model=ensemble,
        autoencoder_model=autoencoder,
        rule_config=RuleConfig(),
    )

    base_time = datetime(2026, 10, 4, 12, 0, 0, tzinfo=timezone.utc)
    assessments_added = []

    # Send 5 sequential normal reports for aircraft "800abc" (e.g. steady cruise at 250 m/s, 10,000m)
    for i in range(5):
        record = {
            "icao24": "800abc",
            "callsign": "AIC101",
            "latitude": 28.5 + (i * 0.01),
            "longitude": 77.1 + (i * 0.01),
            "altitude_m": 10000.0,
            "velocity_ms": 250.0,
            "heading_deg": 45.0,
            "vertical_rate_ms": 0.0,
            "on_ground": False,
            "received_at": base_time + timedelta(seconds=i * 10),
            "source": "opensky",
            "metadata": {"is_known_entity": False, "known_entity_label": None},
        }
        await service.process_record(record)

    # Collect all AircraftAssessment objects added to the DB session
    added_objects = [args[0] for args, _ in async_db_session.add.call_args_list]
    assessments_added = [
        obj for obj in added_objects if obj.__class__.__name__ == "AircraftAssessment"
    ]

    assert len(assessments_added) == 5
    latest_assessment = assessments_added[-1]

    # Verify canonical assessment fields
    assert latest_assessment.icao24 == "800abc"
    assert latest_assessment.combined_risk_score is not None
    # Risk should be very low (0.021 = autoencoder 0.05 * 0.30 / 0.70 available weight)
    assert 0.0 <= latest_assessment.combined_risk_score <= 0.10

    # Verify signals dictionary
    signals = latest_assessment.signals
    assert signals is not None
    assert "trust_score" in signals
    assert signals["trust_score"] is not None
    assert 90.0 <= signals["trust_score"] <= 100.0
    # Canonical relationship: trust = clamp((1 - combined_risk) * 100, 0, 100)
    expected_trust = round((1.0 - latest_assessment.combined_risk_score) * 100, 2)
    assert abs(signals["trust_score"] - expected_trust) < 0.1

    # Evidence confidence should reflect rules + autoencoder (0.40 + 0.30 = 0.70)
    assert signals["evidence_confidence"] == 0.70
    assert latest_assessment.assessment_status in ("PARTIALLY_ASSESSED", "ASSESSED")

    # Unavailable reasons should clearly explain missing ensemble and receiver evidence
    assert any("Ensemble" in r for r in signals["unavailable_reasons"])
    assert any("receiver" in r.lower() for r in signals["unavailable_reasons"])

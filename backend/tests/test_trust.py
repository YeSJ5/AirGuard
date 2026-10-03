import pytest
from datetime import datetime, timedelta, timezone

from app.detection.trust import (
    compute_weighted_rolling_trust,
    classify_trust_pattern
)


def test_trust_history_shapes_gradual_decline_vs_sudden_drop():
    """Asserts that the computed trust-history correctly reflects both gradual decline and sudden drop shapes.
    
    Gradual decline: Smooth, steady decay across multiple readings with small step differences (e.g. GPS jamming).
    Sudden drop: Flat high trust followed by a steep cliff drop within 1-2 readings (e.g. spoofed ghost injection).
    """
    base_time = datetime(2026, 9, 30, 10, 0, 0, tzinfo=timezone.utc)
    interval = timedelta(seconds=8)

    # 1. Construct Gradual Decline Sequence (15 steps)
    # Risk slowly creeps up: 0.0, 0.05, 0.10, 0.16, 0.22, 0.30, 0.40, 0.50, 0.60, 0.70, 0.78, 0.84, 0.90, 0.92, 0.95
    gradual_risks = [
        0.00, 0.05, 0.10, 0.16, 0.22, 0.30, 0.40, 0.50,
        0.60, 0.70, 0.78, 0.84, 0.90, 0.92, 0.95
    ]
    gradual_readings = [
        {
            "timestamp": base_time + (i * interval),
            "risk_score": r,
            "reported_nic": 9 if r < 0.5 else 4,
            "is_alert": r >= 0.7
        }
        for i, r in enumerate(gradual_risks)
    ]

    gradual_history = compute_weighted_rolling_trust(gradual_readings, window=10)
    assert len(gradual_history) == 15

    # Shape verification for Gradual Decline:
    # (a) Starts fully trusted, finishes degraded
    assert gradual_history[0]["trust_score"] == 100.0
    assert gradual_history[-1]["trust_score"] < 40.0

    # (b) Smooth step progression: No single transition has a cliff drop >= 15 points
    gradual_step_drops = [
        gradual_history[i - 1]["trust_score"] - gradual_history[i]["trust_score"]
        for i in range(1, len(gradual_history))
    ]
    max_gradual_step = max(gradual_step_drops)
    assert max_gradual_step < 15.0, f"Expected smooth steps, but max step drop was {max_gradual_step}"

    # (c) Intermediate scores are spread across the spectrum (showing continuous gradient)
    mid_score = gradual_history[7]["trust_score"]
    assert 55.0 <= mid_score <= 85.0, f"Expected mid-way transition score, got {mid_score}"

    # (d) Classified pattern
    assert classify_trust_pattern(gradual_history) == "GRADUAL_DECLINE"


    # 2. Construct Sudden Drop Sequence (15 steps)
    # 10 baseline clean readings followed by an abrupt spoofed injection (risk = 0.95)
    sudden_risks = [0.0] * 10 + [0.95, 0.98, 0.95, 0.96, 0.97]
    sudden_readings = [
        {
            "timestamp": base_time + (i * interval),
            "risk_score": r,
            "reported_nic": 9 if r == 0.0 else 2,
            "is_alert": r > 0.0
        }
        for i, r in enumerate(sudden_risks)
    ]

    sudden_history = compute_weighted_rolling_trust(sudden_readings, window=10)
    assert len(sudden_history) == 15

    # Shape verification for Sudden Drop:
    # (a) First 10 readings are perfectly clean at 100.0
    for i in range(10):
        assert sudden_history[i]["trust_score"] == 100.0, f"Step {i} should be 100.0"

    # (b) Reading 11 experiences an immediate precipitous plunge
    cliff_drop = sudden_history[9]["trust_score"] - sudden_history[10]["trust_score"]
    assert cliff_drop >= 15.0, f"Expected sharp cliff drop, got {cliff_drop}"

    # (c) Within 2 readings of the attack, trust plummets by > 30 points
    two_step_drop = sudden_history[9]["trust_score"] - sudden_history[11]["trust_score"]
    assert two_step_drop >= 30.0, f"Expected >= 30 point drop over 2 steps, got {two_step_drop}"

    # (d) Classified pattern
    assert classify_trust_pattern(sudden_history) == "SUDDEN_DROP"


    # 3. Direct Contrast of the Two Shapes:
    # Max single-step rate of decline in the sudden drop must be significantly steeper
    sudden_step_drops = [
        sudden_history[i - 1]["trust_score"] - sudden_history[i]["trust_score"]
        for i in range(1, len(sudden_history))
    ]
    max_sudden_step = max(sudden_step_drops)

    assert max_sudden_step > max_gradual_step, (
        f"Sudden drop peak derivative ({max_sudden_step}) should be strictly greater than "
        f"gradual decline peak derivative ({max_gradual_step})"
    )


def test_trust_history_stable_pattern():
    """Confirms that clean flight telemetry maintains 100 trust and 'STABLE' classification."""
    base_time = datetime(2026, 9, 30, 10, 0, 0, tzinfo=timezone.utc)
    readings = [
        {
            "timestamp": base_time + timedelta(seconds=i * 8),
            "risk_score": 0.0,
            "reported_nic": 9,
            "is_alert": False
        }
        for i in range(12)
    ]
    history = compute_weighted_rolling_trust(readings, window=10)
    assert len(history) == 12
    assert all(p["trust_score"] == 100.0 for p in history)
    assert classify_trust_pattern(history) == "STABLE"


def test_trust_history_empty_and_single():
    """Confirms boundary handling for 0 or 1 historical points."""
    assert compute_weighted_rolling_trust([]) == []
    assert classify_trust_pattern([]) == "STABLE"

    single = [{
        "timestamp": datetime.now(timezone.utc),
        "risk_score": 0.2,
        "reported_nic": 8,
        "is_alert": False
    }]
    hist_single = compute_weighted_rolling_trust(single, window=10)
    assert len(hist_single) == 1
    assert hist_single[0]["trust_score"] == 80.0
    assert classify_trust_pattern(hist_single) == "STABLE"

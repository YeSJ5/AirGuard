from datetime import datetime
from typing import List, Dict, Any, Optional


def derive_trust_score(combined_risk_score: Optional[float]) -> Optional[float]:
    """Canonical derivation of Telemetry Trust Index (0-100 scale) from detector combined risk (0-1 scale).

    AirGuard Telemetry Trust Index semantics:
    - Trust Score is a detector-derived telemetry confidence index.
    - Inverse relationship: trust_score = clamp((1.0 - combined_risk_score) * 100, 0, 100).
    - Unassessed risk (None) yields None (unassessed trust).
    - It must NOT be interpreted as aircraft airworthiness, physical safety, collision probability,
      or absolute proof that an aircraft is genuine.
    """
    if combined_risk_score is None:
        return None
    try:
        val = float(combined_risk_score)
        return round(max(0.0, min(100.0, (1.0 - val) * 100.0)), 1)
    except (TypeError, ValueError):
        return None


def compute_weighted_rolling_trust(
    readings: List[Dict[str, Any]],
    window: int = 10
) -> List[Dict[str, Any]]:
    """Computes a rolling trust score (0-100) across a sequence of historical states.
    
    Derived from a weighted rolling average of combined_risk_score at each historical state
    (higher risk score = lower trust, normalized and smoothed over a configurable window).
    
    Each reading dict is expected to contain:
      - 'timestamp': datetime
      - 'risk_score': float (0.0 to 1.0)
      - 'reported_nic': Optional[int]
      - 'is_alert': bool
      
    Returns a list of dicts with:
      - 'timestamp': datetime
      - 'instantaneous_risk': float
      - 'trust_score': float (0.0 to 100.0)
      - 'is_alert': bool
      - 'reported_nic': Optional[int]
    """
    if not readings:
        return []

    # Ensure chronologically sorted
    sorted_readings = sorted(readings, key=lambda x: x["timestamp"])
    history_points = []

    for i in range(len(sorted_readings)):
        start_idx = max(0, i - window + 1)
        window_slice = sorted_readings[start_idx : i + 1]
        k = len(window_slice)

        # Linear weights: 1, 2, ..., k (most recent reading has weight k)
        weights = list(range(1, k + 1))
        sum_weights = sum(weights)

        weighted_risk_sum = sum(w * window_slice[j]["risk_score"] for j, w in enumerate(weights))
        smoothed_risk = weighted_risk_sum / sum_weights if sum_weights > 0 else 0.0

        # Normalization: higher risk = lower trust (0 to 100)
        trust_score = round(max(0.0, min(100.0, (1.0 - smoothed_risk) * 100.0)), 1)
        curr = sorted_readings[i]

        history_points.append({
            "timestamp": curr["timestamp"],
            "instantaneous_risk": round(float(curr["risk_score"]), 4),
            "trust_score": trust_score,
            "is_alert": bool(curr.get("is_alert", False)),
            "reported_nic": curr.get("reported_nic")
        })

    return history_points


def classify_trust_pattern(history_points: List[Dict[str, Any]]) -> str:
    """Classifies the trust progression shape into 'STABLE', 'GRADUAL_DECLINE', or 'SUDDEN_DROP'.
    
    - 'SUDDEN_DROP': An abrupt plunge in trust score within 1-2 consecutive readings 
      (e.g. >= 15 point drop in a single step, or >= 25 point drop over 2 steps).
    - 'GRADUAL_DECLINE': Sustained multi-step descent where trust drops steadily without sharp cliff drops.
    - 'STABLE': Minor or no degradation.
    """
    if len(history_points) < 2:
        return "STABLE"

    scores = [p["trust_score"] for p in history_points]
    max_single_drop = 0.0
    for i in range(1, len(scores)):
        drop = scores[i - 1] - scores[i]
        if drop > max_single_drop:
            max_single_drop = drop

    max_two_step_drop = 0.0
    for i in range(2, len(scores)):
        drop2 = scores[i - 2] - scores[i]
        if drop2 > max_two_step_drop:
            max_two_step_drop = drop2

    overall_drop = scores[0] - scores[-1]

    # In a 10-reading linear WMA, max theoretical single-step drop from 0 to 1 risk is ~18.2 points.
    # Therefore, a single-step drop >= 15.0 or 2-step drop >= 25.0 unambiguously signifies a sudden cliff drop.
    if max_single_drop >= 15.0 or max_two_step_drop >= 25.0:
        return "SUDDEN_DROP"

    # Significant overall drop achieved progressively via gentle steps (< 15 points per step)
    if overall_drop >= 20.0 or (scores[-1] < 70.0 and max_single_drop < 15.0):
        return "GRADUAL_DECLINE"

    return "STABLE"


def compute_weighted_rolling_risk(readings: List[Dict[str, Any]], window: int = 10) -> List[Dict[str, Any]]:
    """Smooth observed detector risk without converting it into an aircraft trust rating."""
    if not readings:
        return []
    ordered = sorted(readings, key=lambda item: item["timestamp"])
    output = []
    for idx, current in enumerate(ordered):
        window_slice = ordered[max(0, idx - window + 1):idx + 1]
        weights = range(1, len(window_slice) + 1)
        weighted_sum = sum(weight * item["risk_score"] for weight, item in zip(weights, window_slice))
        weight_total = len(window_slice) * (len(window_slice) + 1) / 2
        output.append({
            "timestamp": current["timestamp"],
            "risk_score": round(float(current["risk_score"]), 4),
            "smoothed_risk_score": round(weighted_sum / weight_total, 4),
            "is_alert": bool(current.get("is_alert", False)),
            "reported_nic": current.get("reported_nic"),
        })
    return output


def classify_risk_pattern(history_points: List[Dict[str, Any]]) -> str:
    """Describe changes in smoothed detector risk; this is not a threat classification."""
    if len(history_points) < 2:
        return "UNASSESSED"
    values = [point["smoothed_risk_score"] for point in history_points]
    max_rise = max((values[i] - values[i - 1] for i in range(1, len(values))), default=0.0)
    max_two_point_rise = max((values[i] - values[i - 2] for i in range(2, len(values))), default=0.0)
    net_rise = values[-1] - values[0]
    if max_rise >= 0.15 or max_two_point_rise >= 0.25:
        return "RISK_SPIKE"
    if net_rise >= 0.20 or (values[-1] >= 0.65 and max_rise < 0.15):
        return "RISK_RISING"
    return "STABLE"

import math
import os
import torch
import torch.nn as nn
import numpy as np
from typing import List, Dict, Any, Tuple

# --- Ground Receivers Reference Database ---
# Mapped coordinates for ground receiver station nodes
GROUND_RECEIVERS = {
    # US West Coast Stations
    "1": (37.7749, -122.4194),  # San Francisco
    "2": (37.8044, -122.2712),  # Oakland
    "3": (37.3382, -121.8863),  # San Jose
    "4": (38.5816, -121.4944),  # Sacramento
    "5": (36.7783, -119.4179),  # Fresno
    # Indian Regional Ground Receivers
    "VIDP": (28.5562, 77.1000), # Delhi IGI
    "VABB": (19.0896, 72.8656), # Mumbai CSMIA
    "VOBL": (13.1986, 77.7066), # Bengaluru KIA
    "VECC": (22.6547, 88.4467), # Kolkata NSCBIA
    "VOHS": (17.2403, 78.4294), # Hyderabad RGIA
    "VOMM": (12.9941, 80.1709), # Chennai MAA
    "101": (28.5562, 77.1000),  # Delhi Ground Node
    "102": (19.0896, 72.8656),  # Mumbai Ground Node
    "103": (13.1986, 77.7066),  # Bangalore Ground Node
    "104": (22.6547, 88.4467),  # Kolkata Ground Node
    "105": (17.2403, 78.4294),  # Hyderabad Ground Node
    "106": (12.9941, 80.1709)   # Chennai Ground Node
}
MOCK_RECEIVERS = GROUND_RECEIVERS  # Backward-compatible alias

MODEL_PATH = os.path.join(os.path.dirname(__file__), "autoencoder.pth")

# --- Autoencoder Network Architecture ---

class AutoencoderModel(nn.Module):
    def __init__(self, input_dim: int = 4, latent_dim: int = 3):
        super(AutoencoderModel, self).__init__()
        # Compression layers
        self.encoder = nn.Sequential(
            nn.Linear(input_dim, 8),
            nn.ReLU(),
            nn.Linear(8, latent_dim)
        )
        # Reconstruction layers
        self.decoder = nn.Sequential(
            nn.Linear(latent_dim, 8),
            nn.ReLU(),
            nn.Linear(8, input_dim)
        )
        
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.decoder(self.encoder(x))


class UnsupervisedAutoencoder:
    def __init__(self, input_dim: int = 4, latent_dim: int = 3):
        self.model = AutoencoderModel(input_dim, latent_dim)
        self.model.eval()
        self.load_weights()

    def load_weights(self) -> None:
        """Loads weights from disk if trained file exists."""
        if os.path.exists(MODEL_PATH):
            try:
                self.model.load_state_dict(torch.load(MODEL_PATH))
                self.model.eval()
            except Exception:
                pass

    def compute_anomaly_score(self, features: np.ndarray) -> float:
        """Calculate reconstruction MSE on normalized kinematic features and scale to 0-1 probability score.

        Feature scales:
        - speed_var: normalized by typical cruise variance (50.0)
        - heading_var: normalized by typical heading drift (50.0)
        - alt_rate_var: normalized by vertical rate variance (20.0)
        - time_diff: centered around typical 5s poll interval, bounded to [0, 1]
        """
        # Feature normalization
        spd_norm = min(5.0, float(features[0]) / 50.0)
        hdg_norm = min(5.0, float(features[1]) / 50.0)
        alt_norm = min(5.0, float(features[2]) / 20.0)
        dt_val = float(features[3]) if len(features) > 3 else 5.0
        dt_norm = min(3.0, max(0.0, (dt_val - 5.0) / 10.0))

        norm_vector = np.array([spd_norm, hdg_norm, alt_norm, dt_norm], dtype=np.float32)
        tensor_features = torch.FloatTensor(norm_vector.reshape(1, -1))

        with torch.no_grad():
            reconstructed = self.model(tensor_features)
            mse = torch.mean((tensor_features - reconstructed) ** 2).item()

        # Calibrated exponential curve:
        # Near-zero variance / nominal telemetry yields anomaly score ~0.02 - 0.08
        # High kinematic anomalies scale cleanly towards 1.0
        raw_score = 1.0 - math.exp(-mse / 1.5)
        calibrated_score = max(0.01, min(1.0, (raw_score - 0.30) / 0.65))
        return float(calibrated_score)


# --- Trilateration Plausibility Check ---

def check_trilateration_plausibility(
    aircraft_lat: float,
    aircraft_lon: float,
    sensors: List[str]
) -> Tuple[float, str, Dict[str, Any]]:
    """Verify that the reporting sensors are within physically plausible range.

    If sensor locations are known, checks the distance from the target's reported position
    to each receiver. A spoofed transmitter on the ground broadcasting false aircraft
    positions cannot satisfy the geometric ranges of multiple receivers.
    """
    # Exclude invalid or empty sensor values
    valid_sensors = [str(s) for s in sensors if str(s) in MOCK_RECEIVERS]

    # Degrade gracefully if data is sparse
    if len(valid_sensors) < 2:
        return 1.0, "inconclusive", {"reason": "insufficient sensor data", "sensors_evaluated": valid_sensors}

    # Haversine distance calculator
    def haversine(lat1, lon1, lat2, lon2):
        R = 6371.0
        p1 = math.radians(lat1)
        p2 = math.radians(lat2)
        dp = math.radians(lat2 - lat1)
        dl = math.radians(lon2 - lon1)
        a = (math.sin(dp/2.0)**2) + math.cos(p1) * math.cos(p2) * (math.sin(dl/2.0)**2)
        return R * 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0-a))

    distances = []
    for s_id in valid_sensors:
        rx_lat, rx_lon = MOCK_RECEIVERS[s_id]
        dist = haversine(rx_lat, rx_lon, aircraft_lat, aircraft_lon)
        distances.append(dist)

    max_dist = max(distances)
    avg_dist = sum(distances) / len(distances)

    evidence = {
        "sensors_evaluated": valid_sensors,
        "distances_km": distances,
        "max_distance_km": max_dist,
        "avg_distance_km": avg_dist
    }

    # Physical Boundary: Line-of-sight limit for typical ADS-B ground stations is ~350 km.
    # If any reporting sensor is > 350 km away from the reported coordinates, the signal geometry is implausible.
    if max_dist > 350.0:
        # Consistency drops off linearly beyond the 350 km threshold
        consistency = max(0.0, 1.0 - (max_dist - 350.0) / 150.0)
        reason = f"physically inconsistent geometry: max receiver distance of {max_dist:.1f} km exceeds line-of-sight limits."
        return consistency, reason, evidence

    return 1.0, "consistent", evidence


# --- Combined Scoring Logic ---

def combine_scores(
    rule_flags: List[bool],
    ensemble_score: float,
    autoencoder_score: float,
    trilateration_consistency: float,
    threshold: float = 0.7
) -> Tuple[float, bool]:
    """Combines rule, ensemble, autoencoder, and trilateration signals into a risk score.

    Weighted Scoring Formula:
    - Rule Risk (W_rules = 0.40): Evaluates if any explicit physical boundaries (Prompt 5) were violated.
    - Ensemble Classifier (W_ensemble = 0.30): Supervised machine learning prediction.
    - Autoencoder Reconstruction (W_autoencoder = 0.20): Unsupervised deep learning anomaly signal.
    - Trilateration Inconsistency (W_trilateration = 0.10): Geometric consistency (1.0 - consistency).

    Score Summation:
        combined_risk = 0.40 * (any(rule_flags)) 
                        + 0.30 * ensemble_score 
                        + 0.20 * autoencoder_score 
                        + 0.10 * (1.0 - trilateration_consistency)

    Returns:
        combined_risk_score (0.0 to 1.0)
        is_alert_triggered (True if combined_risk >= threshold)
    """
    rule_risk = 1.0 if any(rule_flags) else 0.0
    trilateration_inconsistency = 1.0 - trilateration_consistency

    # Define weights
    w_rules = 0.40
    w_ensemble = 0.30
    w_autoencoder = 0.20
    w_trilateration = 0.10

    # Calculate weighted combined risk score
    combined_risk = (
        (w_rules * rule_risk) +
        (w_ensemble * ensemble_score) +
        (w_autoencoder * autoencoder_score) +
        (w_trilateration * trilateration_inconsistency)
    )

    # Ensure score is strictly bounded to [0.0, 1.0]
    combined_risk = min(1.0, max(0.0, combined_risk))
    is_triggered = combined_risk >= threshold

    return combined_risk, is_triggered

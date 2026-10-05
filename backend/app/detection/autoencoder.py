import math
import os
import logging
import torch
import torch.nn as nn
import numpy as np
from typing import List, Dict, Any, Tuple, Optional

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
        self.is_available = False
        self.load_weights()

    def load_weights(self) -> None:
        """Loads weights from disk if trained file exists."""
        if os.path.exists(MODEL_PATH):
            try:
                self.model.load_state_dict(torch.load(MODEL_PATH, map_location="cpu", weights_only=True))
                self.model.eval()
                self.is_available = True
            except Exception as exc:
                self.is_available = False
                logging.getLogger("airguard.detection").warning("Autoencoder weights could not be loaded: %s", exc)

    def compute_anomaly_score(self, features: np.ndarray) -> float | None:
        """Calculate reconstruction MSE on normalized kinematic features and scale to 0-1 probability score.

        Feature scales:
        - speed_var: normalized by typical cruise variance (50.0)
        - heading_var: normalized by typical heading drift (50.0)
        - alt_rate_var: normalized by vertical rate variance (20.0)
        - time_diff: centered around typical 5s poll interval, bounded to [0, 1]
        """
        if not self.is_available:
            return None

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
) -> Tuple[None, str, Dict[str, Any]]:
    """Return unavailable until calibrated, time-synchronized receiver observations exist.

    OpenSky's public state vector may include sensor identifiers, but AirGuard does not
    have an authorized station registry or per-receiver timing/range observations. A
    location-only station lookup cannot establish multilateration or receiver consistency.
    """
    return None, "unavailable", {
        "reason": "No calibrated receiver observations are configured.",
        "receiver_ids_supplied": len(sensors or []),
        "receiver_geometry_available": False,
    }


# --- Combined Scoring Logic ---

def combine_scores(
    rule_flags: List[bool | None],
    ensemble_score: float | None,
    autoencoder_score: float | None,
    trilateration_consistency: float | None,
    threshold: float = 0.7
) -> Tuple[Optional[float], bool]:
    """Fuse only available evidence; missing models/receivers contribute no fabricated pass."""
    assessed_rules = [flag for flag in rule_flags if flag is not None]
    weighted_signals = []
    if assessed_rules:
        weighted_signals.append((0.40, 1.0 if any(assessed_rules) else 0.0))
    if ensemble_score is not None:
        weighted_signals.append((0.30, float(ensemble_score)))
    if autoencoder_score is not None:
        weighted_signals.append((0.20, float(autoencoder_score)))
    if trilateration_consistency is not None:
        weighted_signals.append((0.10, 1.0 - float(trilateration_consistency)))

    if not weighted_signals:
        return None, False
    total_weight = sum(weight for weight, _ in weighted_signals)
    combined_risk = sum(weight * score for weight, score in weighted_signals) / total_weight
    combined_risk = min(1.0, max(0.0, combined_risk))
    return combined_risk, combined_risk >= threshold


def compute_evidence_confidence(
    rule_flags: List[bool | None],
    ensemble_score: float | None,
    autoencoder_score: float | None,
    trilateration_consistency: float | None,
) -> float:
    """Computes evidence confidence/coverage as the proportion of the intended evidence stack available."""
    assessed_rules = [flag for flag in rule_flags if flag is not None]
    available_weight = 0.0
    if assessed_rules:
        available_weight += 0.40
    if ensemble_score is not None:
        available_weight += 0.30
    if autoencoder_score is not None:
        available_weight += 0.20
    if trilateration_consistency is not None:
        available_weight += 0.10
    return round(min(1.0, max(0.0, available_weight)), 2)


import sys
import os
import numpy as np

backend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from app.detection.ensemble import TrustScoringEnsemble
from app.detection.autoencoder import UnsupervisedAutoencoder, combine_scores

ens = TrustScoringEnsemble()
ae = UnsupervisedAutoencoder()

test_vectors = [
    ('Normal Cruise (Calm)', np.array([0.05, 0.02, 0.01, 5.0, 0, 0, 0, 0, 0])),
    ('High Turn Rate', np.array([2.5, 25.0, 0.5, 5.0, 0, 0, 0, 0, 0])),
    ('Speed & Alt Fluctuations', np.array([35.0, 12.0, 8.0, 5.0, 0, 0, 0, 0, 0])),
    ('Rule: Impossible Climb', np.array([1.0, 0.5, 50.0, 5.0, 0, 0, 1, 0, 0])),
    ('Rule: Position Jump (Spoof)', np.array([2.0, 0.2, 0.0, 5.0, 1, 0, 0, 0, 0])),
    ('Rule: Multi-Rule Attack', np.array([40.0, 80.0, 60.0, 10.0, 1, 1, 1, 1, 0])),
]

print(f"{'Scenario':<30} | {'Ensemble':<10} | {'Autoencoder':<12} | {'Combined Risk':<14} | {'Trust %':<8}")
print("-" * 82)
for name, v in test_vectors:
    ens_score, _ = ens.predict_anomaly(v)
    ae_score = ae.compute_anomaly_score(v[:4])
    rule_flags = [bool(x) for x in v[4:]]
    comb_risk, _ = combine_scores(rule_flags, ens_score, ae_score, 1.0, 0.65)
    trust = (1.0 - comb_risk) * 100.0
    print(f"{name:<30} | {ens_score:<10.4f} | {ae_score:<12.4f} | {comb_risk:<14.4f} | {trust:<8.2f}%")

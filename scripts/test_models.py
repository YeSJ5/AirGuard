import os
import sys
import numpy as np

sys.path.insert(0, os.path.abspath('backend'))
from app.detection.ensemble import TrustScoringEnsemble
from app.detection.autoencoder import UnsupervisedAutoencoder, combine_scores

ens = TrustScoringEnsemble()
ae = UnsupervisedAutoencoder()

print(f"Ensemble loaded: {ens.model is not None}")
print(f"AE loaded: {ae.model is not None}")

# Cold start with rule_jump = 1.0
v_cold = np.array([0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0])
p_cold, _ = ens.predict_anomaly(v_cold, compute_shap=False)
a_cold = ae.compute_anomaly_score(np.array([0.0, 0.0, 0.0, 0.0]))
c_cold, _ = combine_scores([True, False, False, False, False], p_cold, a_cold, 0.0)
print(f"Cold Start: Ens={p_cold:.6f}, AE={a_cold:.6f}, Comb={c_cold:.6f}")

# Distinct kinematics
v1 = np.array([12.5, 3.2, 1.4, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0])
p1, _ = ens.predict_anomaly(v1, compute_shap=False)
a1 = ae.compute_anomaly_score(np.array([12.5, 3.2, 1.4, 5.0]))
c1, _ = combine_scores([False, False, False, False, False], p1, a1, 0.0)
print(f"Flight 1 (Normal): Ens={p1:.6f}, AE={a1:.6f}, Comb={c1:.6f}")

v2 = np.array([84.2, 45.1, 18.9, 10.0, 1.0, 0.0, 0.0, 0.0, 0.0])
p2, _ = ens.predict_anomaly(v2, compute_shap=False)
a2 = ae.compute_anomaly_score(np.array([84.2, 45.1, 18.9, 10.0]))
c2, _ = combine_scores([True, False, False, False, False], p2, a2, 0.0)
print(f"Flight 2 (Spoofed/Jump): Ens={p2:.6f}, AE={a2:.6f}, Comb={c2:.6f}")

import os
import sys

# Configure UTF-8 stdout/stderr for Windows consoles
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import numpy as np

# Ensure backend directory is in path
backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '../backend'))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from app.detection.ensemble import TrustScoringEnsemble
from app.detection.autoencoder import UnsupervisedAutoencoder, check_trilateration_plausibility, combine_scores, GROUND_RECEIVERS

def main():
    print("================================================================")
    print("AirGuard Multi-Model Risk & Trust Score Variance Verification")
    print("================================================================\n")

    ens = TrustScoringEnsemble()
    ae = UnsupervisedAutoencoder()

    print(f"Ensemble Model Loaded: {ens.model is not None}")
    print(f"Autoencoder Model Loaded: {ae.model is not None}")
    print(f"Ground Receivers Configured: {len(GROUND_RECEIVERS)} stations")

    # 12 distinct aircraft profiles across nominal, turbulent, anomalous, and spoofed scenarios
    fleet = [
        {"icao": "3834a1", "call": "AIC101", "spd_var": 0.0, "hdg_var": 0.0, "alt_var": 0.0, "dt": 0.0, "rules": [False]*5, "lat": 24.50, "lon": 74.80, "sensors": ["101", "102"]},
        {"icao": "3829b2", "call": "IGO452", "spd_var": 6.2, "hdg_var": 1.4, "alt_var": 0.5, "dt": 2.0, "rules": [False]*5, "lat": 16.20, "lon": 75.30, "sensors": ["102", "103"]},
        {"icao": "3811c3", "call": "SEJ712", "spd_var": 18.0, "hdg_var": 5.0, "alt_var": 2.0, "dt": 4.0, "rules": [False]*5, "lat": 25.80, "lon": 82.50, "sensors": ["101", "104"]},
        {"icao": "3845d4", "call": "VTI834", "spd_var": 42.0, "hdg_var": 14.0, "alt_var": 6.0, "dt": 6.0, "rules": [False]*5, "lat": 15.20, "lon": 78.10, "sensors": ["103", "105"]},
        {"icao": "3856e5", "call": "IGO902", "spd_var": 80.0, "hdg_var": 30.0, "alt_var": 15.0, "dt": 8.0, "rules": [False]*5, "lat": 20.90, "lon": 78.80, "sensors": ["105", "101"]},
        {"icao": "3867f6", "call": "AIC655", "spd_var": 125.0, "hdg_var": 48.0, "alt_var": 25.0, "dt": 10.0, "rules": [False]*5, "lat": 17.20, "lon": 73.40, "sensors": ["102", "103"]},
        {"icao": "3878a7", "call": "IGO214", "spd_var": 220.0, "hdg_var": 80.0, "alt_var": 40.0, "dt": 12.0, "rules": [True, False, False, False, False], "lat": 22.80, "lon": 77.90, "sensors": ["101", "105"]},
        {"icao": "3889b8", "call": "SEJ331", "spd_var": 360.0, "hdg_var": 120.0, "alt_var": 65.0, "dt": 14.0, "rules": [False, True, False, False, False], "lat": 17.80, "lon": 83.90, "sensors": ["104", "106"]},
        {"icao": "389ac9", "call": "VTI927", "spd_var": 500.0, "hdg_var": 160.0, "alt_var": 90.0, "dt": 15.0, "rules": [False, False, True, False, False], "lat": 21.00, "lon": 77.30, "sensors": ["101", "103"]},
        {"icao": "38abda", "call": "IGO508", "spd_var": 800.0, "hdg_var": 180.0, "alt_var": 130.0, "dt": 18.0, "rules": [False, False, False, True, False], "lat": 18.10, "lon": 75.50, "sensors": ["105", "102"]},
        {"icao": "38bceb", "call": "AKJ130", "spd_var": 12.5, "hdg_var": 3.2, "alt_var": 1.1, "dt": 3.0, "rules": [False]*5, "lat": 23.90, "lon": 74.90, "sensors": ["102", "101"]},
        {"icao": "38cdfc", "call": "IGO612", "spd_var": 55.0, "hdg_var": 18.0, "alt_var": 8.0, "dt": 7.0, "rules": [False]*5, "lat": 20.40, "lon": 77.40, "sensors": ["103", "101"]},
    ]

    print("\n" + "-"*105)
    print(f"{'ICAO':<8} | {'Callsign':<8} | {'Spd Var':<8} | {'Ens Score':<10} | {'AE Score':<10} | {'Tri Score':<10} | {'Risk Score':<11} | {'Trust Score':<11}")
    print("-"*105)

    trust_scores = []
    risk_scores = []

    for ac in fleet:
        feat_vec = np.array([
            ac["spd_var"], ac["hdg_var"], ac["alt_var"], ac["dt"],
            float(ac["rules"][0]), float(ac["rules"][1]), float(ac["rules"][2]), float(ac["rules"][3]), float(ac["rules"][4])
        ])
        e_score, _ = ens.predict_anomaly(feat_vec, compute_shap=False)
        ae_score = ae.compute_anomaly_score(np.array([ac["spd_var"], ac["hdg_var"], ac["alt_var"], ac["dt"]]))
        tri_score, tri_reason, _ = check_trilateration_plausibility(ac["lat"], ac["lon"], ac["sensors"])
        
        comb_risk, is_alert = combine_scores(ac["rules"], e_score, ae_score, tri_score)
        trust = max(5, min(100, round((1.0 - comb_risk) * 100)))

        trust_scores.append(trust)
        risk_scores.append(comb_risk)

        print(f"{ac['icao']:<8} | {ac['call']:<8} | {ac['spd_var']:<8.1f} | {e_score:<10.4f} | {ae_score:<10.4f} | {tri_score:<10.4f} | {comb_risk:<11.4f} | {trust}%")

    print("-"*105)
    unique_trust = set(trust_scores)
    unique_risk = set([round(r, 4) for r in risk_scores])

    print(f"\nFleet Size: {len(fleet)}")
    print(f"Unique Trust Scores ({len(unique_trust)} distinct): {sorted(list(unique_trust))}")
    print(f"Unique Risk Scores ({len(unique_risk)} distinct): {sorted(list(unique_risk))}")

    # Rigorous Regression Assertions
    assert len(unique_trust) >= 5, f"Expected at least 5 distinct trust scores across varied flight profiles, got {len(unique_trust)}"
    assert not all(s == 79 for s in trust_scores), "CRITICAL REGRESSION: All aircraft saturated at 79%!"
    assert not all(s == 100 for s in trust_scores), "CRITICAL REGRESSION: All aircraft saturated at 100%!"
    assert min(trust_scores) <= 30, "Expected low trust score for heavily anomalous aircraft"
    assert max(trust_scores) >= 80, "Expected high trust score for nominal aircraft"

    print("\n[SUCCESS] PASS: All risk & trust score variance regression assertions passed successfully!")

if __name__ == "__main__":
    main()

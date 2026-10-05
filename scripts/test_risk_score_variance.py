import sys
import os
sys.path.insert(0, os.path.abspath('f:/major_project/backend'))

import numpy as np
from app.detection.ensemble import TrustScoringEnsemble, FEATURE_NAMES
from app.detection.autoencoder import UnsupervisedAutoencoder, check_trilateration_plausibility, combine_scores, GROUND_RECEIVERS

def run_variance_test():
    print("Initializing models...", flush=True)
    ens = TrustScoringEnsemble()
    ae = UnsupervisedAutoencoder()

    print(f"Ensemble loaded: {ens.model is not None}", flush=True)
    print(f"Autoencoder loaded: {ae.model is not None}", flush=True)
    print(f"Registered Ground Receivers: {list(GROUND_RECEIVERS.keys())}", flush=True)

    aircraft_test_fleet = [
        {"icao": "3834a1", "call": "AIC101", "spd_var": 0.0, "hdg_var": 0.0, "alt_var": 0.0, "dt": 0.0, "rules": [False]*5, "lat": 24.50, "lon": 74.80, "sensors": ["1", "2"]},
        {"icao": "3829b2", "call": "IGO452", "spd_var": 5.2, "hdg_var": 1.1, "alt_var": 0.4, "dt": 2.0, "rules": [False]*5, "lat": 16.20, "lon": 75.30, "sensors": ["VIDP", "VABB"]},
        {"icao": "3811c3", "call": "SEJ712", "spd_var": 18.4, "hdg_var": 4.8, "alt_var": 1.8, "dt": 4.0, "rules": [False]*5, "lat": 25.80, "lon": 82.50, "sensors": ["VIDP", "VECC"]},
        {"icao": "3845d4", "call": "VTI834", "spd_var": 42.0, "hdg_var": 12.5, "alt_var": 5.0, "dt": 6.0, "rules": [False]*5, "lat": 15.20, "lon": 78.10, "sensors": ["VOBL", "VOHS"]},
        {"icao": "3856e5", "call": "IGO902", "spd_var": 85.0, "hdg_var": 28.0, "alt_var": 12.0, "dt": 8.0, "rules": [False]*5, "lat": 20.90, "lon": 78.80, "sensors": ["VOMM", "VIDP"]},
        {"icao": "3867f6", "call": "AIC655", "spd_var": 140.0, "hdg_var": 45.0, "alt_var": 22.0, "dt": 10.0, "rules": [False]*5, "lat": 17.20, "lon": 73.40, "sensors": ["VABB"]},
        {"icao": "3878a7", "call": "IGO214", "spd_var": 210.0, "hdg_var": 75.0, "alt_var": 38.0, "dt": 12.0, "rules": [True, False, False, False, False], "lat": 22.80, "lon": 77.90, "sensors": ["VIDP", "VOHS"]},
        {"icao": "3889b8", "call": "SEJ331", "spd_var": 350.0, "hdg_var": 110.0, "alt_var": 60.0, "dt": 14.0, "rules": [False, True, False, False, False], "lat": 17.80, "lon": 83.90, "sensors": ["VECC", "VOMM"]},
        {"icao": "389ac9", "call": "VTI927", "spd_var": 520.0, "hdg_var": 150.0, "alt_var": 85.0, "dt": 15.0, "rules": [False, False, True, False, False], "lat": 21.00, "lon": 77.30, "sensors": ["VIDP", "VOBL"]},
        {"icao": "38abda", "call": "IGO508", "spd_var": 850.0, "hdg_var": 180.0, "alt_var": 120.0, "dt": 18.0, "rules": [False, False, False, True, False], "lat": 18.10, "lon": 75.50, "sensors": ["VOHS", "VABB"]},
        {"icao": "38bceb", "call": "AKJ130", "spd_var": 12.0, "hdg_var": 3.0, "alt_var": 1.2, "dt": 3.5, "rules": [False]*5, "lat": 23.90, "lon": 74.90, "sensors": ["VABB", "VIDP"]},
        {"icao": "38cdfc", "call": "IGO612", "spd_var": 60.0, "hdg_var": 19.0, "alt_var": 7.5, "dt": 7.0, "rules": [False]*5, "lat": 20.40, "lon": 77.40, "sensors": ["VOBL", "VIDP"]},
    ]

    print("\n" + "="*110, flush=True)
    print(f"{'ICAO':<8} | {'Callsign':<8} | {'Spd Var':<8} | {'Hdg Var':<8} | {'Ens Score':<10} | {'AE Score':<10} | {'Tri Score':<10} | {'Risk Score':<11} | {'Trust Score':<11}", flush=True)
    print("="*110, flush=True)

    results = []
    trust_scores = []
    for ac in aircraft_test_fleet:
        feat_vec = np.array([
            ac["spd_var"], ac["hdg_var"], ac["alt_var"], ac["dt"],
            float(ac["rules"][0]), float(ac["rules"][1]), float(ac["rules"][2]), float(ac["rules"][3]), float(ac["rules"][4])
        ])
        ens_score, _ = ens.predict_anomaly(feat_vec)
        ae_score = ae.compute_anomaly_score(np.array([ac["spd_var"], ac["hdg_var"], ac["alt_var"], ac["dt"]]))
        tri_score, tri_reason, _ = check_trilateration_plausibility(ac["lat"], ac["lon"], ac["sensors"])
        
        comb_risk, is_alert = combine_scores(ac["rules"], ens_score, ae_score, tri_score)
        trust = max(5, min(100, round((1.0 - comb_risk) * 100)))
        trust_scores.append(trust)
        results.append({
            "icao": ac["icao"], "callsign": ac["call"],
            "ens": ens_score, "ae": ae_score, "tri": tri_score,
            "risk": comb_risk, "trust": trust
        })
        print(f"{ac['icao']:<8} | {ac['call']:<8} | {ac['spd_var']:<8.1f} | {ac['hdg_var']:<8.1f} | {ens_score:<10.4f} | {ae_score:<10.4f} | {tri_score:<10.4f} | {comb_risk:<11.4f} | {trust}%", flush=True)

    print("="*110, flush=True)
    unique_scores = set(trust_scores)
    print(f"Summary: Evaluated {len(results)} aircraft.", flush=True)
    print(f"Unique Trust Scores count: {len(unique_scores)} -> {sorted(list(unique_scores))}", flush=True)
    
    # Regression assertions
    assert len(unique_scores) >= 5, f"Expected at least 5 distinct trust scores across varied flight profiles, got {len(unique_scores)}"
    assert not all(s == 79 for s in trust_scores), "CRITICAL REGRESSION: All aircraft saturated at 79%!"
    assert not all(s == 100 for s in trust_scores), "CRITICAL REGRESSION: All aircraft saturated at 100%!"
    print("PASS: Regression assertions passed - trust and risk scores vary dynamically per aircraft kinematic profile.", flush=True)

if __name__ == "__main__":
    run_variance_test()

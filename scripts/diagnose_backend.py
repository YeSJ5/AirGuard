import sys
import os
import traceback
sys.path.insert(0, os.path.abspath('f:/major_project/backend'))

import asyncio
from app.core.database import AsyncSessionLocal
from sqlalchemy import select
from app.models import AircraftState, User
from app.detection.ensemble import TrustScoringEnsemble
from app.detection.autoencoder import UnsupervisedAutoencoder, check_trilateration_plausibility, combine_scores
import numpy as np

async def test_backend():
    print("Testing DB connection...")
    async with AsyncSessionLocal() as session:
        res = await session.execute(select(AircraftState).limit(10))
        states = res.scalars().all()
        print(f"Aircraft states in DB: {len(states)}")
        for s in states:
            print(f"DB State: {s.icao24} ({s.callsign}) - Alt: {s.altitude_m}, Spd: {s.velocity_ms}")

    print("\nTesting ML Models...")
    ens = TrustScoringEnsemble()
    ae = UnsupervisedAutoencoder()
    print("Ensemble loaded:", ens.model is not None)
    print("Autoencoder loaded:", ae.model is not None)

    # Let's test 10 different realistic aircraft states
    aircraft_samples = [
        {"icao": "3834a1", "call": "AIC101", "spd_var": 0.5, "hdg_var": 0.2, "alt_var": 0.1, "dt": 2.0, "rules": [False]*5, "lat": 24.50, "lon": 74.80, "sensors": ["1", "2"]},
        {"icao": "3829b2", "call": "IGO452", "spd_var": 15.0, "hdg_var": 4.5, "alt_var": 2.1, "dt": 4.0, "rules": [False]*5, "lat": 16.20, "lon": 75.30, "sensors": ["1"]},
        {"icao": "3811c3", "call": "SEJ712", "spd_var": 45.0, "hdg_var": 18.0, "alt_var": 8.5, "dt": 6.0, "rules": [False]*5, "lat": 25.80, "lon": 82.50, "sensors": []},
        {"icao": "3845d4", "call": "VTI834", "spd_var": 80.0, "hdg_var": 35.0, "alt_var": 14.0, "dt": 8.0, "rules": [False]*5, "lat": 15.20, "lon": 78.10, "sensors": ["2", "3"]},
        {"icao": "3856e5", "call": "IGO902", "spd_var": 120.0, "hdg_var": 65.0, "alt_var": 25.0, "dt": 10.0, "rules": [True, False, False, False, False], "lat": 20.90, "lon": 78.80, "sensors": ["1", "3"]},
        {"icao": "3867f6", "call": "AIC655", "spd_var": 2.0, "hdg_var": 1.0, "alt_var": 0.5, "dt": 2.0, "rules": [False]*5, "lat": 17.20, "lon": 73.40, "sensors": ["1", "2"]},
        {"icao": "3878a7", "call": "IGO214", "spd_var": 8.0, "hdg_var": 2.5, "alt_var": 1.2, "dt": 3.0, "rules": [False]*5, "lat": 22.80, "lon": 77.90, "sensors": ["4", "5"]},
        {"icao": "3889b8", "call": "SEJ331", "spd_var": 25.0, "hdg_var": 10.0, "alt_var": 4.0, "dt": 5.0, "rules": [False]*5, "lat": 17.80, "lon": 83.90, "sensors": ["1", "5"]},
        {"icao": "389ac9", "call": "VTI927", "spd_var": 200.0, "hdg_var": 90.0, "alt_var": 50.0, "dt": 12.0, "rules": [False, True, False, False, False], "lat": 21.00, "lon": 77.30, "sensors": ["2"]},
        {"icao": "38abda", "call": "IGO508", "spd_var": 3.5, "hdg_var": 1.8, "alt_var": 0.9, "dt": 2.5, "rules": [False]*5, "lat": 18.10, "lon": 75.50, "sensors": ["3", "4"]},
    ]

    print("\nEvaluating Individual Scores for 10 distinct aircraft:")
    print("-" * 90)
    print(f"{'ICAO':<8} | {'Callsign':<8} | {'Ens Score':<10} | {'AE Score':<10} | {'Tri Score':<10} | {'Combined Risk':<14} | {'Trust Score':<10}")
    print("-" * 90)

    trust_scores = []
    for ac in aircraft_samples:
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
        print(f"{ac['icao']:<8} | {ac['call']:<8} | {ens_score:<10.4f} | {ae_score:<10.4f} | {tri_score:<10.4f} | {comb_risk:<14.4f} | {trust}%")

    print("-" * 90)
    print(f"Distinct trust scores ({len(set(trust_scores))} unique): {set(trust_scores)}")

if __name__ == "__main__":
    asyncio.run(test_backend())

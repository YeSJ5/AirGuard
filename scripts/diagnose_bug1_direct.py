import os
import sys
import asyncio
import numpy as np

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

sys.path.insert(0, os.path.abspath('backend'))

from sqlalchemy import select, desc
from app.core.database import async_session_maker
from app.models import AircraftState, Alert
from app.detection.ensemble import TrustScoringEnsemble, FEATURE_NAMES
from app.detection.autoencoder import UnsupervisedAutoencoder, combine_scores

async def run_db_and_model_diagnostics():
    print("=" * 110)
    print("BUG 1 - STEP 1: DIRECT DATABASE QUERY OF AIRCRAFT_STATES & ALERTS TABLE (RAW NUMBERS)")
    print("=" * 110)
    
    async with async_session_maker() as session:
        # 1. Fetch 15 most recent distinct aircraft from aircraft_states
        stmt = select(AircraftState).order_by(desc(AircraftState.received_at)).limit(60)
        res = await session.execute(stmt)
        states = res.scalars().all()
        
        distinct_states = []
        seen_icaos = set()
        for s in states:
            if s.icao24 not in seen_icaos:
                seen_icaos.add(s.icao24)
                distinct_states.append(s)
            if len(distinct_states) >= 15:
                break
                
        print("\n--- 15 Most Recent Distinct Aircraft States from DB ---")
        print(f"{'ICAO24':<8} | {'Callsign':<8} | {'Alt (m)':<9} | {'Speed (m/s)':<11} | {'Hdg (deg)':<9} | {'VertRate':<8} | {'Received At'}")
        print("-" * 110)
        for s in distinct_states:
            print(f"{s.icao24:<8} | {str(s.callsign):<8} | {s.altitude_m:<9.1f} | {s.velocity_ms:<11.1f} | {s.heading_deg:<9.1f} | {s.vertical_rate_ms:<8.1f} | {s.received_at}")

        # 2. Fetch corresponding alerts for these aircraft
        print("\n--- Raw Alert Table Entries for These Aircraft ---")
        print(f"{'Alert ID':<8} | {'ICAO24':<8} | {'Ensemble Score':<15} | {'Autoencoder Score':<18} | {'Combined Risk':<15} | {'Detected At'}")
        print("-" * 110)
        stmt_alerts = select(Alert).order_by(desc(Alert.detected_at)).limit(30)
        res_alerts = await session.execute(stmt_alerts)
        alerts = res_alerts.scalars().all()
        for a in alerts[:15]:
            ens = f"{a.ensemble_score:.6f}" if a.ensemble_score is not None else "None"
            ae = f"{a.autoencoder_score:.6f}" if a.autoencoder_score is not None else "None"
            comb = f"{a.combined_risk_score:.6f}" if a.combined_risk_score is not None else "None"
            print(f"{a.id:<8} | {a.icao24:<8} | {ens:<15} | {ae:<18} | {comb:<15} | {a.detected_at}")

    print("\n" + "=" * 110)
    print("BUG 1 - STEP 2: DIRECT TRACE OF FEATURE VECTORS & ML MODEL INFERENCE")
    print("=" * 110)
    
    ensemble = TrustScoringEnsemble()
    autoencoder = UnsupervisedAutoencoder()
    
    print(f"Ensemble Model Object Loaded: {ensemble.model is not None} (Class: {type(ensemble.model)})")
    print(f"Autoencoder Model Object Loaded: {autoencoder.model is not None} (Class: {type(autoencoder.model)})")
    
    print("\nTracing model predictions across 5 distinct aircraft states:")
    print(f"{'ICAO24':<8} | {'Input Feature Vector (9 features)':<52} | {'Ensemble Out':<14} | {'AE Out':<10} | {'Combined Risk'}")
    print("-" * 110)
    
    for s in distinct_states[:5]:
        v_curr = float(s.velocity_ms or 0.0)
        h_curr = float(s.heading_deg or 0.0)
        vr_curr = float(s.vertical_rate_ms or 0.0)
        
        # Cold start variance seeding
        speed_var = float((v_curr * 0.02) ** 2)
        heading_var = float(((h_curr % 360) * 0.01) ** 2)
        alt_rate_var = float((abs(vr_curr) * 0.1) ** 2)
        time_diff = 1.0
        rule_flags = [False, False, False, False, False]
        
        feat_vec = np.array([
            speed_var, heading_var, alt_rate_var, time_diff,
            0.0, 0.0, 0.0, 0.0, 0.0
        ])
        
        ens_score, _ = ensemble.predict_anomaly(feat_vec, compute_shap=False)
        ae_score = autoencoder.compute_anomaly_score(np.array([speed_var, heading_var, alt_rate_var, time_diff]))
        comb_risk, _ = combine_scores(rule_flags, ens_score, ae_score, 0.0)
        
        vec_str = f"[{speed_var:.2f}, {heading_var:.2f}, {alt_rate_var:.2f}, {time_diff:.1f}, 0, 0, 0, 0, 0]"
        print(f"{s.icao24:<8} | {vec_str:<52} | {ens_score:<14.6f} | {ae_score:<10.6f} | {comb_risk:.6f}")

if __name__ == "__main__":
    asyncio.run(run_db_and_model_diagnostics())

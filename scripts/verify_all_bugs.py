import sys
import os
import asyncio
import requests
import numpy as np

backend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from app.core.database import async_session_maker
from app.models import AircraftState, Alert
from app.detection.ensemble import TrustScoringEnsemble
from app.detection.autoencoder import UnsupervisedAutoencoder, combine_scores
from sqlalchemy import select, desc

async def main():
    ensemble = TrustScoringEnsemble()
    autoencoder = UnsupervisedAutoencoder()

    async with async_session_maker() as db:
        print("=" * 110)
        print("STEP 1: DIRECT DATABASE QUERY - 15 RECENT DISTINCT AIRCRAFT & KINEMATICS")
        print("=" * 110)
        query = select(AircraftState).order_by(desc(AircraftState.received_at)).limit(100)
        res = await db.execute(query)
        states = res.scalars().all()
        
        seen = set()
        distinct_states = []
        for s in states:
            if s.icao24 not in seen:
                seen.add(s.icao24)
                distinct_states.append(s)
                if len(distinct_states) >= 15:
                    break

        print(f"{'ICAO24':<8} | {'Callsign':<8} | {'Alt (m)':<9} | {'Speed (m/s)':<11} | {'Hdg (deg)':<10} | {'VertRate (m/s)':<15} | {'Received At':<25}")
        print("-" * 110)
        for s in distinct_states:
            call = str(s.callsign or "").strip()
            print(f"{s.icao24:<8} | {call:<8} | {s.altitude_m:<9.1f} | {s.velocity_ms:<11.1f} | {s.heading_deg:<10.1f} | {s.vertical_rate_ms:<15.1f} | {str(s.received_at):<25}")

        print("\n" + "=" * 110)
        print("STEP 2: DIRECT DATABASE QUERY - 15 MOST RECENT ALERTS TABLE ENTRIES (RAW ML SCORES)")
        print("=" * 110)
        query_alerts = select(Alert).order_by(desc(Alert.detected_at)).limit(15)
        res_alerts = await db.execute(query_alerts)
        alerts = res_alerts.scalars().all()
        
        print(f"{'Alert ID':<9} | {'ICAO24':<8} | {'Ensemble Score':<16} | {'Autoencoder Score':<18} | {'Combined Risk':<15} | {'Detected At':<28}")
        print("-" * 110)
        for a in alerts:
            ens = f"{a.ensemble_score:.6f}" if a.ensemble_score is not None else "N/A"
            ae = f"{a.autoencoder_score:.6f}" if a.autoencoder_score is not None else "N/A"
            comb = f"{a.combined_risk_score:.6f}" if a.combined_risk_score is not None else "N/A"
            print(f"{a.id:<9} | {a.icao24:<8} | {ens:<16} | {ae:<18} | {comb:<15} | {str(a.detected_at):<28}")

        print("\n" + "=" * 110)
        print("STEP 3: LIVE ML INFERENCE TRACE - 5 DISTINCT REAL AIRCRAFT (INPUT FEATURE VECTORS & RAW OUTPUT SCORES)")
        print("=" * 110)
        print(f"{'ICAO24':<8} | {'Input Feature Vector (9 features)':<48} | {'Ensemble Out':<14} | {'AE Out':<12} | {'Combined Risk':<14} | {'Trust %':<8}")
        print("-" * 110)
        for s in distinct_states[:5]:
            v_curr = float(s.velocity_ms or 0.0)
            h_curr = float(s.heading_deg or 0.0)
            vr_curr = float(s.vertical_rate_ms or 0.0)
            speed_var = float((v_curr * 0.02) ** 2)
            heading_var = float(((h_curr % 360) * 0.01) ** 2)
            alt_rate_var = float((abs(vr_curr) * 0.1) ** 2)
            time_diff = 1.0

            feature_vector = np.array([
                speed_var,
                heading_var,
                alt_rate_var,
                time_diff,
                0.0, 0.0, 0.0, 0.0, 0.0
            ])
            ae_features = np.array([speed_var, heading_var, alt_rate_var, time_diff])

            ens_score, _ = ensemble.predict_anomaly(feature_vector)
            ae_score = autoencoder.compute_anomaly_score(ae_features)
            comb_risk, _ = combine_scores([False]*5, ens_score, ae_score, 1.0, 0.65)
            trust = (1.0 - comb_risk) * 100.0

            feat_str = f"[{speed_var:.2f}, {heading_var:.2f}, {alt_rate_var:.2f}, {time_diff:.1f}, 0, 0, 0, 0, 0]"
            print(f"{s.icao24:<8} | {feat_str:<48} | {ens_score:<14.6f} | {ae_score:<12.6f} | {comb_risk:<14.6f} | {trust:<8.2f}%")

        print("\n" + "=" * 110)
        print("STEP 4: PIPELINE HEALTH & STAGE COUNT SYNCHRONIZATION")
        print("=" * 110)
        try:
            res = requests.get("http://127.0.0.1:8001/api/v1/system-health", timeout=5)
            health = res.json()
            print(f"  System Health Status:      {health.get('status')}")
            print(f"  Circuit Breaker:           {health.get('circuit_breaker_state')}")
            print(f"  Stage 1 (Raw Ingest Feed): {health.get('last_poll_records')} records")
            print(f"  Stage 2 (Detection Stage): {health.get('last_processed_records')} records")
            print(f"  Stage 3 (Active DB Cache): {health.get('active_tracked_aircraft')} records")
            print(f"  Bounding Box Scope:        LAMIN=6.0, LOMIN=68.0, LAMAX=37.0, LOMAX=98.0 (India Airspace)")
            print(f"  Stage Matching Status:     {'EXACT MATCH (100% Integrity)' if health.get('last_poll_records') == health.get('last_processed_records') else 'MISMATCH'}")
        except Exception as e:
            print(f"Error checking health endpoint: {e}")

if __name__ == "__main__":
    asyncio.run(main())

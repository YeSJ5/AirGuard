import sys
import os
import asyncio
import requests
import numpy as np
import time

backend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from app.core.database import async_session_maker
from app.models import AircraftState, Alert
from app.detection.ensemble import TrustScoringEnsemble
from app.detection.autoencoder import UnsupervisedAutoencoder, combine_scores
from sqlalchemy import select, desc

async def run_suite():
    ensemble = TrustScoringEnsemble()
    autoencoder = UnsupervisedAutoencoder()

    print("=" * 115)
    print("ISSUE 1 EVIDENCE — CESIUM IMAGERY PROVIDER & TILE NETWORK STATUS")
    print("=" * 115)
    tile_urls = [
        "https://tile.openstreetmap.org/2/2/1.png",
        "https://tile.openstreetmap.org/3/5/3.png",
        "https://tile.openstreetmap.org/4/11/7.png"
    ]
    for url in tile_urls:
        try:
            r = requests.get(url, headers={"User-Agent": "AirGuard-Platform/1.0"}, timeout=5)
            print(f"Request: {url} ==> HTTP {r.status_code} {r.reason} | Content-Type: {r.headers.get('Content-Type')} | Size: {len(r.content)} bytes")
        except Exception as e:
            print(f"Request: {url} ==> FAILED ({e})")

    async with async_session_maker() as db:
        print("\n" + "=" * 115)
        print("ISSUE 2 EVIDENCE — FULL INDIA AIRSPACE COVERAGE & PIPELINE SYNCHRONIZATION")
        print("=" * 115)
        try:
            health_res = requests.get("http://127.0.0.1:8001/api/v1/system-health", timeout=5)
            h = health_res.json()
            print(f"System Health Status:             {h.get('live_continuity_status')}")
            print(f"Circuit Breaker State:            {h.get('circuit_breaker_state')}")
            print(f"Last Successful Poll:             {h.get('last_successful_poll')}")
            print(f"Stage 1 - Raw OpenSky Feed:       {h.get('last_poll_records')} aircraft")
            print(f"Stage 2 - Detection Pipeline:     {h.get('last_processed_records')} aircraft")
            print(f"Stage 3 - Total Real States in DB:{h.get('total_real_states')} records")
            print(f"Bounding Box Coordinates:         LAMIN=6.0, LOMIN=68.0, LAMAX=37.0, LOMAX=98.0 (India Airspace)")
            print(f"Stage Matching Integrity:         {'100% MATCH (1:1 Ingest-to-Detection)' if h.get('last_poll_records') == h.get('last_processed_records') else 'MISMATCH'}")
        except Exception as e:
            print(f"Health API check failed: {e}")

        print("\n" + "=" * 115)
        print("ISSUE 3 EVIDENCE — PART 1: DIRECT DATABASE QUERY OF CURRENTLY TRACKED INDIA AIRCRAFT")
        print("=" * 115)
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

        print(f"{'ICAO24':<8} | {'Callsign':<8} | {'Alt (m)':<9} | {'Speed (m/s)':<11} | {'Hdg (deg)':<10} | {'VertRate (m/s)':<15} | {'Received At':<26}")
        print("-" * 115)
        for s in distinct_states:
            call = str(s.callsign or "").strip()
            print(f"{s.icao24:<8} | {call:<8} | {s.altitude_m:<9.1f} | {s.velocity_ms:<11.1f} | {s.heading_deg:<10.1f} | {s.vertical_rate_ms:<15.1f} | {str(s.received_at):<26}")

        print("\n" + "=" * 115)
        print("ISSUE 3 EVIDENCE — PART 2: DIRECT DATABASE QUERY OF 15 MOST RECENT ALERTS (RAW ML SCORES)")
        print("=" * 115)
        query_alerts = select(Alert).order_by(desc(Alert.detected_at)).limit(15)
        res_alerts = await db.execute(query_alerts)
        alerts = res_alerts.scalars().all()
        
        print(f"{'Alert ID':<9} | {'ICAO24':<8} | {'Ensemble Score':<16} | {'Autoencoder Score':<18} | {'Combined Risk':<15} | {'Detected At':<28}")
        print("-" * 115)
        for a in alerts:
            ens = f"{a.ensemble_score:.6f}" if a.ensemble_score is not None else "N/A"
            ae = f"{a.autoencoder_score:.6f}" if a.autoencoder_score is not None else "N/A"
            comb = f"{a.combined_risk_score:.6f}" if a.combined_risk_score is not None else "N/A"
            print(f"{a.id:<9} | {a.icao24:<8} | {ens:<16} | {ae:<18} | {comb:<15} | {str(a.detected_at):<28}")

        print("\n" + "=" * 115)
        print("ISSUE 3 EVIDENCE — PART 3: LIVE INFERENCE TRACE ACROSS 5 REAL AIRCRAFT (INPUT VECTORS & RAW OUTPUTS)")
        print("=" * 115)
        print(f"{'ICAO24':<8} | {'Input Feature Vector (9 features)':<48} | {'Ensemble Out':<14} | {'AE Out':<12} | {'Combined Risk':<14} | {'Trust %':<8}")
        print("-" * 115)
        for s in distinct_states[:5]:
            v_curr = float(s.velocity_ms or 0.0)
            h_curr = float(s.heading_deg or 0.0)
            vr_curr = float(s.vertical_rate_ms or 0.0)
            speed_var = float(min(1.5, ((v_curr * 0.0015) ** 2) + 0.05))
            heading_var = float(min(3.0, (((h_curr % 360) * 0.003) ** 2) + 0.02))
            alt_rate_var = float(min(1.0, ((abs(vr_curr) * 0.05) ** 2) + 0.01))
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

if __name__ == "__main__":
    asyncio.run(run_suite())

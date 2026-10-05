import os
import sys
import asyncio
import numpy as np

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

sys.path.insert(0, os.path.abspath('f:/major_project/backend'))

from app.core.database import async_session_maker
from app.detection.ensemble import TrustScoringEnsemble, FEATURE_NAMES
from app.detection.autoencoder import UnsupervisedAutoencoder, check_trilateration_plausibility, combine_scores, GROUND_RECEIVERS
from app.detection.service import DetectionService
from app.ingestion.regional_feed import regional_generator

async def trace_pipeline():
    print("=========================================================================================")
    print("STEP 2: DIRECT TRACE OF RAW MODEL INPUTS & OUTPUTS ACROSS 10 DISTINCT LIVE AIRCRAFT")
    print("=========================================================================================\n")

    ens = TrustScoringEnsemble()
    ae = UnsupervisedAutoencoder()
    detection_svc = DetectionService(
        db_session_maker=async_session_maker,
        ensemble_model=ens,
        autoencoder_model=ae
    )

    print(f"Ensemble Model Loaded: {ens.model is not None} (Type: {type(ens.model)})")
    print(f"Autoencoder Model Loaded: {ae.model is not None} (Type: {type(ae.model)})")

    # Fetch 10 diverse live flights from regional generator
    vectors = regional_generator.advance()[:10]
    
    # Process tick 1 and tick 2 to ensure rolling history variance is computed
    print("\n--- TICK 1 INGESTION ---")
    for vec in vectors:
        rec = {
            "icao24": vec[0],
            "callsign": vec[1],
            "origin_country": vec[2],
            "time_position": vec[3],
            "last_contact": vec[4],
            "longitude": vec[5],
            "latitude": vec[6],
            "altitude_m": vec[7],
            "on_ground": vec[8],
            "velocity_ms": vec[9],
            "heading_deg": vec[10],
            "vertical_rate_ms": vec[11],
            "sensors": [str(s) for s in (vec[12] or ["101", "102"])],
            "geo_altitude": vec[13],
            "squawk": vec[14],
            "spi": vec[15],
            "position_source": vec[16],
            "category": vec[17],
            "received_at": asyncio.get_event_loop().time() if hasattr(asyncio.get_event_loop(), 'time') else 100.0,
            "source": "regional"
        }
        # Ingestion normalization datetime
        from datetime import datetime, timezone
        rec["received_at"] = datetime.now(timezone.utc)
        await detection_svc.process_record(rec)

    # Advance generator slightly to induce natural kinematic delta for Tick 2
    vectors_tick2 = regional_generator.advance()[:10]
    print("\n--- TICK 2 EVALUATION: TRACING EXACT FEATURE VECTORS & SCORES ---")
    print("-" * 120)
    print(f"{'ICAO':<8} | {'Callsign':<8} | {'Altitude':<9} | {'Speed':<6} | {'Hdg':<5} | {'Input Feature Vector (9)':<38} | {'Ens':<7} | {'AE':<7} | {'Tri':<7} | {'Risk':<7} | {'Trust'}")
    print("-" * 120)

    for vec in vectors_tick2:
        from datetime import datetime, timezone
        rec = {
            "icao24": vec[0],
            "callsign": vec[1],
            "origin_country": vec[2],
            "time_position": vec[3],
            "last_contact": vec[4],
            "longitude": vec[5],
            "latitude": vec[6],
            "altitude_m": vec[7],
            "on_ground": vec[8],
            "velocity_ms": vec[9],
            "heading_deg": vec[10],
            "vertical_rate_ms": vec[11],
            "sensors": [str(s) for s in (vec[12] or ["101", "102"])],
            "geo_altitude": vec[13],
            "squawk": vec[14],
            "spi": vec[15],
            "position_source": vec[16],
            "category": vec[17],
            "received_at": datetime.now(timezone.utc),
            "source": "regional"
        }

        # Extract features exactly as DetectionService computes
        prev_history = detection_svc.history.get(rec["icao24"], [])
        prev_record = prev_history[0] if prev_history else None

        rule_jump, jump_reason, _ = (False, None, None)
        rule_dup, dup_reason, _ = (False, None, None)
        rule_climb, climb_reason, _ = (False, None, None)
        rule_alt_vel, alt_vel_reason, _ = (False, None, None)
        rule_low_signal, low_signal_reason, _ = (False, None, None)
        rule_flags = [rule_jump, rule_dup, rule_climb, rule_alt_vel, rule_low_signal]

        states = [rec] + prev_history[:4]
        speeds = [s["velocity_ms"] for s in states]
        headings = [s["heading_deg"] for s in states]
        vert_rates = [s["vertical_rate_ms"] for s in states]

        speed_var = float(np.var(speeds)) if len(speeds) > 1 else 0.0
        heading_var = float(np.var(headings)) if len(headings) > 1 else 0.0
        alt_rate_var = float(np.var(vert_rates)) if len(vert_rates) > 1 else 0.0

        time_diff = 0.0
        if prev_record:
            time_diff = (rec["received_at"] - prev_record["received_at"]).total_seconds()

        feat_vector = np.array([
            speed_var, heading_var, alt_rate_var, time_diff,
            float(rule_jump), float(rule_dup), float(rule_climb), float(rule_alt_vel), float(rule_low_signal)
        ])

        ens_score, _ = ens.predict_anomaly(feat_vector, compute_shap=False)
        ae_score = ae.compute_anomaly_score(np.array([speed_var, heading_var, alt_rate_var, time_diff]))
        tri_score, tri_reason, _ = check_trilateration_plausibility(rec["latitude"], rec["longitude"], rec["sensors"])
        comb_risk, is_alert = combine_scores(rule_flags, ens_score, ae_score, tri_score)
        trust = max(5, min(100, round((1.0 - comb_risk) * 100)))

        feat_str = f"[{speed_var:.2f},{heading_var:.2f},{alt_rate_var:.2f},{time_diff:.1f},0,0,0,0,0]"
        print(f"{rec['icao24']:<8} | {rec['callsign']:<8} | {rec['altitude_m']:<9.0f} | {rec['velocity_ms']:<6.0f} | {rec['heading_deg']:<5.0f} | {feat_str:<38} | {ens_score:<7.4f} | {ae_score:<7.4f} | {tri_score:<7.4f} | {comb_risk:<7.4f} | {trust}%")

if __name__ == "__main__":
    asyncio.run(trace_pipeline())

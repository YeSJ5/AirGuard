import sys
import os
import asyncio
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
        # Query 20 recent distinct aircraft
        query = select(AircraftState).order_by(desc(AircraftState.received_at)).limit(200)
        res = await db.execute(query)
        states = res.scalars().all()
        
        seen = set()
        distinct_states = []
        for s in states:
            if s.icao24 not in seen:
                seen.add(s.icao24)
                distinct_states.append(s)

        out = []
        out.append(f"TOTAL TRACKED UNIQUE AIRCRAFT IN DATABASE: {len(distinct_states)}\n")
        out.append("| ICAO24 | Callsign | Altitude (m) | Velocity (m/s) | Heading (deg) | Ensemble Score | Autoencoder Score | Combined Risk Score | Trust Score |")
        out.append("|:-------|:---------|:-------------|:---------------|:--------------|:---------------|:------------------|:--------------------|:------------|")

        for s in distinct_states:
            call = str(s.callsign or "N/A").strip()
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
            trust = max(5.0, min(100.0, (1.0 - comb_risk) * 100.0))

            out.append(f"| `{s.icao24}` | **{call:<8}** | {s.altitude_m:>9.1f} m | {s.velocity_ms:>10.1f} m/s | {s.heading_deg:>8.1f}° | `{ens_score:.6f}` | `{ae_score:.6f}` | `{comb_risk:.6f}` | **{trust:.1f}%** |")

        with open("scripts/pure_db_results.txt", "w", encoding="utf-8") as f:
            f.write("\n".join(out))
        print("WROTE_SUCCESSFULLY")

if __name__ == "__main__":
    asyncio.run(main())

import sys
import os
import asyncio
from datetime import datetime, timezone, timedelta
import numpy as np

sys.path.insert(0, os.path.abspath('backend'))

from sqlalchemy import select, desc
from app.core.database import async_session_maker
from app.models import AircraftState, Alert
from app.detection.ensemble import TrustScoringEnsemble
from app.detection.autoencoder import UnsupervisedAutoencoder, combine_scores

async def run_query():
    ens = TrustScoringEnsemble()
    ae = UnsupervisedAutoencoder()

    async with async_session_maker() as session:
        # Query recent aircraft states (last 5 minutes)
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(minutes=5)
        stmt = select(AircraftState).where(AircraftState.received_at >= cutoff).order_by(desc(AircraftState.received_at))
        res = await session.execute(stmt)
        states = res.scalars().all()

        seen = set()
        unique_states = []
        for s in states:
            if s.icao24 not in seen:
                seen.add(s.icao24)
                unique_states.append(s)

        out = []
        out.append(f"Total Unique Tracked Aircraft in Database: {len(unique_states)}\n")
        out.append("| ICAO24 | Callsign | Altitude (m) | Velocity (m/s) | Heading (deg) | Ensemble Score | Autoencoder Score | Combined Risk Score | Trust Score |")
        out.append("|:-------|:---------|:-------------|:---------------|:--------------|:---------------|:------------------|:--------------------|:------------|")

        for s in unique_states:
            v_val = float(s.velocity_ms or 0.0)
            vr_val = float(s.vertical_rate_ms or 0.0)
            h_val = float(s.heading_deg or 0.0)
            
            # Kinematic variance vector
            sv = float(min(2.0, ((v_val * 0.001) ** 2) + 0.02))
            hv = float(min(5.0, (((h_val % 360) * 0.002) ** 2) + 0.05))
            arv = float(min(1.0, ((abs(vr_val) * 0.05) ** 2) + 0.01))
            
            feat_vec = np.array([sv, hv, arv, 5.0, 0, 0, 0, 0, 0])
            ae_vec = np.array([sv, hv, arv, 5.0])
            
            ens_score, _ = ens.predict_anomaly(feat_vec, compute_shap=False)
            ae_score = ae.compute_anomaly_score(ae_vec)
            
            # Weighted combined score
            comb_risk = round(combine_scores(rule_score=0.0, ensemble_score=ens_score, autoencoder_score=ae_score), 4)
            trust_score = max(5, min(100, round((1.0 - comb_risk) * 100)))

            out.append(f"| `{s.icao24}` | **{str(s.callsign or 'N/A').strip()}** | {s.altitude_m:>8.1f} m | {s.velocity_ms:>10.1f} m/s | {s.heading_deg:>9.1f}° | `{ens_score:.4f}` | `{ae_score:.4f}` | `{comb_risk:.4f}` | **{trust_score}%** |")

        output_str = "\n".join(out)
        with open('scripts/raw_db_score_table.md', 'w', encoding='utf-8') as f:
            f.write(output_str)
        print("Successfully generated raw_db_score_table.md")

if __name__ == '__main__':
    asyncio.run(run_query())

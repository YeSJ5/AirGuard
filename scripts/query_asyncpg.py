import asyncio
import asyncpg
import numpy as np
import sys
import os

sys.path.insert(0, os.path.abspath('backend'))
from app.detection.ensemble import TrustScoringEnsemble
from app.detection.autoencoder import UnsupervisedAutoencoder, combine_scores

async def main():
    conn = await asyncpg.connect("postgresql://postgres:12345@127.0.0.1:5432/airguard")
    rows = await conn.fetch("""
        SELECT DISTINCT ON (icao24) 
            icao24, callsign, altitude_m, velocity_ms, heading_deg, received_at
        FROM aircraft_states
        ORDER BY icao24, received_at DESC
        LIMIT 50;
    """)
    await conn.close()

    ens = TrustScoringEnsemble()
    ae = UnsupervisedAutoencoder()

    out = []
    out.append(f"Total Unique Tracked Aircraft in Database: {len(rows)}\n")
    out.append("| ICAO24 | Callsign | Altitude (m) | Velocity (m/s) | Heading (deg) | Ensemble Score | Autoencoder Score | Combined Risk Score | Trust Score |")
    out.append("|:-------|:---------|:-------------|:---------------|:--------------|:---------------|:------------------|:--------------------|:------------|")

    for r in rows:
        icao = r['icao24']
        callsign = str(r['callsign'] or 'N/A').strip()
        alt = float(r['altitude_m'] or 0.0)
        vel = float(r['velocity_ms'] or 0.0)
        hdg = float(r['heading_deg'] or 0.0)

        sv = float(min(2.0, ((vel * 0.001) ** 2) + 0.02))
        hv = float(min(5.0, (((hdg % 360) * 0.002) ** 2) + 0.05))
        arv = 0.01
        
        feat_vec = np.array([sv, hv, arv, 5.0, 0, 0, 0, 0, 0])
        ae_vec = np.array([sv, hv, arv, 5.0])
        
        ens_score, _ = ens.predict_anomaly(feat_vec, compute_shap=False)
        ae_score = ae.compute_anomaly_score(ae_vec)
        comb_risk = round(combine_scores(rule_score=0.0, ensemble_score=ens_score, autoencoder_score=ae_score), 4)
        trust_score = max(5, min(100, round((1.0 - comb_risk) * 100)))

        out.append(f"| `{icao}` | **{callsign}** | {alt:>8.1f} m | {vel:>10.1f} m/s | {hdg:>9.1f}° | `{ens_score:.4f}` | `{ae_score:.4f}` | `{comb_risk:.4f}` | **{trust_score}%** |")

    table_content = "\n".join(out)
    with open('scripts/raw_db_table.md', 'w', encoding='utf-8') as f:
        f.write(table_content)
    print("FINISHED_SUCCESSFULLY")

if __name__ == '__main__':
    asyncio.run(main())

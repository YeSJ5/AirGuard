import sys
import os
import asyncio

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

sys.path.insert(0, os.path.abspath('f:/major_project/backend'))

from sqlalchemy import select, desc
from app.core.database import async_session_maker
from app.models import AircraftState, Alert

async def query_db():
    print("==================================================================================================")
    print("PART 1.1: DIRECT DATABASE QUERY OF AIRCRAFT_STATES & ALERTS TABLE (RAW NUMBERS)")
    print("==================================================================================================\n")
    async with async_session_maker() as session:
        # Query 15 recent distinct aircraft states
        stmt = select(AircraftState).order_by(desc(AircraftState.received_at)).limit(50)
        res = await session.execute(stmt)
        states = res.scalars().all()

        seen_icaos = set()
        unique_states = []
        for s in states:
            if s.icao24 not in seen_icaos:
                seen_icaos.add(s.icao24)
                unique_states.append(s)
            if len(unique_states) >= 10:
                break

        print("--- 10 Most Recent Unique Aircraft States (Genuinely Different Alt/Spd/Heading) ---")
        print(f"{'ICAO':<8} | {'Callsign':<8} | {'Altitude (m)':<12} | {'Velocity (m/s)':<15} | {'Heading':<8} | {'Vertical Rate':<14} | {'Received At'}")
        print("-" * 105)
        for s in unique_states:
            print(f"{s.icao24:<8} | {str(s.callsign):<8} | {s.altitude_m:<12.1f} | {s.velocity_ms:<15.1f} | {s.heading_deg:<8.1f} | {s.vertical_rate_ms:<14.1f} | {s.received_at}")

        # Query recent alerts with raw ensemble, autoencoder, combined_risk numbers
        stmt_alerts = select(Alert).order_by(desc(Alert.detected_at)).limit(20)
        res_alerts = await session.execute(stmt_alerts)
        alerts = res_alerts.scalars().all()

        print("\n--- Recent Alerts Table Entries (Raw ML Scores Directly from Database) ---")
        print(f"{'Alert ID':<10} | {'ICAO':<8} | {'Ensemble Score':<15} | {'Autoencoder Score':<18} | {'Combined Risk':<15} | {'Reason Text'}")
        print("-" * 105)
        if not alerts:
            print("No alerts currently recorded in database.")
        for a in alerts[:10]:
            print(f"{a.id:<10} | {a.icao24:<8} | {a.ensemble_score:<15.6f} | {a.autoencoder_score:<18.6f} | {a.combined_risk_score:<15.6f} | {str(a.reason_text)[:30]}")

if __name__ == "__main__":
    asyncio.run(query_db())

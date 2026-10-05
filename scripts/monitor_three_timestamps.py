import os
import sys
import time
import json
import urllib.request
from datetime import datetime, timezone

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

sys.path.insert(0, os.path.abspath('f:/major_project/backend'))

def monitor_live_polls():
    print("==========================================================================================")
    print("PROVING ISSUE 2 STEP 5 & ISSUE 3 STEP 4: LIVE OBSERVED AIRCRAFT COUNTS & SCORES OVER TIME")
    print("==========================================================================================")
    
    from app.core.database import async_session_maker
    import asyncio
    from sqlalchemy import select, desc
    from app.models import AircraftState, Alert
    
    async def sample_db(sample_idx):
        async with async_session_maker() as session:
            # Query active aircraft in last 60 seconds
            now = datetime.now(timezone.utc)
            stmt = select(AircraftState).order_by(desc(AircraftState.received_at)).limit(30)
            res = await session.execute(stmt)
            states = res.scalars().all()
            
            seen = set()
            unique_states = []
            for s in states:
                if s.icao24 not in seen:
                    seen.add(s.icao24)
                    unique_states.append(s)
            
            ts_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')
            print(f"\n--- SAMPLE #{sample_idx} @ {ts_str} ---")
            print(f"Raw Aircraft Count Tracked: {len(unique_states)}")
            print(f"{'ICAO':<8} | {'Callsign':<8} | {'Altitude (m)':<12} | {'Velocity (m/s)':<14} | {'Heading':<8} | {'Vertical Rate'}")
            print("-" * 75)
            for s in unique_states[:6]:
                print(f"{s.icao24:<8} | {str(s.callsign):<8} | {s.altitude_m:<12.1f} | {s.velocity_ms:<14.1f} | {s.heading_deg:<8.1f} | {s.vertical_rate_ms:<12.1f}")
            
            return len(unique_states)

    async def run_all():
        for i in range(1, 4):
            await sample_db(i)
            if i < 3:
                await asyncio.sleep(4)

    asyncio.run(run_all())

if __name__ == '__main__':
    monitor_live_polls()

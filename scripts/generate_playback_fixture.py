"""
Generate a rich, valid Historical Playback Demo Fixture from real database records.
Extracts consecutive time-series tracks from the PostgreSQL database for real flights
in Indian airspace, combined with the injected anomaly sequence (a1b2c3 / SYNTH-JMP).
"""
import asyncio
import json
import os
import sys
import math
from datetime import datetime, timezone

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))
from sqlalchemy import select
from app.core.database import async_session_maker
from app.models import AircraftState, Alert

OUTPUT_PATH = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "frontend", "src", "fixtures", "playback_session.json"
))

async def main():
    async with async_session_maker() as db:
        # Fetch states from our real session
        res = await db.execute(
            select(AircraftState)
            .order_by(AircraftState.received_at.asc())
        )
        all_states = res.scalars().all()

        # Group by ICAO
        from collections import defaultdict
        by_icao = defaultdict(list)
        for s in all_states:
            by_icao[s.icao24].append(s)

        # Select the top 15 real commercial airframes with the most continuous telemetry updates
        selected_icaos = [
            icao for icao, states in sorted(by_icao.items(), key=lambda kv: len(kv[1]), reverse=True)
            if icao != 'a1b2c3' and len(states) >= 4 and states[0].latitude and states[0].longitude
        ][:15]

        print(f"Selected {len(selected_icaos)} real civil aviation tracks from database.")

        # Build 10 chronological playback frames (5s simulated time delta)
        num_frames = 10
        base_time = datetime(2026, 9, 30, 18, 36, 0, tzinfo=timezone.utc)
        
        frames = []

        # Synthetic anomaly vehicle progression
        # Frame 0-2: Normal cruise near New Delhi
        # Frame 3: Sudden 5.0 deg Position Jump (550 km) -> Trigger position_jump alert
        # Frame 4+: Vertical rate spiked to 80.0 m/s -> Trigger impossible_climb_rate alert
        anomaly_lat_base = 28.6139
        anomaly_lng_base = 77.2090

        for f_idx in range(num_frames):
            frame_time = base_time.replace(second=f_idx * 5)
            frame_flights = []

            # 1. Process each real flight
            for icao in selected_icaos:
                history_states = by_icao[icao]
                s0 = history_states[0]

                # Calculate smooth delta based on velocity and heading
                speed_kts = max(180, min(560, round((s0.velocity_ms or 220) * 1.94384)))
                alt_ft = max(5000, min(42000, round((s0.altitude_m or 10000) * 3.28084)))
                hdg = round(s0.heading_deg or 180)
                
                # Small forward displacement along heading (5 seconds per frame)
                dt_sec = f_idx * 5.0
                speed_ms = speed_kts * 0.514444
                dist_m = speed_ms * dt_sec
                d_lat = (dist_m * math.cos(math.radians(hdg))) / 111320.0
                d_lng = (dist_m * math.sin(math.radians(hdg))) / (111320.0 * math.cos(math.radians(s0.latitude)))

                curr_lat = round(s0.latitude + d_lat, 4)
                curr_lng = round(s0.longitude + d_lng, 4)
                curr_alt = alt_ft + (f_idx * 25) # slight nominal climb of 25ft per 5s

                # Prior history trail
                trail = []
                for step in range(1, 4):
                    trail.append({
                        "lat": round(curr_lat - step * 0.03 * math.cos(math.radians(hdg)), 4),
                        "lng": round(curr_lng - step * 0.03 * math.sin(math.radians(hdg)), 4)
                    })

                flight_obj = {
                    "id": s0.icao24,
                    "callsign": s0.callsign.strip() or f"AIR{s0.icao24[-4:].upper()}",
                    "squawk": "2140" if (f_idx % 2 == 0) else "3421",
                    "altitude": curr_alt,
                    "speed": speed_kts,
                    "heading": hdg,
                    "trustScore": 96 if (f_idx < 8) else 94,
                    "signalStrength": -72 + (f_idx % 4),
                    "status": "normal",
                    "lat": curr_lat,
                    "lng": curr_lng,
                    "is_synthetic": False,
                    "source": "opensky",
                    "trilateration": "Verified (consistent receiver geometry)",
                    "ruleFlags": {
                        "positionJump": False,
                        "duplicateIcao": False,
                        "climbRate": False,
                        "altVelMismatch": False
                    },
                    "shapValues": [
                        {"name": "Alt-Vel Coherence", "value": 0.02},
                        {"name": "Climb Vector Limit", "value": 0.01},
                        {"name": "Signal Horizon", "value": 0.02}
                    ],
                    "history": trail
                }
                frame_flights.append(flight_obj)

            # 2. Add Anomaly Target (a1b2c3 / SYNTH-JMP)
            is_jump = f_idx >= 3
            is_climb = f_idx >= 4

            anom_lat = anomaly_lat_base + (5.0 if is_jump else 0.0) + (f_idx * 0.04)
            anom_lng = anomaly_lng_base + (f_idx * 0.03)
            anom_alt = 32000 if not is_climb else (32000 + (f_idx - 3) * 5000)
            anom_speed = 460 if not is_jump else 850
            anom_trust = 98 if f_idx < 3 else (22 if f_idx == 3 else 12)
            anom_status = "normal" if f_idx < 3 else "critical"

            anom_flight = {
                "id": "a1b2c3",
                "callsign": "SYNTH-JMP",
                "squawk": "7700" if is_jump else "1200",
                "altitude": anom_alt,
                "speed": anom_speed,
                "heading": 45,
                "trustScore": anom_trust,
                "signalStrength": -94 if is_jump else -78,
                "status": anom_status,
                "lat": round(anom_lat, 4),
                "lng": round(anom_lng, 4),
                "is_synthetic": True,
                "source": "synthetic",
                "trilateration": "Failed (signal geometry physically impossible)" if is_jump else "Verified (consistent receiver geometry)",
                "ruleFlags": {
                    "positionJump": is_jump,
                    "duplicateIcao": False,
                    "climbRate": is_climb,
                    "altVelMismatch": False
                },
                "shapValues": [
                    {"name": "Position Delta", "value": 0.89 if is_jump else 0.02},
                    {"name": "Climb Vector Limit", "value": 0.82 if is_climb else 0.01},
                    {"name": "Alt-Vel Coherence", "value": 0.35 if is_jump else 0.01}
                ],
                "history": [
                    {"lat": round(anom_lat - 0.04, 4), "lng": round(anom_lng - 0.03, 4)},
                    {"lat": round(anom_lat - 0.08, 4), "lng": round(anom_lng - 0.06, 4)}
                ]
            }
            frame_flights.append(anom_flight)

            # Frame log summary
            if f_idx < 3:
                log_msg = f"[{frame_time.strftime('%H:%M:%S')}] Ingesting live ADS-B vectors across northern airspace. {len(frame_flights)} targets nominal."
            elif f_idx == 3:
                log_msg = f"[{frame_time.strftime('%H:%M:%S')}] CRITICAL ALERT: SYNTH-JMP (a1b2c3) position jumped 550 km in 5s! Speed > 1,200 km/h."
            elif f_idx == 4:
                log_msg = f"[{frame_time.strftime('%H:%M:%S')}] DUAL VIOLATION: SYNTH-JMP climb rate (80.0 m/s) exceeded civil envelope! Trust collapsed to 12%."
            else:
                log_msg = f"[{frame_time.strftime('%H:%M:%S')}] Ground Station Tracking: Anomaly flight SYNTH-JMP isolated. Airspace telemetry streaming normally."

            frames.append({
                "timestamp": frame_time.isoformat(),
                "flights": frame_flights,
                "log": log_msg
            })

        print(f"Generated {len(frames)} frames with {len(frames[0]['flights'])} aircraft per frame.")
        
        with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
            json.dump(frames, f, indent=2)

        print(f"Successfully wrote playback fixture to {OUTPUT_PATH}")

if __name__ == "__main__":
    asyncio.run(main())

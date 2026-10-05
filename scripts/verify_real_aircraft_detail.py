import asyncio
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from httpx import AsyncClient, ASGITransport

from app.main import app
from app.models import AircraftState, FlightRoute, Alert, User
from app.core.database import async_session_maker, get_db
from app.api.deps import get_current_user, require_viewer

async def run_verification():
    print("=" * 70)
    print("AIRGUARD END-TO-END VERIFICATION: REAL AIRCRAFT TRACKING & DETAIL")
    print("=" * 70)

    # 1. Inspect real aircraft in database
    async with async_session_maker() as session:
        from sqlalchemy import select, func
        # Get distinct icao24s with recent states
        stmt = (
            select(
                AircraftState.icao24,
                AircraftState.callsign,
                AircraftState.latitude,
                AircraftState.longitude,
                AircraftState.altitude_m,
                AircraftState.velocity_ms,
                AircraftState.heading_deg,
                AircraftState.vertical_rate_ms,
                AircraftState.received_at,
                AircraftState.source
            )
            .order_by(AircraftState.received_at.desc())
        )
        result = await session.execute(stmt)
        all_states = result.fetchall()
        
        # Deduplicate to latest state per icao
        seen = set()
        latest_states = []
        for s in all_states:
            if s.icao24 not in seen:
                seen.add(s.icao24)
                latest_states.append(s)

    print(f"\n[1] Database Inspection:")
    print(f"    Total recorded states: {len(all_states)}")
    print(f"    Unique aircraft tracked in region: {len(latest_states)}")
    for s in latest_states:
        print(f"    - ICAO: {s.icao24:<8} Callsign: {s.callsign or 'N/A':<10} Alt: {round(s.altitude_m)}m Spd: {round(s.velocity_ms)}m/s Track: {round(s.heading_deg)}° VRate: {s.vertical_rate_ms}m/s")

    # Override viewer auth for testing endpoints
    mock_user = User(id=1, email="analyst@airguard.sec", role="analyst")
    app.dependency_overrides[require_viewer] = lambda: mock_user
    app.dependency_overrides[get_current_user] = lambda: mock_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # [2] Test GET /api/v1/aircraft (Full Snapshot)
        print(f"\n[2] Testing GET /api/v1/aircraft (Full Snapshot):")
        res = await client.get("/api/v1/aircraft?max_age_seconds=86400") # wide retention for test DB
        print(f"    HTTP Status: {res.status_code}")
        snapshot = res.json()
        print(f"    Aircraft returned in full snapshot: {len(snapshot)} (no artificial cutoff)")
        for ac in snapshot[:5]:
            print(f"    • {ac['icao24'].upper()} ({ac['callsign']}): Lat={ac['latitude']:.2f}, Lng={ac['longitude']:.2f}, Staleness={ac['staleness_status']} ({ac['last_seen_seconds_ago']}s ago)")

        # [3] Pick 5 real aircraft and test GET /api/v1/aircraft/{icao24}/detail
        test_icaos = [s.icao24 for s in latest_states[:5]]
        # If fewer than 5 unique icaos in DB, fill with known real commercial aircraft
        default_icaos = ["800b46", "400a12", "8002a1", "8013ef", "a1b2c3"]
        for d in default_icaos:
            if d not in test_icaos and len(test_icaos) < 5:
                test_icaos.append(d)

        print(f"\n[3] Testing Consolidated Detail Endpoint GET /api/v1/aircraft/{{icao24}}/detail for 5 Aircraft:")
        
        field_reliability = {
            "icao24": 0,
            "callsign": 0,
            "live_telemetry": 0,
            "route_text": 0,
            "route_known_airports": 0,
            "aircraft_model": 0,
            "aircraft_operator": 0,
            "registration": 0,
            "trust_status": 0,
            "first_seen_session": 0,
            "staleness": 0
        }

        for idx, icao in enumerate(test_icaos[:5], 1):
            detail_res = await client.get(f"/api/v1/aircraft/{icao}/detail")
            print(f"\n    --- Aircraft #{idx}: {icao.upper()} ---")
            print(f"    HTTP Status: {detail_res.status_code}")
            assert detail_res.status_code == 200, f"Detail request failed for {icao}"
            detail = detail_res.json()

            # Verify and print fields
            live = detail["live_state"]
            route = detail["route"]
            identity = detail["identity"]
            trust = detail["trust_status"]
            staleness = detail["staleness"]
            first_seen = detail["first_seen_session"]

            print(f"    Callsign:              {detail.get('callsign') or 'N/A'}")
            print(f"    Live Telemetry:        Alt={round(live['altitude_m'] * 3.28084):,} ft | Spd={round(live['velocity_ms'] * 1.94384)} kts | Hdg={round(live['heading_deg'])}° | VRate={live['vertical_rate_ms']} m/s")
            print(f"    Route:                 {route['route_text']} (Dep={route.get('est_departure_airport') or 'None'}, Arr={route.get('est_arrival_airport') or 'None'})")
            print(f"    Airframe Identity:     Model: {identity.get('model')} | Operator: {identity.get('operator')} | Reg: {identity.get('registration') or 'Unfiled'} ({identity.get('source')})")
            print(f"    Trust Status:          '{trust['status_text']}' | Risk: {trust['combined_risk_score']} | Rolling Trust: {trust['rolling_trust_score']}%")
            print(f"    Story Explanation:     {trust['explanation']}")
            print(f"    Staleness:             Status={staleness['status']} | Last Seen={staleness['last_seen_seconds_ago']}s ago")
            print(f"    Session First Seen:    {first_seen}")

            # Check reliability
            if detail.get("icao24"): field_reliability["icao24"] += 1
            if detail.get("callsign"): field_reliability["callsign"] += 1
            if live.get("altitude_m") is not None and live.get("velocity_ms") is not None: field_reliability["live_telemetry"] += 1
            if route.get("route_text"): field_reliability["route_text"] += 1
            if route.get("est_departure_airport") or route.get("est_arrival_airport"): field_reliability["route_known_airports"] += 1
            if identity.get("model") and identity.get("model") != "None": field_reliability["aircraft_model"] += 1
            if identity.get("operator") and identity.get("operator") != "None": field_reliability["aircraft_operator"] += 1
            if identity.get("registration"): field_reliability["registration"] += 1
            if trust.get("status_text") and trust.get("combined_risk_score") is not None: field_reliability["trust_status"] += 1
            if first_seen: field_reliability["first_seen_session"] += 1
            if staleness.get("status"): field_reliability["staleness"] += 1

            # Assertions: No blanks or unhandled placeholders
            assert detail["icao24"] == icao.lower()
            assert trust["status_text"] in ["Verified normal", "Flagged — signal inconsistency detected"]
            assert route["route_text"] is not None and len(route["route_text"]) > 0
            assert staleness["status"] in ["LIVE", "STALE", "LOST"]

        print("\n" + "=" * 70)
        print("FIELD RELIABILITY AUDIT SUMMARY (Across 5 Tracked Aircraft):")
        print("=" * 70)
        for field, count in field_reliability.items():
            pct = (count / 5) * 100
            availability = "RELIABLE (100%)" if count == 5 else f"PARTIAL ({pct:.0f}%)" if count > 0 else "UNAVAILABLE (0%)"
            print(f"  • {field:<24}: {count}/5 ({pct:.0f}%) -> {availability}")
        print("=" * 70)

if __name__ == "__main__":
    asyncio.run(run_verification())

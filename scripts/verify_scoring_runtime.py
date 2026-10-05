"""AirGuard Live Runtime Scoring Verification Script.
Queries real database records and FastAPI endpoints using ASGITransport to verify real aircraft scoring end-to-end.
"""
import asyncio
import os
import sys
import json
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from httpx import AsyncClient, ASGITransport
from sqlalchemy import select, text

from app.main import app
from app.models import AircraftState, AircraftAssessment, User
from app.core.database import async_session_maker
from app.api.deps import get_current_user, require_viewer
from app.detection.service import DetectionService
from app.detection.rules import RuleConfig
from app.detection.autoencoder import UnsupervisedAutoencoder
from app.detection.ensemble import TrustScoringEnsemble
from app.detection.trust import derive_trust_score


async def verify_runtime():
    print("=" * 70)
    print("AIRGUARD RISK & TRUST SCORE PIPELINE END-TO-END VERIFICATION")
    print("=" * 70)

    # 1. Inspect existing real aircraft states in DB
    print("\n[1] Querying real aircraft states from PostgreSQL database...")
    async with async_session_maker() as session:
        stmt = select(AircraftState).order_by(AircraftState.received_at.desc()).limit(100)
        res = await session.execute(stmt)
        recent_states = res.scalars().all()

        print(f"  Found {len(recent_states)} recent aircraft states in DB.")
        
        # Group by icao24
        by_icao = {}
        for s in recent_states:
            by_icao.setdefault(s.icao24, []).append(s)

        print(f"  Unique ICAO24s observed: {len(by_icao)}")
        for icao, states in list(by_icao.items())[:5]:
            latest = states[0]
            print(f"    - ICAO: {icao:<8} Callsign: {latest.callsign or 'N/A':<8} Obs count: {len(states)} | Alt: {latest.altitude_m}m | Spd: {latest.velocity_ms}m/s | Hdg: {latest.heading_deg}°")

    # 2. Run real DetectionService pipeline on accumulated observations
    print("\n[2] Processing real aircraft observations through live DetectionService pipeline...")
    queue = asyncio.Queue()
    rule_config = RuleConfig()
    
    # Initialize real Autoencoder and Ensemble
    autoencoder = UnsupervisedAutoencoder()
    ensemble = TrustScoringEnsemble()
    
    service = DetectionService(
        queue=queue,
        db_session_maker=async_session_maker,
        ensemble_model=ensemble,
        autoencoder_model=autoencoder,
        rule_config=rule_config
    )

    # Pick an aircraft with multiple observations or real data
    target_icao = None
    target_states = None
    for icao, states in by_icao.items():
        if len(states) >= 3:
            target_icao = icao
            target_states = list(reversed(states)) # chronological order
            break
            
    if not target_icao and recent_states:
        target_icao = recent_states[0].icao24
        target_states = [recent_states[0]]

    print(f"\n  Selected Target ICAO for detailed trace: {target_icao}")
    
    # Ingest records through detection service
    last_assessment = None
    for idx, s in enumerate(target_states):
        record = {
            "icao24": s.icao24,
            "callsign": s.callsign,
            "latitude": s.latitude,
            "longitude": s.longitude,
            "altitude_m": s.altitude_m,
            "velocity_ms": s.velocity_ms,
            "heading_deg": s.heading_deg,
            "vertical_rate_ms": s.vertical_rate_ms,
            "on_ground": s.on_ground,
            "received_at": s.received_at,
            "source": s.source,
            "metadata": {"is_known_entity": False, "known_entity_label": None}
        }
        await service.process_record(record)
        print(f"    Processed obs #{idx+1} at {s.received_at} -> Lat: {s.latitude:.4f}, Lng: {s.longitude:.4f}, Alt: {s.altitude_m:.1f}m, Spd: {s.velocity_ms:.1f}m/s")

    # 3. Query the persisted assessment from DB
    print("\n[3] Querying persisted AircraftAssessment from database...")
    async with async_session_maker() as session:
        stmt = (
            select(AircraftAssessment)
            .where(AircraftAssessment.icao24 == target_icao)
            .order_by(AircraftAssessment.assessed_at.desc())
            .limit(1)
        )
        res = await session.execute(stmt)
        assessment = res.scalar_one_or_none()

        if assessment:
            print(f"  Assessment Record Found (ID: {assessment.id}):")
            print(f"    - ICAO24: {assessment.icao24}")
            print(f"    - Combined Risk Score: {assessment.combined_risk_score}")
            print(f"    - Status: {assessment.status}")
            print(f"    - Rule Coverage: {assessment.rule_assessment_coverage}")
            print(f"    - Assessed At: {assessment.assessed_at}")
            print(f"    - Signals Dictionary:")
            for k, v in assessment.signals.items():
                print(f"        {k}: {v}")
        else:
            print("  No assessment record found in database.")

    # 4. Query FastAPI API endpoints via ASGITransport
    print("\n[4] Querying live FastAPI endpoints...")
    mock_user = User(id=1, email="analyst@airguard.sec", role="analyst")
    app.dependency_overrides[require_viewer] = lambda: mock_user
    app.dependency_overrides[get_current_user] = lambda: mock_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # A. /api/v1/aircraft
        resp_list = await client.get("/api/v1/aircraft")
        print(f"  GET /api/v1/aircraft status: {resp_list.status_code}")
        if resp_list.status_code == 200:
            aircraft_list = resp_list.json()
            print(f"  Returned {len(aircraft_list)} aircraft states.")
            match_in_list = next((a for a in aircraft_list if a.get("icao24") == target_icao), None)
            if match_in_list:
                print(f"  Target in List Snapshot:")
                print(f"    - ICAO24: {match_in_list.get('icao24')}")
                print(f"    - Callsign: {match_in_list.get('callsign')}")
                print(f"    - Combined Risk Score: {match_in_list.get('combined_risk_score')}")
                print(f"    - Trust Score: {match_in_list.get('trust_score')}")
                print(f"    - Evidence Confidence: {match_in_list.get('evidence_confidence')}")
                print(f"    - Assessment Status: {match_in_list.get('assessment_status')}")

        # B. /api/v1/aircraft/{icao24}/detail
        resp_detail = await client.get(f"/api/v1/aircraft/{target_icao}/detail")
        print(f"\n  GET /api/v1/aircraft/{target_icao}/detail status: {resp_detail.status_code}")
        if resp_detail.status_code == 200:
            detail = resp_detail.json()
            trust_stat = detail.get("trust_status", {})
            print("  Detail Trust Status Object:")
            print(f"    - Status Text: {trust_stat.get('status_text')}")
            print(f"    - Combined Risk Score: {trust_stat.get('combined_risk_score')}")
            print(f"    - Trust Score: {trust_stat.get('trust_score')}")
            print(f"    - Rolling Trust Score: {trust_stat.get('rolling_trust_score')}")
            print(f"    - Evidence Confidence: {trust_stat.get('evidence_confidence')}")
            print(f"    - Assessment Status: {trust_stat.get('assessment_status')}")
            print(f"    - Explanation: {trust_stat.get('explanation')}")
            print(f"    - Reasons: {trust_stat.get('reasons')}")
            print(f"    - Technical Details: {json.dumps(trust_stat.get('technical_details'), indent=8)}")
            print(f"    - Unavailable Reasons: {trust_stat.get('unavailable_reasons')}")

    print("\n" + "=" * 70)
    print("VERIFICATION COMPLETE")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(verify_runtime())

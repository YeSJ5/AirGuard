import pytest
from datetime import datetime, timedelta, timezone
from sqlalchemy import select, func
from app.core.database import Base, engine, async_session_maker
from app.models import AircraftState, Alert
from app.tasks.retention import run_retention

async def check_db_connection() -> bool:
    try:
        async with engine.connect() as conn:
            from sqlalchemy import text
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False

@pytest.mark.asyncio
async def test_retention_downsampling():
    if not await check_db_connection():
        pytest.skip("PostgreSQL database is offline. Skipping retention integration test.")

    # 1. Recreate database tables to ensure clean state
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    now = datetime.now(timezone.utc)
    old_time = now - timedelta(days=35)
    new_time = now - timedelta(days=5)

    async with async_session_maker() as session:
        # 2. Insert 20 unlinked old states (should be subject to downsampling)
        for i in range(20):
            state = AircraftState(
                icao24="OLD111",
                callsign=f"OLD{i:02d}",
                latitude=37.0 + (i * 0.01),
                longitude=-122.0 - (i * 0.01),
                altitude_m=5000.0,
                velocity_ms=200.0,
                heading_deg=90.0,
                vertical_rate_ms=0.0,
                on_ground=False,
                received_at=old_time + timedelta(minutes=i),
                source="opensky"
            )
            session.add(state)

        # 3. Insert 1 linked old state (should NEVER be deleted)
        linked_state = AircraftState(
            icao24="LNK222",
            callsign="LINKED",
            latitude=38.0,
            longitude=-121.0,
            altitude_m=6000.0,
            velocity_ms=210.0,
            heading_deg=100.0,
            vertical_rate_ms=0.0,
            on_ground=False,
            received_at=old_time,
            source="opensky"
        )
        session.add(linked_state)
        await session.flush()  # populated linked_state.id
        
        alert = Alert(
            icao24="LNK222",
            aircraft_state_id=linked_state.id,
            rule_flags=["CLIMB_RATE"],
            ensemble_score=0.8,
            autoencoder_score=0.9,
            combined_risk_score=0.85,
            reason_text="Linked state mock alert",
            shap_explanation={"shap": {}, "evidence": {}},
            detected_at=now,
            is_synthetic=False,
            acknowledged=False
        )
        session.add(alert)

        # 4. Insert 5 new states (should NEVER be deleted)
        for i in range(5):
            state = AircraftState(
                icao24="NEW333",
                callsign=f"NEW{i}",
                latitude=39.0 + (i * 0.01),
                longitude=-120.0 - (i * 0.01),
                altitude_m=7000.0,
                velocity_ms=220.0,
                heading_deg=110.0,
                vertical_rate_ms=0.0,
                on_ground=False,
                received_at=new_time + timedelta(minutes=i),
                source="opensky"
            )
            session.add(state)

        await session.commit()

    # 5. Execute in DRY RUN mode (verify no deletions happen)
    dry_deleted_count = await run_retention(days=30, dry_run=True)
    
    # 20 old unlinked records, keeping 1-in-10 (keep sequence 1 and 11), so 18 should be candidates for deletion
    assert dry_deleted_count == 18, f"Expected 18 candidates for deletion, found {dry_deleted_count}"

    async with async_session_maker() as session:
        count_res = await session.execute(
            select(func.count(AircraftState.id)).where(AircraftState.icao24.in_(["OLD111", "LNK222", "NEW333"]))
        )
        total_count_before = count_res.scalar()
        assert total_count_before == 26, "Dry-run should not delete any records."

    # 6. Execute in ACTIVE mode
    actual_deleted_count = await run_retention(days=30, dry_run=False)
    assert actual_deleted_count == 18

    # 7. Assert database records count and integrity
    async with async_session_maker() as session:
        # Check total remaining test states
        count_res = await session.execute(
            select(func.count(AircraftState.id)).where(AircraftState.icao24.in_(["OLD111", "LNK222", "NEW333"]))
        )
        total_count_after = count_res.scalar()
        
        # Original 26 - 18 deleted = 8 remaining
        assert total_count_after == 8, f"Expected 8 remaining states, found {total_count_after}"

        # Verify new states are fully intact
        new_res = await session.execute(select(AircraftState).where(AircraftState.icao24 == "NEW333"))
        assert len(new_res.scalars().all()) == 5

        # Verify linked state is fully intact
        linked_res = await session.execute(select(AircraftState).where(AircraftState.icao24 == "LNK222"))
        assert len(linked_res.scalars().all()) == 1

        # Verify OLD states are downsampled to exactly 2 records (1-in-10 of 20 is 2)
        old_res = await session.execute(select(AircraftState).where(AircraftState.icao24 == "OLD111"))
        remaining_old_states = old_res.scalars().all()
        assert len(remaining_old_states) == 2
        
        # Verify the kept states are the 1st and 11th sequences (received_at)
        callsigns = {s.callsign for s in remaining_old_states}
        assert "OLD00" in callsigns
        assert "OLD10" in callsigns

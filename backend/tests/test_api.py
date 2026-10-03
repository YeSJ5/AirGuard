import pytest
from httpx import AsyncClient, ASGITransport
from fastapi.testclient import TestClient
from unittest.mock import MagicMock, AsyncMock
from datetime import datetime, timezone
import json

from app.main import app
from app.api.v1.endpoints import manager, SYSTEM_STATS
from app.models import AircraftState, Alert, ModelRun

# Override the get_db and auth dependencies
from app.core.database import get_db
from app.api.deps import get_current_user, require_viewer, require_analyst, require_admin
from app.models import User

from unittest.mock import MagicMock, AsyncMock, patch

@pytest.fixture
def mock_db():
    session = AsyncMock()
    return session

@pytest.fixture(autouse=True)
def override_db_dependency(mock_db):
    mock_user = User(id=1, email="test@airguard.sec", role="admin")
    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_current_user] = lambda: mock_user
    app.dependency_overrides[require_viewer] = lambda: mock_user
    app.dependency_overrides[require_analyst] = lambda: mock_user
    app.dependency_overrides[require_admin] = lambda: mock_user
    with patch("app.api.v1.endpoints.redis_client.get", new=AsyncMock(return_value=None)):
        yield
    app.dependency_overrides.clear()

@pytest.mark.asyncio
async def test_get_aircraft(mock_db):
    mock_state = AircraftState(
        id=1, 
        icao24="a1b2c3", 
        callsign="UAL824", 
        latitude=37.7749, 
        longitude=-122.4194,
        altitude_m=10000.0, 
        velocity_ms=250.0, 
        heading_deg=180.0, 
        vertical_rate_ms=0.0,
        on_ground=False, 
        received_at=datetime.now(timezone.utc), 
        source="opensky"
    )
    
    mock_res = MagicMock()
    mock_res.scalars.return_value.all.return_value = [mock_state]
    mock_db.execute.return_value = mock_res
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/aircraft")
        
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["icao24"] == "a1b2c3"
    assert data[0]["callsign"] == "UAL824"

@pytest.mark.asyncio
async def test_get_aircraft_history(mock_db):
    mock_state = AircraftState(
        id=1, 
        icao24="a1b2c3", 
        callsign="UAL824", 
        latitude=37.7749, 
        longitude=-122.4194,
        altitude_m=10000.0, 
        velocity_ms=250.0, 
        heading_deg=180.0, 
        vertical_rate_ms=0.0,
        on_ground=False, 
        received_at=datetime.now(timezone.utc), 
        source="opensky"
    )
    
    mock_res = MagicMock()
    mock_res.scalars.return_value.all.return_value = [mock_state]
    mock_db.execute.return_value = mock_res
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/aircraft/a1b2c3/history")
        
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["icao24"] == "a1b2c3"

@pytest.mark.asyncio
async def test_get_aircraft_detail(mock_db):
    mock_state = AircraftState(
        id=1, 
        icao24="a1b2c3", 
        callsign="UAL824", 
        latitude=37.7749, 
        longitude=-122.4194,
        altitude_m=10000.0, 
        velocity_ms=250.0, 
        heading_deg=180.0, 
        vertical_rate_ms=0.0,
        on_ground=False, 
        received_at=datetime.now(timezone.utc), 
        source="opensky"
    )
    
    mock_res = MagicMock()
    mock_res.scalar_one_or_none.return_value = mock_state
    mock_db.execute.return_value = mock_res
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/aircraft/a1b2c3/detail")
        
    assert res.status_code == 200
    data = res.json()
    assert data["icao24"] == "a1b2c3"
    assert data["live_state"]["callsign"] == "UAL824"
    assert "route" in data
    assert "identity" in data
    assert "trust_status" in data
    assert "staleness" in data
    assert data["staleness"]["status"] in ["LIVE", "STALE", "LOST"]

@pytest.mark.asyncio
async def test_get_alerts(mock_db):
    mock_alert = Alert(
        id=1, 
        icao24="a1b2c3", 
        aircraft_state_id=1, 
        rule_flags=["rule_position_jump"],
        ensemble_score=0.8, 
        autoencoder_score=0.9, 
        combined_risk_score=0.85,
        reason_text="Implied speed anomaly", 
        shap_explanation={"top_features": []},
        detected_at=datetime.now(timezone.utc), 
        is_synthetic=False, 
        acknowledged=False
    )
    
    mock_res = MagicMock()
    mock_res.scalars.return_value.all.return_value = [mock_alert]
    mock_db.execute.return_value = mock_res
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/alerts?acknowledged=false&icao24=a1b2c3")
        
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["combined_risk_score"] == 0.85

@pytest.mark.asyncio
async def test_acknowledge_alert(mock_db):
    mock_alert = Alert(
        id=1, 
        icao24="a1b2c3", 
        aircraft_state_id=1, 
        rule_flags=["rule_position_jump"],
        ensemble_score=0.8, 
        autoencoder_score=0.9, 
        combined_risk_score=0.85,
        reason_text="Implied speed anomaly", 
        shap_explanation={"top_features": []},
        detected_at=datetime.now(timezone.utc), 
        is_synthetic=False, 
        acknowledged=False
    )
    
    mock_res = MagicMock()
    mock_res.scalar_one_or_none.return_value = mock_alert
    mock_db.execute.return_value = mock_res
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/alerts/1/acknowledge")
        
    assert res.status_code == 200
    data = res.json()
    assert data["acknowledged"] is True
    
    # Test 404
    mock_res.scalar_one_or_none.return_value = None
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/alerts/999/acknowledge")
    assert res.status_code == 404

@pytest.mark.asyncio
async def test_get_model_runs(mock_db):
    mock_run = ModelRun(
        id=1, 
        run_at=datetime.now(timezone.utc), 
        model_version="v0.1.0",
        true_positives=10, 
        false_positives=1, 
        true_negatives=100, 
        false_negatives=2,
        precision=0.9, 
        recall=0.8, 
        f1=0.85, 
        notes="Ensemble test run"
    )
    
    mock_res = MagicMock()
    mock_res.scalars.return_value.all.return_value = [mock_run]
    mock_db.execute.return_value = mock_res
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/model-runs")
        
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["model_version"] == "v0.1.0"

@pytest.mark.asyncio
async def test_system_health():
    SYSTEM_STATS["last_successful_poll"] = datetime.now(timezone.utc)
    SYSTEM_STATS["poll_latency_ms"] = 124.5
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/system-health")
        
    assert res.status_code == 200
    data = res.json()
    assert data["circuit_breaker_state"] == "CLOSED"
    assert data["poll_latency_ms"] == 124.5

def test_websocket_broadcast():
    client = TestClient(app)
    with client.websocket_connect("/api/v1/stream") as websocket:
        import asyncio
        async def do_broadcast():
            await manager.broadcast({"event": "ALERT_TRIGGERED", "icao24": "test11"})
            
        asyncio.run(do_broadcast())
        
        msg = websocket.receive_json()
        assert msg["event"] == "ALERT_TRIGGERED"
        assert msg["icao24"] == "test11"


@pytest.mark.asyncio
async def test_generate_session_report(mock_db):
    mock_db.execute.side_effect = [
        # Distinct icao24 query
        MagicMock(scalars=lambda: MagicMock(all=lambda: ["a1b2c3"])),
        # All alerts query
        MagicMock(scalars=lambda: MagicMock(all=lambda: [
            Alert(
                id=1, 
                icao24="a1b2c3", 
                aircraft_state_id=1, 
                rule_flags=["rule_position_jump"],
                ensemble_score=0.8,
                autoencoder_score=0.7,
                combined_risk_score=0.85, 
                reason_text="Implied speed anomaly",
                shap_explanation={"shap": {"speed": 0.5}},
                detected_at=datetime.now(timezone.utc)
            )
        ])),
        # Model run query
        MagicMock(scalar_one_or_none=lambda: ModelRun(
            model_version="v0.1.0", 
            precision=0.9, 
            recall=0.8, 
            f1=0.85, 
            notes="Mini set"
        )),
        # Top alerts query
        MagicMock(scalars=lambda: MagicMock(all=lambda: [
            Alert(
                id=1, 
                icao24="a1b2c3", 
                aircraft_state_id=1, 
                rule_flags=["rule_position_jump"],
                ensemble_score=0.8,
                autoencoder_score=0.7,
                combined_risk_score=0.85, 
                reason_text="Implied speed anomaly",
                shap_explanation={"shap": {"speed": 0.5}},
                detected_at=datetime.now(timezone.utc)
            )
        ]))
    ]
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/reports/session")
        
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert len(res.content) > 0


@pytest.mark.asyncio
async def test_get_all_aircraft_history(mock_db):
    mock_state = AircraftState(
        id=1, 
        icao24="a1b2c3", 
        callsign="UAL824", 
        latitude=37.7749, 
        longitude=-122.4194,
        altitude_m=10000.0, 
        velocity_ms=250.0, 
        heading_deg=180.0, 
        vertical_rate_ms=0.0,
        on_ground=False, 
        received_at=datetime.now(timezone.utc), 
        source="opensky",
        is_synthetic=False
    )
    
    mock_res = MagicMock()
    mock_res.scalar.return_value = 1
    mock_res.scalars.return_value.all.return_value = [mock_state]
    mock_db.execute.return_value = mock_res
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/aircraft/history?start=2026-08-04T00:00:00Z&end=2026-08-04T23:59:59Z")
        
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["icao24"] == "a1b2c3"
    assert res.headers["x-total-count"] == "1"
    assert res.headers["x-is-truncated"] == "false"


@pytest.mark.asyncio
async def test_get_all_aircraft_history_naive_and_paginated(mock_db):
    mock_state = AircraftState(
        id=1, 
        icao24="a1b2c3", 
        callsign="UAL824", 
        latitude=37.7749, 
        longitude=-122.4194,
        altitude_m=10000.0, 
        velocity_ms=250.0, 
        heading_deg=180.0, 
        vertical_rate_ms=0.0,
        on_ground=False, 
        received_at=datetime.now(timezone.utc), 
        source="opensky",
        is_synthetic=False
    )
    
    mock_res = MagicMock()
    mock_res.scalar.return_value = 50
    mock_res.scalars.return_value.all.return_value = [mock_state]
    mock_db.execute.return_value = mock_res
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # Test with naive timestamp (no Z) and limit=1
        res = await ac.get("/api/v1/aircraft/history?start=2026-08-04T00:00:00&end=2026-08-04T23:59:59&limit=1&icao24=a1b2c3")
        
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert res.headers["x-total-count"] == "50"
    assert res.headers["x-is-truncated"] == "true"
    assert "x-query-start-utc" in res.headers


@pytest.mark.asyncio
async def test_get_config():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/config")
        
    assert res.status_code == 200
    data = res.json()
    assert "max_implied_speed_kmh" in data


@pytest.mark.asyncio
async def test_update_config():
    payload = {
        "max_implied_speed_kmh": 1300.0,
        "duplicate_icao_dist_km": 60.0,
        "max_vertical_rate_ms": 55.0,
        "max_ground_altitude_m": 120.0,
        "max_ground_speed_ms": 80.0,
        "min_flight_speed_ms": 25.0
    }
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/config", json=payload)
        
    assert res.status_code == 200
    data = res.json()
    assert data["max_implied_speed_kmh"] == 1300.0


@pytest.mark.asyncio
async def test_replay_session_validation(mock_db):
    # Mock data queries:
    # 1. Distinct states query
    # 2. Alerts query
    mock_db.execute.side_effect = [
        # States list
        MagicMock(scalars=lambda: MagicMock(all=lambda: [
            AircraftState(
                id=1, icao24="a1b2c3", callsign="UAL824", latitude=37.7749, longitude=-122.4194,
                altitude_m=10000.0, velocity_ms=250.0, heading_deg=180.0, vertical_rate_ms=0.0,
                on_ground=False, received_at=datetime.now(timezone.utc), source="opensky"
            )
        ])),
        # Alerts list (ground truth check)
        MagicMock(scalars=lambda: MagicMock(all=lambda: [
            Alert(
                id=1, icao24="a1b2c3", aircraft_state_id=1, is_synthetic=True
            )
        ]))
    ]
    
    # Mock refresh to populate db_run.id
    def mock_refresh(obj):
        obj.id = 99
        return None
    mock_db.refresh.side_effect = mock_refresh
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/model-runs/replay")
        
    assert res.status_code == 200
    data = res.json()
    assert data["model_version"] == "Replay-Config"
    assert "notes" in data




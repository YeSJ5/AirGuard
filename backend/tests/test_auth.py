from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.deps import get_current_user
from app.main import app
from app.models import Alert, AuditLog, User


# Static Schema Tests
def test_static_user_schema():
    table = User.__table__
    assert table.c.id.type.__class__.__name__ == "BigInteger"
    assert table.c.email.type.length == 255
    assert table.c.hashed_password.type.length == 255
    assert table.c.role.type.length == 20
    assert table.c.created_at.type.timezone is True


def test_static_audit_log_schema():
    table = AuditLog.__table__
    assert table.c.id.type.__class__.__name__ == "BigInteger"
    assert table.c.user_id.type.__class__.__name__ == "BigInteger"
    assert table.c.action.type.length == 50
    assert table.c.target_type.type.length == 50
    assert table.c.target_id.type.length == 100
    assert table.c.timestamp.type.timezone is True
    assert table.c.ip_address.type.length == 50


# Mock DB fixture
@pytest.fixture
def mock_db():
    session = AsyncMock()
    session.add = MagicMock()
    return session


# API Role Boundary Tests
@pytest.mark.asyncio
async def test_unauthorized_endpoints():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/alerts/1/acknowledge")
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_viewer_role_boundaries(mock_db):
    viewer_user = User(id=1, email="viewer@test.com", role="viewer")
    app.dependency_overrides[get_current_user] = lambda: viewer_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/alerts/1/acknowledge")

    assert res.status_code == 403
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_analyst_role_acknowledges_alert(mock_db):
    analyst_user = User(id=2, email="analyst@test.com", role="analyst")
    app.dependency_overrides[get_current_user] = lambda: analyst_user

    mock_alert = Alert(
        id=1,
        icao24="a1b2c3",
        aircraft_state_id=1,
        rule_flags=[],
        ensemble_score=0.1,
        autoencoder_score=0.1,
        combined_risk_score=0.1,
        reason_text="",
        shap_explanation={},
        detected_at=datetime.now(timezone.utc),
        is_synthetic=False,
        acknowledged=False,
    )

    mock_res = MagicMock()
    mock_res.scalar_one_or_none.return_value = mock_alert
    mock_db.execute.return_value = mock_res

    from app.core.database import get_db

    app.dependency_overrides[get_db] = lambda: mock_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/alerts/1/acknowledge")

    assert res.status_code == 200
    assert mock_alert.acknowledged is True
    assert mock_db.add.call_count > 0
    added_obj = mock_db.add.call_args[0][0]
    assert isinstance(added_obj, AuditLog)
    assert added_obj.user_id == analyst_user.id
    assert added_obj.action == "acknowledge"

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_viewer_role_boundaries_and_removed_injection_endpoint():
    viewer_user = User(id=1, email="viewer@test.com", role="viewer")
    app.dependency_overrides[get_current_user] = lambda: viewer_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res1 = await ac.post("/api/v1/config", json={"max_implied_speed_kmh": 1200.0})
        res2 = await ac.post(
            "/api/v1/inject", json={"type": "speed", "icao24": "test01"}
        )
        res3 = await ac.post(
            "/api/v1/admin/users",
            json={"email": "u@test.com", "password": "pwd", "role": "viewer"},
        )

    assert res1.status_code == 403
    assert res2.status_code == 404
    assert res3.status_code == 403
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_analyst_cannot_access_admin_endpoints():
    analyst_user = User(id=2, email="analyst@test.com", role="analyst")
    app.dependency_overrides[get_current_user] = lambda: analyst_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post(
            "/api/v1/admin/users",
            json={"email": "u@test.com", "password": "pwd", "role": "viewer"},
        )

    assert res.status_code == 403
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_admin_creates_user_with_audit_log(mock_db):
    admin_user = User(id=3, email="admin@test.com", role="admin")
    app.dependency_overrides[get_current_user] = lambda: admin_user

    mock_res = MagicMock()
    mock_res.scalar_one_or_none.return_value = None  # User does not exist yet
    mock_db.execute.return_value = mock_res

    def mock_refresh(obj):
        obj.id = 99

    mock_db.refresh.side_effect = mock_refresh

    from app.core.database import get_db

    app.dependency_overrides[get_db] = lambda: mock_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post(
            "/api/v1/admin/users",
            json={
                "email": "newuser@test.com",
                "password": "Password123!",
                "role": "analyst",
            },
        )

    assert res.status_code == 200
    data = res.json()
    assert data["email"] == "newuser@test.com"
    assert data["role"] == "analyst"
    assert data["id"] == 99

    # Verify AuditLog was created
    audit_calls = [
        call[0][0]
        for call in mock_db.add.call_args_list
        if isinstance(call[0][0], AuditLog)
    ]
    assert len(audit_calls) > 0
    assert audit_calls[0].action == "create_user"
    assert audit_calls[0].user_id == admin_user.id

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_analyst_updates_config_with_audit_log(mock_db):
    analyst_user = User(id=2, email="analyst@test.com", role="analyst")
    app.dependency_overrides[get_current_user] = lambda: analyst_user

    from app.core.database import get_db

    app.dependency_overrides[get_db] = lambda: mock_db

    payload = {
        "max_implied_speed_kmh": 1250.0,
        "duplicate_icao_dist_km": 55.0,
        "max_vertical_rate_ms": 50.0,
        "max_ground_altitude_m": 100.0,
        "max_ground_speed_ms": 75.0,
        "min_flight_speed_ms": 30.0,
    }

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/config", json=payload)

    assert res.status_code == 200
    data = res.json()
    assert data["max_implied_speed_kmh"] == 1250.0

    # Verify AuditLog was recorded
    audit_calls = [
        call[0][0]
        for call in mock_db.add.call_args_list
        if isinstance(call[0][0], AuditLog)
    ]
    assert len(audit_calls) > 0
    assert audit_calls[0].action == "update_config"
    assert audit_calls[0].user_id == analyst_user.id

    app.dependency_overrides.clear()

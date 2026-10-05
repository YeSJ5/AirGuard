import pytest
from datetime import datetime, timezone
from unittest.mock import MagicMock, AsyncMock, patch
from httpx import AsyncClient, ASGITransport, Response

from app.main import app
from app.models import AircraftState, AircraftAssessment, Alert, User, FlightRoute
from app.core.database import get_db
from app.api.deps import get_current_user, require_viewer
from app.ingestion.route_service import FlightRouteService, get_airport_coordinates

def _mock_db_session():
    result = MagicMock()
    result.scalar_one_or_none.return_value = None
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)
    session.add = MagicMock()
    return session


@pytest.fixture
def mock_db():
    return _mock_db_session()

@pytest.fixture(autouse=True)
def override_deps(mock_db):
    mock_user = User(id=1, email="analyst@airguard.sec", role="analyst")
    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_current_user] = lambda: mock_user
    app.dependency_overrides[require_viewer] = lambda: mock_user
    with patch("app.api.v1.endpoints.redis_client.get", new=AsyncMock(return_value=None)):
        yield
    app.dependency_overrides.clear()

def test_airport_coordinate_lookup():
    del_coords = get_airport_coordinates("VIDP")
    assert del_coords is not None
    assert del_coords["iata"] == "DEL"
    assert del_coords["lat"] == 28.5562
    assert del_coords["lng"] == 77.1000

    bom_coords = get_airport_coordinates("VABB")
    assert bom_coords is not None
    assert bom_coords["iata"] == "BOM"
    assert bom_coords["lat"] == 19.0896
    assert bom_coords["lng"] == 72.8656

    unknown_coords = get_airport_coordinates("ZZZZ")
    assert unknown_coords is None

@pytest.mark.asyncio
async def test_route_service_fetch_and_cache():
    mock_session_maker = MagicMock()
    mock_session = _mock_db_session()
    mock_session_maker.return_value.__aenter__.return_value = mock_session

    service = FlightRouteService(mock_session_maker)
    
    # Mock OpenSky /api/flights/aircraft 200 response with flight data
    mock_flight_payload = [
        {
            "icao24": "800539",
            "callsign": "SEJ123",
            "estDepartureAirport": "VIDP",
            "estArrivalAirport": "VABB",
            "firstSeen": 1700000000,
            "lastSeen": 1700007200,
        }
    ]

    mock_resp = Response(
        status_code=200,
        json=mock_flight_payload,
        request=MagicMock()
    )

    with patch("app.ingestion.opensky_auth.opensky_auth.request", AsyncMock(return_value=mock_resp)):
        route = await service.get_or_fetch_route("800539", callsign="SEJ123", db=mock_session)

    assert route["icao24"] == "800539"
    assert route["est_departure_airport"] == "VIDP"
    assert route["est_arrival_airport"] == "VABB"
    assert "DEL/VIDP" in route["route_text"] and "BOM/VABB" in route["route_text"]
    assert route["dep_lat"] == 28.5562
    assert route["dep_lng"] == 77.1000
    assert route["arr_lat"] == 19.0896
    assert route["arr_lng"] == 72.8656

    # Test in-memory cache hit: second call does not call OpenSky HTTP
    with patch("app.ingestion.opensky_auth.opensky_auth.request", AsyncMock()) as mock_get:
        cached = await service.get_or_fetch_route("800539")
        assert cached == route
        mock_get.assert_not_called()

@pytest.mark.asyncio
async def test_route_service_fallback_when_route_unknown():
    mock_session_maker = MagicMock()
    mock_session = _mock_db_session()
    mock_session_maker.return_value.__aenter__.return_value = mock_session

    service = FlightRouteService(mock_session_maker)

    # Mock OpenSky 404 (coverage partial, no flight record found)
    mock_resp = Response(
        status_code=404,
        text="Not found",
        request=MagicMock()
    )

    with patch("app.ingestion.opensky_auth.opensky_auth.request", AsyncMock(return_value=mock_resp)):
        route = await service.get_or_fetch_route("a1b2c3", callsign="UNKNOWN1", db=mock_session)

    assert route["icao24"] == "a1b2c3"
    assert route["est_departure_airport"] is None
    assert route["est_arrival_airport"] is None
    assert route["route_text"] == "Route unknown"
    assert route["dep_lat"] is None
    assert route["arr_lat"] is None

@pytest.mark.asyncio
async def test_aircraft_detail_endpoint_normal_flow(mock_db):
    now = datetime.now(timezone.utc)
    mock_state = AircraftState(
        id=10,
        icao24="800539",
        callsign="SEJ123",
        latitude=28.5562,
        longitude=77.1000,
        altitude_m=10668.0,
        velocity_ms=230.0,
        heading_deg=210.0,
        vertical_rate_ms=1.5,
        on_ground=False,
        received_at=now,
        source="opensky",
        reported_nic=8,
        is_synthetic=False
    )

    # 1st query: AircraftState
    # 2nd query: Alert (none)
    # 3rd query: scored assessment; 4th query: first-seen timestamp
    res_state = MagicMock()
    res_state.scalar_one_or_none.return_value = mock_state

    res_alert = MagicMock()
    res_alert.scalar_one_or_none.return_value = None

    res_assessment = MagicMock()
    res_assessment.scalar_one_or_none.return_value = AircraftAssessment(
        aircraft_state_id=10, icao24="800539", combined_risk_score=0.05,
        rule_assessment_coverage=1.0, status="SCORED", signals={},
        detector_version="rules-v2", assessed_at=now,
    )
    res_first_seen = MagicMock()
    res_first_seen.scalar_one_or_none.return_value = now

    mock_db.execute.side_effect = [res_state, res_alert, res_assessment, res_first_seen]

    # Mock route service returning verified route
    mock_route = {
        "icao24": "800539",
        "session_id": "test-session",
        "callsign": "SEJ123",
        "est_departure_airport": "VIDP",
        "est_arrival_airport": "VABB",
        "first_seen": now,
        "last_seen": now,
        "route_text": "Delhi (DEL/VIDP) → Mumbai (BOM/VABB)",
        "fetched_at": now,
        "dep_lat": 28.5562,
        "dep_lng": 77.1000,
        "arr_lat": 19.0896,
        "arr_lng": 72.8656
    }

    mock_route_svc = MagicMock()
    mock_route_svc.get_or_fetch_route = AsyncMock(return_value=mock_route)
    with patch("app.api.v1.endpoints.active_route_service", new=mock_route_svc):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.get("/api/v1/aircraft/800539/detail")

    assert res.status_code == 200
    data = res.json()

    # 1. Live state & telemetry
    assert data["icao24"] == "800539"
    assert data["callsign"] == "SEJ123"
    assert data["live_state"]["altitude_m"] == 10668.0
    assert data["live_state"]["velocity_ms"] == 230.0
    assert data["live_state"]["heading_deg"] == 210.0
    assert data["live_state"]["vertical_rate_ms"] == 1.5

    # 2. Route with coordinates
    assert data["route"]["est_departure_airport"] == "VIDP"
    assert data["route"]["est_arrival_airport"] == "VABB"
    assert data["route"]["route_text"] == "Delhi (DEL/VIDP) → Mumbai (BOM/VABB)"
    assert data["route"]["dep_lat"] == 28.5562
    assert data["route"]["arr_lat"] == 19.0896

    # 3. Trust status normal
    assert data["trust_status"]["status_text"] == "No active review flag"
    assert data["trust_status"]["is_flagged"] is False
    assert data["trust_status"]["combined_risk_score"] <= 0.1

    # 4. First seen session
    assert data["first_seen_session"] is not None

@pytest.mark.asyncio
async def test_aircraft_detail_endpoint_flagged_with_unknown_route(mock_db):
    now = datetime.now(timezone.utc)
    mock_state = AircraftState(
        id=20,
        icao24="400001",
        callsign="GHOST99",
        latitude=21.0,
        longitude=78.0,
        altitude_m=5000.0,
        velocity_ms=120.0,
        heading_deg=90.0,
        vertical_rate_ms=-40.0,
        on_ground=False,
        received_at=now,
        source="opensky",
        reported_nic=2,
        is_synthetic=False
    )

    mock_alert = Alert(
        id=99,
        icao24="400001",
        aircraft_state_id=20,
        rule_flags=["rule_climb_rate", "rule_alt_vel_mismatch"],
        ensemble_score=0.92,
        autoencoder_score=0.88,
        combined_risk_score=0.91,
        reason_text="Impossible descent rate; Speed mismatch",
        shap_explanation={
            "evidence": {
                "rule_flags": {"climb_rate": True, "alt_vel_mismatch": True}
            },
            "shap": {"climb_vector": 0.85}
        },
        detected_at=now,
        is_synthetic=True,
        acknowledged=False
    )

    res_state = MagicMock()
    res_state.scalar_one_or_none.return_value = mock_state

    res_alert = MagicMock()
    res_alert.scalar_one_or_none.return_value = mock_alert

    res_assessment = MagicMock()
    res_assessment.scalar_one_or_none.return_value = None

    res_first_seen = MagicMock()
    res_first_seen.scalar_one_or_none.return_value = now

    mock_db.execute.side_effect = [res_state, res_alert, res_assessment, res_first_seen]

    # Route unknown fallback
    mock_route = {
        "icao24": "400001",
        "session_id": "test-session",
        "callsign": "GHOST99",
        "est_departure_airport": None,
        "est_arrival_airport": None,
        "first_seen": None,
        "last_seen": None,
        "route_text": "Route unknown",
        "fetched_at": now,
        "dep_lat": None,
        "dep_lng": None,
        "arr_lat": None,
        "arr_lng": None
    }

    mock_route_svc = MagicMock()
    mock_route_svc.get_or_fetch_route = AsyncMock(return_value=mock_route)
    with patch("app.api.v1.endpoints.active_route_service", new=mock_route_svc):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            res = await ac.get("/api/v1/aircraft/400001/detail")

    assert res.status_code == 200
    data = res.json()

    # Route fallback confirmed
    assert data["route"]["route_text"] == "Route unknown"
    assert data["route"]["est_departure_airport"] is None
    assert data["route"]["est_arrival_airport"] is None

    # Trust status flagged confirmed
    assert data["trust_status"]["status_text"] == "Flagged — signal inconsistency detected"
    assert data["trust_status"]["is_flagged"] is True
    assert data["trust_status"]["combined_risk_score"] >= 0.8
    assert "climb_rate" in data["trust_status"]["rule_flags"]
    assert data["trust_status"]["rule_flags"]["climb_rate"] is True

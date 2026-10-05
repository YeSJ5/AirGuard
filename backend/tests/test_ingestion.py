import os
import json
import pytest
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock
import httpx

from app.ingestion.service import OpenSkyIngestionService, CircuitBreakerOpenException
from app.ingestion.sources import OpenSkyStateVectorSource

# Load fixture
FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures/opensky_fixture.json")

def load_fixture():
    with open(FIXTURE_PATH, "r") as f:
        return json.load(f)

@pytest.mark.asyncio
async def test_normalization():
    # Setup test queue
    queue = asyncio.Queue()
    db_session_maker = MagicMock()
    
    service = OpenSkyIngestionService(queue=queue, db_session_maker=db_session_maker)
    
    # Pre-populate known entities cache
    service.known_entities = {
        "d81234": "MILITARY_TARGET_A"
    }
    
    fixture_data = load_fixture()
    states = fixture_data["states"]
    
    # 1. Test UAL824 (normal flight)
    val = service.normalize_state(states[0])
    assert val is not None
    assert val["icao24"] == "a1b2c3"
    assert val["callsign"] == "UAL824"
    assert val["latitude"] == 37.7749
    assert val["longitude"] == -122.4194
    assert val["altitude_m"] == 10000.0
    assert val["velocity_ms"] == 250.0
    assert val["heading_deg"] == 180.0
    assert val["on_ground"] is False
    assert val["metadata"]["is_known_entity"] is False
    
    # 2. Test DLH452 (null baro altitude, falls back to geo altitude 10050.0)
    val = service.normalize_state(states[1])
    assert val is not None
    assert val["altitude_m"] == 10050.0
    
    # 3. Test MIL-1 (null velocities, heading -> defaults to 0.0, known entity check)
    val = service.normalize_state(states[2])
    assert val is not None
    assert val["velocity_ms"] == 0.0
    assert val["heading_deg"] == 0.0
    assert val["metadata"]["is_known_entity"] is True
    assert val["metadata"]["known_entity_label"] == "MILITARY_TARGET_A"

    # 4. Test f9232a (missing longitude -> should be skipped)
    val = service.normalize_state(states[3])
    assert val is None

    # 5. Test AAL102 (on ground is true)
    val = service.normalize_state(states[4])
    assert val is not None
    assert val["on_ground"] is True


@pytest.mark.asyncio
async def test_circuit_breaker_and_backoff():
    queue = asyncio.Queue()
    db_session_maker = MagicMock()
    
    # Initialize with max_retries = 3 and short cooldown = 1s for testing
    service = OpenSkyIngestionService(
        queue=queue, 
        db_session_maker=db_session_maker,
        max_retries=3,
        cooldown_seconds=1.0
    )
    
    # Mock the underlying HTTP request used by the OpenSky source adapter.
    mock_request = AsyncMock()
    service.client.request = mock_request
    
    # Step 1: Simulate 1st failure (consecutive_failures=1, backoff 2^1 = 2s)
    mock_request.side_effect = httpx.ConnectError("Connection timed out")
    assert await service.poll_api() is None
        
    assert service.consecutive_failures == 1
    assert service.breaker_state == "CLOSED"
    assert service.backoff_seconds == 2.0

    # Step 2: Simulate 2nd failure (backoff 2^2 = 4s)
    assert await service.poll_api() is None
        
    assert service.consecutive_failures == 2
    assert service.breaker_state == "CLOSED"
    assert service.backoff_seconds == 4.0

    # Step 3: Simulate 3rd failure (consecutive_failures=3 reaches max_retries=3 -> TRIPS BREAKER TO OPEN)
    assert await service.poll_api() is None
        
    assert service.consecutive_failures == 3
    assert service.breaker_state == "OPEN"
    assert service.backoff_seconds == 0.0 # Resets backoff during OPEN
    
    # Step 4: Next poll immediately should raise CircuitBreakerOpenException (cooldown active)
    with pytest.raises(CircuitBreakerOpenException):
        await service.poll_api()
        
    # Step 5: Wait 1.1s for cooldown to expire
    await asyncio.sleep(1.1)
    
    # Next poll should change state to HALF_OPEN and run the query.
    # Set the return value to a successful mock response
    mock_res = MagicMock()
    mock_res.status_code = 200
    mock_res.headers = {"x-rate-limit-remaining": "100"}
    mock_res.json.return_value = {"states": [
        ["a1b2c3", "UAL824", "USA", 1722784490, 1722784495, -122.4194, 37.7749, 10000.0, False, 250.0, 180.0, 0.0, None, 10100.0, "1200", False, 0]
    ]}
    mock_request.side_effect = None
    mock_request.return_value = mock_res
    
    states = await service.poll_api()
    assert len(states) == 1
    assert states[0]["icao24"] == "a1b2c3"
    
    # Breaker should recover to CLOSED and consecutive_failures resets
    assert service.breaker_state == "CLOSED"
    assert service.consecutive_failures == 0


def test_opensky_snapshot_shape_distinguishes_empty_from_invalid():
    assert OpenSkyStateVectorSource.decode({"states": None}) == []
    assert OpenSkyStateVectorSource.decode({"states": []}) == []
    with pytest.raises(ValueError, match="missing the required states field"):
        OpenSkyStateVectorSource.decode({"time": 123})
    with pytest.raises(ValueError, match="unexpected states shape"):
        OpenSkyStateVectorSource.decode({"states": "not-a-list"})


@pytest.mark.asyncio
async def test_valid_empty_poll_replaces_snapshot(monkeypatch):
    service = OpenSkyIngestionService(queue=asyncio.Queue(), db_session_maker=MagicMock())
    response = MagicMock(status_code=200, headers={"x-rate-limit-remaining": "42"})
    source = MagicMock(name="test_feed")
    source.name = "test_feed"
    source.fetch = AsyncMock(return_value=(response, []))
    service.source_adapter = source
    service.last_valid_snapshot = [{"icao24": "abc123"}]
    service._broadcast_refresh_state = AsyncMock()

    from app.core.redis import redis_client
    from app.api.v1 import endpoints
    monkeypatch.setattr(redis_client, "ping", AsyncMock(return_value=True))
    monkeypatch.setattr(endpoints, "invalidate_snapshot_cache", AsyncMock())

    assert await service.run_single_poll_cycle() == 0
    assert service.last_valid_snapshot == []
    assert service.last_successful_update is not None
    assert service.current_source_status == "FRESH"
    await service.client.aclose()


@pytest.mark.asyncio
async def test_failed_poll_retains_last_valid_snapshot():
    service = OpenSkyIngestionService(queue=asyncio.Queue(), db_session_maker=MagicMock())
    source = MagicMock(name="test_feed")
    source.name = "test_feed"
    source.fetch = AsyncMock(side_effect=httpx.ConnectError("temporary outage"))
    service.source_adapter = source
    previous_snapshot = [{"icao24": "abc123"}]
    service.last_valid_snapshot = previous_snapshot
    service._broadcast_refresh_state = AsyncMock()

    assert await service.run_single_poll_cycle() == 1
    assert service.last_valid_snapshot is previous_snapshot
    assert service.current_source_status == "UNAVAILABLE"
    assert service.last_error
    assert service.next_attempt_at is not None
    await service.client.aclose()


@pytest.mark.asyncio
async def test_rate_limit_retry_after_controls_next_attempt_and_preserves_snapshot():
    service = OpenSkyIngestionService(queue=asyncio.Queue(), db_session_maker=MagicMock())
    response = MagicMock(status_code=429, headers={"retry-after": "120"}, text="rate limited")
    source = MagicMock(name="test_feed")
    source.name = "test_feed"
    source.fetch = AsyncMock(return_value=(response, []))
    service.source_adapter = source
    previous_snapshot = [{"icao24": "abc123"}]
    service.last_valid_snapshot = previous_snapshot
    service._broadcast_refresh_state = AsyncMock()

    assert await service.poll_api() is None
    assert service.last_valid_snapshot is previous_snapshot
    assert service.current_source_status == "RATE_LIMITED"
    assert service.retry_after_until is not None
    assert service.next_attempt_at == service.retry_after_until
    assert service.cooldown_until == service.retry_after_until.timestamp()
    await service.client.aclose()


@pytest.mark.asyncio
async def test_manual_refresh_is_queued_without_bypassing_retry_deadline():
    service = OpenSkyIngestionService(queue=asyncio.Queue(), db_session_maker=MagicMock())
    service.next_attempt_at = datetime.now(timezone.utc) + timedelta(seconds=15)
    service._broadcast_refresh_state = AsyncMock()

    result = await service.request_manual_refresh()
    assert result["accepted"] is True
    assert result["queued"] is True
    assert service.next_attempt_at > datetime.now(timezone.utc)
    assert service.manual_refresh_requested is True
    duplicate = await service.request_manual_refresh()
    assert duplicate["accepted"] is False
    await service.client.aclose()

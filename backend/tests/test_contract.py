import os
from datetime import datetime, timezone

os.environ["RUN_INGESTION"] = "false"

from unittest.mock import AsyncMock, MagicMock

import pytest
import schemathesis
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    get_current_user,
    require_admin,
    require_analyst,
    require_viewer,
)
from app.core.database import get_db
from app.main import app
from app.models import User

# Disable Rate Limiting during contract testing to prevent 429 errors
if hasattr(app.state, "limiter"):
    app.state.limiter.enabled = False


@pytest.fixture(autouse=True)
def contract_dependencies(monkeypatch):
    """Reinstall contract-only overrides for every case.

    Other API unit-test fixtures clear app overrides during teardown; setting
    these only at module import made later schema cases hit real local services.
    """
    previous = dict(app.dependency_overrides)

    async def mock_get_db():
        mock_session = MagicMock(spec=AsyncSession)

        async def mock_execute(*args, **kwargs):
            mock_result = MagicMock()
            mock_result.scalars.return_value.all.return_value = []
            mock_result.all.return_value = []
            mock_result.scalar.return_value = None
            mock_result.scalar_one_or_none.return_value = None
            mock_result.scalar_one.return_value = None
            return mock_result

        mock_session.execute = mock_execute

        def mock_add(instance):
            # Simulate a database-generated primary key for rows created by a
            # successful endpoint; validation failures never enter this path.
            if isinstance(instance, User) and instance.id is None:
                instance.id = 1

        mock_session.add = mock_add
        yield mock_session

    async def mock_user_dependency():
        return User(
            id=1,
            email="admin@airguard.sec",
            role="admin",
            created_at=datetime.now(timezone.utc),
        )

    app.dependency_overrides[get_db] = mock_get_db
    app.dependency_overrides[get_current_user] = mock_user_dependency
    app.dependency_overrides[require_viewer] = mock_user_dependency
    app.dependency_overrides[require_analyst] = mock_user_dependency
    app.dependency_overrides[require_admin] = mock_user_dependency
    # Keep schema generation independent from Redis socket timeouts. These mocks
    # do not represent service availability; that is checked separately.
    monkeypatch.setattr(
        "app.api.v1.endpoints.redis_client.get", AsyncMock(return_value=None)
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.redis_client.setex", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.redis_client.keys", AsyncMock(return_value=[])
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.redis_client.delete", AsyncMock(return_value=0)
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.redis_client.publish", AsyncMock(return_value=1)
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.redis_client.xlen", AsyncMock(return_value=0)
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.redis_client.ping", AsyncMock(return_value=True)
    )

    class ContractRouteService:
        async def get_or_fetch_route(self, icao24, callsign=None, db=None):
            return {
                "icao24": icao24,
                "session_id": "contract-session",
                "callsign": callsign,
                "route_text": "Route unknown",
            }

    monkeypatch.setattr(
        "app.api.v1.endpoints.active_route_service", ContractRouteService()
    )

    class ContractIngestionService:
        async def request_manual_refresh(self):
            return {
                "accepted": True,
                "queued": True,
                "source_status": "AWAITING_TELEMETRY",
            }

    monkeypatch.setattr(
        "app.api.v1.endpoints.active_ingestion_service", ContractIngestionService()
    )
    monkeypatch.setattr(
        "app.ingestion.metadata_service.active_metadata_service.get_aircraft_metadata",
        AsyncMock(return_value={"source": "unavailable"}),
    )
    yield
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)


class ContractASGI:
    """Expose the HTTP ASGI app without restarting external services per case.

    Lifespan is verified separately by application tests and real service runs.
    Starting models and Redis listeners for every generated contract example
    made this request-only contract test slow and coupled it to local services.
    """

    def __init__(self, application):
        self.application = application

    async def __call__(self, scope, receive, send):
        if scope["type"] != "lifespan":
            await self.application(scope, receive, send)
            return
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return


# Contract cases verify request/response behavior; service startup is covered
# independently so Schemathesis does not restart model and Redis tasks per case.
schema = schemathesis.openapi.from_asgi("/api/v1/openapi.json", ContractASGI(app))


@schema.parametrize()
@pytest.mark.filterwarnings("ignore::DeprecationWarning")
def test_api_contracts(case):
    """
    Contract test executing Schemathesis parameters generation against
    the API schema definitions using from_asgi.
    """
    response = case.call()

    # Run positive schema conformance checks only to avoid negative-data false alarms
    case.validate_response(
        response,
        checks=(
            schemathesis.checks.not_a_server_error,
            schemathesis.checks.status_code_conformance,
            schemathesis.checks.content_type_conformance,
            schemathesis.checks.response_schema_conformance,
        ),
    )

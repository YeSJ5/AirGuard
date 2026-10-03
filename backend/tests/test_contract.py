import os
os.environ["RUN_INGESTION"] = "false"

import pytest
import schemathesis
from unittest.mock import MagicMock
from sqlalchemy.ext.asyncio import AsyncSession
from app.main import app
from app.core.database import get_db
from app.api.deps import require_viewer, require_analyst, require_admin
from app.models import User

# Disable Rate Limiting during contract testing to prevent 429 errors
if hasattr(app.state, "limiter"):
    app.state.limiter.enabled = False

# Mock DB Session yielding
async def mock_get_db():
    mock_session = MagicMock(spec=AsyncSession)
    
    async def mock_execute(*args, **kwargs):
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_result.scalar.return_value = None
        return mock_result
        
    mock_session.execute = mock_execute
    yield mock_session

# Mock User dependency returning active User
async def mock_user_dependency():
    return User(id=1, email="admin@airguard.sec", role="admin")

# Register Dependency Overrides
app.dependency_overrides[get_db] = mock_get_db
app.dependency_overrides[require_viewer] = mock_user_dependency
app.dependency_overrides[require_analyst] = mock_user_dependency
app.dependency_overrides[require_admin] = mock_user_dependency

# Load openapi schema via schemathesis.openapi.from_asgi
schema = schemathesis.openapi.from_asgi("/api/v1/openapi.json", app)

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
        )
    )

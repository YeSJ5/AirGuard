import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

from unittest.mock import AsyncMock, patch
from app.core.database import get_db

@pytest.mark.asyncio
async def test_health_check():
    async def mock_get_db():
        mock_session = AsyncMock()
        yield mock_session

    app.dependency_overrides[get_db] = mock_get_db
    try:
        with patch("app.main.redis_client.ping", AsyncMock(return_value=True)):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["service"] == "AirGuard"
    finally:
        app.dependency_overrides.pop(get_db, None)

"""Shared OAuth2 client-credentials authentication for OpenSky REST requests."""

import asyncio
import time
from typing import Any

import httpx

from app.core.config import settings


TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"


class OpenSkyAuth:
    def __init__(self) -> None:
        self.client_id = settings.OPENSKY_CLIENT_ID.strip()
        self.client_secret = settings.OPENSKY_CLIENT_SECRET.strip()
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()
        self._token_client = httpx.AsyncClient(timeout=10.0)

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    async def _get_token(self, force_refresh: bool = False, rejected_token: str | None = None) -> str | None:
        if not self.configured:
            return None
        if not force_refresh and self._token and time.monotonic() < self._expires_at:
            return self._token

        async with self._lock:
            # Another request may already have replaced a token that was rejected
            # on the caller's request; reuse that fresh token instead of racing a
            # second OAuth exchange.
            if rejected_token and self._token and self._token != rejected_token and time.monotonic() < self._expires_at:
                return self._token
            if not force_refresh and self._token and time.monotonic() < self._expires_at:
                return self._token
            response = await self._token_client.post(
                TOKEN_URL,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            response.raise_for_status()
            payload = response.json()
            token = payload.get("access_token")
            if not isinstance(token, str) or not token:
                raise RuntimeError("OpenSky token response did not contain an access token")
            lifetime = max(60, int(payload.get("expires_in", 1800)))
            self._token = token
            self._expires_at = time.monotonic() + max(1, lifetime - min(60, lifetime // 10))
            return token

    async def request(self, client: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}) or {})
        token = await self._get_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        response = await client.request(method, url, headers=headers, **kwargs)
        if response.status_code == 401 and token:
            token = await self._get_token(force_refresh=True, rejected_token=token)
            if token:
                headers["Authorization"] = f"Bearer {token}"
                response = await client.request(method, url, headers=headers, **kwargs)
        return response

    async def aclose(self) -> None:
        await self._token_client.aclose()
        self._token = None
        self._expires_at = 0.0
        self._token_client = httpx.AsyncClient(timeout=10.0)


opensky_auth = OpenSkyAuth()

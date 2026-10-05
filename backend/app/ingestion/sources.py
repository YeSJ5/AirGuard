"""Provider adapters for live surveillance feeds.

Adapters own provider-specific transport and wire-format handling. The
ingestion service can consume any adapter that returns canonical observations.
"""
from __future__ import annotations

from typing import Any, Mapping, Protocol, Sequence

import httpx

from app.ingestion.opensky_auth import opensky_auth


class SurveillanceSource(Protocol):
    name: str

    async def fetch(self, client: httpx.AsyncClient, url: str, params: dict[str, Any]) -> tuple[httpx.Response, list[dict[str, Any]]]:
        """Return the raw response for telemetry and canonical observations."""


class OpenSkyStateVectorSource:
    """Translate OpenSky's indexed state vectors into named observations."""

    name = "opensky"
    FIELDS = (
        "icao24", "callsign", "origin_country", "time_position", "last_contact",
        "longitude", "latitude", "baro_altitude", "on_ground", "velocity",
        "true_track", "vertical_rate", "sensors", "geo_altitude", "squawk",
        "spi", "position_source", "category",
    )

    @classmethod
    def decode(cls, payload: Any) -> list[dict[str, Any]]:
        if not isinstance(payload, Mapping):
            raise ValueError("OpenSky returned a non-object response")
        if "states" not in payload:
            raise ValueError("OpenSky response is missing the required states field")
        vectors = payload["states"]
        if vectors is None:
            return []
        if not isinstance(vectors, Sequence) or isinstance(vectors, (str, bytes)):
            raise ValueError("OpenSky returned an unexpected states shape")
        result = []
        for vector in vectors:
            if not isinstance(vector, Sequence) or isinstance(vector, (str, bytes)):
                continue
            result.append({field: vector[i] if i < len(vector) else None for i, field in enumerate(cls.FIELDS)})
        return result

    async def fetch(self, client: httpx.AsyncClient, url: str, params: dict[str, Any]) -> tuple[httpx.Response, list[dict[str, Any]]]:
        response = await opensky_auth.request(client, "GET", url, params=params)
        records = self.decode(response.json()) if response.status_code == 200 else []
        return response, records

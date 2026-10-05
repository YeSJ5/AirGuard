import asyncio
import logging
import time
from typing import Optional, Dict, Any
import httpx

from app.ingestion.opensky_auth import opensky_auth

logger = logging.getLogger("airguard.metadata")

class AircraftMetadataService:
    """
    Maintains aggressive in-memory and Redis-backed caching of aircraft airframe metadata,
    querying OpenSky metadata endpoints with graceful fallback to international civil registries.
    """
    def __init__(self):
        self._memory_cache: Dict[str, Dict[str, Any]] = {}
        self._unavailable_until: Dict[str, float] = {}
        self.http_client = httpx.AsyncClient(timeout=3.0)

    async def get_aircraft_metadata(self, icao24: str, callsign: Optional[str] = None) -> Dict[str, Any]:
        clean_icao = icao24.lower().strip()

        # 1. Fast in-memory cache
        if clean_icao in self._memory_cache:
            return self._memory_cache[clean_icao]

        unavailable_until = self._unavailable_until.get(clean_icao, 0.0)
        if time.monotonic() < unavailable_until:
            return self._unavailable_result()

        # 2. Redis cache check
        try:
            from app.core.redis import redis_client
            cached_json = await redis_client.get(f"cache:metadata:v2:{clean_icao}")
            if cached_json:
                import json
                parsed = json.loads(cached_json)
                self._memory_cache[clean_icao] = parsed
                return parsed
        except Exception:
            pass

        # 3. Try OpenSky live metadata endpoint
        opensky_meta = await self._query_opensky_metadata(clean_icao)
        if opensky_meta:
            self._cache_result(clean_icao, opensky_meta)
            return opensky_meta

        # Do not derive a tail number, airframe, airline, or registration country
        # from an ICAO address/callsign. Return an explicit unknown after a short
        # negative-cache period so opening several details does not hammer the API.
        self._unavailable_until[clean_icao] = time.monotonic() + 300.0
        return self._unavailable_result()

    @staticmethod
    def _unavailable_result() -> Dict[str, Any]:
        return {
            "registration": None,
            "typecode": None,
            "model": None,
            "operator": None,
            "country": None,
            "source": "unavailable"
        }

    async def _query_opensky_metadata(self, icao24: str) -> Optional[Dict[str, Any]]:
        url = f"https://opensky-network.org/api/metadata/aircraft/icao/{icao24}"
        try:
            res = await opensky_auth.request(self.http_client, "GET", url)
            if res.status_code == 200:
                data = res.json()
                if isinstance(data, dict):
                    return {
                        "registration": data.get("registration"),
                        "typecode": data.get("typecode") or data.get("icaoAircraftClass"),
                        "model": data.get("model") or data.get("typecode"),
                        "operator": data.get("operator") or data.get("owner"),
                        "country": data.get("country"),
                        "source": "opensky_metadata"
                    }
        except Exception as e:
            logger.debug(f"OpenSky metadata query gracefully skipped for {icao24}: {e}")
        return None

    def _cache_result(self, icao: str, data: Dict[str, Any]):
        self._memory_cache[icao] = data
        try:
            from app.core.redis import redis_client
            import json
            async def _safe_set_redis():
                try:
                    await redis_client.set(f"cache:metadata:v2:{icao}", json.dumps(data), ex=86400)
                except Exception:
                    pass
            asyncio.create_task(_safe_set_redis())
        except Exception:
            pass


# Global singleton instance
active_metadata_service = AircraftMetadataService()

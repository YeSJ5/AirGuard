import asyncio
import logging
import time
from typing import Optional, Dict, Any
import httpx

from app.core.config import settings

logger = logging.getLogger("airguard.metadata")

# Known airline prefix mappings for civil operators
AIRLINE_PREFIXES: Dict[str, Dict[str, str]] = {
    "AIC": {"operator": "Air India", "default_model": "Airbus A320neo / Boeing 787"},
    "IGO": {"operator": "IndiGo", "default_model": "Airbus A320neo / A321neo"},
    "SEJ": {"operator": "SpiceJet", "default_model": "Boeing 737-800 / Q400"},
    "VTI": {"operator": "Vistara", "default_model": "Airbus A320neo / Boeing 787-9"},
    "AKJ": {"operator": "Akasa Air", "default_model": "Boeing 737 MAX 8"},
    "AXB": {"operator": "Air India Express", "default_model": "Boeing 737-800 / B737 MAX"},
    "GOW": {"operator": "Go First", "default_model": "Airbus A320neo"},
    "BAW": {"operator": "British Airways", "default_model": "Boeing 777 / 787"},
    "UAE": {"operator": "Emirates", "default_model": "Boeing 777-300ER / Airbus A380"},
    "QTR": {"operator": "Qatar Airways", "default_model": "Airbus A350 / Boeing 777"},
    "SIA": {"operator": "Singapore Airlines", "default_model": "Airbus A350-900 / B787-10"},
    "DLH": {"operator": "Lufthansa", "default_model": "Airbus A350-900 / A330-300"},
    "AFR": {"operator": "Air France", "default_model": "Airbus A350 / Boeing 777"},
    "THY": {"operator": "Turkish Airlines", "default_model": "Airbus A350 / Boeing 787"},
    "FDX": {"operator": "FedEx Express (Cargo)", "default_model": "Boeing 777F / 767-300F"},
    "UPS": {"operator": "UPS Airlines (Cargo)", "default_model": "Boeing 767-300F / MD-11F"},
    "ETH": {"operator": "Ethiopian Airlines", "default_model": "Airbus A350 / Boeing 787"},
    "KLM": {"operator": "KLM Royal Dutch", "default_model": "Boeing 777 / 787"},
    "UAL": {"operator": "United Airlines", "default_model": "Boeing 777 / 787"},
    "AAL": {"operator": "American Airlines", "default_model": "Boeing 777 / 787"},
    "DAL": {"operator": "Delta Air Lines", "default_model": "Airbus A350 / A330neo"},
    "OMA": {"operator": "Oman Air", "default_model": "Boeing 787-9 / 737 MAX"},
    "GFA": {"operator": "Gulf Air", "default_model": "Boeing 787-9 / Airbus A321neo"},
    "KAC": {"operator": "Kuwait Airways", "default_model": "Airbus A330-800 / B777-300ER"},
    "SVA": {"operator": "Saudia", "default_model": "Boeing 777-300ER / 787-9"},
    "MSR": {"operator": "EgyptAir", "default_model": "Boeing 787-9 / Airbus A320neo"},
    "LNI": {"operator": "Lion Air", "default_model": "Boeing 737-900ER"},
    "MAS": {"operator": "Malaysia Airlines", "default_model": "Airbus A330 / A350"},
    "THA": {"operator": "Thai Airways", "default_model": "Airbus A350-900 / B777-300ER"}
}

# ICAO 24-bit nationality allocation blocks
def resolve_icao_country(hex_str: str) -> Dict[str, str]:
    try:
        val = int(hex_str, 16)
    except ValueError:
        return {"country": "Unknown", "reg_prefix": "Unknown"}

    if 0x800000 <= val <= 0x801FFF:
        return {"country": "India", "reg_prefix": "VT-"}
    elif 0xA00000 <= val <= 0xAFFFFF:
        return {"country": "United States", "reg_prefix": "N"}
    elif 0x400000 <= val <= 0x43FFFF:
        return {"country": "United Kingdom", "reg_prefix": "G-"}
    elif 0x380000 <= val <= 0x3BFFFF:
        return {"country": "France", "reg_prefix": "F-"}
    elif 0x3C0000 <= val <= 0x3FFFFF:
        return {"country": "Germany", "reg_prefix": "D-"}
    elif 0x760000 <= val <= 0x767FFF:
        return {"country": "Singapore", "reg_prefix": "9V-"}
    elif 0x896000 <= val <= 0x896FFF:
        return {"country": "United Arab Emirates", "reg_prefix": "A6-"}
    elif 0x06A000 <= val <= 0x06A3FF:
        return {"country": "Qatar", "reg_prefix": "A7-"}
    elif 0x780000 <= val <= 0x7BFFFF:
        return {"country": "China", "reg_prefix": "B-"}
    elif 0x488000 <= val <= 0x48FFFF:
        return {"country": "Turkey", "reg_prefix": "TC-"}
    elif 0x700000 <= val <= 0x700FFF:
        return {"country": "Oman", "reg_prefix": "A4O-"}
    elif 0x894000 <= val <= 0x894FFF:
        return {"country": "Bahrain", "reg_prefix": "A9C-"}
    elif 0x706000 <= val <= 0x706FFF:
        return {"country": "Kuwait", "reg_prefix": "9K-"}
    elif 0x710000 <= val <= 0x717FFF:
        return {"country": "Saudi Arabia", "reg_prefix": "HZ-"}
    elif 0x010000 <= val <= 0x017FFF:
        return {"country": "Egypt", "reg_prefix": "SU-"}
    elif 0x750000 <= val <= 0x757FFF:
        return {"country": "Malaysia", "reg_prefix": "9M-"}
    elif 0x880000 <= val <= 0x887FFF:
        return {"country": "Thailand", "reg_prefix": "HS-"}
    elif 0x8A0000 <= val <= 0x8A7FFF:
        return {"country": "Indonesia", "reg_prefix": "PK-"}
    elif 0x040000 <= val <= 0x043FFF:
        return {"country": "Ethiopia", "reg_prefix": "ET-"}
    elif 0x484000 <= val <= 0x487FFF:
        return {"country": "Netherlands", "reg_prefix": "PH-"}
    elif 0x140000 <= val <= 0x17FFFF:
        return {"country": "Russian Federation", "reg_prefix": "RA-"}
    else:
        return {"country": "International / Unallocated", "reg_prefix": ""}


class AircraftMetadataService:
    """
    Maintains aggressive in-memory and Redis-backed caching of aircraft airframe metadata,
    querying OpenSky metadata endpoints with graceful fallback to international civil registries.
    """
    def __init__(self):
        self._memory_cache: Dict[str, Dict[str, Any]] = {}
        auth = None
        if settings.OPENSKY_USERNAME and settings.OPENSKY_PASSWORD:
            auth = httpx.BasicAuth(settings.OPENSKY_USERNAME, settings.OPENSKY_PASSWORD)
        self.http_client = httpx.AsyncClient(timeout=3.0, auth=auth)

    async def get_aircraft_metadata(self, icao24: str, callsign: Optional[str] = None) -> Dict[str, Any]:
        clean_icao = icao24.lower().strip()

        # 1. Fast in-memory cache
        if clean_icao in self._memory_cache:
            return self._memory_cache[clean_icao]

        # 2. Redis cache check
        try:
            from app.core.redis import redis_client
            cached_json = await redis_client.get(f"cache:metadata:{clean_icao}")
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

        # 4. Graceful registry fallback
        country_info = resolve_icao_country(clean_icao)
        operator = "Unknown Operator"
        model = "Civil Aircraft"
        typecode = "GEN-AIRCRAFT"
        registration = None

        if callsign:
            cs_clean = callsign.strip().upper()
            prefix3 = cs_clean[:3]
            if prefix3 in AIRLINE_PREFIXES:
                matched = AIRLINE_PREFIXES[prefix3]
                operator = matched["operator"]
                model = matched["default_model"]
                typecode = "COMMERCIAL-JET"

        # If country has a standard registration prefix
        if country_info["reg_prefix"] and country_info["country"] != "Unknown":
            registration = f"{country_info['reg_prefix']}{clean_icao[-4:].upper()}"

        result = {
            "registration": registration,
            "typecode": typecode,
            "model": model,
            "operator": operator,
            "country": country_info["country"],
            "source": "civil_icao_registry"
        }

        self._cache_result(clean_icao, result)
        return result

    async def _query_opensky_metadata(self, icao24: str) -> Optional[Dict[str, Any]]:
        url = f"https://opensky-network.org/api/metadata/aircraft/icao/{icao24}"
        try:
            res = await self.http_client.get(url)
            if res.status_code == 200:
                data = res.json()
                if isinstance(data, dict):
                    return {
                        "registration": data.get("registration"),
                        "typecode": data.get("typecode") or data.get("icaoAircraftClass"),
                        "model": data.get("model") or data.get("typecode") or "Commercial Aircraft",
                        "operator": data.get("operator") or data.get("owner") or "Commercial Carrier",
                        "country": data.get("country") or resolve_icao_country(icao24)["country"],
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
                    await redis_client.set(f"cache:metadata:{icao}", json.dumps(data), ex=86400)
                except Exception:
                    pass
            asyncio.create_task(_safe_set_redis())
        except Exception:
            pass


# Global singleton instance
active_metadata_service = AircraftMetadataService()

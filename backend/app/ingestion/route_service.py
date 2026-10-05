import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ingestion.opensky_auth import opensky_auth
from app.models import FlightRoute

logger = logging.getLogger("airguard.routes")

# Dictionary of major Indian/regional airports for operator readability
AIRPORT_NAMES: dict[str, str] = {
    "VIDP": "Delhi (DEL/VIDP)",
    "VABB": "Mumbai (BOM/VABB)",
    "VOBL": "Bengaluru (BLR/VOBL)",
    "VOMM": "Chennai (MAA/VOMM)",
    "VECC": "Kolkata (CCU/VECC)",
    "VOHS": "Hyderabad (HYD/VOHS)",
    "VOCI": "Cochin (COK/VOCI)",
    "VAAH": "Ahmedabad (AMD/VAAH)",
    "VOGO": "Goa Dabolim (GOI/VOGO)",
    "VOGA": "Goa Mopa (GOX/VOGA)",
    "VOTP": "Tirupati (TIR/VOTP)",
    "VIJP": "Jaipur (JAI/VIJP)",
    "VILK": "Lucknow (LKO/VILK)",
    "VOCB": "Coimbatore (CJB/VOCB)",
    "VEGY": "Gaya (GAY/VEGY)",
    "VEBS": "Bhubaneswar (BBI/VEBS)",
    "VEGT": "Guwahati (GAU/VEGT)",
    "VABO": "Vadodara (BDQ/VABO)",
    "VAPO": "Pune (PNQ/VAPO)",
    "VANP": "Nagpur (NAG/VANP)",
    "VAID": "Indore (IDR/VAID)",
    "VEBD": "Bagdogra (IXB/VEBD)",
    "VOPB": "Port Blair (IXZ/VOPB)",
    "VOCL": "Calicut (CCJ/VOCL)",
    "VOTV": "Trivandrum (TRV/VOTV)",
    "VEPT": "Patna (PAT/VEPT)",
    "VIAR": "Amritsar (ATQ/VIAR)",
    "VISR": "Srinagar (SXR/VISR)",
    "OMDB": "Dubai Int'l (DXB/OMDB)",
    "OMAA": "Abu Dhabi (AUH/OMAA)",
    "OTHH": "Doha Hamad (DOH/OTHH)",
    "WSSS": "Singapore Changi (SIN/WSSS)",
    "VTBS": "Bangkok Suvarnabhumi (BKK/VTBS)",
    "OOMS": "Muscat (MCT/OOMS)",
    "OBBI": "Bahrain (BAH/OBBI)",
    "OKBK": "Kuwait (KWI/OKBK)",
    "OERK": "Riyadh (RUH/OERK)",
    "OEJN": "Jeddah (JED/OEJN)",
    "EGLL": "London Heathrow (LHR/EGLL)",
    "EDDF": "Frankfurt (FRA/EDDF)",
    "EHAM": "Amsterdam Schiphol (AMS/EHAM)",
    "KJFK": "New York JFK (JFK/KJFK)",
}

AIRPORT_COORDINATES: dict[str, dict[str, Any]] = {
    "VIDP": {
        "lat": 28.5562,
        "lng": 77.1000,
        "name": "Indira Gandhi Intl",
        "city": "Delhi",
        "iata": "DEL",
    },
    "VABB": {
        "lat": 19.0896,
        "lng": 72.8656,
        "name": "Chhatrapati Shivaji Intl",
        "city": "Mumbai",
        "iata": "BOM",
    },
    "VOBL": {
        "lat": 13.1986,
        "lng": 77.7066,
        "name": "Kempegowda Intl",
        "city": "Bengaluru",
        "iata": "BLR",
    },
    "VOMM": {
        "lat": 12.9941,
        "lng": 80.1709,
        "name": "Chennai Intl",
        "city": "Chennai",
        "iata": "MAA",
    },
    "VECC": {
        "lat": 22.6547,
        "lng": 88.4467,
        "name": "Netaji Subhash Chandra Bose Intl",
        "city": "Kolkata",
        "iata": "CCU",
    },
    "VOHS": {
        "lat": 17.2403,
        "lng": 78.4294,
        "name": "Rajiv Gandhi Intl",
        "city": "Hyderabad",
        "iata": "HYD",
    },
    "VOCI": {
        "lat": 10.1518,
        "lng": 76.3929,
        "name": "Cochin Intl",
        "city": "Kochi",
        "iata": "COK",
    },
    "VAAH": {
        "lat": 23.0772,
        "lng": 72.6347,
        "name": "Sardar Vallabhbhai Patel Intl",
        "city": "Ahmedabad",
        "iata": "AMD",
    },
    "VOGO": {
        "lat": 15.3808,
        "lng": 73.8314,
        "name": "Dabolim",
        "city": "Goa",
        "iata": "GOI",
    },
    "VOGA": {
        "lat": 15.7428,
        "lng": 73.8661,
        "name": "Manohar Intl Mopa",
        "city": "Goa",
        "iata": "GOX",
    },
    "VIJP": {
        "lat": 26.8242,
        "lng": 75.8122,
        "name": "Jaipur Intl",
        "city": "Jaipur",
        "iata": "JAI",
    },
    "VILK": {
        "lat": 26.7606,
        "lng": 80.8893,
        "name": "Chaudhary Charan Singh Intl",
        "city": "Lucknow",
        "iata": "LKO",
    },
    "VEGT": {
        "lat": 26.1061,
        "lng": 91.5859,
        "name": "Lokpriya Gopinath Bordoloi Intl",
        "city": "Guwahati",
        "iata": "GAU",
    },
    "VOCB": {
        "lat": 11.0299,
        "lng": 77.0434,
        "name": "Coimbatore Intl",
        "city": "Coimbatore",
        "iata": "CJB",
    },
    "VEBS": {
        "lat": 20.2444,
        "lng": 85.8178,
        "name": "Biju Patnaik Intl",
        "city": "Bhubaneswar",
        "iata": "BBI",
    },
    "VAPO": {
        "lat": 18.5821,
        "lng": 73.9197,
        "name": "Pune Intl",
        "city": "Pune",
        "iata": "PNQ",
    },
    "VANP": {
        "lat": 21.0922,
        "lng": 79.0594,
        "name": "Dr. Babasaheb Ambedkar Intl",
        "city": "Nagpur",
        "iata": "NAG",
    },
    "VAID": {
        "lat": 22.7217,
        "lng": 75.8011,
        "name": "Devi Ahilya Bai Holkar",
        "city": "Indore",
        "iata": "IDR",
    },
    "VEBD": {
        "lat": 26.6812,
        "lng": 88.3286,
        "name": "Bagdogra",
        "city": "Siliguri",
        "iata": "IXB",
    },
    "VOPB": {
        "lat": 11.6414,
        "lng": 92.7297,
        "name": "Veer Savarkar Intl",
        "city": "Port Blair",
        "iata": "IXZ",
    },
    "VOCL": {
        "lat": 11.1368,
        "lng": 75.9553,
        "name": "Calicut Intl",
        "city": "Kozhikode",
        "iata": "CCJ",
    },
    "VOTV": {
        "lat": 8.4821,
        "lng": 76.9200,
        "name": "Trivandrum Intl",
        "city": "Thiruvananthapuram",
        "iata": "TRV",
    },
    "VEPT": {
        "lat": 25.5913,
        "lng": 85.0880,
        "name": "Jay Prakash Narayan Intl",
        "city": "Patna",
        "iata": "PAT",
    },
    "VIAR": {
        "lat": 31.7096,
        "lng": 74.7973,
        "name": "Sri Guru Ram Dass Jee Intl",
        "city": "Amritsar",
        "iata": "ATQ",
    },
    "VISR": {
        "lat": 33.9871,
        "lng": 74.7741,
        "name": "Sheikh ul-Alam Intl",
        "city": "Srinagar",
        "iata": "SXR",
    },
    "OMDB": {
        "lat": 25.2532,
        "lng": 55.3657,
        "name": "Dubai Intl",
        "city": "Dubai",
        "iata": "DXB",
    },
    "OMAA": {
        "lat": 24.4330,
        "lng": 54.6511,
        "name": "Abu Dhabi Intl",
        "city": "Abu Dhabi",
        "iata": "AUH",
    },
    "OTHH": {
        "lat": 25.2731,
        "lng": 51.6081,
        "name": "Hamad Intl",
        "city": "Doha",
        "iata": "DOH",
    },
    "WSSS": {
        "lat": 1.3644,
        "lng": 103.9915,
        "name": "Singapore Changi",
        "city": "Singapore",
        "iata": "SIN",
    },
    "VTBS": {
        "lat": 13.6900,
        "lng": 100.7501,
        "name": "Suvarnabhumi",
        "city": "Bangkok",
        "iata": "BKK",
    },
    "OOMS": {
        "lat": 23.5933,
        "lng": 58.2844,
        "name": "Muscat Intl",
        "city": "Muscat",
        "iata": "MCT",
    },
    "OBBI": {
        "lat": 26.2708,
        "lng": 50.6336,
        "name": "Bahrain Intl",
        "city": "Manama",
        "iata": "BAH",
    },
    "OKBK": {
        "lat": 29.2268,
        "lng": 47.9689,
        "name": "Kuwait Intl",
        "city": "Kuwait City",
        "iata": "KWI",
    },
    "OERK": {
        "lat": 24.9576,
        "lng": 46.6988,
        "name": "King Khalid Intl",
        "city": "Riyadh",
        "iata": "RUH",
    },
    "OEJN": {
        "lat": 21.6796,
        "lng": 39.1565,
        "name": "King Abdulaziz Intl",
        "city": "Jeddah",
        "iata": "JED",
    },
    "EGLL": {
        "lat": 51.4700,
        "lng": -0.4543,
        "name": "London Heathrow",
        "city": "London",
        "iata": "LHR",
    },
    "EDDF": {
        "lat": 50.0379,
        "lng": 8.5622,
        "name": "Frankfurt Airport",
        "city": "Frankfurt",
        "iata": "FRA",
    },
    "EHAM": {
        "lat": 52.3105,
        "lng": 4.7683,
        "name": "Amsterdam Schiphol",
        "city": "Amsterdam",
        "iata": "AMS",
    },
    "KJFK": {
        "lat": 40.6413,
        "lng": -73.7781,
        "name": "John F. Kennedy Intl",
        "city": "New York",
        "iata": "JFK",
    },
}


def get_airport_coordinates(icao_code: str | None) -> dict[str, Any] | None:
    if not icao_code:
        return None
    return AIRPORT_COORDINATES.get(icao_code.upper().strip())


class FlightRouteService:
    def __init__(self, db_session_maker):
        self.db_session_maker = db_session_maker
        self.session_id = os.getenv(
            "AIRGUARD_SESSION_ID", datetime.now(timezone.utc).strftime("session-%Y%m%d")
        )

        # In-memory fast cache: icao24 -> dict of route info
        self._memory_cache: dict[str, dict[str, Any]] = {}

        self._semaphore = asyncio.Semaphore(
            1
        )  # Serialized OpenSky route requests to prevent 429
        self._rate_limited_until: float = 0.0
        self._last_request_at: float = 0.0

        # HTTP client
        self.http_client = httpx.AsyncClient(timeout=6.0)

    def get_cached_route(self, icao24: str) -> dict[str, Any] | None:
        return self._memory_cache.get(icao24.lower().strip())

    def _format_route_text(self, dep: str | None, arr: str | None) -> str:
        if dep and arr:
            dep_name = AIRPORT_NAMES.get(dep, dep)
            arr_name = AIRPORT_NAMES.get(arr, arr)
            return f"{dep_name} → {arr_name}"
        elif dep:
            dep_name = AIRPORT_NAMES.get(dep, dep)
            return f"{dep_name} → Route unknown"
        elif arr:
            arr_name = AIRPORT_NAMES.get(arr, arr)
            return f"Route unknown → {arr_name}"
        return "Route unknown"

    async def get_or_fetch_route(
        self, icao24: str, callsign: str | None = None, db: AsyncSession | None = None
    ) -> dict[str, Any]:
        """
        Retrieve route information for an aircraft. Checks:
        1. In-memory cache
        2. Database flight_routes table (keyed by icao24 + session_id)
        3. Live OpenSky /api/flights/aircraft endpoint (persists result)
        """
        icao = icao24.lower().strip()

        # 1. In-memory cache hit
        if icao in self._memory_cache:
            return self._memory_cache[icao]

        # 2. Check Database
        if db is not None:
            existing = await self._query_db_route(db, icao)
            if existing:
                self._memory_cache[icao] = existing
                return existing
        else:
            async with self.db_session_maker() as session:
                existing = await self._query_db_route(session, icao)
                if existing:
                    self._memory_cache[icao] = existing
                    return existing

        # 3. Fetch from OpenSky API
        return await self._fetch_and_persist_route(icao, callsign)

    async def _query_db_route(
        self, db: AsyncSession, icao: str
    ) -> dict[str, Any] | None:
        result = await db.execute(
            select(FlightRoute)
            .where(FlightRoute.icao24 == icao)
            .where(FlightRoute.session_id == self.session_id)
            .limit(1)
        )
        row = result.scalar_one_or_none()
        if row and hasattr(row, "session_id"):
            dep = getattr(row, "est_departure_airport", None)
            arr = getattr(row, "est_arrival_airport", None)
            dep_coords = get_airport_coordinates(dep)
            arr_coords = get_airport_coordinates(arr)
            return {
                "icao24": getattr(row, "icao24", icao),
                "session_id": getattr(row, "session_id", self.session_id),
                "callsign": getattr(row, "callsign", None),
                "est_departure_airport": dep,
                "est_arrival_airport": arr,
                "first_seen": getattr(row, "first_seen", None),
                "last_seen": getattr(row, "last_seen", None),
                "route_text": getattr(row, "route_text", "Route unknown"),
                "fetched_at": getattr(row, "fetched_at", None),
                "dep_lat": dep_coords["lat"] if dep_coords else None,
                "dep_lng": dep_coords["lng"] if dep_coords else None,
                "arr_lat": arr_coords["lat"] if arr_coords else None,
                "arr_lng": arr_coords["lng"] if arr_coords else None,
            }
        return None

    async def _fetch_and_persist_route(
        self, icao: str, callsign: str | None = None
    ) -> dict[str, Any]:
        now_ts = time.time()
        if now_ts < self._rate_limited_until:
            # Rate limited cooldown active — return graceful transient placeholder without persisting
            return {
                "icao24": icao,
                "session_id": self.session_id,
                "callsign": callsign,
                "est_departure_airport": None,
                "est_arrival_airport": None,
                "first_seen": None,
                "last_seen": None,
                "route_text": "Route unknown",
                "fetched_at": datetime.now(timezone.utc),
                "dep_lat": None,
                "dep_lng": None,
                "arr_lat": None,
                "arr_lng": None,
            }

        now = int(now_ts)
        time_window = 86400 if opensky_auth.configured else 7200
        begin = (
            now - time_window
        )  # 24 hours for authenticated OpenSky, 2 hours for anonymous
        url = f"https://opensky-network.org/api/flights/aircraft?icao24={icao}&begin={begin}&end={now}"

        dep = None
        arr = None
        first_seen_dt = None
        last_seen_dt = None
        resolved_callsign = callsign
        is_rate_limited = False

        async with self._semaphore:
            try:
                pacing_wait = 2.5 - (time.monotonic() - self._last_request_at)
                if pacing_wait > 0:
                    await asyncio.sleep(pacing_wait)
                self._last_request_at = time.monotonic()
                logger.info(
                    f"[OPENSKY ROUTE] Fetching route for newly-tracked aircraft {icao.upper()}..."
                )
                res = await opensky_auth.request(self.http_client, "GET", url)
                if res.status_code == 200:
                    flights = res.json()
                    if isinstance(flights, list) and len(flights) > 0:
                        # Take the most recent flight record
                        latest_flight = flights[-1]
                        dep = latest_flight.get("estDepartureAirport")
                        arr = latest_flight.get("estArrivalAirport")

                        f_call = latest_flight.get("callsign")
                        if f_call and f_call.strip():
                            resolved_callsign = f_call.strip()

                        if latest_flight.get("firstSeen"):
                            first_seen_dt = datetime.fromtimestamp(
                                latest_flight["firstSeen"], tz=timezone.utc
                            )
                        if latest_flight.get("lastSeen"):
                            last_seen_dt = datetime.fromtimestamp(
                                latest_flight["lastSeen"], tz=timezone.utc
                            )

                        logger.info(
                            f"[OPENSKY ROUTE] Sourced route for {icao.upper()}: Dep={dep} Arr={arr}"
                        )
                    else:
                        logger.info(
                            f"[OPENSKY ROUTE] No flight records found for {icao.upper()} (Coverage partial)."
                        )
                elif res.status_code == 404:
                    logger.info(
                        f"[OPENSKY ROUTE] OpenSky returned 404 for {icao.upper()} — route unknown in sector."
                    )
                elif res.status_code == 429:
                    logger.warning(
                        f"[OPENSKY ROUTE] HTTP 429 Rate Limit for {icao.upper()} — pausing queries for 30s"
                    )
                    self._rate_limited_until = time.time() + 30.0
                    is_rate_limited = True
                else:
                    logger.warning(
                        f"[OPENSKY ROUTE] HTTP {res.status_code} for {icao.upper()}: {res.text[:100]}"
                    )
            except Exception as e:
                logger.warning(
                    f"[OPENSKY ROUTE] Route fetch failed for {icao.upper()}: {e}"
                )

        route_text = self._format_route_text(dep, arr)
        fetched_at = datetime.now(timezone.utc)
        dep_coords = get_airport_coordinates(dep)
        arr_coords = get_airport_coordinates(arr)

        route_data = {
            "icao24": icao,
            "session_id": self.session_id,
            "callsign": resolved_callsign,
            "est_departure_airport": dep,
            "est_arrival_airport": arr,
            "first_seen": first_seen_dt,
            "last_seen": last_seen_dt,
            "route_text": route_text,
            "fetched_at": fetched_at,
            "dep_lat": dep_coords["lat"] if dep_coords else None,
            "dep_lng": dep_coords["lng"] if dep_coords else None,
            "arr_lat": arr_coords["lat"] if arr_coords else None,
            "arr_lng": arr_coords["lng"] if arr_coords else None,
        }

        # Do NOT persist or permanently cache 429 failures!
        if is_rate_limited:
            return route_data

        # Save in memory cache
        self._memory_cache[icao] = route_data

        # Persist to database
        try:
            async with self.db_session_maker() as db:
                db_record = FlightRoute(
                    icao24=icao,
                    session_id=self.session_id,
                    callsign=resolved_callsign,
                    est_departure_airport=dep,
                    est_arrival_airport=arr,
                    first_seen=first_seen_dt,
                    last_seen=last_seen_dt,
                    route_text=route_text,
                    fetched_at=fetched_at,
                )
                db.add(db_record)
                await db.commit()
        except Exception as e:
            # Handle unique constraint duplicate race condition
            logger.debug(f"DB route insert race condition handled for {icao}: {e}")

        return route_data

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import httpx
from sqlalchemy import select

from app.models import KnownEntity
from app.core.config import settings

logger = logging.getLogger("airguard.ingestion")

class CircuitBreakerOpenException(Exception):
    pass

class OpenSkyIngestionService:
    def __init__(
        self,
        queue: Any = None,
        db_session_maker: Any = None,
        poll_interval_seconds: float = 8.0,
        opensky_url: str = "https://opensky-network.org/api/states/all",
        max_retries: int = 5,
        cooldown_seconds: float = 60.0,
        detection_service: Any = None,
        route_service: Any = None
    ):
        self.queue = queue
        self.db_session_maker = db_session_maker
        self.poll_interval = poll_interval_seconds
        self.opensky_url = opensky_url
        self.detection_service = detection_service
        self.route_service = route_service
        self.tracked_icaos: set = set()
        
        # Telemetry stats
        self.last_poll_timestamp: Optional[datetime] = None
        self.last_poll_records: int = 0
        self.last_processed_records: int = 0
        self.rate_limit_remaining: Optional[str] = None
        self.poll_status_code: int = 0
        
        # Ingestion Client Auth
        auth = None
        if settings.OPENSKY_USERNAME and settings.OPENSKY_PASSWORD:
            auth = (settings.OPENSKY_USERNAME, settings.OPENSKY_PASSWORD)
            print("[OPENSKY INGESTION] Authenticated OpenSky access configured.", flush=True)
            logger.info("OpenSky Ingestion configured with HTTP Basic Authentication credentials.")
        else:
            print("[OPENSKY INGESTION] Running with anonymous OpenSky access (No Basic Auth credentials).", flush=True)
            logger.info("OpenSky authentication not configured.")
            
        self.client = httpx.AsyncClient(timeout=15.0, auth=auth)
        
        # Known Entities Cache
        self.known_entities: Dict[str, str] = {} # icao24 -> label
        
        # Reliability Control State
        self.breaker_state = "CLOSED" # CLOSED, OPEN, HALF_OPEN
        self.consecutive_failures = 0
        self.max_retries = max_retries
        self.cooldown_duration = cooldown_seconds
        self.cooldown_until: float = 0.0
        self.backoff_seconds: float = 0.0

    async def refresh_known_entities(self) -> None:
        """Fetch known entities from the database and refresh the in-memory cache."""
        try:
            async with self.db_session_maker() as session:
                result = await session.execute(select(KnownEntity))
                entities = result.scalars().all()
                self.known_entities = {e.icao24.lower(): e.label for e in entities}
                logger.info(f"Refreshed known entities cache. Loaded {len(self.known_entities)} records.")
        except Exception as e:
            logger.error(f"Failed to refresh known entities from database: {e}")

    def normalize_state(self, vector: List[Any]) -> Optional[Dict[str, Any]]:
        """Normalize OpenSky state vector array into a standardized schema dict.

        OpenSky State Vector Spec & Accuracy Field Analysis:
        ---------------------------------------------------
        - index 0 (icao24): Unique ICAO 24-bit address (str)
        - index 1 (callsign): Callsign of the vehicle (str or null)
        - index 2 (origin_country): Country name of registration (str)
        - index 3 (time_position): Unix epoch of last position update (int or null)
        - index 4 (last_contact): Unix epoch of last transponder signal (int)
        - index 5 (longitude): Geodetic longitude in decimal degrees (float or null)
        - index 6 (latitude): Geodetic latitude in decimal degrees (float or null)
        - index 7 (baro_altitude): Barometric altitude in meters (float or null)
        - index 8 (on_ground): True if taxiing or landed (bool)
        - index 9 (velocity): Ground speed in meters per second (float or null)
        - index 10 (true_track): True track/heading in decimal degrees clockwise from north (float or null)
        - index 11 (vertical_rate): Vertical speed in meters per second (float or null)
        - index 12 (sensors): Sensor IDs (list[int] or null)
        - index 13 (geo_altitude): Geometric altitude in meters (float or null)
        - index 14 (squawk): Transponder squawk code (str or null)
        - index 15 (spi): Special purpose indicator (bool)
        - index 16 (position_source): Position source identifier (int):
            0 = ADS-B (direct transponder broadcast)
            1 = ASTERIX (radar data exchange)
            2 = MLAT (multilateration / time-difference-of-arrival)
            3 = FLARM (light aircraft collision avoidance)
        - index 17 (category): Aircraft category (0-20 int or null, depending on transponder version)

        ADS-B Navigation Accuracy & Integrity (DO-260B vs OpenSky REST API):
        -------------------------------------------------------------------
        In standard ADS-B broadcasts (RTCA DO-260B / 1090 MHz Mode S Extended Squitter),
        the aircraft avionics honestly broadcast their GPS receiver's self-assessed integrity:
          - NIC (Navigation Integrity Category, 0-11): Containment radius Rc (NIC >= 7 => Rc < 0.2 NM).
          - NACp (Navigation Accuracy Category - Position, 0-11): Estimated position uncertainty.
          - SIL (Source Integrity Level, 0-3): Probability of exceeding containment.
        OpenSky's standard public REST endpoint (/api/states/all) exposes up to 18 fields
        (indices 0-17). The raw DO-260B NIC/NACp fields are preserved in OpenSky's raw message
        database (Trino/Impala cluster state_vectors_data4 / Type Codes 9-18).
        In our pipeline:
          - If the input vector contains an extended index 18 (e.g. from an enhanced receiver feed,
            custom decoder, or synthetic injector), we read it directly as reported_nic.
          - If the input is passed as a dict with 'reported_nic' or 'nic', we preserve it.
          - If position_source is MLAT (2) or radar (1), GPS avionics NIC is null.
          - Otherwise, reported_nic defaults to None when not provided by the current transponder feed.
        """
        # Critical Filter: We require latitude and longitude to track/score aircraft
        if len(vector) < 7 or vector[5] is None or vector[6] is None:
            return None

        icao24 = str(vector[0]).strip().lower()
        callsign = str(vector[1]).strip() if vector[1] is not None else None

        # Unit Conversions & Null Handling:
        # - Latitude/Longitude: decimal degrees (No conversion, stored directly)
        lat = float(vector[6])
        lng = float(vector[5])

        # - Altitude: OpenSky delivers altitude in meters.
        #   We use baro_altitude (index 7) as primary, falling back to geo_altitude (index 13).
        #   If both are null, we set to 0.0 and document default.
        altitude = 0.0
        if vector[7] is not None:
            altitude = float(vector[7])
        elif vector[13] is not None:
            altitude = float(vector[13])

        # - Velocity: OpenSky ground speed is delivered in m/s. Stored directly. Default to 0.0.
        velocity = float(vector[9]) if vector[9] is not None else 0.0

        # - Heading: OpenSky track angle is in decimal degrees from North. Default to 0.0.
        heading = float(vector[10]) if vector[10] is not None else 0.0

        # - Vertical Rate: OpenSky vertical speed is in m/s. Stored directly. Default to 0.0.
        vertical_rate = float(vector[11]) if vector[11] is not None else 0.0

        on_ground = bool(vector[8])

        # - Received timestamp: Convert unix epoch to timezone-aware datetime.
        #   Fallback sequence: time_position (index 3) -> last_contact (index 4) -> current system time.
        timestamp_epoch = vector[3] if vector[3] is not None else vector[4]
        if timestamp_epoch is not None:
            received_at = datetime.fromtimestamp(timestamp_epoch, tz=timezone.utc)
        else:
            received_at = datetime.now(timezone.utc)

        # - Navigation Integrity Category (NIC) extraction:
        # Check index 18 if provided in extended state vectors
        reported_nic: Optional[int] = None
        if len(vector) > 18 and vector[18] is not None:
            try:
                reported_nic = int(vector[18])
            except (ValueError, TypeError):
                reported_nic = None

        # Cross-reference with Known Entities cache
        known_label = self.known_entities.get(icao24)
        is_known = known_label is not None
        
        if is_known:
            # Explicitly log suppression tag
            logger.info(
                json.dumps({
                    "event": "SUPPRESSION",
                    "icao24": icao24,
                    "label": known_label,
                    "message": f"[SUPPRESSION] Target flagged as known entity: {known_label}. Downstream checks bypassed."
                })
            )

        return {
            "icao24": icao24,
            "callsign": callsign,
            "latitude": lat,
            "longitude": lng,
            "altitude_m": altitude,
            "velocity_ms": velocity,
            "heading_deg": heading,
            "vertical_rate_ms": vertical_rate,
            "on_ground": on_ground,
            "received_at": received_at,
            "source": "opensky",
            "reported_nic": reported_nic,
            "metadata": {
                "is_known_entity": is_known,
                "known_entity_label": known_label,
                "is_synthetic": False
            }
        }

    def update_circuit_state_on_failure(self, error_detail: str = "Unknown error") -> None:
        """Increment failure state, calculate backoff, and trip breaker if threshold hit."""
        self.consecutive_failures += 1
        
        if self.consecutive_failures >= self.max_retries:
            self.breaker_state = "OPEN"
            self.cooldown_until = time.time() + self.cooldown_duration
            self.backoff_seconds = 0.0
            print(
                f"[OPENSKY INGESTION FAILURE] Poll failed ({error_detail}). Consecutive failures: {self.consecutive_failures}. "
                f"Circuit breaker tripped to OPEN. Cooldown active for {self.cooldown_duration}s. Self-healing active.",
                flush=True
            )
            logger.warning(
                json.dumps({
                    "event": "CIRCUIT_TRIPPED",
                    "breaker_state": self.breaker_state,
                    "cooldown_until": self.cooldown_until,
                    "consecutive_failures": self.consecutive_failures,
                    "error": error_detail,
                    "message": f"Circuit breaker tripped to OPEN. Cooldown active for {self.cooldown_duration}s."
                })
            )
        else:
            # Exponential backoff base 2s (e.g. 2s, 4s, 8s, 16s)
            self.backoff_seconds = min(60.0, 2.0 ** self.consecutive_failures)
            print(
                f"[OPENSKY INGESTION FAILURE] Poll failed ({error_detail}). Consecutive failures: {self.consecutive_failures}. "
                f"Engaging self-healing exponential backoff: retrying in {self.backoff_seconds:.1f}s...",
                flush=True
            )
            logger.info(
                json.dumps({
                    "event": "BACKOFF_ENGAGED",
                    "consecutive_failures": self.consecutive_failures,
                    "backoff_seconds": self.backoff_seconds,
                    "error": error_detail,
                    "message": f"Poll failed. Engaging exponential backoff for {self.backoff_seconds}s."
                })
            )

    def update_circuit_state_on_success(self, record_count: int = 0) -> None:
        """Reset failure counters, restore breaker state to CLOSED, and log recovery."""
        previous_failures = self.consecutive_failures
        previous_breaker = self.breaker_state
        
        if previous_failures > 0 or previous_breaker != "CLOSED":
            print(
                f"[OPENSKY INGESTION RECOVERED] Polling restored successfully after {previous_failures} failures! "
                f"Fetched {record_count} live aircraft. Circuit breaker restored to CLOSED. Normal polling resumed.",
                flush=True
            )
            logger.info(
                json.dumps({
                    "event": "CIRCUIT_CLOSED",
                    "breaker_state": "CLOSED",
                    "previous_failures": previous_failures,
                    "record_count": record_count,
                    "message": f"Circuit breaker restored to CLOSED state. Ingestion recovered after {previous_failures} failures."
                })
            )
        self.breaker_state = "CLOSED"
        self.consecutive_failures = 0
        self.backoff_seconds = 0.0

    def evaluate_circuit(self) -> None:
        """Check if circuit is OPEN and test if cooldown expired to transition to HALF_OPEN."""
        now = time.time()
        
        if self.breaker_state == "OPEN":
            if now >= self.cooldown_until:
                self.breaker_state = "HALF_OPEN"
                logger.info(
                    json.dumps({
                        "event": "CIRCUIT_HALF_OPEN",
                        "breaker_state": self.breaker_state,
                        "message": "Cooldown expired. Circuit transitioned to HALF_OPEN. Testing next poll."
                    })
                )
            else:
                remaining = self.cooldown_until - now
                logger.debug(f"Circuit breaker is OPEN. Cooldown remaining: {remaining:.1f}s")
                raise CircuitBreakerOpenException(f"Circuit breaker is OPEN. Cooldown remaining: {remaining:.1f}s")

    async def poll_api(self) -> Optional[List[List[Any]]]:
        """Query OpenSky endpoint. Enforces circuit evaluation and metrics tracking."""
        # Global view is the default. Bounding box filters can be enabled for quota-constrained use.
        params = {} if settings.OPENSKY_GLOBAL_VIEW else {
            "lamin": float(settings.OPENSKY_LAMIN),
            "lomin": float(settings.OPENSKY_LOMIN),
            "lamax": float(settings.OPENSKY_LAMAX),
            "lomax": float(settings.OPENSKY_LOMAX)
        }
        
        start_time = time.time()
        try:
            res = await self.client.get(self.opensky_url, params=params)
            latency = (time.time() - start_time) * 1000.0 # ms
            raw_rate = res.headers.get("x-rate-limit-remaining") if hasattr(res, "headers") and hasattr(res.headers, "get") else None
            rate_remaining = str(raw_rate) if isinstance(raw_rate, (str, int, float)) else None
            self.poll_status_code = res.status_code
            self.rate_limit_remaining = rate_remaining
            
            # Prominently log raw response status code and record count to console / stdout on EVERY poll
            record_count = 0
            if res.status_code == 200:
                try:
                    data = res.json()
                    states = data.get("states") or []
                    record_count = len(states)
                except Exception:
                    states = []
            else:
                states = []

            self.last_poll_records = record_count

            # Keep upstream observation counts and failures separate from any fallback batch.
            try:
                from app.api.v1.endpoints import SYSTEM_STATS
                SYSTEM_STATS["last_poll_attempt"] = datetime.now(timezone.utc)
                SYSTEM_STATS["last_poll_http_status"] = res.status_code
                SYSTEM_STATS["last_poll_records"] = record_count
                SYSTEM_STATS["poll_latency_ms"] = latency
                SYSTEM_STATS["upstream_status"] = "LIVE" if res.status_code == 200 else ("RATE_LIMITED" if res.status_code == 429 else "UNAVAILABLE")
            except Exception:
                pass

            print(
                f"[OPENSKY POLL] HTTP Status: {res.status_code} | "
                f"Raw OpenSky Records: {record_count} | "
                f"Rate-Limit Remaining: {rate_remaining or 'N/A'} | "
                f"Latency: {latency:.1f}ms | Region: {settings.MONITOR_REGION}",
                flush=True
            )
            
            if res.status_code == 429:
                retry_after = res.headers.get("retry-after") or res.headers.get("x-rate-limit-retry-after-seconds")
                try:
                    retry_seconds = float(retry_after) if retry_after else 60.0
                except ValueError:
                    retry_seconds = 60.0
                
                print(
                    f"[WARNING] [OPENSKY INGESTION RATE-LIMITED] HTTP 429 Too Many Requests. "
                    f"Retry-after: {retry_seconds}s. No aircraft will be shown until the live feed recovers.",
                    flush=True
                )
                logger.warning(
                    json.dumps({
                        "event": "OPENSKY_RATE_LIMITED",
                        "status_code": 429,
                        "retry_after_seconds": retry_seconds,
                        "message": "OpenSky API rate limited (429); no fallback aircraft are generated."
                    })
                )
                self.backoff_seconds = min(86400.0, max(60.0, retry_seconds))
                try:
                    from app.api.v1.endpoints import SYSTEM_STATS
                    SYSTEM_STATS["circuit_breaker_state"] = "RATE_LIMITED"
                    SYSTEM_STATS["last_poll_http_status"] = 429
                    SYSTEM_STATS["last_poll_records"] = 0
                    SYSTEM_STATS["upstream_status"] = "RATE_LIMITED"
                    SYSTEM_STATS["rate_limit_remaining"] = "0 (429 Rate-Limited)"
                except Exception:
                    pass
                return None
                
            if res.status_code != 200:
                print(f"[OPENSKY INGESTION ERROR] Non-200 response: {res.status_code} - {res.text[:200]}", flush=True)
                try:
                    from app.api.v1.endpoints import SYSTEM_STATS
                    SYSTEM_STATS["last_poll_http_status"] = res.status_code
                except Exception:
                    pass
                return None
                
            self.last_poll_timestamp = datetime.now(timezone.utc)
            self.last_poll_records = len(states)
            self.update_circuit_state_on_success(len(states))
            
            # Sync to SYSTEM_STATS
            try:
                from app.api.v1.endpoints import SYSTEM_STATS
                SYSTEM_STATS["last_successful_poll"] = self.last_poll_timestamp
                SYSTEM_STATS["last_poll_records"] = len(states)
                SYSTEM_STATS["last_poll_http_status"] = 200
                SYSTEM_STATS["rate_limit_remaining"] = rate_remaining or "Active"
                SYSTEM_STATS["poll_latency_ms"] = latency
                SYSTEM_STATS["circuit_breaker_state"] = self.breaker_state
            except Exception:
                pass

            # Log structured poll metric
            logger.info(
                json.dumps({
                    "event": "POLL_METRICS",
                    "success": True,
                    "record_count": len(states),
                    "latency_ms": latency,
                    "rate_remaining": rate_remaining,
                    "breaker_state": self.breaker_state
                })
            )
            return states
            
        except Exception as e:
            latency = (time.time() - start_time) * 1000.0 # ms
            print(f"[OPENSKY INGESTION POLL EXCEPTION] Error: {e} ({latency:.1f}ms)", flush=True)
            logger.error(
                json.dumps({
                    "event": "POLL_METRICS",
                    "success": False,
                    "error": str(e),
                    "latency_ms": latency,
                    "breaker_state": self.breaker_state
                })
            )
            self.poll_status_code = getattr(getattr(e, 'response', None), 'status_code', 503)
            self.last_poll_records = 0
            try:
                from app.api.v1.endpoints import SYSTEM_STATS
                SYSTEM_STATS["last_poll_http_status"] = self.poll_status_code
                SYSTEM_STATS["last_poll_attempt"] = datetime.now(timezone.utc)
                SYSTEM_STATS["last_poll_records"] = 0
                SYSTEM_STATS["upstream_status"] = "RATE_LIMITED" if self.poll_status_code == 429 else "UNAVAILABLE"
                SYSTEM_STATS["poll_latency_ms"] = latency
            except Exception:
                pass
            return None
 
    async def run_single_poll_cycle(self) -> int:
        """Executes a single fetch, normalizes vectors, writes to Redis Stream and processes through detection."""
        from app.core.redis import redis_client
        from app.core.telemetry import OPENSKY_POLL_SUCCESS, OPENSKY_POLL_FAILURE
        from datetime import datetime

        raw_states = None
        try:
            raw_states = await self.poll_api()
        except Exception as ex:
            print(f"[OPENSKY POLL EXCEPTION] {ex}", flush=True)

        if raw_states is not None:
            OPENSKY_POLL_SUCCESS.inc()
            vectors_to_process = raw_states
            source_label = "opensky_live"
            raw_count = len(raw_states)
            fallback_reason = None
        else:
            vectors_to_process = []
            source_label = "unavailable"
            raw_count = 0
            fallback_reason = (
                "Upstream feed returned no aircraft for the configured area."
                if raw_states is not None
                else f"Upstream request unavailable (HTTP {self.poll_status_code or 'unknown'})."
            )

        # Check Redis reachability once per cycle
        redis_available = False
        try:
            await asyncio.wait_for(redis_client.ping(), timeout=0.15)
            redis_available = True
        except Exception:
            redis_available = False

        normalized_records = []
        for vector in vectors_to_process:
            normalized = self.normalize_state(vector)
            if normalized is not None:
                normalized.setdefault("metadata", {})
                normalized["metadata"]["is_synthetic"] = False
                normalized["source"] = source_label
                normalized_records.append(normalized)

                # 1. Push to Redis Stream if available
                if redis_available:
                    try:
                        state_data = normalized.copy()
                        if isinstance(state_data["received_at"], datetime):
                            state_data["received_at"] = state_data["received_at"].isoformat()
                            
                        payload_data = {
                            "record": state_data,
                            "trace_carrier": {}
                        }
                        await redis_client.xadd("airguard:telemetry", {"payload": json.dumps(payload_data)})
                    except Exception:
                        redis_available = False

                # 2. Schedule route and metadata resolution once per newly-tracked aircraft
                icao = normalized["icao24"]
                if icao not in self.tracked_icaos:
                    self.tracked_icaos.add(icao)
                    if self.route_service:
                        asyncio.create_task(
                            self.route_service.schedule_route_resolution(icao, normalized.get("callsign"))
                        )
                    try:
                        from app.ingestion.metadata_service import active_metadata_service
                        asyncio.create_task(
                            active_metadata_service.get_aircraft_metadata(icao, normalized.get("callsign"))
                        )
                    except Exception as meta_err:
                        logger.debug(f"Pre-warm metadata task error for {icao}: {meta_err}")

        # 3. In-Process Processing Fallback
        import os
        should_process_in_process = (not redis_available) or os.getenv("ENABLE_IN_PROCESS_DETECTION", "true").lower() == "true"
        if self.detection_service and should_process_in_process and normalized_records:
            async def _process_batch(records_to_process):
                sem = asyncio.Semaphore(15)
                async def _process_bounded(rec):
                    async with sem:
                        try:
                            await self.detection_service.process_record(rec)
                        except Exception as e:
                            logger.error(f"Error in in-process detection for {rec.get('icao24')}: {e}")
                await asyncio.gather(*[_process_bounded(r) for r in records_to_process], return_exceptions=True)

            asyncio.create_task(_process_batch(normalized_records))

        normalized_count = len(normalized_records)
        self.last_processed_records = normalized_count

        # Sync comprehensive telemetry to SYSTEM_STATS
        try:
            from app.api.v1.endpoints import SYSTEM_STATS
            SYSTEM_STATS["last_processed_records"] = normalized_count
            SYSTEM_STATS["feed_source"] = source_label
            SYSTEM_STATS["feed_mode"] = "LIVE" if source_label == "opensky_live" else "UNAVAILABLE"
            SYSTEM_STATS["fallback_reason"] = fallback_reason
        except Exception:
            pass

        print(
            f"[OPENSKY INGESTION] Poll Cycle Done | "
            f"HTTP Status: {self.poll_status_code or 200} | "
            f"Raw OpenSky Records: {raw_count} | "
            f"Detection Processed: {normalized_count} | "
            f"Feed Mode: {source_label.upper()} | "
            f"Region: {settings.MONITOR_REGION}",
            flush=True
        )
        return normalized_count

    async def start_polling_loop(self) -> None:
        """Spins up the continuous async polling run loop indefinitely with supervisor auto-recovery."""
        logger.info("Starting OpenSky Ingestion continuous polling loop...")
        print(f"[OPENSKY INGESTION] Starting persistent background loop indefinitely (Interval: {self.poll_interval}s)...", flush=True)
        try:
            await self.refresh_known_entities()
        except Exception as e:
            logger.error(f"Initial known entities load error: {e}")
        
        consecutive_loop_errors = 0
        while True:
            try:
                await self.run_single_poll_cycle()
                consecutive_loop_errors = 0
            except asyncio.CancelledError:
                logger.info("OpenSky Ingestion polling loop cancelled by shutdown.")
                raise
            except Exception as loop_err:
                consecutive_loop_errors += 1
                backoff = min(60.0, 2.0 ** min(consecutive_loop_errors, 5))
                logger.error(f"[SUPERVISOR] Ingestion loop error ({consecutive_loop_errors}): {loop_err}. Self-healing in {backoff}s...")
                print(f"[OPENSKY SUPERVISOR] Ingestion loop error: {loop_err}. Auto-recovering in {backoff}s...", flush=True)
                await asyncio.sleep(backoff)

            await asyncio.sleep(max(self.poll_interval, self.backoff_seconds))
            self.backoff_seconds = 0.0

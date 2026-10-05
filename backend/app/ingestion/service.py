import asyncio
import email.utils
import json
import logging
import math
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from sqlalchemy import select

from app.core.config import settings
from app.ingestion.opensky_auth import opensky_auth
from app.ingestion.sources import OpenSkyStateVectorSource, SurveillanceSource
from app.models import KnownEntity

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
        route_service: Any = None,
        source_adapter: SurveillanceSource | None = None,
    ):
        self.queue = queue
        self.db_session_maker = db_session_maker
        self.poll_interval = poll_interval_seconds
        self.opensky_url = opensky_url
        self.detection_service = detection_service
        self.route_service = route_service
        self.source_adapter = source_adapter or OpenSkyStateVectorSource()

        # Telemetry stats
        self.last_poll_timestamp: datetime | None = None
        self.last_successful_update: datetime | None = None
        self.last_attempt_at: datetime | None = None
        self.next_attempt_at: datetime | None = None
        self.retry_after_until: datetime | None = None
        self.current_source_status = "AWAITING_TELEMETRY"
        self.last_error: str | None = None
        self.last_valid_snapshot: list[dict[str, Any]] | None = None
        self.refresh_in_progress = False
        self.manual_refresh_requested = False
        self._refresh_lock = asyncio.Lock()
        self._manual_refresh_wakeup = asyncio.Event()
        self.last_poll_records: int = 0
        self.last_normalized_records: int = 0
        self.rate_limit_remaining: str | None = None
        self.poll_status_code: int = 0

        # OpenSky's live REST API requires OAuth2 client credentials for its
        # authenticated tier; username/password Basic auth is no longer valid.
        if opensky_auth.configured:
            logger.info("OpenSky OAuth2 client credentials are configured.")
        else:
            logger.warning(
                "OpenSky OAuth2 is not configured; global anonymous credit limits apply."
            )

        self.client = httpx.AsyncClient(timeout=15.0)

        # Known Entities Cache
        self.known_entities: dict[str, str] = {}  # icao24 -> label

        # Reliability Control State
        self.breaker_state = "CLOSED"  # CLOSED, OPEN, HALF_OPEN
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
                logger.info(
                    f"Refreshed known entities cache. Loaded {len(self.known_entities)} records."
                )
        except Exception as e:
            logger.error(f"Failed to refresh known entities from database: {e}")

    def normalize_state(self, vector: Any) -> dict[str, Any] | None:
        """Normalize a canonical source observation into the shared schema.

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

        Navigation-integrity fields:
        ---------------------------
        The standard OpenSky REST state vector exposes fields 0-17 and does not
        contain NIC/NACp/SIL. Do not interpret an undocumented trailing field as NIC.
        The live OpenSky normalizer therefore returns reported_nic=None; a future
        receiver/source adapter must explicitly map documented integrity fields and
        preserve their source provenance before those fields can inform a rule.
        """
        # Do not turn missing telemetry into plausible-looking zeros. DB numeric
        # columns remain non-null for compatibility, while data_quality tells every
        # downstream consumer which values were actually observed.
        source_fields = OpenSkyStateVectorSource.FIELDS

        def raw(index: int) -> Any:
            if isinstance(vector, dict):
                return (
                    vector.get(source_fields[index])
                    if index < len(source_fields)
                    else None
                )
            return vector[index] if index < len(vector) else None

        def number(index: int) -> float | None:
            value = raw(index)
            if value is None:
                return None
            try:
                parsed = float(value)
                return parsed if math.isfinite(parsed) else None
            except (TypeError, ValueError, OverflowError):
                return None

        icao24 = str(raw(0) or "").strip().lower()
        if len(icao24) != 6 or any(c not in "0123456789abcdef" for c in icao24):
            return None

        lat_value, lon_value = number(6), number(5)
        if (
            lat_value is None
            or lon_value is None
            or not (-90 <= lat_value <= 90 and -180 <= lon_value <= 180)
        ):
            return None
        lat, lng = lat_value, lon_value
        callsign_value = raw(1)
        callsign = (
            str(callsign_value).strip() or None if callsign_value is not None else None
        )

        baro_altitude, geo_altitude = number(7), number(13)
        altitude = baro_altitude if baro_altitude is not None else geo_altitude
        velocity = number(9)
        heading = number(10)
        vertical_rate = number(11)
        ground_value = raw(8)
        on_ground = ground_value if isinstance(ground_value, bool) else None
        sensors = raw(12) if isinstance(raw(12), list) else None

        observed_fields = ["latitude", "longitude"]
        if baro_altitude is not None or geo_altitude is not None:
            observed_fields.append("altitude")
        if velocity is not None:
            observed_fields.append("velocity")
        if heading is not None:
            observed_fields.append("heading")
        if vertical_rate is not None:
            observed_fields.append("vertical_rate")
        if on_ground is not None:
            observed_fields.append("on_ground")
        if sensors is not None:
            observed_fields.append("sensor_ids")
        squawk_value = raw(14)
        squawk = str(squawk_value).strip() if squawk_value is not None else None
        if squawk:
            observed_fields.append("squawk")

        timestamp_epoch = number(3) if number(3) is not None else number(4)
        if timestamp_epoch is None:
            return None
        timestamp_source = "time_position" if number(3) is not None else "last_contact"
        try:
            received_at = datetime.fromtimestamp(timestamp_epoch, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None

        # Standard OpenSky vectors omit NIC; no undocumented array position is
        # treated as a navigation-integrity measurement.
        reported_nic: int | None = None

        # Cross-reference with Known Entities cache
        known_label = self.known_entities.get(icao24)
        is_known = known_label is not None

        if is_known:
            # Explicitly log suppression tag
            logger.info(
                json.dumps(
                    {
                        "event": "SUPPRESSION",
                        "icao24": icao24,
                        "label": known_label,
                        "message": f"[SUPPRESSION] Target flagged as known entity: {known_label}. Downstream checks bypassed.",
                    }
                )
            )

        return {
            "ingestion_id": str(uuid.uuid4()),
            "icao24": icao24,
            "callsign": callsign,
            "latitude": lat,
            "longitude": lng,
            "altitude_m": altitude if altitude is not None else 0.0,
            "velocity_ms": velocity if velocity is not None else 0.0,
            "heading_deg": heading if heading is not None else 0.0,
            "vertical_rate_ms": vertical_rate if vertical_rate is not None else 0.0,
            "on_ground": on_ground if on_ground is not None else False,
            "squawk": squawk,
            "sensors": sensors,
            "data_quality": {
                "observed_fields": observed_fields,
                "missing_fields": [
                    name
                    for name, present in (
                        ("altitude", altitude is not None),
                        ("velocity", velocity is not None),
                        ("heading", heading is not None),
                        ("vertical_rate", vertical_rate is not None),
                        ("on_ground", on_ground is not None),
                    )
                    if not present
                ],
                "altitude_source": (
                    "barometric"
                    if baro_altitude is not None
                    else "geometric" if geo_altitude is not None else None
                ),
                "timestamp_source": timestamp_source,
                "position_source": raw(16),
                "sensors_are_geometry": False,
            },
            "received_at": received_at,
            "source": "opensky",
            "reported_nic": reported_nic,
            "metadata": {
                "is_known_entity": is_known,
                "known_entity_label": known_label,
                "is_synthetic": False,
            },
        }

    def update_circuit_state_on_failure(
        self, error_detail: str = "Unknown error"
    ) -> None:
        """Increment failure state, calculate backoff, and trip breaker if threshold hit."""
        self.consecutive_failures += 1

        if self.consecutive_failures >= self.max_retries:
            self.breaker_state = "OPEN"
            self.cooldown_until = time.time() + self.cooldown_duration
            self.backoff_seconds = 0.0
            print(
                f"[OPENSKY INGESTION FAILURE] Poll failed ({error_detail}). Consecutive failures: {self.consecutive_failures}. "
                f"Circuit breaker tripped to OPEN. Cooldown active for {self.cooldown_duration}s. Self-healing active.",
                flush=True,
            )
            logger.warning(
                json.dumps(
                    {
                        "event": "CIRCUIT_TRIPPED",
                        "breaker_state": self.breaker_state,
                        "cooldown_until": self.cooldown_until,
                        "consecutive_failures": self.consecutive_failures,
                        "error": error_detail,
                        "message": f"Circuit breaker tripped to OPEN. Cooldown active for {self.cooldown_duration}s.",
                    }
                )
            )
        else:
            # Exponential backoff base 2s (e.g. 2s, 4s, 8s, 16s)
            self.backoff_seconds = min(60.0, 2.0**self.consecutive_failures)
            print(
                f"[OPENSKY INGESTION FAILURE] Poll failed ({error_detail}). Consecutive failures: {self.consecutive_failures}. "
                f"Engaging self-healing exponential backoff: retrying in {self.backoff_seconds:.1f}s...",
                flush=True,
            )
            logger.info(
                json.dumps(
                    {
                        "event": "BACKOFF_ENGAGED",
                        "consecutive_failures": self.consecutive_failures,
                        "backoff_seconds": self.backoff_seconds,
                        "error": error_detail,
                        "message": f"Poll failed. Engaging exponential backoff for {self.backoff_seconds}s.",
                    }
                )
            )

    def update_circuit_state_on_success(self, record_count: int = 0) -> None:
        """Reset failure counters, restore breaker state to CLOSED, and log recovery."""
        previous_failures = self.consecutive_failures
        previous_breaker = self.breaker_state

        if previous_failures > 0 or previous_breaker != "CLOSED":
            print(
                f"[OPENSKY INGESTION RECOVERED] Polling restored successfully after {previous_failures} failures! "
                f"Fetched {record_count} live aircraft. Circuit breaker restored to CLOSED. Normal polling resumed.",
                flush=True,
            )
            logger.info(
                json.dumps(
                    {
                        "event": "CIRCUIT_CLOSED",
                        "breaker_state": "CLOSED",
                        "previous_failures": previous_failures,
                        "record_count": record_count,
                        "message": f"Circuit breaker restored to CLOSED state. Ingestion recovered after {previous_failures} failures.",
                    }
                )
            )
        self.breaker_state = "CLOSED"
        self.consecutive_failures = 0
        self.backoff_seconds = 0.0

    def _refresh_state(self) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        snapshot_age = (
            max(0.0, (now - self.last_successful_update).total_seconds())
            if self.last_successful_update
            else None
        )
        payload = {
            "source_status": self.current_source_status,
            "source_name": self.source_adapter.name,
            "last_successful_update": (
                self.last_successful_update.isoformat()
                if self.last_successful_update
                else None
            ),
            "last_attempt_at": (
                self.last_attempt_at.isoformat() if self.last_attempt_at else None
            ),
            "next_attempt_at": (
                self.next_attempt_at.isoformat() if self.next_attempt_at else None
            ),
            "retry_after": (
                self.retry_after_until.isoformat() if self.retry_after_until else None
            ),
            "snapshot_age_seconds": snapshot_age,
            "snapshot_count": (
                len(self.last_valid_snapshot)
                if self.last_valid_snapshot is not None
                else None
            ),
            "consecutive_failures": self.consecutive_failures,
            "last_error": self.last_error,
            "refresh_in_progress": self.refresh_in_progress,
            "manual_refresh_pending": self.manual_refresh_requested,
        }
        try:
            from app.api.v1.endpoints import SYSTEM_STATS

            SYSTEM_STATS.update(
                {
                    **payload,
                    "last_successful_update": self.last_successful_update,
                    "last_attempt_at": self.last_attempt_at,
                    "next_attempt_at": self.next_attempt_at,
                    "retry_after": self.retry_after_until,
                }
            )
        except Exception:
            pass
        return payload

    async def _broadcast_refresh_state(
        self, *, snapshot_replaced: bool = False
    ) -> None:
        payload = {
            "event": "SOURCE_REFRESH_STATE",
            **self._refresh_state(),
            "snapshot_replaced": snapshot_replaced,
        }
        try:
            from app.api.v1.endpoints import manager as ws_manager

            await ws_manager.broadcast(payload)
        except Exception as exc:
            logger.debug("Could not broadcast source freshness state: %s", exc)

    def _schedule_failed_retry(self) -> None:
        now = datetime.now(timezone.utc)
        if self.retry_after_until and self.retry_after_until > now:
            self.next_attempt_at = self.retry_after_until
        elif self.breaker_state == "OPEN" and self.cooldown_until > time.time():
            self.next_attempt_at = datetime.fromtimestamp(
                self.cooldown_until, tz=timezone.utc
            )
        else:
            self.next_attempt_at = now + timedelta(
                seconds=max(1.0, self.backoff_seconds or 2.0)
            )

    async def request_manual_refresh(self) -> dict[str, Any]:
        """Queue one real source poll; it never skips a provider retry/schedule deadline."""
        if self.refresh_in_progress:
            return {
                "accepted": False,
                "reason": "A telemetry refresh is already in progress.",
            }
        if self.manual_refresh_requested:
            return {
                "accepted": False,
                "reason": "A manual telemetry refresh is already queued.",
            }
        self.manual_refresh_requested = True
        self._manual_refresh_wakeup.set()
        logger.info(
            "Manual source refresh queued; earliest permitted attempt is %s",
            self.next_attempt_at,
        )
        await self._broadcast_refresh_state()
        return {"accepted": True, "queued": True, **self._refresh_state()}

    def evaluate_circuit(self) -> None:
        """Check if circuit is OPEN and test if cooldown expired to transition to HALF_OPEN."""
        now = time.time()

        if self.breaker_state == "OPEN":
            if now >= self.cooldown_until:
                self.breaker_state = "HALF_OPEN"
                logger.info(
                    json.dumps(
                        {
                            "event": "CIRCUIT_HALF_OPEN",
                            "breaker_state": self.breaker_state,
                            "message": "Cooldown expired. Circuit transitioned to HALF_OPEN. Testing next poll.",
                        }
                    )
                )
            else:
                remaining = self.cooldown_until - now
                logger.debug(
                    f"Circuit breaker is OPEN. Cooldown remaining: {remaining:.1f}s"
                )
                raise CircuitBreakerOpenException(
                    f"Circuit breaker is OPEN. Cooldown remaining: {remaining:.1f}s"
                )

    async def poll_api(self) -> list[dict[str, Any]] | None:
        """Query the configured surveillance adapter and return canonical records."""
        # Global view is the default. Bounding box filters can be enabled for quota-constrained use.
        params = (
            {}
            if settings.OPENSKY_GLOBAL_VIEW
            else {
                "lamin": float(settings.OPENSKY_LAMIN),
                "lomin": float(settings.OPENSKY_LOMIN),
                "lamax": float(settings.OPENSKY_LAMAX),
                "lomax": float(settings.OPENSKY_LOMAX),
            }
        )

        # Do not count a request rejected by the local circuit breaker as an
        # upstream attempt or overwrite the last meaningful source state.
        self.evaluate_circuit()

        self.last_attempt_at = datetime.now(timezone.utc)
        self.retry_after_until = None
        self.current_source_status = "REFRESHING"
        self.last_error = None
        try:
            from app.api.v1.endpoints import SYSTEM_STATS

            SYSTEM_STATS["last_poll_attempt"] = self.last_attempt_at
            SYSTEM_STATS["upstream_status"] = "REFRESHING"
            SYSTEM_STATS["last_error"] = None
        except Exception:
            pass
        await self._broadcast_refresh_state()
        start_time = time.time()
        try:
            res, states = await self.source_adapter.fetch(
                self.client, self.opensky_url, params
            )
            latency = (time.time() - start_time) * 1000.0  # ms
            raw_rate = (
                res.headers.get("x-rate-limit-remaining")
                if hasattr(res, "headers") and hasattr(res.headers, "get")
                else None
            )
            rate_remaining = (
                str(raw_rate) if isinstance(raw_rate, (str, int, float)) else None
            )
            self.poll_status_code = res.status_code
            self.rate_limit_remaining = rate_remaining

            # Prominently log raw response status code and record count to console / stdout on EVERY poll
            record_count = 0
            if res.status_code == 200:
                record_count = len(states)

            try:
                from app.api.v1.endpoints import SYSTEM_STATS

                SYSTEM_STATS["last_attempt_records"] = record_count
                SYSTEM_STATS["last_poll_http_status"] = res.status_code
                SYSTEM_STATS["poll_latency_ms"] = latency
            except Exception:
                pass

            # Keep upstream observation counts and failures separate from any fallback batch.
            try:
                from app.api.v1.endpoints import SYSTEM_STATS

                SYSTEM_STATS["last_poll_attempt"] = datetime.now(timezone.utc)
                SYSTEM_STATS["last_poll_http_status"] = res.status_code
                SYSTEM_STATS["poll_latency_ms"] = latency
                SYSTEM_STATS["upstream_status"] = (
                    "REFRESHING"
                    if res.status_code == 200
                    else ("RATE_LIMITED" if res.status_code == 429 else "UNAVAILABLE")
                )
            except Exception:
                pass

            print(
                f"[OPENSKY POLL] HTTP Status: {res.status_code} | "
                f"Raw OpenSky Records: {record_count} | "
                f"Rate-Limit Remaining: {rate_remaining or 'N/A'} | "
                f"Latency: {latency:.1f}ms | Region: {settings.MONITOR_REGION}",
                flush=True,
            )

            if res.status_code == 429:
                retry_after = res.headers.get("retry-after") or res.headers.get(
                    "x-rate-limit-retry-after-seconds"
                )
                try:
                    if retry_after:
                        try:
                            retry_seconds = float(retry_after)
                        except ValueError:
                            retry_at = email.utils.parsedate_to_datetime(retry_after)
                            if retry_at.tzinfo is None:
                                retry_at = retry_at.replace(tzinfo=timezone.utc)
                            retry_seconds = (
                                retry_at - datetime.now(timezone.utc)
                            ).total_seconds()
                    else:
                        retry_seconds = 60.0
                except (TypeError, ValueError, OverflowError):
                    retry_seconds = 60.0
                retry_seconds = max(1.0, retry_seconds)
                self.retry_after_until = datetime.now(timezone.utc) + timedelta(
                    seconds=retry_seconds
                )

                print(
                    f"[WARNING] [OPENSKY INGESTION RATE-LIMITED] HTTP 429 Too Many Requests. "
                    f"Retry-after: {retry_seconds:.0f}s. Retaining the last valid aircraft snapshot.",
                    flush=True,
                )
                logger.warning(
                    json.dumps(
                        {
                            "event": "OPENSKY_RATE_LIMITED",
                            "status_code": 429,
                            "retry_after_seconds": retry_seconds,
                            "message": "OpenSky API rate limited (429); retaining the last valid snapshot and respecting Retry-After.",
                        }
                    )
                )
                self.update_circuit_state_on_failure("OpenSky HTTP 429 rate limit")
                self.backoff_seconds = min(86400.0, retry_seconds)
                # A provider Retry-After is authoritative. Align any circuit
                # cooldown so it cannot cause an earlier, conflicting retry.
                self.cooldown_until = self.retry_after_until.timestamp()
                self.current_source_status = "RATE_LIMITED"
                self.last_error = "Source returned HTTP 429 (rate limited)."
                self._schedule_failed_retry()
                try:
                    from app.api.v1.endpoints import SYSTEM_STATS

                    SYSTEM_STATS["circuit_breaker_state"] = "RATE_LIMITED"
                    SYSTEM_STATS["last_poll_http_status"] = 429
                    SYSTEM_STATS["upstream_status"] = "RATE_LIMITED"
                    SYSTEM_STATS["rate_limit_remaining"] = "0 (429 Rate-Limited)"
                    SYSTEM_STATS["last_error"] = self.last_error
                    self._refresh_state()
                except Exception:
                    pass
                return None

            if res.status_code != 200:
                print(
                    f"[OPENSKY INGESTION ERROR] Non-200 response: {res.status_code} - {res.text[:200]}",
                    flush=True,
                )
                self.update_circuit_state_on_failure(f"HTTP {res.status_code}")
                self.current_source_status = "UNAVAILABLE"
                self.last_error = f"Source returned HTTP {res.status_code}."
                self._schedule_failed_retry()
                try:
                    from app.api.v1.endpoints import SYSTEM_STATS

                    SYSTEM_STATS["last_poll_http_status"] = res.status_code
                    SYSTEM_STATS["upstream_status"] = "UNAVAILABLE"
                    SYSTEM_STATS["last_error"] = self.last_error
                    self._refresh_state()
                except Exception:
                    pass
                return None

            self.update_circuit_state_on_success(len(states))

            # Log structured poll metric
            logger.info(
                json.dumps(
                    {
                        "event": "POLL_METRICS",
                        "success": True,
                        "record_count": len(states),
                        "latency_ms": latency,
                        "rate_remaining": rate_remaining,
                        "breaker_state": self.breaker_state,
                    }
                )
            )
            return states

        except Exception as e:
            latency = (time.time() - start_time) * 1000.0  # ms
            print(
                f"[OPENSKY INGESTION POLL EXCEPTION] Error: {e} ({latency:.1f}ms)",
                flush=True,
            )
            logger.error(
                json.dumps(
                    {
                        "event": "POLL_METRICS",
                        "success": False,
                        "error": str(e),
                        "latency_ms": latency,
                        "breaker_state": self.breaker_state,
                    }
                )
            )
            self.poll_status_code = getattr(
                getattr(e, "response", None), "status_code", 503
            )
            self.update_circuit_state_on_failure(str(e))
            self.current_source_status = (
                "INVALID_RESPONSE"
                if isinstance(e, (ValueError, json.JSONDecodeError))
                else "UNAVAILABLE"
            )
            self.last_error = str(e)
            if self.current_source_status == "INVALID_RESPONSE":
                self.poll_status_code = 502
            self._schedule_failed_retry()
            try:
                from app.api.v1.endpoints import SYSTEM_STATS

                SYSTEM_STATS["last_poll_http_status"] = self.poll_status_code
                SYSTEM_STATS["last_poll_attempt"] = datetime.now(timezone.utc)
                SYSTEM_STATS["upstream_status"] = self.current_source_status
                SYSTEM_STATS["poll_latency_ms"] = latency
                SYSTEM_STATS["last_error"] = self.last_error
                self._refresh_state()
            except Exception:
                pass
            return None

    async def run_single_poll_cycle(self) -> int:
        if self._refresh_lock.locked():
            return len(self.last_valid_snapshot or [])
        async with self._refresh_lock:
            self.refresh_in_progress = True
            self._refresh_state()
            await self._broadcast_refresh_state()
            try:
                return await self._run_single_poll_cycle()
            finally:
                self.refresh_in_progress = False
                await self._broadcast_refresh_state()

    async def _run_single_poll_cycle(self) -> int:
        """Executes a single fetch, normalizes vectors, writes to Redis Stream and processes through detection."""
        from datetime import datetime

        from app.core.redis import redis_client
        from app.core.telemetry import OPENSKY_POLL_FAILURE, OPENSKY_POLL_SUCCESS

        raw_states = None
        try:
            raw_states = await self.poll_api()
        except Exception as ex:
            print(f"[OPENSKY POLL EXCEPTION] {ex}", flush=True)

        if raw_states is None:
            OPENSKY_POLL_FAILURE.inc()
            if self.current_source_status == "REFRESHING":
                self.current_source_status = "UNAVAILABLE"
                self.last_error = (
                    "The source did not return a valid telemetry response."
                )
                self.update_circuit_state_on_failure(self.last_error)
                self._schedule_failed_retry()
            logger.warning(
                "Source refresh failed; retaining last valid snapshot (%s records): %s",
                len(self.last_valid_snapshot or []),
                self.last_error or "unknown source error",
            )
            self._refresh_state()
            await self._broadcast_refresh_state()
            return len(self.last_valid_snapshot or [])

        vectors_to_process = raw_states
        source_label = f"{self.source_adapter.name}_live"
        raw_count = len(raw_states)
        fallback_reason = None

        # Check Redis reachability once per cycle
        redis_available = False
        try:
            await asyncio.wait_for(redis_client.ping(), timeout=0.15)
            redis_available = True
        except Exception:
            redis_available = False

        normalized_records = []
        for vector in vectors_to_process:
            try:
                normalized = self.normalize_state(vector)
            except (TypeError, ValueError, OverflowError, OSError, IndexError) as exc:
                logger.warning("Skipping malformed upstream state vector: %s", exc)
                continue
            if normalized is not None:
                normalized.setdefault("metadata", {})
                normalized["metadata"]["is_synthetic"] = False
                normalized["source"] = source_label
                normalized_records.append(normalized)

        if raw_states and not normalized_records:
            self.current_source_status = "INVALID_RESPONSE"
            self.last_error = "The source response contained aircraft vectors, but none had valid positions and observation timestamps."
            self.update_circuit_state_on_failure(self.last_error)
            self._schedule_failed_retry()
            try:
                from app.api.v1.endpoints import SYSTEM_STATS

                SYSTEM_STATS["upstream_status"] = "INVALID_RESPONSE"
                SYSTEM_STATS["feed_mode"] = "UNAVAILABLE"
                SYSTEM_STATS["fallback_reason"] = self.last_error
                SYSTEM_STATS["last_error"] = self.last_error
                SYSTEM_STATS["last_poll_http_status"] = 502
                self._refresh_state()
            except Exception:
                pass
            logger.warning(
                "Invalid source snapshot rejected; retaining %s aircraft",
                len(self.last_valid_snapshot or []),
            )
            await self._broadcast_refresh_state()
            OPENSKY_POLL_FAILURE.inc()
            return len(self.last_valid_snapshot or [])

        # Commit atomically only after the entire response has been structurally
        # validated and normalized. An empty list is valid only for an explicit
        # HTTP 200 response with a valid empty `states` field.
        retrieved_at = datetime.now(timezone.utc)
        self.last_valid_snapshot = list(normalized_records)
        self.last_successful_update = retrieved_at
        self.last_poll_timestamp = retrieved_at
        self.last_poll_records = raw_count
        self.last_normalized_records = len(normalized_records)
        self.current_source_status = "FRESH"
        self.last_error = None
        self.retry_after_until = None
        self.next_attempt_at = retrieved_at + timedelta(seconds=self.poll_interval)
        self.update_circuit_state_on_success(len(normalized_records))
        try:
            from app.api.v1.endpoints import SYSTEM_STATS

            SYSTEM_STATS.update(
                {
                    "last_successful_poll": retrieved_at,
                    "last_poll_records": raw_count,
                    "last_normalized_records": len(normalized_records),
                    "last_poll_http_status": 200,
                    "rate_limit_remaining": self.rate_limit_remaining or "Active",
                    "poll_latency_ms": SYSTEM_STATS.get("poll_latency_ms", 0.0),
                    "circuit_breaker_state": self.breaker_state,
                    "upstream_status": "LIVE",
                    "feed_mode": "LIVE",
                    "feed_source": source_label,
                    "fallback_reason": None,
                }
            )
        except Exception:
            pass
        OPENSKY_POLL_SUCCESS.inc()
        logger.info(
            "Validated %s source snapshot with %s real aircraft observations",
            self.source_adapter.name,
            len(normalized_records),
        )
        try:
            from app.api.v1.endpoints import invalidate_snapshot_cache

            await invalidate_snapshot_cache()
        except Exception as exc:
            logger.debug("Could not invalidate shared aircraft snapshot cache: %s", exc)
        await self._broadcast_refresh_state(snapshot_replaced=True)

        # Batch stream writes so a global snapshot does not require one Redis
        # network round trip per aircraft. Transactional chunks make the
        # fallback boundary explicit if a later chunk cannot be queued.
        queued_count = 0
        if redis_available:
            batch_size = 250
            for offset in range(0, len(normalized_records), batch_size):
                batch = normalized_records[offset : offset + batch_size]
                pipeline = redis_client.pipeline(transaction=True)
                for normalized in batch:
                    state_data = normalized.copy()
                    if isinstance(state_data.get("received_at"), datetime):
                        state_data["received_at"] = state_data[
                            "received_at"
                        ].isoformat()
                    payload_data = {"record": state_data, "trace_carrier": {}}
                    pipeline.xadd(
                        "airguard:telemetry", {"payload": json.dumps(payload_data)}
                    )
                try:
                    await pipeline.execute()
                    queued_count += len(batch)
                except Exception as exc:
                    redis_available = False
                    logger.error(
                        "Failed to queue telemetry batch at offset %s; %s records remain for local fallback: %s",
                        offset,
                        len(normalized_records) - queued_count,
                        exc,
                    )
                    break

        # 3. In-Process Processing Fallback
        # Redis-stream workers own successfully queued records. Process only the
        # unqueued remainder locally to avoid duplicate assessments and alerts.
        fallback_records = normalized_records[queued_count:]
        if self.detection_service and fallback_records:

            async def _process_batch(records_to_process):
                for offset in range(0, len(records_to_process), 200):
                    batch = records_to_process[offset : offset + 200]
                    sem = asyncio.Semaphore(20)
                    grouped_records = {}
                    for rec in batch:
                        grouped_records.setdefault(str(rec["icao24"]), []).append(rec)

                    async def _process_aircraft(records_for_aircraft):
                        async with sem:
                            aircraft_updates = []
                            for rec in records_for_aircraft:
                                try:
                                    update = (
                                        await self.detection_service.process_record(rec)
                                    )
                                    if update is not None:
                                        aircraft_updates.append(update)
                                except Exception as exc:
                                    logger.critical(
                                        "In-process detection could not persist %s; poll cycle is marked failed: %s",
                                        rec.get("icao24"),
                                        exc,
                                        exc_info=True,
                                    )
                                    raise
                            return aircraft_updates

                    grouped_updates = await asyncio.gather(
                        *[
                            _process_aircraft(records_for_aircraft)
                            for records_for_aircraft in grouped_records.values()
                        ]
                    )
                    updates = [
                        update
                        for aircraft_updates in grouped_updates
                        for update in aircraft_updates
                    ]
                    live_updates = [update for update in updates if update is not None]
                    if live_updates:
                        try:
                            from app.api.v1.endpoints import manager as ws_manager

                            await ws_manager.broadcast(
                                {
                                    "event": "AIRCRAFT_BATCH_UPDATE",
                                    "payload": {"items": live_updates},
                                }
                            )
                        except Exception as exc:
                            logger.warning(
                                "Failed to publish aircraft update batch: %s", exc
                            )
                    # Yield to event loop between chunks so HTTP/health requests are served immediately
                    await asyncio.sleep(0.01)

            # Await local fallback processing so successive poll cycles cannot
            # race each other's per-aircraft history when Redis is unavailable.
            await _process_batch(fallback_records)

        normalized_count = len(normalized_records)
        self.last_normalized_records = normalized_count

        # Sync comprehensive telemetry to SYSTEM_STATS
        try:
            from app.api.v1.endpoints import SYSTEM_STATS

            SYSTEM_STATS["last_normalized_records"] = normalized_count
            SYSTEM_STATS["feed_source"] = source_label
            SYSTEM_STATS["feed_mode"] = (
                "LIVE" if source_label.endswith("_live") else "UNAVAILABLE"
            )
            SYSTEM_STATS["fallback_reason"] = fallback_reason
        except Exception:
            pass

        print(
            f"[OPENSKY INGESTION] Poll Cycle Done | "
            f"HTTP Status: {self.poll_status_code or 200} | "
            f"Raw OpenSky Records: {raw_count} | "
            f"Valid Normalized Records: {normalized_count} | "
            f"Feed Mode: {source_label.upper()} | "
            f"Region: {settings.MONITOR_REGION}",
            flush=True,
        )
        return normalized_count

    async def start_polling_loop(self) -> None:
        """Spins up the continuous async polling run loop indefinitely with supervisor auto-recovery."""
        # Yield 1 second on startup so Uvicorn completes socket binding and health endpoints respond immediately
        await asyncio.sleep(1.0)
        logger.info("Starting OpenSky Ingestion continuous polling loop...")
        print(
            f"[OPENSKY INGESTION] Starting persistent background loop indefinitely (Interval: {self.poll_interval}s)...",
            flush=True,
        )

        consecutive_loop_errors = 0
        while True:
            if self.next_attempt_at is not None:
                wait_seconds = max(
                    0.0,
                    (self.next_attempt_at - datetime.now(timezone.utc)).total_seconds(),
                )
            else:
                wait_seconds = 0.0
            self._manual_refresh_wakeup.clear()
            if wait_seconds > 0:
                try:
                    await asyncio.wait_for(
                        self._manual_refresh_wakeup.wait(), timeout=wait_seconds
                    )
                except asyncio.TimeoutError:
                    pass
                if (
                    self.next_attempt_at
                    and datetime.now(timezone.utc) < self.next_attempt_at
                ):
                    continue
            self._manual_refresh_wakeup.clear()
            self.manual_refresh_requested = False
            try:
                await self.run_single_poll_cycle()
                consecutive_loop_errors = 0
            except asyncio.CancelledError:
                logger.info("OpenSky Ingestion polling loop cancelled by shutdown.")
                raise
            except Exception as loop_err:
                consecutive_loop_errors += 1
                backoff = min(60.0, 2.0 ** min(consecutive_loop_errors, 5))
                logger.error(
                    f"[SUPERVISOR] Ingestion loop error ({consecutive_loop_errors}): {loop_err}. Self-healing in {backoff}s..."
                )
                print(
                    f"[OPENSKY SUPERVISOR] Ingestion loop error: {loop_err}. Auto-recovering in {backoff}s...",
                    flush=True,
                )
                await asyncio.sleep(backoff)

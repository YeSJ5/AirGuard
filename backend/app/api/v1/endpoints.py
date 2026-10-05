import asyncio
import json
import logging

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)

logger = logging.getLogger("airguard.api")
import math
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Any

from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from redis.exceptions import RedisError
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import (
    get_current_user,
    get_websocket_user,
    require_admin,
    require_analyst,
    require_viewer,
)
from app.api.schemas import (
    AircraftDetailResponse,
    AircraftIdentityResponse,
    AircraftStalenessResponse,
    AircraftStateResponse,
    AircraftTrustDetailResponse,
    AircraftTrustHistoryResponse,
    AirspaceEventCandidate,
    AirspaceEventCaseCreate,
    AirspaceEventCaseResponse,
    AirspaceEventCaseUpdate,
    AlertResponse,
    AuditLogResponse,
    FlightRouteResponse,
    ModelRunResponse,
    SystemHealthResponse,
    TokenResponse,
    UserRegister,
    UserResponse,
)
from app.core.config import settings
from app.core.database import get_db
from app.core.limiter import limiter
from app.core.security import create_access_token, get_password_hash, verify_password
from app.detection.trust import (
    classify_risk_pattern,
    compute_weighted_rolling_risk,
    derive_trust_score,
)
from app.ingestion.opensky_auth import opensky_auth
from app.models import (
    AircraftAssessment,
    AircraftState,
    AirspaceEventCase,
    AirspaceEventCaseReview,
    Alert,
    AuditLog,
    ModelRun,
    User,
)

router = APIRouter()

active_detection_service = None
active_ingestion_service = None
active_route_service = None


def _invalid_body(field: str, message: str) -> HTTPException:
    """Return manual validation errors in FastAPI's documented 422 shape."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=[{"loc": ["body", field], "msg": message, "type": "value_error"}],
    )


async def write_audit_log(
    db: AsyncSession,
    user_id: int,
    action: str,
    target_type: str,
    target_id: str | None = None,
    ip_address: str | None = None,
):
    log = AuditLog(
        user_id=user_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        ip_address=ip_address,
        timestamp=datetime.now(timezone.utc),
    )
    db.add(log)
    await db.commit()


# --- Auth Endpoints ---


@router.post("/auth/register", response_model=UserResponse)
async def register_user(payload: UserRegister, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == payload.email.lower()))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    hashed_pwd = get_password_hash(payload.password)
    user = User(
        email=payload.email.lower(),
        hashed_password=hashed_pwd,
        role="viewer",
        created_at=datetime.now(timezone.utc),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    await write_audit_log(
        db=db,
        user_id=user.id,
        action="register",
        target_type="user",
        target_id=str(user.id),
    )
    return user


@router.post("/auth/login", response_model=TokenResponse)
async def login(
    request: Request,
    db: AsyncSession = Depends(get_db),
    form_data: OAuth2PasswordRequestForm = Depends(),
):
    result = await db.execute(
        select(User).where(User.email == form_data.username.lower())
    )
    user = result.scalar_one_or_none()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token = create_access_token(subject=user.id)
    await write_audit_log(
        db=db,
        user_id=user.id,
        action="login",
        target_type="auth",
        target_id=str(user.id),
        ip_address=request.client.host if request.client else None,
    )
    return {"access_token": access_token, "token_type": "bearer"}


@router.get("/auth/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user


# --- Admin Endpoints ---


@router.get("/admin/audit-logs", response_model=list[AuditLogResponse])
async def get_audit_logs(
    request: Request,
    user_id: int | None = Query(default=None),
    action: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    query = select(AuditLog)
    if user_id is not None:
        query = query.where(AuditLog.user_id == user_id)
    if action is not None:
        query = query.where(AuditLog.action == action)

    result = await db.execute(
        query.order_by(AuditLog.timestamp.desc()).limit(limit).offset(offset)
    )
    return result.scalars().all()


@router.get("/admin/users", response_model=list[UserResponse])
async def list_users(
    db: AsyncSession = Depends(get_db), current_user: User = Depends(require_admin)
):
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    return result.scalars().all()


@router.post("/admin/users", response_model=UserResponse)
async def create_user(
    payload: UserRegister,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.email == payload.email.lower()))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    hashed_pwd = get_password_hash(payload.password)
    user = User(
        email=payload.email.lower(),
        hashed_password=hashed_pwd,
        role=payload.role,
        created_at=datetime.now(timezone.utc),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    await write_audit_log(
        db=db,
        user_id=current_user.id,
        action="create_user",
        target_type="user",
        target_id=str(user.id),
    )
    return user


@router.delete("/admin/users/{id}")
async def delete_user(
    id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    if id == current_user.id:
        raise HTTPException(
            status_code=400, detail="Cannot delete currently logged in admin account"
        )

    result = await db.execute(select(User).where(User.id == id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    await db.delete(user)
    await db.commit()

    await write_audit_log(
        db=db,
        user_id=current_user.id,
        action="delete_user",
        target_type="user",
        target_id=str(id),
    )
    return {"status": "deleted"}


# Keep track of service startup time for session reporting
START_TIME = datetime.now(timezone.utc)

# WebSocket Connection Manager
import os
import uuid

from app.core.redis import redis_client
from app.core.telemetry import ACTIVE_WEBSOCKETS

REPLICA_ID = os.getenv("REPLICA_ID", f"replica-{os.getpid()}-{uuid.uuid4().hex[:6]}")


class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        ACTIVE_WEBSOCKETS.set(len(self.active_connections))

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        ACTIVE_WEBSOCKETS.set(len(self.active_connections))

    async def broadcast_local(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                pass

    async def broadcast(self, message: dict):
        # 1. Immediately broadcast locally with zero latency
        await self.broadcast_local(message)
        # 2. Also publish to Redis PubSub if Redis is running, tagged with REPLICA_ID
        try:
            import asyncio

            pub_payload = {"_sender": REPLICA_ID, "data": message}
            await asyncio.wait_for(
                redis_client.publish(
                    "airguard:websocket_channel", json.dumps(pub_payload)
                ),
                timeout=0.2,
            )
        except Exception:
            pass


manager = ConnectionManager()


async def websocket_pubsub_listener(manager: ConnectionManager):
    import asyncio

    while True:
        try:
            pubsub = redis_client.pubsub()
            await asyncio.wait_for(
                pubsub.subscribe("airguard:websocket_channel"), timeout=1.0
            )
            async for message in pubsub.listen():
                if message["type"] == "message":
                    try:
                        raw = json.loads(message["data"])
                        if isinstance(raw, dict) and "_sender" in raw:
                            if raw["_sender"] == REPLICA_ID:
                                continue  # Avoid duplicate broadcast on originating replica
                            await manager.broadcast_local(raw.get("data", {}))
                        else:
                            await manager.broadcast_local(raw)
                    except Exception:
                        pass
        except asyncio.CancelledError:
            break
        except Exception:
            await asyncio.sleep(5)


# Global variables for system health polling (live telemetry statistics)
SYSTEM_STATS = {
    "poll_latency_ms": 0.0,
    "queue_depth": 0,
    "circuit_breaker_state": "CLOSED",
    "last_successful_poll": None,
    "last_poll_attempt": None,
    "last_poll_records": 0,
    "last_normalized_records": 0,
    "upstream_status": "UNKNOWN",
    "feed_mode": "UNKNOWN",
    "feed_source": "none",
    "fallback_reason": None,
    "last_poll_http_status": None,
    "rate_limit_remaining": None,
    "total_real_states": 0,
    "total_synthetic_states": 0,
    "source_status": "AWAITING_TELEMETRY",
    "source_name": None,
    "last_successful_update": None,
    "next_attempt_at": None,
    "retry_after": None,
    "snapshot_age_seconds": None,
    "snapshot_count": None,
    "consecutive_failures": 0,
    "last_error": None,
    "refresh_in_progress": False,
    "manual_refresh_pending": False,
    "refresh_interval_seconds": None,
}


async def invalidate_snapshot_cache():
    """Invalidates distributed snapshot caches across all API replicas."""
    try:
        keys = await redis_client.keys("cache:aircraft:snapshot:*")
        if keys:
            await redis_client.delete(*keys)
    except Exception as e:
        logger.debug(f"Redis cache invalidation error: {e}")


@router.get("/aircraft", response_model=list[AircraftStateResponse])
@limiter.limit("50/minute")
async def get_aircraft(
    request: Request,
    response: Response,
    limit: int | None = Query(
        default=None,
        ge=1,
        le=5000,
        description="Optional maximum aircraft to return. If omitted, returns all currently tracked aircraft without cutoff.",
    ),
    offset: int = Query(default=0, ge=0),
    max_age_seconds: float | None = Query(
        default=None,
        ge=10.0,
        le=86400.0,
        description="Active tracking retention window in seconds.",
    ),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    """
    Retrieve full snapshot of every aircraft currently tracked in aircraft_states
    within the active retention window (no artificial cutoff). Annotates staleness status.
    """
    # A validated source snapshot is authoritative, including a valid empty
    # snapshot. During source failures this remains unchanged and continues to
    # be served with its original observation timestamps.
    service = active_ingestion_service
    snapshot = getattr(service, "last_valid_snapshot", None) if service else None
    if snapshot is not None:
        response.headers["X-AirGuard-Snapshot-Authoritative"] = "true"
        poll_interval = float(
            settings.OPENSKY_POLL_INTERVAL_SECONDS
            or (90.0 if opensky_auth.configured else 900.0)
        )
        now = datetime.now(timezone.utc)
        items = []
        det_svc = active_detection_service
        for record in snapshot:
            observed_at = record.get("received_at")
            if isinstance(observed_at, str):
                try:
                    observed_at = datetime.fromisoformat(
                        observed_at.replace("Z", "+00:00")
                    )
                except ValueError:
                    continue
            if not isinstance(observed_at, datetime):
                continue
            if observed_at.tzinfo is None:
                observed_at = observed_at.replace(tzinfo=timezone.utc)
            age = max(0.0, (now - observed_at).total_seconds())

            score_data = det_svc.get_latest_score(record["icao24"]) if det_svc else None
            comb_risk = score_data.get("combined_risk_score") if score_data else None
            trust_val = (
                score_data.get("trust_score")
                if score_data
                else derive_trust_score(comb_risk)
            )
            evidence_conf = (
                score_data.get("evidence_confidence") if score_data else None
            )
            ass_status = (
                score_data.get("assessment_status")
                if score_data
                else ("PARTIALLY_ASSESSED" if comb_risk is not None else "UNASSESSED")
            )

            items.append(
                AircraftStateResponse(
                    id=None,
                    icao24=record["icao24"],
                    callsign=record.get("callsign"),
                    squawk=record.get("squawk"),
                    latitude=record["latitude"],
                    longitude=record["longitude"],
                    altitude_m=record["altitude_m"],
                    velocity_ms=record["velocity_ms"],
                    heading_deg=record["heading_deg"],
                    vertical_rate_ms=record["vertical_rate_ms"],
                    on_ground=record["on_ground"],
                    received_at=observed_at,
                    source=record.get("source", service.source_adapter.name),
                    reported_nic=record.get("reported_nic"),
                    data_quality=record.get("data_quality") or {},
                    is_synthetic=False,
                    last_seen_seconds_ago=round(age, 1),
                    staleness_status=(
                        "STALE" if age > max(20.0, poll_interval * 1.5) else "LIVE"
                    ),
                    trust_score=trust_val,
                    combined_risk_score=comb_risk,
                    evidence_confidence=evidence_conf,
                    assessment_status=ass_status,
                )
            )
        if offset:
            items = items[offset:]
        if limit is not None:
            items = items[:limit]
        return items

    poll_interval = float(
        settings.OPENSKY_POLL_INTERVAL_SECONDS
        or (90.0 if opensky_auth.configured else 900.0)
    )
    max_age_seconds = max_age_seconds or min(86400.0, max(120.0, poll_interval * 3.0))
    cache_key = f"cache:aircraft:snapshot:{limit}:{offset}:{int(max_age_seconds)}"
    try:
        cached = await redis_client.get(cache_key)
        if cached:
            return json.loads(cached)
    except Exception as e:
        logger.error(f"Redis cache read error: {e}")

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(seconds=max_age_seconds)

    # 1. Query latest states within retention window. Subquery groups by icao24 to deduplicate historical records.
    subq = (
        select(
            AircraftState.icao24,
            func.max(AircraftState.received_at).label("max_received"),
        )
        .where(AircraftState.received_at >= cutoff)
        .where(AircraftState.is_synthetic == False)
        .where(AircraftState.source != "regional_fallback")
        .group_by(AircraftState.icao24)
        .subquery()
    )
    stmt = (
        select(
            AircraftState,
            AircraftAssessment.combined_risk_score,
            AircraftAssessment.status,
            AircraftAssessment.signals,
        )
        .join(
            subq,
            (AircraftState.icao24 == subq.c.icao24)
            & (AircraftState.received_at == subq.c.max_received),
        )
        .outerjoin(
            AircraftAssessment, AircraftAssessment.aircraft_state_id == AircraftState.id
        )
        .order_by(AircraftState.received_at.desc())
    )
    if offset > 0:
        stmt = stmt.offset(offset)
    if limit is not None:
        stmt = stmt.limit(limit)

    result = await db.execute(stmt)
    states = result.all()

    # Deduplicate in case multiple rows share exact same max_received for same icao24
    seen = set()
    response_items = []
    for s, assessment_risk, assessment_status, assessment_signals in states:
        if s.icao24 in seen:
            continue
        seen.add(s.icao24)

        s_dt = ensure_utc_dt(s.received_at)
        seconds_ago = max(0.0, (now - s_dt).total_seconds())
        # Staleness: mark STALE if older than 2x poll interval (20s)
        is_stale = seconds_ago > max(20.0, poll_interval * 1.5)
        staleness_status = "STALE" if is_stale else "LIVE"

        comb_risk = round(assessment_risk, 4) if assessment_risk is not None else None
        trust_val = derive_trust_score(comb_risk)
        evidence_conf = None
        if isinstance(assessment_signals, dict):
            evidence_conf = assessment_signals.get("evidence_confidence")
        if evidence_conf is None and comb_risk is not None:
            evidence_conf = 0.40

        item = AircraftStateResponse(
            id=s.id,
            icao24=s.icao24,
            callsign=s.callsign,
            squawk=s.squawk,
            latitude=s.latitude,
            longitude=s.longitude,
            altitude_m=s.altitude_m,
            velocity_ms=s.velocity_ms,
            heading_deg=s.heading_deg,
            vertical_rate_ms=s.vertical_rate_ms,
            on_ground=s.on_ground,
            received_at=s.received_at,
            source=s.source,
            reported_nic=s.reported_nic,
            data_quality=getattr(s, "data_quality", {}) or {},
            is_synthetic=bool(
                getattr(s, "is_synthetic", False) or s.source == "regional_fallback"
            ),
            last_seen_seconds_ago=round(seconds_ago, 1),
            staleness_status=staleness_status,
            trust_score=trust_val,
            combined_risk_score=comb_risk,
            evidence_confidence=evidence_conf,
            assessment_status=assessment_status,
        )
        response_items.append(item)

    try:
        serialized = [item.model_dump(mode="json") for item in response_items]
        await redis_client.setex(cache_key, 2, json.dumps(serialized))
    except Exception as e:
        logger.error(f"Redis cache write error: {e}")

    return response_items


@router.post(
    "/system/refresh",
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        409: {"description": "A source refresh is already active or queued."},
        429: {"description": "Refresh requests are rate limited."},
        503: {"description": "The telemetry source manager is not initialized."},
    },
)
@limiter.limit("6/minute")
async def request_source_refresh(
    request: Request,
    current_user: User = Depends(require_viewer),
):
    """Queue one legitimate refresh through the configured source adapter."""
    if active_ingestion_service is None:
        raise HTTPException(
            status_code=503,
            detail="Telemetry source manager is not initialized; awaiting backend startup.",
        )
    result = await active_ingestion_service.request_manual_refresh()
    if not result.get("accepted"):
        raise HTTPException(
            status_code=409, detail=result.get("reason", "A refresh is already active.")
        )
    return result


def ensure_utc_dt(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    try:
        return dt.astimezone(timezone.utc)
    except OverflowError as exc:
        raise HTTPException(
            status_code=422, detail="Timestamp is outside the supported UTC range"
        ) from exc


@router.get("/aircraft/history", response_model=list[AircraftStateResponse])
@limiter.limit("60/minute")
async def get_all_aircraft_history(
    request: Request,
    response: Response,
    start: datetime = Query(
        ..., description="Query start timestamp (ISO 8601). If naive, UTC is assumed."
    ),
    end: datetime = Query(
        ..., description="Query end timestamp (ISO 8601). If naive, UTC is assumed."
    ),
    icao24: str | None = Query(
        default=None, description="Optional aircraft ICAO 24-bit address filter."
    ),
    limit: int | None = Query(
        default=None,
        ge=1,
        le=50000,
        description="Max records to return. If omitted, returns all records up to safety ceiling.",
    ),
    offset: int = Query(default=0, ge=0, description="Pagination offset."),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    """Retrieve historical states for all aircraft within a time range, guaranteed UTC normalized."""
    start_utc = ensure_utc_dt(start)
    end_utc = ensure_utc_dt(end)

    if start_utc > end_utc:
        raise HTTPException(
            status_code=400,
            detail=f"Start timestamp ({start_utc.isoformat()}) cannot be after end timestamp ({end_utc.isoformat()})",
        )

    # Build query
    base_query = select(AircraftState).where(
        AircraftState.received_at >= start_utc,
        AircraftState.received_at <= end_utc,
        AircraftState.is_synthetic == False,
        AircraftState.source != "regional_fallback",
    )

    if icao24:
        base_query = base_query.where(AircraftState.icao24 == icao24.lower())

    from sqlalchemy import func

    count_query = select(func.count()).select_from(base_query.subquery())
    count_res = await db.execute(count_query)
    total_count = count_res.scalar() or 0

    effective_limit = limit if limit is not None else 10000
    query = (
        base_query.order_by(AircraftState.received_at.asc())
        .offset(offset)
        .limit(effective_limit)
    )

    result = await db.execute(query)
    states = result.scalars().all()

    # Informative response headers so truncation or timezone issues are visible, not silent
    response.headers["X-Total-Count"] = str(total_count)
    response.headers["X-Returned-Count"] = str(len(states))
    response.headers["X-Query-Start-UTC"] = start_utc.isoformat()
    response.headers["X-Query-End-UTC"] = end_utc.isoformat()
    response.headers["X-Is-Truncated"] = (
        "true" if total_count > (offset + len(states)) else "false"
    )

    return states


@router.get("/aircraft/{icao24}/history", response_model=list[AircraftStateResponse])
@limiter.limit("50/minute")
async def get_aircraft_history(
    request: Request,
    icao24: str,
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    """Retrieve historical reports for a specific aircraft address (ICAO 24-bit)."""
    result = await db.execute(
        select(AircraftState)
        .where(AircraftState.icao24 == icao24.lower())
        .order_by(AircraftState.received_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return result.scalars().all()


@router.get("/aircraft/{icao24}/detail", response_model=AircraftDetailResponse)
@limiter.limit("60/minute")
async def get_aircraft_detail(
    request: Request,
    icao24: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    """
    Retrieve single consolidated aircraft detail joining:
    1. Most recent physical telemetry state vector
    2. Cached flight route progression (departure, arrival, route text)
    3. Aggressively cached aircraft airframe identity & civil registry
    4. Continuously recalculated trust evaluation, risk scores & Story Mode narrative
    5. Continuous tracking freshness & staleness status
    """
    clean_icao = icao24.lower().strip()

    # 1. Fetch latest telemetry state vector
    result = await db.execute(
        select(AircraftState)
        .where(func.lower(AircraftState.icao24) == clean_icao)
        .order_by(AircraftState.received_at.desc())
        .limit(1)
    )
    latest_state = result.scalar_one_or_none()
    if not latest_state:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Aircraft '{clean_icao}' not found in active telemetry",
        )
    if latest_state.is_synthetic or latest_state.source == "regional_fallback":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Aircraft '{clean_icao}' has no live provider report",
        )

    now = datetime.now(timezone.utc)
    s_dt = ensure_utc_dt(latest_state.received_at)
    seconds_ago = max(0.0, (now - s_dt).total_seconds())
    poll_interval = float(
        settings.OPENSKY_POLL_INTERVAL_SECONDS
        or (90.0 if opensky_auth.configured else 900.0)
    )
    stale_after = max(20.0, poll_interval * 1.5)
    removal_after = max(120.0, poll_interval * 3.0)
    is_stale = seconds_ago > stale_after
    tracking_status = (
        "LOST" if seconds_ago > removal_after else ("STALE" if is_stale else "LIVE")
    )

    # 2. Sourced route (from active route service)
    route_service_instance = active_route_service
    if not route_service_instance:
        from app.core.database import async_session_maker
        from app.ingestion.route_service import FlightRouteService

        route_service_instance = FlightRouteService(async_session_maker)

    # Route and identity lookups are user-triggered and run concurrently. The
    # ingestion loop never fans these external requests out across the whole sky.
    from app.ingestion.metadata_service import active_metadata_service

    route_data, meta_data = await asyncio.gather(
        route_service_instance.get_or_fetch_route(
            clean_icao, callsign=latest_state.callsign, db=db
        ),
        active_metadata_service.get_aircraft_metadata(
            clean_icao, callsign=latest_state.callsign
        ),
    )
    route_resp = FlightRouteResponse(**route_data)
    identity_resp = AircraftIdentityResponse(**meta_data)

    # 4. Latest Trust Status & Risk Scoring
    alert_result = await db.execute(
        select(Alert)
        .where(func.lower(Alert.icao24) == clean_icao)
        .order_by(Alert.detected_at.desc())
        .limit(1)
    )
    latest_alert = alert_result.scalar_one_or_none()

    assessment_result = await db.execute(
        select(AircraftAssessment)
        .where(AircraftAssessment.aircraft_state_id == latest_state.id)
        .limit(1)
    )
    latest_assessment = assessment_result.scalar_one_or_none()
    is_flagged = False
    risk_score = (
        latest_assessment.combined_risk_score if latest_assessment is not None else None
    )
    explanation = (
        "This observation has insufficient scored evidence. This is not a safety finding or independent verification."
        if risk_score is None
        else "An available detector signal produced a triage score. The score is not a calibrated trust, safety, or airworthiness rating."
    )
    reasons = []
    rule_flags = {}
    technical_details = {}

    if (
        latest_alert
        and hasattr(latest_alert, "acknowledged")
        and not latest_alert.acknowledged
    ):
        alert_dt = (
            ensure_utc_dt(latest_alert.detected_at)
            if hasattr(latest_alert, "detected_at")
            else now
        )
        state_id_matches = (
            hasattr(latest_alert, "aircraft_state_id")
            and latest_alert.aircraft_state_id == latest_state.id
        )
        if state_id_matches:
            is_flagged = True
            risk_score = (
                float(latest_alert.combined_risk_score)
                if getattr(latest_alert, "combined_risk_score", None) is not None
                else None
            )
            explanation = getattr(
                latest_alert, "reason_text", "Flagged — signal inconsistency detected."
            )
            reasons = [
                r.strip()
                for r in (getattr(latest_alert, "reason_text", "") or "").split(";")
                if r.strip()
            ]

            shap_info = latest_alert.shap_explanation or {}
            evidence = (
                shap_info.get("evidence", {}) if isinstance(shap_info, dict) else {}
            )
            rule_data = (
                evidence.get("rule_flags", {}) if isinstance(evidence, dict) else {}
            )
            for k, v in rule_data.items():
                rule_flags[k] = bool(v)
            technical_details = {
                "ensemble_score": latest_alert.ensemble_score,
                "autoencoder_score": latest_alert.autoencoder_score,
                "shap": (
                    shap_info.get("shap", {}) if isinstance(shap_info, dict) else {}
                ),
            }

    assessment_signals = (
        latest_assessment.signals
        if latest_assessment is not None and isinstance(latest_assessment.signals, dict)
        else {}
    )
    assessment_rules = (
        assessment_signals.get("rule_flags", {})
        if isinstance(assessment_signals, dict)
        else {}
    )
    if isinstance(assessment_rules, dict):
        rule_flags.update(
            {
                key: value
                for key, value in assessment_rules.items()
                if isinstance(value, bool)
            }
        )

    evidence_conf = (
        assessment_signals.get("evidence_confidence")
        if isinstance(assessment_signals, dict)
        else None
    )
    if evidence_conf is None and risk_score is not None:
        evidence_conf = 0.40
    unavailable_reasons = (
        assessment_signals.get("unavailable_reasons", [])
        if isinstance(assessment_signals, dict)
        else []
    )

    if latest_assessment is not None:
        technical_details.update(
            {
                "rule_risk": (
                    1.0
                    if any(value is True for value in assessment_rules.values())
                    else (
                        0.0
                        if any(
                            isinstance(value, bool)
                            for value in assessment_rules.values()
                        )
                        else None
                    )
                ),
                "ensemble_score": assessment_signals.get("ensemble_score"),
                "autoencoder_score": assessment_signals.get("autoencoder_score"),
                "receiver_consistency_score": assessment_signals.get(
                    "receiver_consistency"
                ),
            }
        )

    assessment_status = (
        latest_assessment.status
        if latest_assessment is not None
        else ("REVIEW_REQUIRED" if is_flagged else "INSUFFICIENT_EVIDENCE")
    )
    trust_val = derive_trust_score(risk_score)

    if is_flagged:
        status_text = "REVIEW_REQUIRED — Anomaly Flagged"
        explanation = getattr(
            latest_alert, "reason_text", "Flagged — signal inconsistency detected."
        )
    elif assessment_status == "ASSESSED":
        status_text = "ASSESSED — Full Evidence Stack"
        explanation = "All intended detector layers evaluated this observation. Telemetry Trust Index reflects verified consistency across physics rules, kinematics, and models."
    elif assessment_status == "PARTIALLY_ASSESSED":
        status_text = "PARTIALLY ASSESSED — Available Evidence"
        explanation = "Detector assessed available telemetry signals (climb envelope, altitude-velocity coherence, kinematics). Telemetry Trust Index is derived from detector risk. This is not an airworthiness or flight safety rating."
    elif assessment_status == "SUPPRESSED":
        status_text = "SUPPRESSED — Known Entity"
        explanation = "Assessment suppressed for verified transponder profile."
    else:
        status_text = "INSUFFICIENT EVIDENCE"
        explanation = "Observation history is accumulating. Not enough scored evidence exists to compute a defensible detector risk or trust score."

    trust_resp = AircraftTrustDetailResponse(
        status_text=status_text,
        is_flagged=is_flagged,
        combined_risk_score=round(risk_score, 4) if risk_score is not None else None,
        trust_score=trust_val,
        evidence_confidence=evidence_conf,
        assessment_status=assessment_status,
        smoothed_risk_score=None,
        explanation=explanation,
        reasons=reasons,
        rule_flags=rule_flags,
        technical_details={
            **technical_details,
            "assessment_status": assessment_status,
            "rule_assessment_coverage": (
                latest_assessment.rule_assessment_coverage
                if latest_assessment is not None
                else None
            ),
            "evidence_confidence": evidence_conf,
            "signals": assessment_signals,
        },
        unavailable_reasons=unavailable_reasons,
        trilateration_stations=None,
        last_evaluated_at=latest_state.received_at,
    )

    live_state_resp = AircraftStateResponse(
        id=latest_state.id,
        icao24=latest_state.icao24,
        callsign=latest_state.callsign,
        latitude=latest_state.latitude,
        longitude=latest_state.longitude,
        altitude_m=latest_state.altitude_m,
        velocity_ms=latest_state.velocity_ms,
        heading_deg=latest_state.heading_deg,
        vertical_rate_ms=latest_state.vertical_rate_ms,
        on_ground=latest_state.on_ground,
        received_at=latest_state.received_at,
        source=latest_state.source,
        reported_nic=latest_state.reported_nic,
        data_quality=getattr(latest_state, "data_quality", {}) or {},
        is_synthetic=bool(
            getattr(latest_state, "is_synthetic", False)
            or latest_state.source == "regional_fallback"
        ),
        last_seen_seconds_ago=round(seconds_ago, 1),
        staleness_status=tracking_status,
        trust_score=trust_val,
        combined_risk_score=round(risk_score, 4) if risk_score is not None else None,
        evidence_confidence=evidence_conf,
        assessment_status=assessment_status,
    )

    staleness_resp = AircraftStalenessResponse(
        status=tracking_status,
        is_stale=is_stale,
        last_seen_seconds_ago=round(seconds_ago, 1),
        last_received_at=latest_state.received_at,
        staleness_threshold_seconds=stale_after,
        removal_threshold_seconds=removal_after,
    )

    # Sourced first seen timestamp for this aircraft in active session
    first_seen_res = await db.execute(
        select(func.min(AircraftState.received_at)).where(
            func.lower(AircraftState.icao24) == clean_icao
        )
    )
    first_seen_val = first_seen_res.scalar_one_or_none()
    if isinstance(first_seen_val, datetime):
        first_seen_session_dt = first_seen_val
    elif hasattr(first_seen_val, "received_at") and isinstance(
        first_seen_val.received_at, datetime
    ):
        first_seen_session_dt = first_seen_val.received_at
    else:
        first_seen_session_dt = latest_state.received_at

    return AircraftDetailResponse(
        icao24=clean_icao,
        callsign=latest_state.callsign,
        live_state=live_state_resp,
        route=route_resp,
        identity=identity_resp,
        trust_status=trust_resp,
        staleness=staleness_resp,
        first_seen_session=first_seen_session_dt,
    )


@router.get("/aircraft/{icao24}/route", response_model=FlightRouteResponse)
@limiter.limit("60/minute")
async def get_aircraft_route(
    request: Request,
    icao24: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    """Retrieve best-effort route context for an aircraft address, when available."""
    clean_icao = icao24.lower().strip()
    route_service_instance = active_route_service
    if not route_service_instance:
        from app.core.database import async_session_maker
        from app.ingestion.route_service import FlightRouteService

        route_service_instance = FlightRouteService(async_session_maker)

    route_data = await route_service_instance.get_or_fetch_route(clean_icao, db=db)
    return FlightRouteResponse(**route_data)


@router.get(
    "/aircraft/{icao24}/trust-history", response_model=AircraftTrustHistoryResponse
)
@limiter.limit("50/minute")
async def get_aircraft_trust_history(
    request: Request,
    icao24: str,
    window: int = Query(
        default=10, ge=1, le=50, description="Rolling smoothing window size in readings"
    ),
    limit: int = Query(
        default=200, ge=1, le=1000, description="Maximum historical readings to process"
    ),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    """Computes a weighted history of available heuristic detector risk scores."""
    clean_icao = icao24.lower().strip()

    # Query aircraft states along with any matched alerts ordered chronologically
    result = await db.execute(
        select(AircraftState, AircraftAssessment.combined_risk_score, Alert.id)
        .outerjoin(
            AircraftAssessment, AircraftAssessment.aircraft_state_id == AircraftState.id
        )
        .outerjoin(Alert, Alert.aircraft_state_id == AircraftState.id)
        .where(AircraftState.icao24 == clean_icao)
        .order_by(AircraftState.received_at.asc())
        .limit(limit)
    )
    rows = result.all()

    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No telemetry records found for aircraft {clean_icao}",
        )

    readings = []
    for state, risk_score, alert_id in rows:
        # Non-alert records do not have a persisted detector score; do not invent zero-risk samples.
        if risk_score is None:
            continue
        instant_risk = float(risk_score)
        readings.append(
            {
                "timestamp": state.received_at,
                "risk_score": instant_risk,
                "reported_nic": state.reported_nic,
                "is_alert": alert_id is not None,
            }
        )

    history_points = compute_weighted_rolling_risk(readings, window=window)
    pattern = classify_risk_pattern(history_points)

    caption = "Only observations with a persisted score are included. Scores are heuristic detector outputs, not probabilities or safety ratings."
    current_risk = history_points[-1]["risk_score"] if history_points else None

    return AircraftTrustHistoryResponse(
        icao24=clean_icao,
        current_risk_score=current_risk,
        window_size=window,
        pattern=pattern,
        caption=caption,
        history=history_points,
    )


@router.get("/alerts", response_model=list[AlertResponse])
@limiter.limit("30/minute")
async def get_alerts(
    request: Request,
    response: Response,
    acknowledged: bool | None = Query(default=None),
    icao24: str | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    """Retrieve security anomaly alerts, filterable by acknowledged state and ICAO code."""
    total_count_result = await db.execute(
        select(func.count(Alert.id)).where(Alert.is_synthetic.is_(False))
    )
    active_count_result = await db.execute(
        select(func.count(Alert.id)).where(
            Alert.is_synthetic.is_(False), Alert.acknowledged.is_(False)
        )
    )
    total_cnt = int(total_count_result.scalar_one() or 0)
    active_cnt = int(active_count_result.scalar_one() or 0)
    response.headers["X-Total-Count"] = str(total_cnt)
    response.headers["X-Active-Alert-Count"] = str(active_cnt)
    # The operational alert stream contains production observations only.
    query = select(Alert).where(Alert.is_synthetic.is_(False))

    if acknowledged is not None:
        query = query.where(Alert.acknowledged == acknowledged)
    if icao24 is not None:
        query = query.where(Alert.icao24 == icao24.lower())

    result = await db.execute(
        query.order_by(Alert.detected_at.desc()).limit(limit).offset(offset)
    )
    return result.scalars().all()


def _distance_km(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    """Great-circle separation used only to link nearby persisted alert observations."""
    radians = math.radians
    d_lat = radians(lat_b - lat_a)
    d_lon = radians(lon_b - lon_a)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(radians(lat_a)) * math.cos(radians(lat_b)) * math.sin(d_lon / 2) ** 2
    )
    return 6371.0088 * 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


async def _derive_airspace_event_candidates(
    db: AsyncSession, window_minutes: int, radius_km: float
) -> list[dict[str, Any]]:
    """Group persisted real alerts by proximity/time; the grouping is not a causal verdict."""
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
    result = await db.execute(
        select(Alert, AircraftState)
        .join(AircraftState, Alert.aircraft_state_id == AircraftState.id)
        .where(Alert.is_synthetic.is_(False))
        .where(AircraftState.is_synthetic.is_(False))
        .where(AircraftState.source != "regional_fallback")
        .where(AircraftState.received_at >= cutoff)
        .order_by(AircraftState.received_at.desc())
        .limit(1000)
    )
    observations = [
        {"alert": alert, "state": state}
        for alert, state in result.all()
        if state.latitude is not None and state.longitude is not None
    ]
    count = len(observations)
    parents = list(range(count))
    linked_pair_counts = [0] * count
    max_link_distances = [0.0] * count
    observation_times = []
    for observation in observations:
        observed_at = observation["state"].received_at
        observation_times.append(
            observed_at.replace(tzinfo=timezone.utc)
            if observed_at.tzinfo is None
            else observed_at
        )

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    max_seconds = window_minutes * 60
    for left in range(count):
        state_a = observations[left]["state"]
        time_a = observation_times[left]
        for right in range(left + 1, count):
            time_b = observation_times[right]
            elapsed_seconds = abs((time_a - time_b).total_seconds())
            # Rows are ordered newest first, so older records cannot match once
            # this pair exceeds the allowed observation-time separation.
            if elapsed_seconds > max_seconds:
                break
            state_b = observations[right]["state"]
            if state_a.icao24 == state_b.icao24:
                continue
            distance = _distance_km(
                state_a.latitude, state_a.longitude, state_b.latitude, state_b.longitude
            )
            if distance <= radius_km:
                root_a, root_b = find(left), find(right)
                if root_a != root_b:
                    parents[root_b] = root_a
                    linked_pair_counts[root_a] += linked_pair_counts[root_b] + 1
                    max_link_distances[root_a] = max(
                        max_link_distances[root_a], max_link_distances[root_b], distance
                    )
                else:
                    linked_pair_counts[root_a] += 1
                    max_link_distances[root_a] = max(
                        max_link_distances[root_a], distance
                    )

    components = {}
    for index in range(count):
        components.setdefault(find(index), []).append(index)

    candidates = []
    for indexes in components.values():
        aircraft = sorted({observations[i]["state"].icao24 for i in indexes})
        if len(aircraft) < 2:
            continue
        component_root = find(indexes[0])
        alerts = [observations[i]["alert"] for i in indexes]
        states = [observations[i]["state"] for i in indexes]
        lat_sum = sum(math.sin(math.radians(state.latitude)) for state in states)
        lat_cos = sum(math.cos(math.radians(state.latitude)) for state in states)
        lon_sin = sum(math.sin(math.radians(state.longitude)) for state in states)
        lon_cos = sum(math.cos(math.radians(state.longitude)) for state in states)
        center_latitude = math.degrees(math.atan2(lat_sum, lat_cos))
        center_longitude = math.degrees(math.atan2(lon_sin, lon_cos))
        first_alert_id = min(alert.id for alert in alerts)
        candidates.append(
            {
                "candidate_id": f"derived-{first_alert_id}",
                "status": "REVIEW_REQUIRED",
                "start_time": min(state.received_at for state in states),
                "end_time": max(state.received_at for state in states),
                "center_latitude": center_latitude,
                "center_longitude": center_longitude,
                "aircraft_icao24": aircraft,
                "alert_ids": sorted({alert.id for alert in alerts}),
                "anomaly_types": sorted(
                    {flag for alert in alerts for flag in (alert.rule_flags or [])}
                ),
                "linked_alert_pairs": linked_pair_counts[component_root],
                "max_link_distance_km": round(max_link_distances[component_root], 2),
                "time_window_minutes": window_minutes,
                "radius_km": radius_km,
                "evidence": [
                    {
                        "alert_id": alert.id,
                        "icao24": state.icao24,
                        "callsign": state.callsign,
                        "observed_at": state.received_at,
                        "latitude": state.latitude,
                        "longitude": state.longitude,
                        "source": state.source,
                        "data_quality": state.data_quality or {},
                        "rule_flags": alert.rule_flags or [],
                        "risk_score": alert.combined_risk_score,
                        "reason_text": alert.reason_text,
                    }
                    for alert, state in (
                        (observations[i]["alert"], observations[i]["state"])
                        for i in indexes
                    )
                ],
            }
        )
    candidates.sort(key=lambda candidate: candidate["end_time"], reverse=True)
    return candidates


@router.get("/airspace/event-candidates", response_model=list[AirspaceEventCandidate])
@limiter.limit("20/minute")
async def get_airspace_event_candidates(
    request: Request,
    window_minutes: int = Query(default=30, ge=1, le=240),
    radius_km: float = Query(default=50.0, ge=1.0, le=500.0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    """Return derived candidate groups and their source alert/observation evidence."""
    return await _derive_airspace_event_candidates(db, window_minutes, radius_km)


@router.get("/airspace/event-cases", response_model=list[AirspaceEventCaseResponse])
@limiter.limit("30/minute")
async def list_airspace_event_cases(
    request: Request,
    status_filter: str | None = Query(
        default=None, alias="status", pattern="^(OPEN|IN_REVIEW|CLOSED)$"
    ),
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    query = select(AirspaceEventCase).options(selectinload(AirspaceEventCase.reviews))
    if status_filter:
        query = query.where(AirspaceEventCase.status == status_filter)
    result = await db.execute(
        query.order_by(AirspaceEventCase.updated_at.desc()).limit(limit)
    )
    return result.scalars().all()


@router.get("/airspace/event-cases/{case_id}", response_model=AirspaceEventCaseResponse)
@limiter.limit("60/minute")
async def get_airspace_event_case(
    request: Request,
    case_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    result = await db.execute(
        select(AirspaceEventCase)
        .options(selectinload(AirspaceEventCase.reviews))
        .where(AirspaceEventCase.id == case_id)
    )
    event_case = result.scalar_one_or_none()
    if event_case is None:
        raise HTTPException(status_code=404, detail="Airspace event case not found")
    return event_case


@router.post(
    "/airspace/event-cases", response_model=AirspaceEventCaseResponse, status_code=201
)
@limiter.limit("10/minute")
async def create_airspace_event_case(
    request: Request,
    payload: AirspaceEventCaseCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_analyst),
):
    alert_ids = sorted(set(payload.alert_ids))
    if len(alert_ids) != len(payload.alert_ids):
        raise _invalid_body("alert_ids", "Alert IDs must be unique")
    if len(payload.title.strip()) < 3:
        raise _invalid_body(
            "title", "Case title must contain at least 3 non-space characters"
        )

    # Recompute the candidate from the source database rows. The client cannot
    # create a case by submitting fabricated coordinates or an arbitrary group.
    candidates = await _derive_airspace_event_candidates(
        db, payload.time_window_minutes, payload.radius_km
    )
    candidate = next(
        (item for item in candidates if item["candidate_id"] == payload.candidate_id),
        None,
    )
    if candidate is None or candidate["alert_ids"] != alert_ids:
        raise HTTPException(
            status_code=409,
            detail="This candidate has changed or is no longer supported by current real alert observations. Refresh candidates and try again.",
        )

    existing_result = await db.execute(
        select(AirspaceEventCase.id)
        .where(
            AirspaceEventCase.candidate_id == payload.candidate_id,
            AirspaceEventCase.status != "CLOSED",
        )
        .limit(1)
    )
    if existing_result.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=409, detail="An open case already exists for this candidate"
        )

    now = datetime.now(timezone.utc)
    event_case = AirspaceEventCase(
        candidate_id=payload.candidate_id,
        title=payload.title.strip(),
        status="OPEN",
        disposition=None,
        evidence_snapshot=jsonable_encoder(
            {
                **candidate,
                "captured_at": now,
                "correlation_method": "space-time-connected-components-v1",
                "causal_finding": None,
            }
        ),
        created_by=current_user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(event_case)
    await db.flush()
    db.add(
        AirspaceEventCaseReview(
            case_id=event_case.id,
            reviewer_id=current_user.id,
            action="CREATED",
            previous_status=None,
            new_status="OPEN",
            previous_disposition=None,
            new_disposition=None,
            notes="Case created from a server-revalidated alert candidate.",
            ip_address=request.client.host if request.client else None,
            created_at=now,
        )
    )
    db.add(
        AuditLog(
            user_id=current_user.id,
            action="create",
            target_type="airspace_event_case",
            target_id=str(event_case.id),
            ip_address=request.client.host if request.client else None,
            timestamp=now,
        )
    )
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="An open case already exists for this candidate"
        ) from exc
    result = await db.execute(
        select(AirspaceEventCase)
        .options(selectinload(AirspaceEventCase.reviews))
        .where(AirspaceEventCase.id == event_case.id)
    )
    return result.scalar_one()


@router.patch(
    "/airspace/event-cases/{case_id}", response_model=AirspaceEventCaseResponse
)
@limiter.limit("20/minute")
async def update_airspace_event_case(
    request: Request,
    case_id: int,
    payload: AirspaceEventCaseUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_analyst),
):
    result = await db.execute(
        select(AirspaceEventCase)
        .options(selectinload(AirspaceEventCase.reviews))
        .where(AirspaceEventCase.id == case_id)
        .with_for_update()
    )
    event_case = result.scalar_one_or_none()
    if event_case is None:
        raise HTTPException(status_code=404, detail="Airspace event case not found")

    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise _invalid_body("body", "Provide a status, disposition, or review note")
    if "status" in changes and changes["status"] is None:
        raise _invalid_body("status", "Status cannot be null")
    previous_status = event_case.status
    previous_disposition = event_case.disposition
    new_status = changes.get("status", previous_status)
    new_disposition = changes.get("disposition", previous_disposition)
    if (
        new_status != "CLOSED"
        and previous_status == "CLOSED"
        and "status" in changes
        and "disposition" not in changes
    ):
        new_disposition = None
    if new_status != "CLOSED" and new_disposition is not None:
        raise _invalid_body(
            "disposition", "A disposition can only be set when closing the case"
        )
    notes = changes.get("notes")
    if new_status == "CLOSED" and (
        not isinstance(notes, str) or len(notes.strip()) < 8
    ):
        raise _invalid_body(
            "notes",
            "Closing a case requires a disposition note of at least 8 characters",
        )
    if new_status == "CLOSED" and new_disposition is None:
        raise _invalid_body(
            "disposition", "Choose a disposition before closing the case"
        )
    if (
        new_status == previous_status
        and new_disposition == previous_disposition
        and not (isinstance(notes, str) and notes.strip())
    ):
        raise HTTPException(status_code=409, detail="No case changes were supplied")

    now = datetime.now(timezone.utc)
    event_case.status = new_status
    event_case.disposition = new_disposition
    event_case.updated_at = now
    event_case.closed_at = now if new_status == "CLOSED" else None
    action = (
        "DISPOSITION_RECORDED"
        if new_status == "CLOSED"
        else "CASE_REOPENED" if previous_status == "CLOSED" else "CASE_UPDATED"
    )
    db.add(
        AirspaceEventCaseReview(
            case_id=event_case.id,
            reviewer_id=current_user.id,
            action=action,
            previous_status=previous_status,
            new_status=new_status,
            previous_disposition=previous_disposition,
            new_disposition=new_disposition,
            notes=notes.strip() if isinstance(notes, str) and notes.strip() else None,
            ip_address=request.client.host if request.client else None,
            created_at=now,
        )
    )
    db.add(
        AuditLog(
            user_id=current_user.id,
            action=action.lower(),
            target_type="airspace_event_case",
            target_id=str(event_case.id),
            ip_address=request.client.host if request.client else None,
            timestamp=now,
        )
    )
    await db.commit()
    result = await db.execute(
        select(AirspaceEventCase)
        .options(selectinload(AirspaceEventCase.reviews))
        .where(AirspaceEventCase.id == case_id)
    )
    return result.scalar_one()


@router.post("/alerts/{id}/acknowledge", response_model=AlertResponse)
@limiter.limit("20/minute")
async def acknowledge_alert(
    request: Request,
    id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_analyst),
):
    """Acknowledge a specific security alert."""
    result = await db.execute(select(Alert).where(Alert.id == id))
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")

    alert.acknowledged = True
    await db.commit()
    await db.refresh(alert)

    await write_audit_log(
        db=db,
        user_id=current_user.id,
        action="acknowledge",
        target_type="alert",
        target_id=str(id),
        ip_address=request.client.host if request.client else None,
    )
    await invalidate_snapshot_cache()
    return alert


@router.get("/model-runs", response_model=list[ModelRunResponse])
@limiter.limit("30/minute")
async def get_model_runs(
    request: Request,
    limit: int = Query(default=50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    """Retrieve historical machine learning model evaluation runs."""
    cache_key = f"cache:model_runs:all:{limit}"
    try:
        cached = await redis_client.get(cache_key)
        if cached:
            return json.loads(cached)
    except Exception as e:
        logger.error(f"Redis cache read error: {e}")

    result = await db.execute(
        select(ModelRun).order_by(ModelRun.run_at.desc()).limit(limit)
    )
    runs = result.scalars().all()

    try:
        serialized = [
            ModelRunResponse.model_validate(r).model_dump(mode="json") for r in runs
        ]
        await redis_client.setex(cache_key, 3600, json.dumps(serialized))
    except Exception as e:
        logger.error(f"Redis cache write error: {e}")

    return runs


@router.get("/system-health", response_model=SystemHealthResponse)
@limiter.limit("60/minute")
async def get_system_health(
    request: Request,
    strict: bool = Query(
        default=False,
        description="If true, return HTTP 503 when continuity gap is detected",
    ),
    db: AsyncSession = Depends(get_db),
):
    """Get system ingestion statistics, queue depths, rate-limit status, and live continuity verification."""
    import inspect

    from fastapi.responses import JSONResponse
    from sqlalchemy import func

    def _to_int(val, default=0):
        try:
            if inspect.isawaitable(val):
                return default
            return int(val) if val is not None else default
        except Exception:
            return default

    def _to_float(val, default=0.0):
        try:
            if inspect.isawaitable(val):
                return default
            return float(val) if val is not None else default
        except Exception:
            return default

    database_status = "UNKNOWN"
    redis_status = "UNKNOWN"
    try:
        await db.execute(text("SELECT 1"))
        database_status = "CONNECTED"
    except SQLAlchemyError as exc:
        database_status = "DISCONNECTED"
        logger.warning("System health database probe failed: %s", exc)
    try:
        await redis_client.ping()
        redis_status = "CONNECTED"
    except RedisError as exc:
        redis_status = "DISCONNECTED"
        logger.warning("System health Redis probe failed: %s", exc)

    try:
        import time

        now_ts = time.time()
        last_refresh = SYSTEM_STATS.get("_last_count_refresh", 0.0)
        if now_ts - last_refresh > 10.0:
            real_res = await db.execute(
                select(func.count(AircraftState.id)).where(
                    AircraftState.is_synthetic == False,
                    AircraftState.source != "regional_fallback",
                )
            )
            real_count = _to_int(
                real_res.scalar() if not inspect.isawaitable(real_res) else 0
            )
            synth_res = await db.execute(
                select(func.count(AircraftState.id)).where(
                    (AircraftState.is_synthetic == True)
                    | (AircraftState.source == "regional_fallback")
                )
            )
            synth_count = _to_int(
                synth_res.scalar() if not inspect.isawaitable(synth_res) else 0
            )
            SYSTEM_STATS["total_real_states"] = real_count
            SYSTEM_STATS["total_synthetic_states"] = synth_count
            SYSTEM_STATS["_last_count_refresh"] = now_ts
    except SQLAlchemyError as exc:
        database_status = "DISCONNECTED"
        logger.warning("System health aircraft counts unavailable: %s", exc)

    # --- Live Data Continuity Verification ---
    poll_interval = float(
        settings.OPENSKY_POLL_INTERVAL_SECONDS
        or (90.0 if opensky_auth.configured else 900.0)
    )
    max_allowed_gap = 2.0 * poll_interval
    now_utc = datetime.now(timezone.utc)
    last_poll = SYSTEM_STATS.get("last_successful_poll")

    if last_poll is not None:
        if last_poll.tzinfo is None:
            last_poll = last_poll.replace(tzinfo=timezone.utc)
        seconds_since_poll = (now_utc - last_poll).total_seconds()
        gap_detected = seconds_since_poll > max_allowed_gap
    else:
        seconds_since_poll = (now_utc - START_TIME).total_seconds()
        gap_detected = False

    upstream_status = str(SYSTEM_STATS.get("upstream_status", "UNKNOWN"))
    feed_mode = str(SYSTEM_STATS.get("feed_mode", "UNKNOWN"))
    last_successful_update = SYSTEM_STATS.get("last_successful_update") or last_poll
    if isinstance(last_successful_update, str):
        try:
            last_successful_update = datetime.fromisoformat(
                last_successful_update.replace("Z", "+00:00")
            )
        except ValueError:
            last_successful_update = None
    if last_successful_update and last_successful_update.tzinfo is None:
        last_successful_update = last_successful_update.replace(tzinfo=timezone.utc)
    snapshot_age_seconds = (
        max(0.0, (now_utc - last_successful_update).total_seconds())
        if last_successful_update
        else None
    )
    source_status = str(SYSTEM_STATS.get("source_status", "AWAITING_TELEMETRY"))
    if (
        source_status == "FRESH"
        and snapshot_age_seconds is not None
        and snapshot_age_seconds > max_allowed_gap
    ):
        source_status = "STALE"
    if gap_detected and upstream_status == "LIVE":
        upstream_status = "STALE"
    if gap_detected:
        live_continuity_status = "GAP_DETECTED"
        continuity_msg = (
            f"LIVE DATA CONTINUITY GAP DETECTED: No successful OpenSky poll in {seconds_since_poll:.1f}s "
            f"(exceeds 2x poll interval limit: {max_allowed_gap:.1f}s)."
        )
        print(f"[CRITICAL CONTINUITY ALERT] {continuity_msg}", flush=True)
        logger.critical(continuity_msg)
    elif upstream_status == "RATE_LIMITED":
        live_continuity_status = "RATE_LIMITED"
        continuity_msg = "The aircraft feed is rate-limited. No aircraft are shown until live reports resume."
    elif upstream_status == "UNAVAILABLE" and SYSTEM_STATS.get(
        "last_poll_http_status"
    ) in {401, 403}:
        live_continuity_status = "AUTHENTICATION_FAILED"
        continuity_msg = "OpenSky rejected authentication. Check the configured OAuth2 client ID and secret; no substitute aircraft data is used."
    elif upstream_status == "UNAVAILABLE":
        live_continuity_status = "UPSTREAM_UNAVAILABLE"
        continuity_msg = "The configured aircraft feed is unavailable. Check its connection and credentials."
    elif upstream_status == "UNKNOWN":
        live_continuity_status = "AWAITING_FIRST_POLL"
        continuity_msg = "No upstream poll has completed in this process yet; live feed health is unverified."
    else:
        live_continuity_status = "HEALTHY"
        continuity_msg = f"The configured aircraft feed is responding. Last successful response was {seconds_since_poll:.1f}s ago."

    if upstream_status == "RATE_LIMITED":
        upstream_message = "The configured global feed returned HTTP 429. No aircraft are shown until access resumes."
    elif (
        upstream_status == "LIVE"
        and _to_int(SYSTEM_STATS.get("last_poll_records", 0)) == 0
    ):
        upstream_message = (
            "The global feed is responding with no aircraft reports at this moment. Anonymous provider access is quota-limited."
            if not opensky_auth.configured
            else "The authenticated global feed is responding with no aircraft reports at this moment."
        )
    elif upstream_status == "LIVE":
        upstream_message = (
            "Aircraft reports are arriving from the authenticated global feed."
            if opensky_auth.configured
            else "Aircraft reports are arriving through anonymous global access; provider quotas limit refresh frequency. Configure OAuth2 credentials for the authenticated quota."
        )
    elif upstream_status == "UNKNOWN":
        upstream_message = (
            "Waiting for the first response from the configured aircraft feed. Anonymous access is quota-limited."
            if not opensky_auth.configured
            else "Waiting for the first response from the authenticated aircraft feed."
        )
    elif upstream_status == "STALE":
        upstream_message = "The last successful global feed response is stale. Aircraft positions may be outdated."
    elif upstream_status == "UNAVAILABLE" and SYSTEM_STATS.get(
        "last_poll_http_status"
    ) in {401, 403}:
        upstream_message = "OpenSky rejected authentication (HTTP 401/403). Configure a valid OAuth2 API client; no generated aircraft are shown."
    else:
        upstream_message = "The configured global aircraft feed is unavailable. No fallback tracks are generated."

    response_payload = SystemHealthResponse(
        database_status=database_status,
        redis_status=redis_status,
        poll_latency_ms=_to_float(SYSTEM_STATS.get("poll_latency_ms", 0.0)),
        queue_depth=_to_int(SYSTEM_STATS.get("queue_depth", 0)),
        circuit_breaker_state=str(SYSTEM_STATS.get("circuit_breaker_state", "CLOSED")),
        last_successful_poll=last_poll,
        last_poll_attempt=SYSTEM_STATS.get("last_poll_attempt"),
        last_poll_records=_to_int(SYSTEM_STATS.get("last_poll_records", 0)),
        last_normalized_records=_to_int(SYSTEM_STATS.get("last_normalized_records", 0)),
        upstream_status=upstream_status,
        feed_mode=feed_mode,
        feed_source=str(SYSTEM_STATS.get("feed_source", "none")),
        fallback_reason=SYSTEM_STATS.get("fallback_reason"),
        upstream_message=upstream_message,
        last_poll_http_status=(
            _to_int(SYSTEM_STATS.get("last_poll_http_status", 200))
            if SYSTEM_STATS.get("last_poll_http_status") is not None
            else None
        ),
        rate_limit_remaining=(
            str(SYSTEM_STATS.get("rate_limit_remaining"))
            if SYSTEM_STATS.get("rate_limit_remaining") is not None
            else None
        ),
        total_real_states=_to_int(SYSTEM_STATS.get("total_real_states", 0)),
        total_synthetic_states=_to_int(SYSTEM_STATS.get("total_synthetic_states", 0)),
        live_continuity_status=live_continuity_status,
        seconds_since_last_poll=round(seconds_since_poll, 2),
        max_allowed_poll_gap_seconds=max_allowed_gap,
        continuity_gap_detected=gap_detected,
        continuity_message=continuity_msg,
        source_status=source_status,
        source_name=SYSTEM_STATS.get("source_name"),
        last_successful_update=last_successful_update,
        next_attempt_at=SYSTEM_STATS.get("next_attempt_at"),
        retry_after=SYSTEM_STATS.get("retry_after"),
        snapshot_age_seconds=(
            round(snapshot_age_seconds, 2) if snapshot_age_seconds is not None else None
        ),
        snapshot_count=SYSTEM_STATS.get("snapshot_count"),
        consecutive_failures=_to_int(SYSTEM_STATS.get("consecutive_failures", 0)),
        last_error=SYSTEM_STATS.get("last_error"),
        refresh_in_progress=bool(SYSTEM_STATS.get("refresh_in_progress", False)),
        manual_refresh_pending=bool(SYSTEM_STATS.get("manual_refresh_pending", False)),
        refresh_interval_seconds=_to_float(
            SYSTEM_STATS.get("refresh_interval_seconds"), poll_interval
        ),
    )

    if (gap_detected or upstream_status in {"RATE_LIMITED", "UNAVAILABLE"}) and strict:
        return JSONResponse(
            status_code=503, content=response_payload.model_dump(mode="json")
        )

    return response_payload


@router.websocket("/stream")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    """WebSocket endpoint to subscribe to real-time ADS-B states and security alert broadcasts."""
    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    user = await get_websocket_user(db, token)
    if not user:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await manager.connect(websocket)
    try:
        while True:
            # Block and wait for messages (primarily to detect client disconnection)
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


@router.get(
    "/reports/session",
    response_class=StreamingResponse,
    responses={
        200: {
            "content": {
                "application/pdf": {"schema": {"type": "string", "format": "binary"}}
            }
        }
    },
)
@limiter.limit("5/minute")
async def generate_session_report(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_viewer),
):
    """Generate a high-fidelity PDF session report including stats, latest model run, and top 5 risk alerts with SHAP explanations."""
    # 1. Gather Session Metrics
    duration = datetime.now(timezone.utc) - START_TIME
    hours, remainder = divmod(int(duration.total_seconds()), 3600)
    minutes, seconds = divmod(remainder, 60)
    duration_str = f"{hours}h {minutes}m {seconds}s"

    # Tracked aircraft count
    aircraft_count_result = await db.execute(select(AircraftState.icao24).distinct())
    tracked_aircraft_count = len(aircraft_count_result.scalars().all())

    # Alerts count
    alerts_result = await db.execute(select(Alert))
    all_alerts = alerts_result.scalars().all()
    total_alerts = len(all_alerts)

    # Alerts by type
    alerts_by_type = {}
    for a in all_alerts:
        for flag in a.rule_flags:
            alerts_by_type[flag] = alerts_by_type.get(flag, 0) + 1

    # Latest Model Run
    model_run_result = await db.execute(
        select(ModelRun).order_by(ModelRun.run_at.desc()).limit(1)
    )
    latest_run = model_run_result.scalar_one_or_none()

    # Top 5 highest-risk alerts
    top_alerts_result = await db.execute(
        select(Alert).order_by(Alert.combined_risk_score.desc()).limit(5)
    )
    top_alerts = top_alerts_result.scalars().all()

    # 2. Build PDF report via ReportLab
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        rightMargin=36,
        leftMargin=36,
        topMargin=36,
        bottomMargin=36,
    )

    styles = getSampleStyleSheet()

    title_style = ParagraphStyle(
        "ReportTitle",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=20,
        leading=24,
        textColor=colors.HexColor("#0ea5e9"),
        spaceAfter=12,
    )

    h2_style = ParagraphStyle(
        "SectionHeader",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=16,
        textColor=colors.HexColor("#0f172a"),
        spaceBefore=12,
        spaceAfter=6,
    )

    body_style = ParagraphStyle(
        "ReportBody",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=9,
        leading=13,
        textColor=colors.HexColor("#334155"),
    )

    bold_body_style = ParagraphStyle(
        "ReportBodyBold", parent=body_style, fontName="Helvetica-Bold"
    )

    story = []

    # Header Title
    story.append(Paragraph("AIRGUARD // SESSION AUDIT REPORT", title_style))
    story.append(
        Paragraph(
            f"Generated at: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC",
            body_style,
        )
    )
    story.append(Spacer(1, 10))

    # Session Details Table
    story.append(Paragraph("1. Session Metrics Summary", h2_style))
    stats_data = [
        [
            Paragraph("Session Duration", bold_body_style),
            Paragraph(duration_str, body_style),
        ],
        [
            Paragraph("Total Tracked Aircraft", bold_body_style),
            Paragraph(str(tracked_aircraft_count), body_style),
        ],
        [
            Paragraph("Total Security Alerts", bold_body_style),
            Paragraph(str(total_alerts), body_style),
        ],
    ]
    t1 = Table(stats_data, colWidths=[200, 300])
    t1.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#94a3b8")),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(t1)
    story.append(Spacer(1, 12))

    # Alerts By Type Table
    story.append(Paragraph("2. Alerts Distribution by Rule Type", h2_style))
    type_data = [
        [Paragraph("Rule Type", bold_body_style), Paragraph("Count", bold_body_style)]
    ]
    if len(alerts_by_type) == 0:
        type_data.append(
            [Paragraph("No alerts logged", body_style), Paragraph("0", body_style)]
        )
    for k, v in alerts_by_type.items():
        type_data.append([Paragraph(k, body_style), Paragraph(str(v), body_style)])
    t2 = Table(type_data, colWidths=[200, 300])
    t2.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#94a3b8")),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(t2)
    story.append(Spacer(1, 12))

    # Model Run Precision/Recall Table
    story.append(Paragraph("3. Active Classifier Model Verification", h2_style))
    if latest_run:
        mr_data = [
            [
                Paragraph("Attribute", bold_body_style),
                Paragraph("Value", bold_body_style),
            ],
            [
                Paragraph("Model Version", body_style),
                Paragraph(latest_run.model_version, body_style),
            ],
            [
                Paragraph("Precision", body_style),
                Paragraph(f"{latest_run.precision:.4f}", body_style),
            ],
            [
                Paragraph("Recall", body_style),
                Paragraph(f"{latest_run.recall:.4f}", body_style),
            ],
            [
                Paragraph("F1 Score", body_style),
                Paragraph(f"{latest_run.f1:.4f}", body_style),
            ],
            [
                Paragraph("Notes / Training Set size", body_style),
                Paragraph(latest_run.notes or "N/A", body_style),
            ],
        ]
    else:
        mr_data = [
            [
                Paragraph("Status", bold_body_style),
                Paragraph("No model runs recorded yet", body_style),
            ]
        ]
    t3 = Table(mr_data, colWidths=[200, 300])
    t3.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#94a3b8")),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(t3)
    story.append(Spacer(1, 12))

    # Top 5 Highest Risk Alerts
    story.append(
        Paragraph("4. Top 5 Highest Risk Anomalies & SHAP Explanations", h2_style)
    )
    if len(top_alerts) == 0:
        story.append(Paragraph("No security alerts logged during session.", body_style))
    else:
        for idx, alert in enumerate(top_alerts, 1):
            callsign_val = getattr(alert, "callsign", None)
            if not callsign_val and getattr(alert, "aircraft_state", None):
                callsign_val = alert.aircraft_state.callsign
            callsign_str = f"{callsign_val} " if callsign_val else ""
            story.append(
                Paragraph(
                    f"<b>Anomaly {idx}: {callsign_str}({alert.icao24.upper()})</b>",
                    bold_body_style,
                )
            )
            story.append(
                Paragraph(
                    f"Combined Risk Score: <b>{alert.combined_risk_score:.4f}</b>",
                    body_style,
                )
            )
            story.append(Paragraph(f"Reason: <i>{alert.reason_text}</i>", body_style))

            # Map SHAP values if present
            shap_text = "N/A"
            if (
                isinstance(alert.shap_explanation, dict)
                and "shap" in alert.shap_explanation
            ):
                shap_list = alert.shap_explanation["shap"]
                if isinstance(shap_list, dict):
                    shap_items = [
                        f"{k}: {v:.4f}" for k, v in shap_list.items() if v > 0
                    ]
                    shap_text = (
                        ", ".join(shap_items)
                        if len(shap_items) > 0
                        else "Low feature contributions"
                    )

            story.append(Paragraph(f"SHAP Explanations: {shap_text}", body_style))
            story.append(Spacer(1, 6))

    doc.build(story)
    buffer.seek(0)

    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={
            "Content-Disposition": "attachment;filename=airguard_session_report.pdf"
        },
    )


from app.core.rule_config import active_rule_config


class ConfigUpdatePayload(BaseModel):
    max_implied_speed_kmh: float
    duplicate_icao_dist_km: float
    max_vertical_rate_ms: float
    max_ground_altitude_m: float
    max_ground_speed_ms: float
    min_flight_speed_ms: float
    min_reliable_nic: int | None = 7
    min_confidence_jump_km: float | None = 10.0

    model_config = {"strict": True, "extra": "forbid"}


@router.get("/config")
@limiter.limit("30/minute")
async def get_current_config(
    request: Request, current_user: User = Depends(require_viewer)
):
    """Retrieve the current active thresholds config."""
    return active_rule_config


@router.post("/config")
@limiter.limit("10/minute")
async def update_thresholds_config(
    request: Request,
    payload: ConfigUpdatePayload,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_analyst),
):
    """Update active telemetry rules check thresholds."""
    active_rule_config.max_implied_speed_kmh = payload.max_implied_speed_kmh
    active_rule_config.duplicate_icao_dist_km = payload.duplicate_icao_dist_km
    active_rule_config.max_vertical_rate_ms = payload.max_vertical_rate_ms
    active_rule_config.max_ground_altitude_m = payload.max_ground_altitude_m
    active_rule_config.max_ground_speed_ms = payload.max_ground_speed_ms
    active_rule_config.min_flight_speed_ms = payload.min_flight_speed_ms
    if payload.min_reliable_nic is not None:
        active_rule_config.min_reliable_nic = payload.min_reliable_nic
    if payload.min_confidence_jump_km is not None:
        active_rule_config.min_confidence_jump_km = payload.min_confidence_jump_km

    await write_audit_log(
        db=db,
        user_id=current_user.id,
        action="update_config",
        target_type="config",
        target_id=None,
        ip_address=request.client.host if request.client else None,
    )
    return active_rule_config


@router.post("/model-runs/replay", response_model=ModelRunResponse)
@limiter.limit("5/minute")
async def replay_session_validation(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_analyst),
):
    """Report unavailable until genuine labeled validation data is configured."""
    raise HTTPException(
        status_code=409,
        detail="Precision and recall are unavailable: AirGuard has no independently labeled validation dataset. Live telemetry and synthetic examples are not ground truth.",
    )

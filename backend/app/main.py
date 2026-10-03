import os
import sys
import logging
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pythonjsonlogger import jsonlogger
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from opentelemetry import trace
from prometheus_client import generate_latest, CONTENT_TYPE_LATEST

from app.core.config import settings
from app.core.limiter import limiter
from app.ingestion.service import OpenSkyIngestionService
from app.core.database import async_session_maker
from app.core.redis import redis_client

# 1. Custom JSON Log Formatter with OTel Trace Correlation IDs
class TraceCorrelationJsonFormatter(jsonlogger.JsonFormatter):
    def add_fields(self, log_record, record, message_dict):
        super().add_fields(log_record, record, message_dict)
        current_span = trace.get_current_span()
        if current_span and current_span.get_span_context().is_valid:
            span_context = current_span.get_span_context()
            log_record["trace_id"] = format(span_context.trace_id, "032x")
            log_record["span_id"] = format(span_context.span_id, "16x")

# Configure Logging
logger = logging.getLogger()
log_handler = logging.StreamHandler(sys.stdout)
formatter = TraceCorrelationJsonFormatter(
    fmt="%(asctime)s %(levelname)s %(name)s %(message)s"
)
log_handler.setFormatter(formatter)
logger.addHandler(log_handler)
logger.setLevel(settings.LOG_LEVEL)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """LIFESPAN: Initializes services, sets up Redis PubSub socket synchronization, and starts ingestion."""
    # Instantiate ML models & Detection Service
    from app.detection.ensemble import TrustScoringEnsemble
    from app.detection.autoencoder import UnsupervisedAutoencoder
    from app.detection.service import DetectionService
    import app.api.v1.endpoints as endpoints_mod

    logger.info("Initializing ML models for in-process detection engine...")
    ensemble = TrustScoringEnsemble()
    autoencoder = UnsupervisedAutoencoder()
    detection_service = DetectionService(
        db_session_maker=async_session_maker,
        ensemble_model=ensemble,
        autoencoder_model=autoencoder
    )
    endpoints_mod.active_detection_service = detection_service

    # Instantiate Route Service
    from app.ingestion.route_service import FlightRouteService
    route_service = FlightRouteService(db_session_maker=async_session_maker)
    endpoints_mod.active_route_service = route_service
    detection_service.route_service = route_service

    # Instantiate Ingestion Service with in-process detection engine and route service
    has_opensky_credentials = bool(settings.OPENSKY_USERNAME and settings.OPENSKY_PASSWORD)
    poll_interval_seconds = settings.OPENSKY_POLL_INTERVAL_SECONDS or (90.0 if has_opensky_credentials else 900.0)
    ingestion_service = OpenSkyIngestionService(
        db_session_maker=async_session_maker,
        poll_interval_seconds=poll_interval_seconds,
        detection_service=detection_service,
        route_service=route_service
    )
    
    # 1. Redis PubSub WebSocket Sync Listener
    from app.api.v1.endpoints import manager, websocket_pubsub_listener
    pubsub_task = asyncio.create_task(websocket_pubsub_listener(manager))
    
    # 2. Run OpenSky Polling Loop if enabled
    run_ingestion = os.getenv("RUN_INGESTION", "true").lower() == "true"
    ingestion_task = None
    if run_ingestion:
        logger.info("Starting OpenSky Ingestion polling task inside API instance.")
        ingestion_task = asyncio.create_task(ingestion_service.start_polling_loop())
    else:
        logger.info("OpenSky Ingestion polling task disabled on this replica instance.")
        
    # 3. Synchronize stats endpoint & monitor live data continuity
    from app.api.v1.endpoints import SYSTEM_STATS
    async def sync_stats_loop():
        gap_alert_active = False
        while True:
            try:
                try:
                    q_len = await asyncio.wait_for(redis_client.xlen("airguard:telemetry"), timeout=0.3)
                    SYSTEM_STATS["queue_depth"] = q_len
                    from app.core.telemetry import QUEUE_DEPTH
                    QUEUE_DEPTH.set(q_len)
                except Exception:
                    SYSTEM_STATS["queue_depth"] = 0
                SYSTEM_STATS["circuit_breaker_state"] = ingestion_service.breaker_state
                if ingestion_service.last_poll_timestamp:
                    SYSTEM_STATS["last_successful_poll"] = ingestion_service.last_poll_timestamp
                if ingestion_service.last_poll_records:
                    SYSTEM_STATS["last_poll_records"] = ingestion_service.last_poll_records
                if ingestion_service.rate_limit_remaining:
                    SYSTEM_STATS["rate_limit_remaining"] = ingestion_service.rate_limit_remaining

                # Automated Live Continuity Gap Monitor (fails loudly if gap > 2x poll interval)
                if run_ingestion:
                    max_allowed_gap = 2.0 * poll_interval_seconds
                    now_utc = datetime.now(timezone.utc)
                    last_poll = ingestion_service.last_poll_timestamp
                    if last_poll is not None:
                        gap_sec = (now_utc - last_poll).total_seconds()
                        if gap_sec > max_allowed_gap:
                            if not gap_alert_active:
                                err_msg = f"[CRITICAL CONTINUITY GAP] No successful OpenSky poll in {gap_sec:.1f}s (exceeds threshold 2x interval = {max_allowed_gap:.1f}s)!"
                                print(err_msg, flush=True)
                                logger.critical(err_msg)
                                gap_alert_active = True
                        else:
                            if gap_alert_active:
                                rec_msg = f"[CONTINUITY RESTORED] OpenSky polling active and within threshold ({gap_sec:.1f}s <= {max_allowed_gap:.1f}s)."
                                print(rec_msg, flush=True)
                                logger.info(rec_msg)
                                gap_alert_active = False
            except Exception:
                pass
            await asyncio.sleep(2)
            
    stats_task = asyncio.create_task(sync_stats_loop())
    
    logger.info("AirGuard API gateway components initialized successfully.")
    yield
    
    # Shutdown sequence
    logger.info("Shutting down AirGuard gateway tasks...")
    pubsub_task.cancel()
    if ingestion_task:
        ingestion_task.cancel()
    stats_task.cancel()
    
    await asyncio.gather(
        pubsub_task, 
        ingestion_task if ingestion_task else asyncio.sleep(0), 
        stats_task, 
        return_exceptions=True
    )
    logger.info("Shutdown sequence completed.")

app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    lifespan=lifespan
)

# Include Router
from app.api.v1.endpoints import router as api_router
app.include_router(api_router, prefix=settings.API_V1_STR)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import time
from app.core.telemetry import REQUEST_LATENCY

@app.middleware("http")
async def measure_request_latency(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    duration = time.perf_counter() - start
    endpoint = request.url.path
    if endpoint.startswith("/api/v1/aircraft/") and endpoint != "/api/v1/aircraft/history":
        endpoint = "/api/v1/aircraft/{icao24}"
    elif endpoint.startswith("/api/v1/alerts/") and endpoint.endswith("/acknowledge"):
        endpoint = "/api/v1/alerts/{id}/acknowledge"
    elif endpoint.startswith("/api/v1/alerts/") and endpoint.endswith("/shap"):
        endpoint = "/api/v1/alerts/{id}/shap"
    elif endpoint.startswith("/api/v1/admin/users/"):
        endpoint = "/api/v1/admin/users/{id}"
        
    try:
        REQUEST_LATENCY.labels(method=request.method, endpoint=endpoint).observe(duration)
    except Exception:
        pass
    return response

from fastapi import Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from app.core.database import get_db

@app.get("/health")
@app.get("/api/v1/health")
@limiter.limit(settings.RATE_LIMIT_DEFAULT)
async def health_check(request: Request, db = Depends(get_db)):
    try:
        await db.execute(text("SELECT 1"))
        return {"status": "healthy", "database": "connected", "service": settings.PROJECT_NAME}
    except Exception as e:
        logger.error(f"Health check failed database check: {e}")
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "database": "disconnected", "reason": str(e)}
        )

@app.get("/metrics")
async def metrics_endpoint():
    """Prometheus Scraper Endpoint."""
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)

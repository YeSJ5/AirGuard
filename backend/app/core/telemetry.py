import logging

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from prometheus_client import Counter, Gauge, Histogram

from app.core.config import settings

logger = logging.getLogger("airguard.telemetry")

# 1. Prometheus Metrics Definitions
REQUEST_LATENCY = Histogram(
    "airguard_request_latency_seconds",
    "FastAPI requests latency",
    ["method", "endpoint"],
)

OPENSKY_POLL_SUCCESS = Counter(
    "airguard_opensky_poll_success_total", "Total successful OpenSky fetches"
)

OPENSKY_POLL_FAILURE = Counter(
    "airguard_opensky_poll_failure_total", "Total failed OpenSky fetches"
)

PIPELINE_STAGE_LATENCY = Histogram(
    "airguard_pipeline_stage_latency_seconds",
    "Pipeline processing stage latency",
    ["stage"],
)

QUEUE_DEPTH = Gauge("airguard_queue_depth", "Redis Streams queue size")

ACTIVE_WEBSOCKETS = Gauge(
    "airguard_active_websockets", "Number of active client WebSocket connections"
)

# 2. OpenTelemetry Tracing Initialization
resource = Resource(attributes={"service.name": "airguard-backend"})
provider = TracerProvider(resource=resource)
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("airguard")

import socket


def _is_otlp_reachable(host: str, port: int = 4317) -> bool:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.1)
        s.connect((host, port))
        s.close()
        return True
    except Exception:
        return False


if _is_otlp_reachable(settings.JAEGER_HOST, 4317):
    try:
        otlp_exporter = OTLPSpanExporter(
            endpoint=f"http://{settings.JAEGER_HOST}:4317", insecure=True
        )
        span_processor = BatchSpanProcessor(otlp_exporter)
        provider.add_span_processor(span_processor)
        logger.info("OpenTelemetry OTLP Tracer successfully initialized.")
    except Exception as e:
        logger.warning(
            f"OTLP Trace exporter failed to start (degrading gracefully): {e}"
        )
else:
    logger.info(
        "Jaeger OTLP collector port 4317 not running; tracer operating in local mode."
    )

import asyncio
import ctypes
import logging
import os
import re
import sys

from app.core.config import settings
from app.core.database import async_session_maker, engine

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("airguard.worker")


def _process_is_running(pid: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetExitCodeProcess.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_uint32),
    ]
    kernel32.GetExitCodeProcess.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenProcess(
        0x1000, False, pid
    )  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        exit_code = ctypes.c_uint32()
        return (
            bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)))
            and exit_code.value == 259
        )
    finally:
        kernel32.CloseHandle(handle)


async def main():
    from app.detection.autoencoder import UnsupervisedAutoencoder
    from app.detection.ensemble import TrustScoringEnsemble
    from app.detection.service import DetectionService

    logger.info("Initializing ML models for standalone detection worker...")
    ensemble = TrustScoringEnsemble(load_artifact=settings.ENABLE_LIVE_ML)
    autoencoder = UnsupervisedAutoencoder()

    logger.info("Starting detection worker instance...")
    from app.ingestion.route_service import FlightRouteService

    route_service = FlightRouteService(db_session_maker=async_session_maker)
    detection_service = DetectionService(
        db_session_maker=async_session_maker,
        ensemble_model=ensemble,
        autoencoder_model=autoencoder,
    )
    detection_service.route_service = route_service

    try:
        await detection_service.start_detection_loop()
    finally:
        await route_service.http_client.aclose()
        from app.core.redis import redis_client
        from app.ingestion.metadata_service import active_metadata_service
        from app.ingestion.opensky_auth import opensky_auth

        await active_metadata_service.http_client.aclose()
        await opensky_auth.aclose()
        await redis_client.aclose()
        await engine.dispose()


async def has_active_consumer() -> bool:
    """Return whether another local worker is actively reading the stream."""
    from app.core.redis import redis_client

    local_prefix = f"worker-{os.getenv('HOSTNAME', 'local')}-"
    try:
        for group in await redis_client.xinfo_groups("airguard:telemetry"):
            if group.get("name") != "detection-group":
                continue
            for consumer in await redis_client.xinfo_consumers(
                "airguard:telemetry", "detection-group"
            ):
                name = str(consumer.get("name", ""))
                idle_ms = int(consumer.get("idle", 2**31 - 1))
                if not name.startswith("worker-") or idle_ms >= 30_000:
                    continue
                # Redis retains consumer entries after a process exits. On this
                # host, verify the PID encoded by DetectionService instead of
                # mistaking a recently-dead consumer for a healthy worker.
                if name.startswith(local_prefix):
                    match = re.fullmatch(re.escape(local_prefix) + r"(\d+)", name)
                    if not match:
                        continue
                    if not _process_is_running(int(match.group(1))):
                        continue
                return True
    except Exception as exc:
        logger.warning("Could not inspect Redis worker consumers: %s", exc)
    finally:
        await redis_client.aclose()
    return False


if __name__ == "__main__":
    try:
        if "--check-active" in sys.argv:
            active = asyncio.run(has_active_consumer())
            print("ACTIVE" if active else "INACTIVE")
            sys.exit(0 if active else 1)
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Worker stopped by user request.")
        sys.exit(0)

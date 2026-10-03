import asyncio
import logging
import sys
from app.core.config import settings
from app.core.database import async_session_maker
from app.detection.service import DetectionService
from app.detection.ensemble import TrustScoringEnsemble
from app.detection.autoencoder import UnsupervisedAutoencoder

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("airguard.worker")

async def main():
    logger.info("Initializing ML models for standalone detection worker...")
    ensemble = TrustScoringEnsemble()
    autoencoder = UnsupervisedAutoencoder()
    
    logger.info("Starting detection worker instance...")
    from app.ingestion.route_service import FlightRouteService
    route_service = FlightRouteService(db_session_maker=async_session_maker)
    detection_service = DetectionService(
        db_session_maker=async_session_maker,
        ensemble_model=ensemble,
        autoencoder_model=autoencoder
    )
    detection_service.route_service = route_service
    
    await detection_service.start_detection_loop()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Worker stopped by user request.")
        sys.exit(0)

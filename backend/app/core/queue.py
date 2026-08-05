import asyncio

# Shared Ingestion Queue to pass telemetry from ingestion API/POST to detection loop
ingestion_queue = asyncio.Queue()

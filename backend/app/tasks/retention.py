import argparse
import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection
from app.core.database import engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("airguard.retention")

async def _run_retention_on_connection(connection: AsyncConnection, cutoff_date: datetime, dry_run: bool) -> int:
    # SQL query to find candidates for deletion
    find_query = text("""
        WITH numbered_states AS (
            SELECT id, 
                   ROW_NUMBER() OVER (PARTITION BY icao24 ORDER BY received_at ASC) as rn
            FROM aircraft_states
            WHERE received_at < :cutoff
              AND id NOT IN (SELECT aircraft_state_id FROM alerts)
        )
        SELECT id FROM numbered_states WHERE rn % 10 != 1;
    """)

    result = await connection.execute(find_query, {"cutoff": cutoff_date})
    delete_ids = [row[0] for row in result.fetchall()]

    candidates_count = len(delete_ids)
    logger.info(
        "Found %s aircraft_state records older than the retention cutoff that match downsample criteria.",
        candidates_count,
    )
    if dry_run:
        logger.info("[DRY RUN] Would delete %s aircraft_states (keeping 1-in-10 records).", candidates_count)
        return candidates_count

    if candidates_count > 0:
        chunk_size = 5000
        for offset in range(0, candidates_count, chunk_size):
            chunk = delete_ids[offset:offset + chunk_size]
            await connection.execute(
                text("DELETE FROM aircraft_states WHERE id = ANY(:ids)"),
                {"ids": chunk},
            )
            logger.info("Deleted a retention chunk of %s states.", len(chunk))
        logger.info("Retention task completed. Deleted %s raw state records.", candidates_count)
    else:
        logger.info("No records met the downsampling criteria; no deletions performed.")
    return candidates_count


async def run_retention(days: int, dry_run: bool, *, connection: AsyncConnection | None = None) -> int:
    """Downsample unlinked old telemetry, optionally using a caller-owned transaction."""
    cutoff_date = datetime.now(timezone.utc) - timedelta(days=days)
    logger.info("Starting data retention run. Cutoff: %s (%s days).", cutoff_date.isoformat(), days)
    if dry_run:
        logger.info("[DRY RUN MODE] No changes will be committed to the database.")

    if connection is not None:
        return await _run_retention_on_connection(connection, cutoff_date, dry_run)
    async with engine.begin() as owned_connection:
        return await _run_retention_on_connection(owned_connection, cutoff_date, dry_run)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AirGuard Data Retention Downsampling Task")
    parser.add_argument("--days", type=int, default=30, help="Retention period in days (default: 30)")
    parser.add_argument("--dry-run", action="store_true", help="Preview deletions without modifying data")
    
    args = parser.parse_args()
    
    asyncio.run(run_retention(args.days, args.dry_run))

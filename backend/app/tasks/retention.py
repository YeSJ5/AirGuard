import argparse
import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone
from sqlalchemy import text
from app.core.database import engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("airguard.retention")

async def run_retention(days: int, dry_run: bool):
    cutoff_date = datetime.now(timezone.utc) - timedelta(days=days)
    logger.info(f"Starting data retention run. Cutoff date: {cutoff_date.isoformat()} ({days} days ago)")
    if dry_run:
        logger.info("[DRY RUN MODE] No changes will be committed to the database.")

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

    async with engine.begin() as conn:
        result = await conn.execute(find_query, {"cutoff": cutoff_date})
        delete_ids = [row[0] for row in result.fetchall()]
        
        candidates_count = len(delete_ids)
        logger.info(f"Found {candidates_count} aircraft_state records older than {days} days matching downsample criteria (not linked to alerts).")
        
        if dry_run:
            logger.info(f"[DRY RUN] Would delete {candidates_count} aircraft_states (keeping 1-in-10 records).")
            return candidates_count

        if candidates_count > 0:
            # Delete in chunks
            chunk_size = 5000
            total_deleted = 0
            for i in range(0, candidates_count, chunk_size):
                chunk = delete_ids[i:i + chunk_size]
                await conn.execute(
                    text("DELETE FROM aircraft_states WHERE id = ANY(:ids)"),
                    {"ids": chunk}
                )
                total_deleted += len(chunk)
                logger.info(f"Deleted chunk of {len(chunk)} records (Total: {total_deleted}/{candidates_count}).")
            
            logger.info(f"Retention task completed. Successfully downsampled {total_deleted} raw state records.")
        else:
            logger.info("No records met the downsampling retention criteria. No deletions performed.")
        
        return candidates_count

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AirGuard Data Retention Downsampling Task")
    parser.add_argument("--days", type=int, default=30, help="Retention period in days (default: 30)")
    parser.add_argument("--dry-run", action="store_true", help="Preview deletions without modifying data")
    
    args = parser.parse_args()
    
    asyncio.run(run_retention(args.days, args.dry_run))

import asyncio
import sys
import os

# Adjust path to find app package
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text
from app.core.database import engine

async def main():
    async with engine.connect() as conn:
        print("Analyzing aircraft states query plan:")
        res = await conn.execute(text("EXPLAIN ANALYZE SELECT * FROM aircraft_states ORDER BY received_at DESC LIMIT 100"))
        for row in res:
            print(row[0])
            
        print("\nAnalyzing alerts query plan:")
        res = await conn.execute(text("EXPLAIN ANALYZE SELECT * FROM alerts ORDER BY detected_at DESC LIMIT 10"))
        for row in res:
            print(row[0])

if __name__ == "__main__":
    asyncio.run(main())

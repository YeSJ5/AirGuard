import asyncio
import sys
import os

# Add backend directory to sys.path so we can import app modules
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../backend')))

from app.core.database import Base, engine

async def reset_db():
    print("Connecting to database for reset...")
    async with engine.begin() as conn:
        print("Dropping existing tables...")
        await conn.run_sync(Base.metadata.drop_all)
        print("Recreating database tables from SQLAlchemy metadata...")
        await conn.run_sync(Base.metadata.create_all)
    print("Database reset completed successfully.")

if __name__ == "__main__":
    asyncio.run(reset_db())

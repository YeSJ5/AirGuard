from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.database import Base, engine


@pytest_asyncio.fixture
async def isolated_postgres_schema():
    """Run PostgreSQL integration checks in an isolated, rolled-back schema."""
    # asyncpg connections belong to the event loop that opened them. These
    # function-scoped tests get separate loops, so never reuse a pooled socket.
    await engine.dispose()
    try:
        connection = await engine.connect()
    except SQLAlchemyError as exc:
        pytest.skip(
            f"PostgreSQL integration database is unavailable: {type(exc).__name__}"
        )

    transaction = await connection.begin()
    schema_name = f"airguard_test_{uuid4().hex}"
    try:
        await connection.execute(text(f'CREATE SCHEMA "{schema_name}"'))
        await connection.execute(text(f'SET LOCAL search_path TO "{schema_name}"'))
        await connection.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(
            bind=connection,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
        yield connection, sessions
    finally:
        if transaction.is_active:
            await transaction.rollback()
        await connection.close()
        await engine.dispose()

"""add idempotency key for at-least-once telemetry delivery

Revision ID: d4a8b6c913ef
Revises: c3b7f912a640
Create Date: 2026-10-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4a8b6c913ef"
down_revision: Union[str, None] = "c3b7f912a640"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("aircraft_states", sa.Column("ingestion_id", sa.String(length=36), nullable=True))
    op.create_index("uq_aircraft_states_ingestion_id", "aircraft_states", ["ingestion_id"], unique=True)


def downgrade() -> None:
    op.drop_index("uq_aircraft_states_ingestion_id", table_name="aircraft_states")
    op.drop_column("aircraft_states", "ingestion_id")

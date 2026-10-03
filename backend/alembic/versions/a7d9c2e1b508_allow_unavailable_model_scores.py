"""allow unavailable model outputs on deterministic alerts

Revision ID: a7d9c2e1b508
Revises: f1a2b3c4d5e6
Create Date: 2026-10-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a7d9c2e1b508"
down_revision: Union[str, None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("alerts", "ensemble_score", existing_type=sa.Float(), nullable=True)
    op.alter_column("alerts", "autoencoder_score", existing_type=sa.Float(), nullable=True)
    op.add_column("aircraft_states", sa.Column("data_quality", sa.dialects.postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")))
    op.create_table(
        "aircraft_assessments",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("aircraft_state_id", sa.BigInteger(), nullable=False),
        sa.Column("icao24", sa.String(length=6), nullable=False),
        sa.Column("combined_risk_score", sa.Float(), nullable=True),
        sa.Column("evidence_confidence", sa.Float(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("signals", sa.dialects.postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("detector_version", sa.String(length=32), nullable=False),
        sa.Column("assessed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["aircraft_state_id"], ["aircraft_states.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("aircraft_state_id"),
    )
    op.create_index("ix_aircraft_assessments_icao24", "aircraft_assessments", ["icao24"])
    op.create_index("ix_aircraft_assessments_assessed_at", "aircraft_assessments", ["assessed_at"])


def downgrade() -> None:
    op.drop_index("ix_aircraft_assessments_assessed_at", table_name="aircraft_assessments")
    op.drop_index("ix_aircraft_assessments_icao24", table_name="aircraft_assessments")
    op.drop_table("aircraft_assessments")
    op.drop_column("aircraft_states", "data_quality")
    # The old schema required model values. Downgrade intentionally fails when
    # unavailable values exist rather than rewriting unknown outputs as zero.
    op.alter_column("alerts", "ensemble_score", existing_type=sa.Float(), nullable=False)
    op.alter_column("alerts", "autoencoder_score", existing_type=sa.Float(), nullable=False)

"""add durable airspace event cases and review history

Revision ID: c3b7f912a640
Revises: a7d9c2e1b508
Create Date: 2026-10-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "c3b7f912a640"
down_revision: Union[str, None] = "a7d9c2e1b508"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "airspace_event_cases",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("candidate_id", sa.String(length=100), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="OPEN", nullable=False),
        sa.Column("disposition", sa.String(length=40), nullable=True),
        sa.Column("evidence_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_by", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_airspace_event_cases_candidate_id", "airspace_event_cases", ["candidate_id"])
    op.create_index("ix_airspace_event_cases_status", "airspace_event_cases", ["status"])
    op.create_index("ix_airspace_event_cases_created_at", "airspace_event_cases", ["created_at"])
    op.create_index(
        "uq_airspace_event_cases_open_candidate",
        "airspace_event_cases",
        ["candidate_id"],
        unique=True,
        postgresql_where=sa.text("status <> 'CLOSED'"),
    )

    op.create_table(
        "airspace_event_case_reviews",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("case_id", sa.BigInteger(), nullable=False),
        sa.Column("reviewer_id", sa.BigInteger(), nullable=True),
        sa.Column("action", sa.String(length=30), nullable=False),
        sa.Column("previous_status", sa.String(length=20), nullable=True),
        sa.Column("new_status", sa.String(length=20), nullable=False),
        sa.Column("previous_disposition", sa.String(length=40), nullable=True),
        sa.Column("new_disposition", sa.String(length=40), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("ip_address", sa.String(length=50), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["case_id"], ["airspace_event_cases.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reviewer_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_airspace_event_case_reviews_case_id", "airspace_event_case_reviews", ["case_id"])
    op.create_index("ix_airspace_event_case_reviews_created_at", "airspace_event_case_reviews", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_airspace_event_case_reviews_created_at", table_name="airspace_event_case_reviews")
    op.drop_index("ix_airspace_event_case_reviews_case_id", table_name="airspace_event_case_reviews")
    op.drop_table("airspace_event_case_reviews")
    op.drop_index("ix_airspace_event_cases_created_at", table_name="airspace_event_cases")
    op.drop_index("uq_airspace_event_cases_open_candidate", table_name="airspace_event_cases")
    op.drop_index("ix_airspace_event_cases_status", table_name="airspace_event_cases")
    op.drop_index("ix_airspace_event_cases_candidate_id", table_name="airspace_event_cases")
    op.drop_table("airspace_event_cases")

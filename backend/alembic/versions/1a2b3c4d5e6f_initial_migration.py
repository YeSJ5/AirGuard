"""initial migration

Revision ID: 1a2b3c4d5e6f
Revises: 
Create Date: 2026-08-04 15:31:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '1a2b3c4d5e6f'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create aircraft_states
    op.create_table(
        'aircraft_states',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('icao24', sa.String(length=6), nullable=False),
        sa.Column('callsign', sa.String(length=10), nullable=True),
        sa.Column('latitude', sa.Float(), nullable=False),
        sa.Column('longitude', sa.Float(), nullable=False),
        sa.Column('altitude_m', sa.Float(), nullable=False),
        sa.Column('velocity_ms', sa.Float(), nullable=False),
        sa.Column('heading_deg', sa.Float(), nullable=False),
        sa.Column('vertical_rate_ms', sa.Float(), nullable=False),
        sa.Column('on_ground', sa.Boolean(), nullable=False),
        sa.Column('received_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('source', sa.String(length=20), server_default='opensky', nullable=False),
        sa.PrimaryKeyConstraint('id')
    )
    # Individual indexes
    op.create_index(op.f('ix_aircraft_states_icao24'), 'aircraft_states', ['icao24'], unique=False)
    op.create_index(op.f('ix_aircraft_states_received_at'), 'aircraft_states', ['received_at'], unique=False)
    # Composite Index: (icao24, received_at DESC)
    op.create_index('idx_states_icao_received_desc', 'aircraft_states', ['icao24', sa.text('received_at DESC')], unique=False)

    # 2. Create alerts
    op.create_table(
        'alerts',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('icao24', sa.String(length=6), nullable=False),
        sa.Column('aircraft_state_id', sa.BigInteger(), nullable=False),
        sa.Column('rule_flags', postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column('ensemble_score', sa.Float(), nullable=False),
        sa.Column('autoencoder_score', sa.Float(), nullable=False),
        sa.Column('combined_risk_score', sa.Float(), nullable=False),
        sa.Column('reason_text', sa.Text(), nullable=False),
        sa.Column('shap_explanation', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('detected_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('is_synthetic', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('acknowledged', sa.Boolean(), server_default='false', nullable=False),
        sa.ForeignKeyConstraint(['aircraft_state_id'], ['aircraft_states.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_alerts_detected_at'), 'alerts', ['detected_at'], unique=False)

    # 3. Create model_runs
    op.create_table(
        'model_runs',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('run_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('model_version', sa.String(length=20), nullable=False),
        sa.Column('true_positives', sa.Integer(), nullable=False),
        sa.Column('false_positives', sa.Integer(), nullable=False),
        sa.Column('true_negatives', sa.Integer(), nullable=False),
        sa.Column('false_negatives', sa.Integer(), nullable=False),
        sa.Column('precision', sa.Float(), nullable=False),
        sa.Column('recall', sa.Float(), nullable=False),
        sa.Column('f1', sa.Float(), nullable=False),
        sa.Column('notes', sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )

    # 4. Create known_entities
    op.create_table(
        'known_entities',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('icao24', sa.String(length=6), nullable=False),
        sa.Column('label', sa.String(length=50), nullable=False),
        sa.Column('source', sa.String(length=50), nullable=False),
        sa.Column('added_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('icao24')
    )


def downgrade() -> None:
    op.drop_table('known_entities')
    op.drop_table('model_runs')
    op.drop_index(op.f('ix_alerts_detected_at'), table_name='alerts')
    op.drop_table('alerts')
    op.drop_index('idx_states_icao_received_desc', table_name='aircraft_states')
    op.drop_index(op.f('ix_aircraft_states_received_at'), table_name='aircraft_states')
    op.drop_index(op.f('ix_aircraft_states_icao24'), table_name='aircraft_states')
    op.drop_table('aircraft_states')

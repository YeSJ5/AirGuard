"""add_performance_indexes

Revision ID: e7c5711fc8e6
Revises: ec3c41830b18
Create Date: 2026-08-06 17:15:19.377172

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e7c5711fc8e6'
down_revision: Union[str, None] = 'ec3c41830b18'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index('idx_states_received_at_desc', 'aircraft_states', [sa.text('received_at DESC')])
    op.create_index('idx_alerts_detected_at_desc', 'alerts', [sa.text('detected_at DESC')])


def downgrade() -> None:
    op.drop_index('idx_states_received_at_desc', table_name='aircraft_states')
    op.drop_index('idx_alerts_detected_at_desc', table_name='alerts')

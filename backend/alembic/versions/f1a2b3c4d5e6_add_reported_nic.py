"""add_reported_nic
 
Revision ID: f1a2b3c4d5e6
Revises: e7c5711fc8e6
Create Date: 2026-09-30 10:49:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, None] = 'e7c5711fc8e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('aircraft_states', sa.Column('reported_nic', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('aircraft_states', 'reported_nic')

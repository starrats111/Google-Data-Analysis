"""add search_impression_share to google_ads_api_data

Revision ID: 002
Revises: 001
Create Date: 2026-02-26
"""
from alembic import op
import sqlalchemy as sa

revision = '002'
down_revision = '001'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('google_ads_api_data') as batch_op:
        batch_op.add_column(
            sa.Column('search_impression_share', sa.Float(), nullable=True)
        )


def downgrade():
    with op.batch_alter_table('google_ads_api_data') as batch_op:
        batch_op.drop_column('search_impression_share')

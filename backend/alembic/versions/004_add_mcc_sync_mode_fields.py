"""add mcc sync_mode and sheet fields (OPT-005)

Revision ID: 004
Revises: 003
Create Date: 2026-03-02

"""
from alembic import op
import sqlalchemy as sa

revision = '004'
down_revision = '003'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('google_mcc_accounts') as batch_op:
        batch_op.add_column(sa.Column('sync_mode', sa.String(10), nullable=False, server_default='api'))
        batch_op.add_column(sa.Column('google_sheet_url', sa.String(500), nullable=True))
        batch_op.add_column(sa.Column('sheet_sync_hour', sa.Integer(), nullable=False, server_default='4'))
        batch_op.add_column(sa.Column('sheet_sync_minute', sa.Integer(), nullable=False, server_default='0'))
        batch_op.add_column(sa.Column('last_sheet_sync_at', sa.DateTime(timezone=True), nullable=True))


def downgrade():
    with op.batch_alter_table('google_mcc_accounts') as batch_op:
        batch_op.drop_column('last_sheet_sync_at')
        batch_op.drop_column('sheet_sync_minute')
        batch_op.drop_column('sheet_sync_hour')
        batch_op.drop_column('google_sheet_url')
        batch_op.drop_column('sync_mode')

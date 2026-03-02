"""add notifications and commission_snapshots (OPT-001/002)

Revision ID: 003
Revises: 002
Create Date: 2026-03-02

"""
from alembic import op
import sqlalchemy as sa

revision = '003'
down_revision = '002'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'notifications',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('type', sa.String(50), nullable=False),
        sa.Column('title', sa.String(200), nullable=False),
        sa.Column('content', sa.Text(), nullable=True),
        sa.Column('is_read', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_notification_user_created', 'notifications', ['user_id', 'created_at'])
    op.create_index('idx_notification_user_read', 'notifications', ['user_id', 'is_read'])

    op.create_table(
        'commission_snapshots',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('snapshot_type', sa.String(20), nullable=False),
        sa.Column('period', sa.String(20), nullable=False),
        sa.Column('total_rejected', sa.Numeric(12, 2), nullable=False, server_default='0'),
        sa.Column('checked_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'snapshot_type', 'period', name='uq_commission_snapshot_user_type_period'),
    )
    op.create_index(op.f('ix_commission_snapshots_user_id'), 'commission_snapshots', ['user_id'])
    op.create_index(op.f('ix_commission_snapshots_snapshot_type'), 'commission_snapshots', ['snapshot_type'])
    op.create_index(op.f('ix_commission_snapshots_period'), 'commission_snapshots', ['period'])


def downgrade():
    op.drop_index('idx_notification_user_read', table_name='notifications')
    op.drop_index('idx_notification_user_created', table_name='notifications')
    op.drop_table('notifications')
    op.drop_index(op.f('ix_commission_snapshots_period'), table_name='commission_snapshots')
    op.drop_index(op.f('ix_commission_snapshots_snapshot_type'), table_name='commission_snapshots')
    op.drop_index(op.f('ix_commission_snapshots_user_id'), table_name='commission_snapshots')
    op.drop_table('commission_snapshots')

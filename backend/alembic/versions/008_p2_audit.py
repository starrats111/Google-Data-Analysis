"""P2 audit: create merchant_source_snapshots and merchant_assignment_events tables.

Revision ID: 008
Revises: 007
Create Date: 2026-03-03

"""
from alembic import op
import sqlalchemy as sa


revision = '008'
down_revision = '007'
branch_labels = None
depends_on = None


def upgrade():
    # G-12: merchant_source_snapshots
    op.create_table(
        'merchant_source_snapshots',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('platform', sa.String(length=32), nullable=False),
        sa.Column('source_api', sa.String(length=32), nullable=False),
        sa.Column('source_key', sa.String(length=128), nullable=False),
        sa.Column('raw_payload', sa.Text(), nullable=True),
        sa.Column('snapshot_date', sa.Date(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_merchant_source_snapshots_id'), 'merchant_source_snapshots', ['id'], unique=False)
    op.create_index(op.f('ix_merchant_source_snapshots_platform'), 'merchant_source_snapshots', ['platform'], unique=False)
    op.create_index(op.f('ix_merchant_source_snapshots_source_key'), 'merchant_source_snapshots', ['source_key'], unique=False)
    op.create_index(op.f('ix_merchant_source_snapshots_snapshot_date'), 'merchant_source_snapshots', ['snapshot_date'], unique=False)
    op.create_index('idx_snapshot_platform_key_date', 'merchant_source_snapshots', ['platform', 'source_key', 'snapshot_date'], unique=False)

    # G-13: merchant_assignment_events
    op.create_table(
        'merchant_assignment_events',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('assignment_id', sa.Integer(), sa.ForeignKey('merchant_assignments.id', ondelete='CASCADE'), nullable=False),
        sa.Column('event_type', sa.String(length=20), nullable=False),
        sa.Column('old_value', sa.Text(), nullable=True),
        sa.Column('new_value', sa.Text(), nullable=True),
        sa.Column('operator_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_merchant_assignment_events_id'), 'merchant_assignment_events', ['id'], unique=False)
    op.create_index(op.f('ix_merchant_assignment_events_assignment_id'), 'merchant_assignment_events', ['assignment_id'], unique=False)
    op.create_index(op.f('ix_merchant_assignment_events_event_type'), 'merchant_assignment_events', ['event_type'], unique=False)
    op.create_index(op.f('ix_merchant_assignment_events_operator_id'), 'merchant_assignment_events', ['operator_id'], unique=False)


def downgrade():
    op.drop_index(op.f('ix_merchant_assignment_events_operator_id'), table_name='merchant_assignment_events')
    op.drop_index(op.f('ix_merchant_assignment_events_event_type'), table_name='merchant_assignment_events')
    op.drop_index(op.f('ix_merchant_assignment_events_assignment_id'), table_name='merchant_assignment_events')
    op.drop_index(op.f('ix_merchant_assignment_events_id'), table_name='merchant_assignment_events')
    op.drop_table('merchant_assignment_events')

    op.drop_index('idx_snapshot_platform_key_date', table_name='merchant_source_snapshots')
    op.drop_index(op.f('ix_merchant_source_snapshots_snapshot_date'), table_name='merchant_source_snapshots')
    op.drop_index(op.f('ix_merchant_source_snapshots_source_key'), table_name='merchant_source_snapshots')
    op.drop_index(op.f('ix_merchant_source_snapshots_platform'), table_name='merchant_source_snapshots')
    op.drop_index(op.f('ix_merchant_source_snapshots_id'), table_name='merchant_source_snapshots')
    op.drop_table('merchant_source_snapshots')

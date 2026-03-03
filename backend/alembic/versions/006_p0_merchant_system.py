"""P0 merchant system: add id_confidence/source_type to affiliate_merchants,
create merchant_discovery_runs and merchant_mid_repair_queue tables.

Revision ID: 006
Revises: 005
Create Date: 2026-03-03

"""
from alembic import op
import sqlalchemy as sa


revision = '006'
down_revision = '005'
branch_labels = None
depends_on = None


def upgrade():
    # G-04: add id_confidence and source_type to affiliate_merchants
    with op.batch_alter_table('affiliate_merchants') as batch_op:
        batch_op.add_column(sa.Column('id_confidence', sa.String(length=16), nullable=False, server_default='high'))
        batch_op.add_column(sa.Column('source_type', sa.String(length=16), nullable=False, server_default='transaction'))

    # G-05: merchant_discovery_runs
    op.create_table(
        'merchant_discovery_runs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('run_date', sa.Date(), nullable=False),
        sa.Column('trigger_type', sa.String(length=16), nullable=False),
        sa.Column('total_tx', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('tx_with_mid', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('tx_missing_mid', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('new_merchant_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('new_missing_mid_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('fallback_tx_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('fallback_with_mid_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='success'),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_merchant_discovery_runs_id'), 'merchant_discovery_runs', ['id'], unique=False)
    op.create_index(op.f('ix_merchant_discovery_runs_run_date'), 'merchant_discovery_runs', ['run_date'], unique=False)

    # G-06: merchant_mid_repair_queue
    op.create_table(
        'merchant_mid_repair_queue',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('platform', sa.String(length=32), nullable=False),
        sa.Column('merchant_name', sa.String(length=200), nullable=False),
        sa.Column('slug', sa.String(length=200), nullable=True),
        sa.Column('latest_tx_time', sa.DateTime(timezone=True), nullable=True),
        sa.Column('candidate_mid', sa.String(length=64), nullable=True),
        sa.Column('repair_status', sa.String(length=20), nullable=False, server_default='pending'),
        sa.Column('confidence_score', sa.Numeric(5, 2), nullable=True),
        sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('next_retry_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('resolved_mid', sa.String(length=64), nullable=True),
        sa.Column('resolved_by', sa.Integer(), nullable=True),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('reason', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_merchant_mid_repair_queue_id'), 'merchant_mid_repair_queue', ['id'], unique=False)
    op.create_index(op.f('ix_merchant_mid_repair_queue_platform'), 'merchant_mid_repair_queue', ['platform'], unique=False)
    op.create_index(op.f('ix_merchant_mid_repair_queue_merchant_name'), 'merchant_mid_repair_queue', ['merchant_name'], unique=False)
    op.create_index(op.f('ix_merchant_mid_repair_queue_repair_status'), 'merchant_mid_repair_queue', ['repair_status'], unique=False)
    op.create_index(op.f('ix_merchant_mid_repair_queue_next_retry_at'), 'merchant_mid_repair_queue', ['next_retry_at'], unique=False)
    op.create_index('idx_repair_platform_name', 'merchant_mid_repair_queue', ['platform', 'merchant_name'], unique=False)


def downgrade():
    op.drop_index('idx_repair_platform_name', table_name='merchant_mid_repair_queue')
    op.drop_index(op.f('ix_merchant_mid_repair_queue_next_retry_at'), table_name='merchant_mid_repair_queue')
    op.drop_index(op.f('ix_merchant_mid_repair_queue_repair_status'), table_name='merchant_mid_repair_queue')
    op.drop_index(op.f('ix_merchant_mid_repair_queue_merchant_name'), table_name='merchant_mid_repair_queue')
    op.drop_index(op.f('ix_merchant_mid_repair_queue_platform'), table_name='merchant_mid_repair_queue')
    op.drop_index(op.f('ix_merchant_mid_repair_queue_id'), table_name='merchant_mid_repair_queue')
    op.drop_table('merchant_mid_repair_queue')

    op.drop_index(op.f('ix_merchant_discovery_runs_run_date'), table_name='merchant_discovery_runs')
    op.drop_index(op.f('ix_merchant_discovery_runs_id'), table_name='merchant_discovery_runs')
    op.drop_table('merchant_discovery_runs')

    with op.batch_alter_table('affiliate_merchants') as batch_op:
        batch_op.drop_column('source_type')
        batch_op.drop_column('id_confidence')

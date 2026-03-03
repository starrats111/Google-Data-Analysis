"""add merchant tables for assignment system

Revision ID: 005
Revises: 004
Create Date: 2026-03-03

"""
from alembic import op
import sqlalchemy as sa


revision = '005'
down_revision = '004'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'affiliate_merchants',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('merchant_id', sa.String(length=64), nullable=True),
        sa.Column('merchant_name', sa.String(length=200), nullable=False),
        sa.Column('platform', sa.String(length=32), nullable=False),
        sa.Column('slug', sa.String(length=200), nullable=True),
        sa.Column('category', sa.String(length=100), nullable=True),
        sa.Column('commission_rate', sa.String(length=50), nullable=True),
        sa.Column('logo_url', sa.String(length=500), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='active'),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('missing_mid', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('platform', 'merchant_id', name='uq_merchant_platform_mid'),
    )
    op.create_index(op.f('ix_affiliate_merchants_id'), 'affiliate_merchants', ['id'], unique=False)
    op.create_index(op.f('ix_affiliate_merchants_merchant_id'), 'affiliate_merchants', ['merchant_id'], unique=False)
    op.create_index(op.f('ix_affiliate_merchants_platform'), 'affiliate_merchants', ['platform'], unique=False)
    op.create_index(op.f('ix_affiliate_merchants_status'), 'affiliate_merchants', ['status'], unique=False)
    op.create_index(op.f('ix_affiliate_merchants_missing_mid'), 'affiliate_merchants', ['missing_mid'], unique=False)
    op.create_index('idx_merchant_name', 'affiliate_merchants', ['merchant_name'], unique=False)

    op.create_table(
        'merchant_assignments',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('merchant_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('assigned_by', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='active'),
        sa.Column('priority', sa.String(length=10), nullable=False, server_default='normal'),
        sa.Column('monthly_target', sa.Numeric(12, 2), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('assigned_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['assigned_by'], ['users.id']),
        sa.ForeignKeyConstraint(['merchant_id'], ['affiliate_merchants.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('merchant_id', 'user_id', 'status', name='uq_assignment_merchant_user_status'),
    )
    op.create_index(op.f('ix_merchant_assignments_id'), 'merchant_assignments', ['id'], unique=False)
    op.create_index(op.f('ix_merchant_assignments_merchant_id'), 'merchant_assignments', ['merchant_id'], unique=False)
    op.create_index(op.f('ix_merchant_assignments_status'), 'merchant_assignments', ['status'], unique=False)
    op.create_index(op.f('ix_merchant_assignments_user_id'), 'merchant_assignments', ['user_id'], unique=False)
    op.create_index('idx_assignment_user_status', 'merchant_assignments', ['user_id', 'status'], unique=False)


def downgrade():
    op.drop_index('idx_assignment_user_status', table_name='merchant_assignments')
    op.drop_index(op.f('ix_merchant_assignments_user_id'), table_name='merchant_assignments')
    op.drop_index(op.f('ix_merchant_assignments_status'), table_name='merchant_assignments')
    op.drop_index(op.f('ix_merchant_assignments_merchant_id'), table_name='merchant_assignments')
    op.drop_index(op.f('ix_merchant_assignments_id'), table_name='merchant_assignments')
    op.drop_table('merchant_assignments')

    op.drop_index('idx_merchant_name', table_name='affiliate_merchants')
    op.drop_index(op.f('ix_affiliate_merchants_status'), table_name='affiliate_merchants')
    op.drop_index(op.f('ix_affiliate_merchants_platform'), table_name='affiliate_merchants')
    op.drop_index(op.f('ix_affiliate_merchants_missing_mid'), table_name='affiliate_merchants')
    op.drop_index(op.f('ix_affiliate_merchants_merchant_id'), table_name='affiliate_merchants')
    op.drop_index(op.f('ix_affiliate_merchants_id'), table_name='affiliate_merchants')
    op.drop_table('affiliate_merchants')

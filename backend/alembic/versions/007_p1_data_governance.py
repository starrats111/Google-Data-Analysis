"""P1 data governance: create merchant_aliases and platform_field_contracts tables.

Revision ID: 007
Revises: 006
Create Date: 2026-03-03

"""
from alembic import op
import sqlalchemy as sa


revision = '007'
down_revision = '006'
branch_labels = None
depends_on = None


def upgrade():
    # G-10: merchant_aliases
    op.create_table(
        'merchant_aliases',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('platform', sa.String(length=32), nullable=False),
        sa.Column('alias_name', sa.String(length=200), nullable=False),
        sa.Column('normalized_name', sa.String(length=200), nullable=False),
        sa.Column('merchant_id_ref', sa.Integer(), sa.ForeignKey('affiliate_merchants.id', ondelete='CASCADE'), nullable=True),
        sa.Column('source', sa.String(length=16), nullable=False, server_default='auto'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_merchant_aliases_id'), 'merchant_aliases', ['id'], unique=False)
    op.create_index(op.f('ix_merchant_aliases_platform'), 'merchant_aliases', ['platform'], unique=False)
    op.create_index(op.f('ix_merchant_aliases_normalized_name'), 'merchant_aliases', ['normalized_name'], unique=False)
    op.create_index(op.f('ix_merchant_aliases_merchant_id_ref'), 'merchant_aliases', ['merchant_id_ref'], unique=False)
    op.create_index('idx_alias_platform_alias', 'merchant_aliases', ['platform', 'alias_name'], unique=True)

    # G-11: platform_field_contracts
    op.create_table(
        'platform_field_contracts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('platform', sa.String(length=32), nullable=False),
        sa.Column('api_type', sa.String(length=24), nullable=False, server_default='transaction'),
        sa.Column('mid_priority_json', sa.Text(), nullable=True),
        sa.Column('merchant_name_priority_json', sa.Text(), nullable=True),
        sa.Column('numeric_only', sa.Boolean(), nullable=False, server_default='1'),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default='1'),
        sa.Column('version', sa.String(length=20), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_platform_field_contracts_id'), 'platform_field_contracts', ['id'], unique=False)
    op.create_index(op.f('ix_platform_field_contracts_platform'), 'platform_field_contracts', ['platform'], unique=True)


def downgrade():
    op.drop_index(op.f('ix_platform_field_contracts_platform'), table_name='platform_field_contracts')
    op.drop_index(op.f('ix_platform_field_contracts_id'), table_name='platform_field_contracts')
    op.drop_table('platform_field_contracts')

    op.drop_index('idx_alias_platform_alias', table_name='merchant_aliases')
    op.drop_index(op.f('ix_merchant_aliases_merchant_id_ref'), table_name='merchant_aliases')
    op.drop_index(op.f('ix_merchant_aliases_normalized_name'), table_name='merchant_aliases')
    op.drop_index(op.f('ix_merchant_aliases_platform'), table_name='merchant_aliases')
    op.drop_index(op.f('ix_merchant_aliases_id'), table_name='merchant_aliases')
    op.drop_table('merchant_aliases')

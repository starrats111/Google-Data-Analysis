"""OPT-009: merchant platform sync — new table + column additions + platform name cleanup.

Revision ID: 009
Revises: 008
Create Date: 2026-03-04
"""
from alembic import op
import sqlalchemy as sa


revision = '009'
down_revision = '008'
branch_labels = None
depends_on = None

PLATFORM_CLEAN_MAP = {
    "bsh":  "BSH",  "bsh1": "BSH",  "bsh2": "BSH",
    "cg":   "CG",   "cg1":  "CG",   "cg2":  "CG",
    "rw":   "RW",   "rw1":  "RW",   "rw2":  "RW",   "rw3": "RW",
    "lh":   "LH",   "lh1":  "LH",   "lh2":  "LH",
    "lb":   "LB",   "lb1":  "LB",   "lb2":  "LB",   "lb3": "LB",
    "pm":   "PM",   "pm1":  "PM",   "pm2":  "PM",
    "cf":   "CF",   "cf1":  "CF",   "cf2":  "CF",
}


def upgrade():
    # 1. merchant_account_relationships
    op.create_table(
        'merchant_account_relationships',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('merchant_id', sa.Integer(), nullable=False),
        sa.Column('affiliate_account_id', sa.Integer(), nullable=False),
        sa.Column('relationship_status', sa.String(length=20), nullable=False),
        sa.Column('previous_status', sa.String(length=20), nullable=True),
        sa.Column('synced_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['merchant_id'], ['affiliate_merchants.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['affiliate_account_id'], ['affiliate_accounts.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('merchant_id', 'affiliate_account_id', name='uq_mar_merchant_account'),
    )
    op.create_index('idx_mar_status', 'merchant_account_relationships', ['relationship_status'])

    # 2. affiliate_accounts += api_token_encrypted, token_updated_at
    with op.batch_alter_table('affiliate_accounts') as batch_op:
        batch_op.add_column(sa.Column('api_token_encrypted', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('token_updated_at', sa.DateTime(timezone=True), nullable=True))

    # 3. affiliate_merchants += relationship_status
    with op.batch_alter_table('affiliate_merchants') as batch_op:
        batch_op.add_column(sa.Column('relationship_status', sa.String(length=20), nullable=True))
        batch_op.create_index('idx_am_relationship_status', ['relationship_status'])

    # 4. 平台名称标准化清洗
    conn = op.get_bind()
    for raw, canonical in PLATFORM_CLEAN_MAP.items():
        conn.execute(
            sa.text(
                "UPDATE affiliate_merchants SET platform = :canonical "
                "WHERE LOWER(platform) = :raw AND platform != :canonical"
            ),
            {"canonical": canonical, "raw": raw},
        )


def downgrade():
    conn = op.get_bind()
    # 无法精确还原平台名称，仅做 DDL 回退
    with op.batch_alter_table('affiliate_merchants') as batch_op:
        batch_op.drop_index('idx_am_relationship_status')
        batch_op.drop_column('relationship_status')

    with op.batch_alter_table('affiliate_accounts') as batch_op:
        batch_op.drop_column('token_updated_at')
        batch_op.drop_column('api_token_encrypted')

    op.drop_index('idx_mar_status', table_name='merchant_account_relationships')
    op.drop_table('merchant_account_relationships')

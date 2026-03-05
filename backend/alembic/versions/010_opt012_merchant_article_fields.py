"""OPT-012: PubArticle add merchant fields + pub_tracking_links table.

Revision ID: 010
Revises: 009
Create Date: 2026-02-27
"""
from alembic import op
import sqlalchemy as sa

revision = '010'
down_revision = '009'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('pub_articles', sa.Column('merchant_url', sa.String(500), nullable=True))
    op.add_column('pub_articles', sa.Column('tracking_link', sa.Text(), nullable=True))
    op.add_column('pub_articles', sa.Column('language', sa.String(10), server_default='zh', nullable=True))

    op.create_table(
        'pub_tracking_links',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('merchant_url', sa.String(500), nullable=False),
        sa.Column('tracking_link', sa.Text(), nullable=False),
        sa.Column('brand_name', sa.String(200), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index('idx_pub_tracking_links_user', 'pub_tracking_links', ['user_id'])
    op.create_index('idx_pub_tracking_links_domain', 'pub_tracking_links', ['merchant_url'])


def downgrade():
    op.drop_index('idx_pub_tracking_links_domain', 'pub_tracking_links')
    op.drop_index('idx_pub_tracking_links_user', 'pub_tracking_links')
    op.drop_table('pub_tracking_links')
    op.drop_column('pub_articles', 'language')
    op.drop_column('pub_articles', 'tracking_link')
    op.drop_column('pub_articles', 'merchant_url')

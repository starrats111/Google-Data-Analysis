"""add merchant_name and merchant_mid to pub_articles

Revision ID: 011
"""
from alembic import op
import sqlalchemy as sa

revision = '011_merchant_fields'
down_revision = '010_opt012_merchant_article_fields'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('pub_articles') as batch_op:
        batch_op.add_column(sa.Column('merchant_name', sa.String(200), nullable=True))
        batch_op.add_column(sa.Column('merchant_mid', sa.String(100), nullable=True))


def downgrade():
    with op.batch_alter_table('pub_articles') as batch_op:
        batch_op.drop_column('merchant_mid')
        batch_op.drop_column('merchant_name')

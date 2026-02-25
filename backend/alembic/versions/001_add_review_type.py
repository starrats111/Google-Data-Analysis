"""add review_type to luchu_reviews

Revision ID: 001
Revises: None
Create Date: 2026-02-25
"""
from alembic import op
import sqlalchemy as sa

revision = '001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('luchu_reviews') as batch_op:
        batch_op.add_column(sa.Column('review_type', sa.String(10), server_default='peer'))


def downgrade():
    with op.batch_alter_table('luchu_reviews') as batch_op:
        batch_op.drop_column('review_type')

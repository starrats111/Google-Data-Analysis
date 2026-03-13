"""CR-008: user_site_bindings table

Revision ID: 011_cr008
Revises: 010_opt012
Create Date: 2026-03-13
"""
from alembic import op
import sqlalchemy as sa

revision = "011_cr008"
down_revision = "010_opt012"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "user_site_bindings",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("site_id", sa.Integer(), sa.ForeignKey("pub_sites.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "site_id", name="uq_user_site"),
    )
    op.create_index("idx_usb_user", "user_site_bindings", ["user_id"])
    op.create_index("idx_usb_site", "user_site_bindings", ["site_id"])


def downgrade():
    op.drop_index("idx_usb_site", table_name="user_site_bindings")
    op.drop_index("idx_usb_user", table_name="user_site_bindings")
    op.drop_table("user_site_bindings")

"""Create category configuration and durable inquiry mail queue."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None


def upgrade():
    op.create_table(
        "inquiry_categories",
        sa.Column("slug", sa.String(80), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("language", sa.String(2), nullable=False),
        sa.Column("form_id", sa.String(20), unique=True, nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("fields", postgresql.JSONB(), nullable=False),
        sa.Column("recipients", postgresql.JSONB(), nullable=False),
        sa.Column("subject_template", sa.String(500), nullable=False),
        sa.Column("body_template", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "inquiries",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("idempotency_key", sa.Uuid(), unique=True, nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("category_slug", sa.String(80), sa.ForeignKey("inquiry_categories.slug"), nullable=False),
        sa.Column("category_snapshot", postgresql.JSONB(), nullable=False),
        sa.Column("fields", postgresql.JSONB(), nullable=False),
        sa.Column("reply_to", sa.String(320), nullable=False),
        sa.Column("recipients", postgresql.JSONB(), nullable=False),
        sa.Column("subject", sa.String(500), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("last_error", sa.String(100)),
    )
    op.create_index("ix_inquiries_next_attempt_at", "inquiries", ["next_attempt_at"])


def downgrade():
    op.drop_table("inquiries")
    op.drop_table("inquiry_categories")

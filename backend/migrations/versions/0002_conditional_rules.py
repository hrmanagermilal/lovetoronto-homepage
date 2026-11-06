"""Store category-specific conditional validation rules."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"


def upgrade():
    op.add_column(
        "inquiry_categories",
        sa.Column("rules", postgresql.JSONB(), nullable=False, server_default="[]"),
    )


def downgrade():
    op.drop_column("inquiry_categories", "rules")

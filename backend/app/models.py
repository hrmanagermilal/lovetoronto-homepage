from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Category(Base):
    __tablename__ = "inquiry_categories"

    slug: Mapped[str] = mapped_column(String(80), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    language: Mapped[str] = mapped_column(String(2))
    form_id: Mapped[str] = mapped_column(String(20), unique=True)
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    fields: Mapped[list[dict]] = mapped_column(JSONB)
    rules: Mapped[list[dict]] = mapped_column(JSONB, default=list, server_default="[]")
    recipients: Mapped[list[str]] = mapped_column(JSONB)
    subject_template: Mapped[str] = mapped_column(String(500))
    body_template: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Inquiry(Base):
    __tablename__ = "inquiries"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    idempotency_key: Mapped[UUID] = mapped_column(unique=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    category_slug: Mapped[str] = mapped_column(ForeignKey("inquiry_categories.slug"))
    category_snapshot: Mapped[dict] = mapped_column(JSONB)
    fields: Mapped[dict] = mapped_column(JSONB)
    reply_to: Mapped[str] = mapped_column(String(320))
    recipients: Mapped[list[str]] = mapped_column(JSONB)
    subject: Mapped[str] = mapped_column(String(500))
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(100))

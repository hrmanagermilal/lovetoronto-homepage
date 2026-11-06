import hashlib
import json
import logging
from datetime import date
from string import Template
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.responses import JSONResponse

from .db import session
from .models import Category, Inquiry
from .schemas import CategoryConfig, InquiryReceipt, InquiryRequest, PublicCategory

logger = logging.getLogger(__name__)
app = FastAPI(title="Love Toronto inquiries", docs_url=None, redoc_url=None)
DB = Annotated[Session, Depends(session)]
email_adapter = TypeAdapter(EmailStr)


class BodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            await self.app(scope, receive, send)
            return
        chunks = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            size += len(message.get("body", b""))
            if size > 65536:
                await JSONResponse({"detail": "Request too large"}, status_code=413)(scope, receive, send)
                return
            chunks.append(message.get("body", b""))
            if not message.get("more_body"):
                break

        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


app.add_middleware(BodyLimit)


@app.get("/api/health")
def health(db: DB):
    db.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.get("/api/v1/inquiry-categories", response_model=list[PublicCategory])
def categories(db: DB):
    return db.scalars(select(Category).where(Category.active.is_(True)).order_by(Category.slug)).all()


def receipt(inquiry: Inquiry) -> InquiryReceipt:
    return InquiryReceipt(id=str(inquiry.id), status=inquiry.status)


@app.post("/api/v1/inquiries", status_code=202, response_model=InquiryReceipt)
def submit(
    payload: InquiryRequest, db: DB,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    request_hash = hashlib.sha256(
        json.dumps(payload.model_dump(), sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()

    def existing_receipt(existing: Inquiry):
        if existing.request_hash != request_hash:
            raise HTTPException(409, "Idempotency key already used for a different inquiry")
        return receipt(existing)

    existing = db.scalar(select(Inquiry).where(Inquiry.idempotency_key == idempotency_key))
    if existing:
        return existing_receipt(existing)
    category = db.get(Category, payload.category)
    if not category or not category.active:
        raise HTTPException(404, "Inquiry category is unavailable")
    config = CategoryConfig.model_validate({
        key: getattr(category, key) for key in CategoryConfig.model_fields
    })
    errors = {}
    definitions = {field.name: field for field in config.fields}
    for key in payload.fields.keys() - definitions.keys():
        errors[key] = "Unknown field"
    validated: dict[str, str | bool] = {}
    for key, field in definitions.items():
        value = payload.fields.get(key, False if field.type == "checkbox" else "")
        if field.type == "checkbox":
            if not isinstance(value, bool) or (field.required and value is not True):
                errors[key] = "Consent is required" if field.required else "Expected a boolean"
        elif not isinstance(value, str):
            errors[key] = "Expected text"
        else:
            value = value.strip()
            if field.required and not value:
                errors[key] = "This field is required"
            elif len(value) > field.max_length:
                errors[key] = f"Maximum length is {field.max_length}"
            elif value and field.type == "select" and value not in field.options:
                errors[key] = "Invalid option"
            elif value and field.type == "email":
                try:
                    value = str(email_adapter.validate_python(value))
                except ValidationError:
                    errors[key] = "Invalid email address"
            elif value and (field.type == "date" or field.format == "date"):
                try:
                    if date.fromisoformat(value).isoformat() != value:
                        raise ValueError("Use yyyy-mm-dd")
                except ValueError:
                    errors[key] = "Invalid date"
            elif value and field.format == "year":
                if len(value) != 4 or not value.isascii() or not value.isdigit() or not 1 <= int(value) <= date.today().year:
                    errors[key] = "Enter a valid four-digit birth year"
            elif "\x00" in value:
                errors[key] = "Invalid text"
        validated[key] = value
    for rule in config.rules:
        if not any(validated.get(name) for name in rule.trigger_fields):
            continue
        if not any(validated.get(name) for name in rule.name_fields):
            errors[rule.name_fields[0]] = "A representative name is required"
        for name in rule.required_fields:
            if not validated.get(name):
                errors[name] = "Required when applying as a representative"
        if validated.get(rule.consent_field) != rule.consent_value:
            errors[rule.consent_field] = "Representative authorization is required"
    if errors:
        raise HTTPException(422, {"fields": errors})
    inquiry_id = uuid4()
    variables = {
        "category": config.name, "inquiry_id": str(inquiry_id),
        "name": str(validated.get("text-name", "")),
        "email": str(validated["email-address"]),
        "details": "\n".join(f"{field.label}: {validated[field.name]}" for field in config.fields),
    }
    subject = Template(config.subject_template).substitute(variables)
    if len(subject) > 500 or "\r" in subject or "\n" in subject:
        raise HTTPException(422, "Email subject is invalid")
    inquiry = Inquiry(
        id=inquiry_id, idempotency_key=idempotency_key, request_hash=request_hash,
        category_slug=config.slug, category_snapshot=config.model_dump(mode="json"),
        fields=validated, reply_to=variables["email"], recipients=list(config.recipients),
        subject=subject, body=Template(config.body_template).substitute(variables),
    )
    db.add(inquiry)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Inquiry).where(Inquiry.idempotency_key == idempotency_key))
        if existing:
            return existing_receipt(existing)
        logger.exception("Inquiry persistence failed")
        raise
    return receipt(inquiry)

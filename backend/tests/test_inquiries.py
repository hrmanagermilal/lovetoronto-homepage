import json
import smtplib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from aiosmtpd.controller import Controller
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import func, select, text

from app.db import SessionLocal, engine
from app.main import app
from app.models import Category, Inquiry
from app.schemas import CategoryConfig
from app.settings import Settings, settings
from app.worker import MAX_ATTEMPTS, deliver_one

CONFIGS = json.loads(Path("config/contact-categories.json").read_text())


@pytest.fixture(autouse=True)
def database():
    assert settings().postgres_host == "db-test"
    assert settings().postgres_db == "lovetoronto_test"
    with engine.begin() as connection:
        connection.execute(text("TRUNCATE inquiries, inquiry_categories CASCADE"))
    with SessionLocal.begin() as db:
        for definition in CONFIGS:
            config = CategoryConfig.model_validate({
                **definition, "active": True, "recipients": [f"{definition['slug']}@example.org"],
            })
            db.add(Category(**config.model_dump(mode="json")))
    yield


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client


def payload(slug="contact-6-ko"):
    config = next(config for config in CONFIGS if config["slug"] == slug)
    values = {}
    for field in config["fields"]:
        if field["type"] == "checkbox":
            value = True
        elif field["type"] == "select":
            value = next((value for value in field["options"] if value), "")
        elif field["type"] == "email":
            value = "sender@example.org"
        elif field["type"] == "date" or field.get("format") == "date":
            value = "2000-01-01"
        elif field.get("format") == "year":
            value = "2000"
        else:
            value = "Test inquiry"
        values[field["name"]] = value
    return {"category": slug, "fields": values}


def post(client, data=None, key=None):
    return client.post("/api/v1/inquiries", json=data or payload(),
                       headers={"Idempotency-Key": str(key or uuid4())})


@pytest.mark.parametrize("slug", [config["slug"] for config in CONFIGS])
def test_all_category_forms_persist_distinct_fields_and_routing(client, slug):
    response = post(client, payload(slug))
    assert response.status_code == 202, response.text
    assert response.json()["status"] == "pending"
    with SessionLocal() as db:
        inquiry = db.get(Inquiry, response.json()["id"])
        assert inquiry.fields == payload(slug)["fields"]
        assert inquiry.recipients == [f"{slug}@example.org"]
        assert inquiry.reply_to == "sender@example.org"
        assert str(inquiry.id) in inquiry.subject
        assert inquiry.category_snapshot["fields"]
        consent = next(field for field in inquiry.category_snapshot["fields"]
                       if field["type"] == "checkbox")
        assert consent["consent_text"]
        assert all(field["label"] in inquiry.body for field in inquiry.category_snapshot["fields"])


def test_public_categories_never_expose_recipients_or_templates(client):
    response = client.get("/api/v1/inquiry-categories")
    assert response.status_code == 200
    assert len(response.json()) == 12
    assert len({category["slug"].rsplit("-", 1)[0] for category in response.json()}) == 6
    assert all(set(category) == {"slug", "name", "language", "form_id", "fields", "rules"}
               for category in response.json())
    with SessionLocal.begin() as db:
        db.get(Category, "contact-6-ko").active = False
    assert len(client.get("/api/v1/inquiry-categories").json()) == 11
    assert post(client).status_code == 404


def test_bulk_recipients_preserves_activation_templates_and_saved_inquiries(client, monkeypatch):
    from app.cli import main
    inquiry_id = post(client).json()["id"]
    with SessionLocal.begin() as db:
        db.get(Category, "contact-1-ko").active = False
        before = {
            category.slug: (category.active, category.subject_template, category.body_template)
            for category in db.scalars(select(Category))
        }
    monkeypatch.setattr("sys.argv", [
        "cli", "set-all-recipients", "--recipient", "lovetoronto.office@gmail.com",
    ])
    main()
    with SessionLocal() as db:
        for category in db.scalars(select(Category)):
            assert category.recipients == ["lovetoronto.office@gmail.com"]
            assert (category.active, category.subject_template, category.body_template) == before[category.slug]
        assert db.get(Inquiry, inquiry_id).recipients == ["contact-6-ko@example.org"]
    response = post(client)
    with SessionLocal() as db:
        assert db.get(Inquiry, response.json()["id"]).recipients == ["lovetoronto.office@gmail.com"]


def test_seed_defaults_route_senior_categories_to_office_and_senior():
    assert len(CONFIGS) == 12
    senior_categories = [config for config in CONFIGS if config["slug"].startswith("contact-7-")]
    other_categories = [config for config in CONFIGS if config not in senior_categories]
    assert len(senior_categories) == 2
    assert all(config["active"] for config in senior_categories)
    assert all(config["recipients"] == [
        "lovetoronto.office@gmail.com", "lovetoronto.senior@gmail.com",
    ] for config in senior_categories)
    assert all(config["active"] for config in other_categories)
    assert all(config["recipients"] == ["lovetoronto.office@gmail.com"] for config in other_categories)


def test_set_category_recipients_preserves_activation_and_templates(client, monkeypatch):
    from app.cli import main

    with SessionLocal.begin() as db:
        category = db.get(Category, "contact-7-ko")
        category.active = False
        before = (category.subject_template, category.body_template)
    monkeypatch.setattr("sys.argv", [
        "cli", "set-recipients", "contact-7-ko",
        "--recipient", "lovetoronto.office@gmail.com",
        "--recipient", "lovetoronto.senior@gmail.com",
    ])
    main()
    with SessionLocal() as db:
        category = db.get(Category, "contact-7-ko")
        assert category.recipients == [
            "lovetoronto.office@gmail.com", "lovetoronto.senior@gmail.com",
        ]
        assert not category.active
        assert (category.subject_template, category.body_template) == before


@pytest.mark.parametrize("language", ["ko", "en"])
def test_event_and_general_share_form_but_preserve_category_routing(client, language):
    configs = {item["slug"]: item for item in client.get("/api/v1/inquiry-categories").json()}
    event = configs[f"contact-5-{language}"]
    general = configs[f"contact-6-{language}"]
    assert event["fields"] == general["fields"]
    assert event["rules"] == general["rules"] == []
    assert [field["name"] for field in event["fields"]] == [
        "text-name", "text-name-kor", "tel-phone", "text-address",
        "email-address", "textarea-msg", "acceptance-consent",
    ]
    ids = []
    for category in (event, general):
        data = payload(category["slug"])
        data["fields"]["acceptance-consent"] = False
        assert post(client, data).status_code == 422
        data["fields"]["acceptance-consent"] = True
        response = post(client, data)
        assert response.status_code == 202
        ids.append(response.json()["id"])
        with SessionLocal() as db:
            inquiry = db.get(Inquiry, response.json()["id"])
            assert inquiry.category_slug == category["slug"]
            assert inquiry.recipients == [f"{category['slug']}@example.org"]
    assert ids[0] != ids[1]


@pytest.mark.parametrize("change", ["missing", "unknown", "email", "long", "consent", "type"])
def test_validation_rejects_without_saving(client, change):
    data = payload()
    if change == "missing":
        del data["fields"]["text-name"]
    elif change == "unknown":
        data["fields"]["recipient"] = "attacker@example.org"
    elif change == "email":
        data["fields"]["email-address"] = "bad\r\nBcc: other@example.org"
    elif change == "long":
        data["fields"]["text-name"] = "x" * 401
    elif change == "consent":
        data["fields"]["acceptance-consent"] = False
    else:
        data["fields"]["text-name"] = True
    assert post(client, data).status_code == 422
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Inquiry)) == 0


def test_category_specific_validation(client):
    data = payload("contact-1-ko")
    del data["fields"]["text-name-other-kor"]
    assert post(client, data).status_code == 422
    data = payload("contact-3-en")
    del data["fields"]["text-expect"]
    assert post(client, data).status_code == 422
    ko = next(config for config in CONFIGS if config["slug"] == "contact-3-ko")
    en = next(config for config in CONFIGS if config["slug"] == "contact-3-en")
    assert {field["name"] for field in ko["fields"]} == {field["name"] for field in en["fields"]}
    assert post(client, payload("contact-4-ko")).status_code == 202
    data = payload("contact-7-ko")
    data["fields"]["menu-home"] = "not-a-valid-option"
    assert post(client, data).status_code == 422


def test_idempotent_submission_and_conflict(client):
    key = uuid4()
    first = post(client, key=key)
    assert post(client, key=key).json() == first.json()
    data = payload()
    data["fields"]["textarea-msg"] = "different"
    assert post(client, data, key).status_code == 409
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Inquiry)) == 1


def test_concurrent_idempotency(client):
    key = uuid4()
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: post(client, key=key), range(4)))
    assert {result.status_code for result in results} == {202}
    assert len({result.json()["id"] for result in results}) == 1


def test_body_limit_and_required_idempotency_header(client):
    assert client.post("/api/v1/inquiries", json=payload()).status_code == 422
    assert client.post("/api/v1/inquiries", content=b"x" * 65537).status_code == 413
    assert client.get("/api/health").json() == {"status": "ok"}


def smtp_config():
    return Settings(postgres_password="unused", smtp_host="127.0.0.1",
                    smtp_port=8025, smtp_security="plain", smtp_from="office@example.org")


def test_real_smtp_delivery_uses_frozen_configuration(client):
    received = []

    class Handler:
        async def handle_DATA(self, server, session, envelope):
            received.append(envelope)
            return "250 OK"

    controller = Controller(Handler(), hostname="127.0.0.1", port=8025)
    controller.start()
    try:
        inquiry_id = post(client).json()["id"]
        with SessionLocal.begin() as db:
            db.get(Category, "contact-6-ko").recipients = ["changed@example.org"]
        assert deliver_one(smtp_config())
        assert not deliver_one(smtp_config())
        assert len(received) == 1
        assert received[0].mail_from == "office@example.org"
        assert received[0].rcpt_tos == ["contact-6-ko@example.org"]
        content = received[0].content.decode()
        assert "Reply-To: sender@example.org" in content
        assert f"Message-ID: <inquiry-{inquiry_id}@www.lovetoronto.org>" in content
        with SessionLocal() as db:
            inquiry = db.get(Inquiry, inquiry_id)
            assert inquiry.status == "sent"
            assert inquiry.attempts == 1
            assert inquiry.sent_at is not None
    finally:
        controller.stop()


def test_worker_retries_and_marks_terminal_failure(client, monkeypatch):
    inquiry_id = post(client).json()["id"]

    def fail(*_):
        raise smtplib.SMTPException("Sensitive SMTP response must not be stored")

    monkeypatch.setattr("app.worker.send_mail", fail)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        assert deliver_one(smtp_config())
        with SessionLocal.begin() as db:
            inquiry = db.get(Inquiry, inquiry_id)
            assert inquiry.attempts == attempt
            assert inquiry.last_error == "SMTPException"
            assert inquiry.status == ("failed" if attempt == MAX_ATTEMPTS else "pending")
            inquiry.next_attempt_at = datetime.now(timezone.utc)
    assert not deliver_one(smtp_config())


def test_locked_queue_rows_are_skipped(client, monkeypatch):
    inquiry_id = post(client).json()["id"]
    sent = []
    monkeypatch.setattr("app.worker.send_mail", lambda *_: sent.append(True))
    with SessionLocal.begin() as db:
        db.scalar(select(Inquiry).where(Inquiry.id == inquiry_id).with_for_update())
        assert not deliver_one(smtp_config())
    assert deliver_one(smtp_config())
    assert len(sent) == 1


def test_templates_reject_unsafe_variables_and_plain_smtp_auth():
    config = CONFIGS[0]
    with pytest.raises(ValidationError):
        CategoryConfig.model_validate({**config, "subject_template": "${__class__}"})
    with pytest.raises(ValidationError):
        CategoryConfig.model_validate({**config, "subject_template": "header\r\ninjection"})
    with pytest.raises(ValidationError):
        CategoryConfig.model_validate({**config, "active": True})
    with pytest.raises(ValidationError):
        Settings(postgres_password="unused", smtp_security="plain", smtp_user="user",
                 smtp_password="password")


@pytest.mark.parametrize("language", ["ko", "en"])
def test_senior_self_application_does_not_require_representative(client, language):
    data = payload(f"contact-7-{language}")
    config = next(config for config in CONFIGS if config["slug"] == data["category"])
    for name in config["rules"][0]["trigger_fields"]:
        data["fields"][name] = ""
    assert post(client, data).status_code == 202


@pytest.mark.parametrize("language", ["ko", "en"])
def test_senior_representative_requires_identity_contact_and_authorization(client, language):
    config = next(config for config in CONFIGS if config["slug"] == f"contact-7-{language}")
    rule = config["rules"][0]
    for missing in [*rule["required_fields"], rule["consent_field"], "names"]:
        data = payload(config["slug"])
        if missing == "names":
            for name in rule["name_fields"]:
                data["fields"][name] = ""
        else:
            data["fields"][missing] = ""
        assert post(client, data).status_code == 422, missing
    data = payload(config["slug"])
    data["fields"][rule["consent_field"]] = "아니오" if language == "ko" else "No"
    assert post(client, data).status_code == 422
    data = payload(config["slug"])
    data["fields"]["text-name-other"] = ""
    assert post(client, data).status_code == 202


@pytest.mark.parametrize("field,value", [
    ("text-dob", "2000-02-31"), ("text-date", "not-a-date"), ("text-dob", "20000101"),
])
def test_senior_dates_use_valid_iso_format(client, field, value):
    data = payload("contact-7-ko")
    data["fields"][field] = value
    assert post(client, data).status_code == 422


def test_smtp_test_cli_sends_synthetic_mail_without_changing_inquiries(monkeypatch, capsys):
    from app.cli import main
    received = []

    class Handler:
        async def handle_DATA(self, server, session, envelope):
            received.append(envelope)
            return "250 OK"

    controller = Controller(Handler(), hostname="127.0.0.1", port=8025)
    controller.start()
    try:
        monkeypatch.setattr("app.settings.settings", smtp_config)
        monkeypatch.setattr("sys.argv", ["cli", "test-email", "--to", "test@example.org"])
        main()
        assert len(received) == 1
        assert received[0].rcpt_tos == ["test@example.org"]
        assert "SMTP server accepted" in capsys.readouterr().out
        with SessionLocal() as db:
            assert db.scalar(select(func.count()).select_from(Inquiry)) == 0
    finally:
        controller.stop()


def test_smtp_test_cli_explicitly_fails_when_unconfigured(monkeypatch):
    from app.cli import main
    monkeypatch.setattr("app.settings.settings", lambda: Settings(postgres_password="unused"))
    monkeypatch.setattr("sys.argv", ["cli", "test-email", "--to", "test@example.org"])
    with pytest.raises(SystemExit) as failure:
        main()
    assert failure.value.code != 0

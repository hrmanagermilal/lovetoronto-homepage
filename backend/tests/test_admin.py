import io
import json
import re
from datetime import timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select, text, update

import app.admin as admin
from app.db import SessionLocal, engine
from app.geo import GeoGate
from app.main import app
from app.models import AdminSession, AdminUser, HeroSlide, Newsletter
from app.settings import settings

TORONTO_IP = "142.150.0.1"
OUTSIDE_IP = "8.8.8.8"
LOCATIONS = {
    TORONTO_IP: {"country": {"iso_code": "CA"}, "location": {"latitude": 43.66, "longitude": -79.39}},
    "99.0.0.1": {"country": {"iso_code": "CA"}, "location": {"latitude": 43.59, "longitude": -79.64}},  # Mississauga
    "70.0.0.1": {"country": {"iso_code": "CA"}, "location": {"latitude": 45.50, "longitude": -73.57}},  # Montreal
    "75.0.0.1": {"country": {"iso_code": "US"}, "location": {"latitude": 42.89, "longitude": -78.88}},  # Buffalo
    "2607:f8b0::1": {"country": {"iso_code": "CA"}, "location": {"latitude": 43.70, "longitude": -79.42}},
}
PASSWORD = "correct horse battery 42"


def make_gate(allowed="", locations=LOCATIONS):
    gate = GeoGate(settings().model_copy(update={"admin_allowed_cidrs": allowed}))
    gate._lookup = lambda ip: locations.get(ip) if locations is not None else None
    return gate


@pytest.fixture(autouse=True)
def admin_state(monkeypatch, tmp_path):
    with engine.begin() as connection:
        connection.execute(text(
            "TRUNCATE admin_users, admin_tokens, admin_challenges, admin_sessions, newsletters CASCADE"))
    gate = make_gate()
    monkeypatch.setattr(admin, "gate", lambda: gate)
    monkeypatch.setattr(settings(), "media_dir", str(tmp_path))
    yield


@pytest.fixture
def mail(monkeypatch):
    sent = []
    monkeypatch.setattr(admin, "send_text", lambda to, subject, body, config: sent.append((to, subject, body)))
    return sent


def new_client(ip=TORONTO_IP):
    client = TestClient(app, base_url="https://www.lovetoronto.org:81")
    client.headers.update({"X-Real-IP": ip, "X-Requested-With": "lt-admin", "Host": "www.lovetoronto.org:81"})
    return client


@pytest.fixture
def client():
    with new_client() as client:
        yield client


def create_admin(email="owner@example.org", role="owner", password=PASSWORD):
    with SessionLocal.begin() as db:
        user = AdminUser(email=email, name="", role=role, active=True, failed_logins=0,
                         password_hash=admin.hash_password(password) if password else None)
        db.add(user)
        db.flush()
        return user.id


def last_link_token(mail):
    return re.search(r"token=([\w-]+)", mail[-1][2]).group(1)


def sign_in(client, mail, email="owner@example.org", password=PASSWORD):
    response = client.post("/api/admin/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    code = re.search(r"\b(\d{6})\b", mail[-1][2]).group(1)
    response = client.post("/api/admin/auth/verify", json={"challenge_id": response.json()["challenge_id"], "code": code})
    assert response.status_code == 200, response.text
    return response


def test_geo_gate_allows_only_the_toronto_area():
    gate = make_gate()
    assert gate.check(TORONTO_IP)[0]
    assert gate.check("99.0.0.1")[0]
    assert gate.check("2607:f8b0::1")[0]
    assert not gate.check("70.0.0.1")[0]
    assert not gate.check("75.0.0.1")[0]
    assert not gate.check(OUTSIDE_IP)[0]
    assert not gate.check("172.18.0.1")[0]
    assert not gate.check("")[0]
    assert not gate.check("not-an-ip")[0]
    assert not make_gate(locations=None).check(TORONTO_IP)[0]
    assert make_gate(allowed="203.0.113.0/24, 172.18.0.1").check("203.0.113.9")[0]
    assert make_gate(allowed="172.18.0.1").check("172.18.0.1")[0]


def test_admin_api_rejects_clients_outside_toronto(mail):
    create_admin()
    with new_client(OUTSIDE_IP) as outside:
        assert outside.get("/api/admin/gate").status_code == 403
        response = outside.post("/api/admin/auth/login", json={"email": "owner@example.org", "password": PASSWORD})
        assert response.status_code == 403
        assert "토론토" in response.json()["detail"]
    with new_client() as inside:
        assert inside.get("/api/admin/gate").status_code == 204
        assert inside.post("/api/admin/gate").status_code == 204
    assert mail == []


def test_state_changing_requests_require_csrf_header_and_same_origin(client):
    create_admin()
    body = {"email": "owner@example.org", "password": PASSWORD}
    assert client.post("/api/admin/auth/login", json=body, headers={"X-Requested-With": ""}).status_code == 403
    assert client.post("/api/admin/auth/login", json=body,
                       headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/admin/auth/login", json=body,
                       headers={"Origin": "https://www.lovetoronto.org:82"}).status_code == 403


def test_invite_password_setup_and_email_two_factor_login(client, mail):
    user_id = create_admin(password=None)
    with SessionLocal.begin() as db:
        admin.issue_link(db, db.get(AdminUser, user_id), "invite")
    # The real token is only in the email; issue one through the owner-facing flow instead.
    with SessionLocal.begin() as db:
        admin.send_link(db, db.get(AdminUser, user_id), "invite")
    assert mail[-1][0] == "owner@example.org"
    token = last_link_token(mail)
    assert client.post("/api/admin/auth/link-info", json={"token": token}).json() == {
        "email": "owner@example.org", "purpose": "invite"}
    assert client.post("/api/admin/auth/accept", json={"token": token, "password": "short"}).status_code == 422
    assert client.post("/api/admin/auth/accept", json={"token": token, "password": "aaaaaaaaaaaaaaa"}).status_code == 422
    assert client.post("/api/admin/auth/accept", json={"token": token, "password": PASSWORD}).status_code == 204
    assert client.post("/api/admin/auth/accept", json={"token": token, "password": PASSWORD}).status_code == 410

    assert client.get("/api/admin/me").status_code == 401
    wrong = client.post("/api/admin/auth/login", json={"email": "owner@example.org", "password": "wrong password!!"})
    assert wrong.status_code == 401
    unknown = client.post("/api/admin/auth/login", json={"email": "nobody@example.org", "password": PASSWORD})
    assert unknown.status_code == 401 and unknown.json() == wrong.json()

    response = client.post("/api/admin/auth/login", json={"email": "OWNER@example.org", "password": PASSWORD})
    assert response.status_code == 200
    challenge = response.json()["challenge_id"]
    code = re.search(r"\b(\d{6})\b", mail[-1][2]).group(1)
    assert "set-cookie" not in response.headers
    bad = f"{(int(code) + 1) % 1_000_000:06d}"
    assert client.post("/api/admin/auth/verify", json={"challenge_id": challenge, "code": bad}).status_code == 401
    response = client.post("/api/admin/auth/verify", json={"challenge_id": challenge, "code": code})
    assert response.status_code == 200
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{admin.COOKIE}=") and "HttpOnly" in cookie and "Secure" in cookie
    assert "samesite=strict" in cookie.lower()
    assert client.get("/api/admin/me").json()["email"] == "owner@example.org"
    # A code works once.
    assert client.post("/api/admin/auth/verify", json={"challenge_id": challenge, "code": code}).status_code == 401
    assert client.post("/api/admin/auth/logout").status_code == 204
    assert client.get("/api/admin/me").status_code == 401


def test_code_attempts_are_limited(client, mail):
    create_admin()
    response = client.post("/api/admin/auth/login", json={"email": "owner@example.org", "password": PASSWORD})
    challenge = response.json()["challenge_id"]
    code = re.search(r"\b(\d{6})\b", mail[-1][2]).group(1)
    bad = f"{(int(code) + 1) % 1_000_000:06d}"
    for _ in range(admin.CODE_ATTEMPTS):
        assert client.post("/api/admin/auth/verify", json={"challenge_id": challenge, "code": bad}).status_code == 401
    assert client.post("/api/admin/auth/verify", json={"challenge_id": challenge, "code": code}).status_code == 401


def test_repeated_password_failures_lock_the_account(client, mail):
    create_admin()
    for _ in range(admin.LOCK_AFTER):
        client.post("/api/admin/auth/login", json={"email": "owner@example.org", "password": "wrong password!!"})
    response = client.post("/api/admin/auth/login", json={"email": "owner@example.org", "password": PASSWORD})
    assert response.status_code == 429
    assert mail == []


def test_sessions_expire_when_idle(client, mail):
    create_admin()
    sign_in(client, mail)
    with SessionLocal.begin() as db:
        db.execute(update(AdminSession).values(last_seen_at=admin.now() - admin.SESSION_IDLE - timedelta(minutes=1)))
    assert client.get("/api/admin/me").status_code == 401


def test_owner_manages_accounts_and_editors_cannot(client, mail):
    owner_id = create_admin()
    sign_in(client, mail)
    response = client.post("/api/admin/users", json={"email": "Editor@Example.org", "name": "편집자", "role": "editor"})
    assert response.status_code == 201, response.text
    editor = response.json()
    assert editor["email"] == "editor@example.org" and not editor["has_password"]
    assert mail[-1][0] == "editor@example.org" and "#/accept?token=" in mail[-1][2]
    assert client.post("/api/admin/users", json={"email": "editor@example.org"}).status_code == 409

    assert client.patch(f"/api/admin/users/{owner_id}", json={"active": False}).status_code == 422
    assert client.patch(f"/api/admin/users/{owner_id}", json={"role": "editor"}).status_code == 422
    assert client.patch(f"/api/admin/users/{editor['id']}", json={"name": "새 이름"}).json()["name"] == "새 이름"

    token = last_link_token(mail)
    with new_client() as editor_client:
        assert editor_client.post("/api/admin/auth/accept", json={"token": token, "password": PASSWORD}).status_code == 204
        sign_in(editor_client, mail, "editor@example.org")
        assert editor_client.get("/api/admin/users").status_code == 403
        assert editor_client.post("/api/admin/users", json={"email": "x@example.org"}).status_code == 403
        assert editor_client.get("/api/admin/hero", params={"language": "ko"}).status_code == 200
        assert client.patch(f"/api/admin/users/{editor['id']}", json={"active": False}).status_code == 200
        assert editor_client.get("/api/admin/me").status_code == 401

    assert client.post(f"/api/admin/users/{editor['id']}/send-link").status_code == 404
    client.patch(f"/api/admin/users/{editor['id']}", json={"active": True, "role": "owner"})
    assert client.post(f"/api/admin/users/{editor['id']}/send-link").json() == {"purpose": "reset"}
    assert "#/reset?token=" in mail[-1][2]
    assert [user["email"] for user in client.get("/api/admin/users").json()] == [
        "owner@example.org", "editor@example.org"]


def test_invite_is_not_created_when_email_fails(client, mail, monkeypatch):
    create_admin()
    sign_in(client, mail)

    def broken(*_):
        raise OSError("smtp down")
    monkeypatch.setattr(admin, "send_text", broken)
    assert client.post("/api/admin/users", json={"email": "new@example.org"}).status_code == 503
    with SessionLocal() as db:
        assert db.scalar(select(AdminUser).where(AdminUser.email == "new@example.org")) is None


def test_forgot_password_does_not_reveal_accounts(client, mail):
    create_admin()
    known = client.post("/api/admin/auth/forgot", json={"email": "owner@example.org"})
    unknown = client.post("/api/admin/auth/forgot", json={"email": "nobody@example.org"})
    assert known.status_code == unknown.status_code == 202 and known.json() == unknown.json()
    assert len(mail) == 1 and "#/reset?token=" in mail[0][2]
    assert client.post("/api/admin/auth/accept", json={"token": last_link_token(mail), "password": "new password 1234"}).status_code == 204
    assert client.post("/api/admin/auth/login", json={"email": "owner@example.org", "password": PASSWORD}).status_code == 401


def image_bytes(fmt="JPEG", size=(3000, 1500)):
    image = Image.new("RGB", size, (200, 30, 30))
    buffer = io.BytesIO()
    exif = Image.Exif()
    exif[0x010F] = "SecretCamera"
    image.save(buffer, fmt, exif=exif) if fmt == "JPEG" else image.save(buffer, fmt)
    return buffer.getvalue()


def test_hero_slides_are_managed_and_published(client, mail, tmp_path):
    create_admin("editor@example.org", "editor")
    sign_in(client, mail, "editor@example.org")
    seeded = client.get("/api/admin/hero", params={"language": "ko"}).json()
    assert [slide["image_url"].rsplit("/", 1)[1] for slide in seeded][0] == "main_banner_4.jpg"

    assert client.post("/api/admin/uploads/hero", files={"file": ("x.gif", b"GIF89a....", "image/gif")}).status_code == 422
    response = client.post("/api/admin/uploads/hero", files={"file": ("a.jpg", image_bytes(), "image/jpeg")})
    assert response.status_code == 201, response.text
    url = response.json()["url"]
    stored = Path(settings().media_dir) / url.removeprefix("/media/")
    with Image.open(stored) as image:
        assert image.size == (2560, 1280)
        assert not image.getexif()

    base = {"language": "ko", "image_url": url, "title": "새 소식\n두 번째 줄", "button_label": "보기"}
    for bad in ({"button_url": "javascript:alert(1)"}, {"image_url": "/archive/../etc/passwd"},
                {"image_url": "https://evil.example/x.jpg"}, {"title": "a\nb\nc\nd\ne"}):
        assert client.post("/api/admin/hero", json={**base, **bad}).status_code == 422, bad
    created = client.post("/api/admin/hero", json={**base, "button_url": "https://example.org/a?b=1"}).json()
    assert created["position"] == len(seeded) + 1

    ids = [created["id"]] + [slide["id"] for slide in seeded]
    ordered = client.post("/api/admin/hero/order", json={"language": "ko", "ids": ids}).json()
    assert [slide["id"] for slide in ordered] == ids
    assert client.post("/api/admin/hero/order", json={"language": "ko", "ids": ids[:-1]}).status_code == 409
    assert client.patch(f"/api/admin/hero/{created['id']}", json={"button_url": "javascript:alert(1)"}).status_code == 422
    client.patch(f"/api/admin/hero/{seeded[0]['id']}", json={"active": False})

    public = client.get("/api/v1/site/content").json()["hero"]["ko"]
    assert public[0] == {"image": url, "alt": "", "title": "새 소식\n두 번째 줄", "buttonLabel": "보기",
                         "buttonUrl": "https://example.org/a?b=1", "newTab": False}
    assert len(public) == len(seeded)

    replacement = client.post("/api/admin/uploads/hero", files={"file": ("b.png", image_bytes("PNG", (800, 400)), "image/png")}).json()["url"]
    assert client.patch(f"/api/admin/hero/{created['id']}", json={"image_url": replacement}).status_code == 200
    assert not stored.exists()
    assert client.delete(f"/api/admin/hero/{created['id']}").status_code == 204
    assert not (Path(settings().media_dir) / replacement.removeprefix("/media/")).exists()


PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def test_newsletters_are_registered_and_published(client, mail):
    create_admin()
    sign_in(client, mail)
    assert client.post("/api/admin/uploads/newsletter", files={"file": ("n.pdf", b"<html>", "application/pdf")}).status_code == 422
    pdf = client.post("/api/admin/uploads/newsletter", files={"file": ("n.pdf", PDF, "application/pdf")}).json()["url"]
    thumb = client.post("/api/admin/uploads/thumbnail", files={"file": ("t.jpg", image_bytes(), "image/jpeg")}).json()["url"]
    assert re.fullmatch(r"/media/newsletters/[0-9a-f]{32}\.pdf", pdf)
    assert client.post("/api/admin/newsletters", json={"title": "x", "file_url": "/media/hero/x.pdf",
                                                       "published_on": "2026-11-01"}).status_code == 422
    older = client.post("/api/admin/newsletters", json={"title": "2026년 2분기 소식지 (2026 Q2 News)", "file_url": pdf,
                                                        "published_on": "2026-06-01"}).json()
    newer = client.post("/api/admin/newsletters", json={"title": "2026년 3분기 소식지", "file_url": pdf,
                                                        "thumbnail_url": thumb, "published_on": "2026-10-01"}).json()
    hidden = client.post("/api/admin/newsletters", json={"title": "draft", "file_url": pdf,
                                                         "published_on": "2026-11-01", "active": False}).json()
    public = client.get("/api/v1/site/content").json()["newsletters"]
    assert [item["title"] for item in public] == [newer["title"], older["title"]]
    assert public[0] == {"title": "2026년 3분기 소식지", "file": pdf, "thumbnail": thumb, "kind": "pdf", "date": "2026-10-01"}
    video = client.post("/api/admin/newsletters", json={"title": "영상 소식", "file_url": "https://www.youtube.com/watch?v=abc&t=4s",
                                                        "published_on": "2020-12-01"})
    assert video.status_code == 201, video.text
    assert client.get("/api/v1/site/content").json()["newsletters"][-1]["kind"] == "link"
    for bad in ("http://example.org/x.pdf", "javascript:alert(1)", "/media/newsletters/../x.pdf"):
        assert client.patch(f"/api/admin/newsletters/{video.json()['id']}", json={"file_url": bad}).status_code == 422, bad
    assert client.delete(f"/api/admin/newsletters/{video.json()['id']}").status_code == 204

    for item in (older, hidden):
        assert client.delete(f"/api/admin/newsletters/{item['id']}").status_code == 204
    assert (Path(settings().media_dir) / pdf.removeprefix("/media/")).exists()
    assert client.patch(f"/api/admin/newsletters/{newer['id']}", json={"thumbnail_url": ""}).status_code == 200
    assert not (Path(settings().media_dir) / thumb.removeprefix("/media/")).exists()
    assert client.delete(f"/api/admin/newsletters/{newer['id']}").status_code == 204
    assert not (Path(settings().media_dir) / pdf.removeprefix("/media/")).exists()


def test_admin_content_requires_login(client):
    assert client.get("/api/admin/hero", params={"language": "ko"}).status_code == 401
    assert client.post("/api/admin/uploads/hero", files={"file": ("a.jpg", image_bytes(), "image/jpeg")}).status_code == 401
    assert client.post("/api/admin/newsletters", json={}).status_code in {401, 422}


def test_hero_seed_migration_round_trip():
    config = Config("alembic.ini")
    command.downgrade(config, "0002")
    command.upgrade(config, "head")
    with SessionLocal() as db:
        slides = db.scalars(select(HeroSlide).order_by(HeroSlide.language, HeroSlide.position)).all()
        assert [(slide.language, slide.position) for slide in slides] == [
            ("en", 1), ("en", 2), ("en", 3), ("en", 4), ("ko", 1), ("ko", 2), ("ko", 3)]
        assert slides[4].title == "한인 동포 사회를 섬기는\n러브 토론토"
        assert db.scalar(select(Newsletter)) is None


def test_archive_newsletters_are_imported_once(tmp_path):
    from app.archive_import import MANIFEST, import_archive_newsletters
    archive = tmp_path / "archive"
    (archive / "download/1").mkdir(parents=True)
    (archive / "download/1/document.pdf").write_bytes(PDF)
    (archive / "cover.jpg").write_bytes(image_bytes(size=(212, 300)))
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps([
        {"title": "2024년 06월 소식지", "published_on": "2024-06-01", "file": "download/1/document.pdf", "thumbnail": "cover.jpg"},
        {"title": "2022년 새해인사", "published_on": "2022-01-01", "link": "https://www.youtube.com/watch?v=x"},
    ]))
    with SessionLocal.begin() as db:
        assert import_archive_newsletters(db, archive, manifest) == (2, 0)
    with SessionLocal.begin() as db:
        assert import_archive_newsletters(db, archive, manifest) == (0, 2)
        items = db.scalars(select(Newsletter).order_by(Newsletter.published_on.desc())).all()
    assert [item.title for item in items] == ["2024년 06월 소식지", "2022년 새해인사"]
    assert (Path(settings().media_dir) / items[0].file_url.removeprefix("/media/")).read_bytes() == PDF
    assert re.fullmatch(r"/media/thumbs/[0-9a-f]{32}\.jpg", items[0].thumbnail_url)
    assert items[1].file_url == "https://www.youtube.com/watch?v=x" and items[1].thumbnail_url == ""

    escape = tmp_path / "escape.json"
    escape.write_text(json.dumps([{"title": "x", "published_on": "2020-01-01", "file": "../manifest.json"}]))
    with pytest.raises(FileNotFoundError), SessionLocal.begin() as db:
        import_archive_newsletters(db, archive, escape)

    entries = json.loads(MANIFEST.read_text())
    assert len(entries) == 27 and len({entry["title"] for entry in entries}) == 27
    assert sum("link" in entry for entry in entries) == 2

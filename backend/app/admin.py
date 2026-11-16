import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, EmailStr, Field, ValidationError, field_validator
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from . import media
from .db import session
from .geo import gate
from .mailer import send_text
from .models import AdminChallenge, AdminSession, AdminToken, AdminUser, HeroSlide, Newsletter
from .security import digest, hash_password, new_code, new_token, password_problem, verify_password
from .settings import settings

logger = logging.getLogger("app.admin")
COOKIE = "__Host-lt_admin"
CSRF_HEADER = "lt-admin"
SESSION_ABSOLUTE = timedelta(hours=12)
SESSION_IDLE = timedelta(hours=2)
CODE_TTL = timedelta(minutes=10)
CODE_ATTEMPTS = 5
CODES_PER_WINDOW = 5
LOCK_AFTER = 5
LOCK_FOR = timedelta(minutes=15)
LINK_TTL = {"invite": timedelta(hours=72), "reset": timedelta(hours=1)}
ROLES = Literal["owner", "editor"]
DB = Annotated[Session, Depends(session)]


def now() -> datetime:
    return datetime.now(timezone.utc)


def client_ip(request: Request) -> str:
    return request.headers.get("x-real-ip", "")


def require_area(request: Request):
    allowed, reason = gate().check(client_ip(request))
    if not allowed:
        logger.warning("Admin access denied for %s: %s", client_ip(request), reason)
        raise HTTPException(403, "관리자 사이트는 토론토 지역에서만 접속할 수 있습니다.")


def require_same_origin(request: Request):
    if request.method in {"GET", "HEAD", "OPTIONS"} or request.url.path == "/api/admin/gate":
        return
    # Custom headers cannot be sent cross-origin without a CORS preflight, which this API never grants.
    if request.headers.get("x-requested-with") != CSRF_HEADER:
        raise HTTPException(403, "Missing CSRF header")
    origin = request.headers.get("origin")
    if origin and origin != f"https://{request.headers.get('host', '')}":
        raise HTTPException(403, "Cross-origin request rejected")


router = APIRouter(prefix="/api/admin", dependencies=[Depends(require_area), Depends(require_same_origin)])


@router.api_route("/gate", methods=["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"], status_code=204)
def area_gate():
    """nginx auth_request target for every request on the admin port."""
    return Response(status_code=204)


# ---------------------------------------------------------------- sessions

def current_user(request: Request, db: DB) -> AdminUser:
    token = request.cookies.get(COOKIE)
    record = db.get(AdminSession, digest(token)) if token else None
    current = now()
    if not record or record.expires_at <= current or record.last_seen_at + SESSION_IDLE <= current:
        if record:
            db.delete(record)
            db.commit()
        raise HTTPException(401, "로그인이 필요합니다.")
    user = db.get(AdminUser, record.user_id)
    if not user or not user.active:
        raise HTTPException(401, "로그인이 필요합니다.")
    if current - record.last_seen_at > timedelta(minutes=1):
        record.last_seen_at = current
        db.commit()
    return user


User = Annotated[AdminUser, Depends(current_user)]


def require_owner(user: User) -> AdminUser:
    if user.role != "owner":
        raise HTTPException(403, "Owner 권한이 필요합니다.")
    return user


Owner = Annotated[AdminUser, Depends(require_owner)]


class Me(BaseModel):
    id: UUID
    email: str
    name: str
    role: str
    active: bool
    has_password: bool
    last_login_at: datetime | None
    created_at: datetime


def me(user: AdminUser) -> Me:
    return Me(id=user.id, email=user.email, name=user.name, role=user.role, active=user.active,
              has_password=user.password_hash is not None, last_login_at=user.last_login_at,
              created_at=user.created_at)


# ---------------------------------------------------------------- email

def deliver(to: str, subject: str, body: str):
    try:
        send_text(to, subject, body, settings())
    except Exception as error:
        logger.error("Admin email to %s failed: %s", to, type(error).__name__)
        raise HTTPException(503, "메일을 보내지 못했습니다. SMTP 설정을 확인한 뒤 다시 시도하십시오.") from None


def issue_link(db: Session, user: AdminUser, purpose: Literal["invite", "reset"]) -> str:
    db.execute(delete(AdminToken).where(AdminToken.user_id == user.id, AdminToken.used_at.is_(None)))
    token = new_token()
    db.add(AdminToken(token_hash=digest(token), user_id=user.id, purpose=purpose,
                      expires_at=now() + LINK_TTL[purpose]))
    return f"{settings().admin_base_url}/#/{'accept' if purpose == 'invite' else 'reset'}?token={token}"


def send_link(db: Session, user: AdminUser, purpose: Literal["invite", "reset"]):
    """Issue the link and send it; the caller commits only after the mail was accepted."""
    link = issue_link(db, user, purpose)
    hours = int(LINK_TTL[purpose].total_seconds() // 3600)
    if purpose == "invite":
        subject = "[Love Toronto] 관리자 계정 초대 / Admin account invitation"
        body = (f"Love Toronto 홈페이지 관리자({user.role}) 계정이 만들어졌습니다.\n"
                f"아래 링크에서 비밀번호를 설정하십시오 ({hours}시간 동안 유효, 1회용).\n\n{link}\n\n"
                "로그인할 때마다 이 이메일로 인증 코드가 발송됩니다(2단계 인증).\n"
                "관리자 사이트는 토론토 지역에서만 접속할 수 있습니다.\n"
                "본인이 요청하지 않았다면 이 메일을 무시하십시오.\n")
    else:
        subject = "[Love Toronto] 관리자 비밀번호 재설정 / Password reset"
        body = (f"관리자 비밀번호 재설정 링크입니다 ({hours}시간 동안 유효, 1회용).\n\n{link}\n\n"
                "본인이 요청하지 않았다면 이 메일을 무시하십시오. 비밀번호는 바뀌지 않습니다.\n")
    deliver(user.email, subject, body)


# ---------------------------------------------------------------- auth

class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(max_length=200)


class VerifyRequest(BaseModel):
    challenge_id: UUID
    code: str = Field(pattern=r"^\d{6}$")


class TokenRequest(BaseModel):
    token: str = Field(min_length=20, max_length=100)


class AcceptRequest(TokenRequest):
    password: str = Field(max_length=200)


class ForgotRequest(BaseModel):
    email: EmailStr


INVALID_LOGIN = "이메일 또는 비밀번호가 올바르지 않습니다."


@router.post("/auth/login")
def login(payload: LoginRequest, request: Request, db: DB):
    user = db.scalar(select(AdminUser).where(AdminUser.email == payload.email.lower()).with_for_update())
    valid = verify_password(payload.password, user.password_hash if user else None)
    if not user or not user.active:
        raise HTTPException(401, INVALID_LOGIN)
    if user.locked_until and user.locked_until > now():
        raise HTTPException(429, "로그인 시도가 너무 많습니다. 15분 후 다시 시도하십시오.")
    if not valid:
        user.failed_logins += 1
        if user.failed_logins >= LOCK_AFTER:
            user.failed_logins = 0
            user.locked_until = now() + LOCK_FOR
            logger.warning("Admin %s locked after repeated failures from %s", user.email, client_ip(request))
        db.commit()
        raise HTTPException(401, INVALID_LOGIN)
    recent = db.scalar(select(func.count()).select_from(AdminChallenge).where(
        AdminChallenge.user_id == user.id, AdminChallenge.created_at > now() - LOCK_FOR))
    if recent >= CODES_PER_WINDOW:
        raise HTTPException(429, "인증 코드 요청이 너무 많습니다. 15분 후 다시 시도하십시오.")
    user.failed_logins = 0
    user.locked_until = None
    code = new_code()
    challenge = AdminChallenge(user_id=user.id, code_hash="", attempts=0, expires_at=now() + CODE_TTL)
    db.add(challenge)
    db.flush()
    challenge.code_hash = digest(f"{challenge.id}:{code}")
    db.execute(update(AdminChallenge).where(AdminChallenge.user_id == user.id, AdminChallenge.id != challenge.id,
                                           AdminChallenge.used_at.is_(None)).values(used_at=now()))
    deliver(user.email, f"[Love Toronto] 관리자 로그인 인증 코드 / Login code",
            f"관리자 로그인 인증 코드: {code}\n\n10분 동안 유효합니다. 접속 IP: {client_ip(request)}\n"
            "본인이 로그인하지 않았다면 즉시 비밀번호를 바꾸십시오.\n")
    db.commit()
    return {"challenge_id": str(challenge.id), "expires_in": int(CODE_TTL.total_seconds())}


@router.post("/auth/verify")
def verify(payload: VerifyRequest, request: Request, response: Response, db: DB):
    challenge = db.get(AdminChallenge, payload.challenge_id, with_for_update=True)
    if not challenge or challenge.used_at or challenge.expires_at <= now() or challenge.attempts >= CODE_ATTEMPTS:
        raise HTTPException(401, "인증 코드가 만료되었습니다. 다시 로그인하십시오.")
    challenge.attempts += 1
    if digest(f"{challenge.id}:{payload.code}") != challenge.code_hash:
        db.commit()
        left = CODE_ATTEMPTS - challenge.attempts
        raise HTTPException(401, f"인증 코드가 올바르지 않습니다. (남은 시도 {left}회)" if left else
                            "인증 코드가 만료되었습니다. 다시 로그인하십시오.")
    user = db.get(AdminUser, challenge.user_id)
    if not user or not user.active:
        raise HTTPException(401, INVALID_LOGIN)
    challenge.used_at = now()
    token = new_token()
    db.add(AdminSession(token_hash=digest(token), user_id=user.id, expires_at=now() + SESSION_ABSOLUTE,
                        ip=client_ip(request)[:45]))
    user.last_login_at = now()
    db.execute(delete(AdminSession).where(AdminSession.expires_at <= now()))
    db.commit()
    response.set_cookie(COOKIE, token, max_age=int(SESSION_ABSOLUTE.total_seconds()), path="/",
                        secure=True, httponly=True, samesite="strict")
    logger.info("Admin %s signed in from %s", user.email, client_ip(request))
    return me(user)


@router.post("/auth/logout", status_code=204)
def logout(request: Request, response: Response, db: DB):
    token = request.cookies.get(COOKIE)
    if token:
        db.execute(delete(AdminSession).where(AdminSession.token_hash == digest(token)))
        db.commit()
    response.delete_cookie(COOKIE, path="/", secure=True, httponly=True, samesite="strict")
    response.status_code = 204
    return response


def usable_token(db: Session, token: str) -> tuple[AdminToken, AdminUser]:
    record = db.get(AdminToken, digest(token), with_for_update=True)
    user = db.get(AdminUser, record.user_id) if record else None
    if not record or record.used_at or record.expires_at <= now() or not user or not user.active:
        raise HTTPException(410, "링크가 만료되었거나 이미 사용되었습니다. 관리자에게 새 링크를 요청하십시오.")
    return record, user


@router.post("/auth/link-info")
def link_info(payload: TokenRequest, db: DB):
    record, user = usable_token(db, payload.token)
    return {"email": user.email, "purpose": record.purpose}


@router.post("/auth/accept", status_code=204)
def accept(payload: AcceptRequest, db: DB):
    record, user = usable_token(db, payload.token)
    if problem := password_problem(payload.password, user.email):
        raise HTTPException(422, problem)
    record.used_at = now()
    user.password_hash = hash_password(payload.password)
    user.failed_logins = 0
    user.locked_until = None
    db.execute(delete(AdminSession).where(AdminSession.user_id == user.id))
    db.commit()
    logger.info("Admin %s set a password via %s link", user.email, record.purpose)


@router.post("/auth/forgot", status_code=202)
def forgot(payload: ForgotRequest, db: DB):
    user = db.scalar(select(AdminUser).where(AdminUser.email == payload.email.lower()))
    if user and user.active:
        try:
            send_link(db, user, "invite" if user.password_hash is None else "reset")
            db.commit()
        except HTTPException:
            db.rollback()
    return {"detail": "등록된 계정이면 재설정 링크를 보냈습니다."}


# ---------------------------------------------------------------- own account

class MeUpdate(BaseModel):
    name: str = Field(max_length=100)


class PasswordChange(BaseModel):
    current_password: str = Field(max_length=200)
    new_password: str = Field(max_length=200)


@router.get("/me")
def get_me(user: User):
    return me(user)


@router.patch("/me")
def update_me(payload: MeUpdate, user: User, db: DB):
    user.name = payload.name.strip()
    db.commit()
    return me(user)


@router.post("/me/password", status_code=204)
def change_password(payload: PasswordChange, request: Request, user: User, db: DB):
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(422, "현재 비밀번호가 올바르지 않습니다.")
    if problem := password_problem(payload.new_password, user.email):
        raise HTTPException(422, problem)
    user.password_hash = hash_password(payload.new_password)
    current = digest(request.cookies.get(COOKIE, ""))
    db.execute(delete(AdminSession).where(AdminSession.user_id == user.id, AdminSession.token_hash != current))
    db.commit()


# ---------------------------------------------------------------- account management (owner)

class UserCreate(BaseModel):
    email: EmailStr
    name: str = Field(default="", max_length=100)
    role: ROLES = "editor"


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    role: ROLES | None = None
    active: bool | None = None


@router.get("/users")
def list_users(_: Owner, db: DB):
    return [me(user) for user in db.scalars(select(AdminUser).order_by(AdminUser.created_at))]


@router.post("/users", status_code=201)
def create_user(payload: UserCreate, owner: Owner, db: DB):
    email = payload.email.lower()
    if db.scalar(select(AdminUser).where(AdminUser.email == email)):
        raise HTTPException(409, "이미 등록된 이메일입니다.")
    user = AdminUser(email=email, name=payload.name.strip(), role=payload.role, active=True, failed_logins=0)
    db.add(user)
    db.flush()
    send_link(db, user, "invite")
    db.commit()
    logger.info("Admin %s invited %s as %s", owner.email, email, payload.role)
    return me(user)


@router.patch("/users/{user_id}")
def update_user(user_id: UUID, payload: UserUpdate, owner: Owner, db: DB):
    user = db.get(AdminUser, user_id, with_for_update=True)
    if not user:
        raise HTTPException(404, "계정을 찾을 수 없습니다.")
    if user.id == owner.id and ((payload.role and payload.role != user.role) or payload.active is False):
        raise HTTPException(422, "자기 계정의 권한 변경이나 비활성화는 할 수 없습니다.")
    if payload.name is not None:
        user.name = payload.name.strip()
    if payload.role is not None:
        user.role = payload.role
    if payload.active is not None:
        user.active = payload.active
    db.flush()
    owners = db.scalar(select(func.count()).select_from(AdminUser).where(
        AdminUser.role == "owner", AdminUser.active.is_(True)))
    if owners == 0:
        raise HTTPException(422, "활성 Owner 가 최소 한 명은 있어야 합니다.")
    if not user.active:
        db.execute(delete(AdminSession).where(AdminSession.user_id == user.id))
    db.commit()
    logger.info("Admin %s updated %s: %s", owner.email, user.email, payload.model_dump(exclude_none=True))
    return me(user)


@router.post("/users/{user_id}/send-link", status_code=202)
def resend_link(user_id: UUID, _: Owner, db: DB):
    user = db.get(AdminUser, user_id)
    if not user or not user.active:
        raise HTTPException(404, "활성 계정이 아닙니다.")
    purpose = "invite" if user.password_hash is None else "reset"
    send_link(db, user, purpose)
    db.commit()
    return {"purpose": purpose}


# ---------------------------------------------------------------- content

SAFE_URL_CHARS = r"[A-Za-z0-9._~%/()+,=&?#:;@!$*'-]"
ARCHIVE_URL = re.compile(r"^/archive/[A-Za-z0-9._~%/()+,-]+$")
LINK_URL = re.compile(rf"^(https?://[A-Za-z0-9.-]+(:\d+)?(/{SAFE_URL_CHARS}*)?|#/page\?{SAFE_URL_CHARS}+)$")


def check_text(value: str, lines: int = 1) -> str:
    value = value.replace("\r\n", "\n").strip()
    if any(ord(char) < 32 and char != "\n" for char in value) or value.count("\n") >= lines:
        raise ValueError("허용되지 않는 문자나 줄바꿈이 있습니다.")
    return value


def check_archive(value: str) -> bool:
    return bool(ARCHIVE_URL.fullmatch(value)) and ".." not in value.split("/")


def check_image(value: str) -> str:
    if value.startswith("/media/"):
        if not re.fullmatch(r"/media/hero/[0-9a-f]{32}\.(jpg|png)", value):
            raise ValueError("업로드한 hero 이미지가 아닙니다.")
    elif not check_archive(value):
        raise ValueError("이미지 주소가 올바르지 않습니다.")
    return value


class SlideFields(BaseModel):
    image_url: str = Field(max_length=500)
    alt: str = Field(default="", max_length=200)
    title: str = Field(default="", max_length=300)
    button_label: str = Field(default="", max_length=100)
    button_url: str = Field(default="", max_length=500)
    new_tab: bool = False
    active: bool = True

    validate_image = field_validator("image_url")(check_image)
    validate_short_text = field_validator("alt", "button_label")(lambda value: check_text(value))
    validate_title = field_validator("title")(lambda value: check_text(value, lines=4))

    @field_validator("button_url")
    @classmethod
    def link(cls, value: str) -> str:
        value = value.strip()
        if value and not LINK_URL.fullmatch(value):
            raise ValueError("링크는 https:// 주소 또는 #/page?file=... 형식이어야 합니다.")
        return value


class SlideCreate(SlideFields):
    language: Literal["ko", "en"]


class SlideUpdate(BaseModel):
    image_url: str | None = Field(default=None, max_length=500)
    alt: str | None = Field(default=None, max_length=200)
    title: str | None = Field(default=None, max_length=300)
    button_label: str | None = Field(default=None, max_length=100)
    button_url: str | None = Field(default=None, max_length=500)
    new_tab: bool | None = None
    active: bool | None = None


class SlideOrder(BaseModel):
    language: Literal["ko", "en"]
    ids: list[int] = Field(max_length=50)


def merged(model: type[BaseModel], current: dict, changes: BaseModel) -> BaseModel:
    """Validate a partial update against the full model, answering 422 like request validation."""
    try:
        return model.model_validate({**current, **changes.model_dump(exclude_unset=True)})
    except ValidationError as error:
        raise RequestValidationError(error.errors(include_url=False, include_context=False)) from None


def slide_json(slide: HeroSlide) -> dict:
    return {key: getattr(slide, key) for key in (
        "id", "language", "position", "image_url", "alt", "title", "button_label", "button_url",
        "new_tab", "active", "updated_at")}


def release(db: Session, *urls: str):
    """Delete uploaded files no longer referenced by any slide or newsletter."""
    for url in urls:
        path = media.media_path(url or "")
        if not path:
            continue
        used = db.scalar(select(func.count()).select_from(HeroSlide).where(HeroSlide.image_url == url)) + \
            db.scalar(select(func.count()).select_from(Newsletter).where(
                or_(Newsletter.file_url == url, Newsletter.thumbnail_url == url)))
        if not used:
            path.unlink(missing_ok=True)


@router.get("/hero")
def list_slides(_: User, db: DB, language: Literal["ko", "en"]):
    return [slide_json(slide) for slide in db.scalars(
        select(HeroSlide).where(HeroSlide.language == language).order_by(HeroSlide.position, HeroSlide.id))]


@router.post("/hero", status_code=201)
def create_slide(payload: SlideCreate, user: User, db: DB):
    last = db.scalar(select(func.max(HeroSlide.position)).where(HeroSlide.language == payload.language)) or 0
    slide = HeroSlide(**payload.model_dump(), position=last + 1)
    db.add(slide)
    db.commit()
    logger.info("Admin %s added %s hero slide %s", user.email, slide.language, slide.id)
    return slide_json(slide)


@router.patch("/hero/{slide_id}")
def update_slide(slide_id: int, payload: SlideUpdate, user: User, db: DB):
    slide = db.get(HeroSlide, slide_id, with_for_update=True)
    if not slide:
        raise HTTPException(404, "슬라이드를 찾을 수 없습니다.")
    previous = slide.image_url
    values = merged(SlideFields, slide_json(slide), payload)
    for key, value in values.model_dump().items():
        setattr(slide, key, value)
    db.commit()
    if previous != slide.image_url:
        release(db, previous)
    logger.info("Admin %s updated hero slide %s", user.email, slide.id)
    return slide_json(slide)


@router.delete("/hero/{slide_id}", status_code=204)
def delete_slide(slide_id: int, user: User, db: DB):
    slide = db.get(HeroSlide, slide_id)
    if not slide:
        raise HTTPException(404, "슬라이드를 찾을 수 없습니다.")
    db.delete(slide)
    db.commit()
    release(db, slide.image_url)
    logger.info("Admin %s deleted hero slide %s", user.email, slide_id)


@router.post("/hero/order")
def order_slides(payload: SlideOrder, _: User, db: DB):
    slides = {slide.id: slide for slide in db.scalars(
        select(HeroSlide).where(HeroSlide.language == payload.language).with_for_update())}
    if sorted(payload.ids) != sorted(slides):
        raise HTTPException(409, "슬라이드 목록이 바뀌었습니다. 새로고침 후 다시 시도하십시오.")
    for position, slide_id in enumerate(payload.ids, start=1):
        slides[slide_id].position = position
    db.commit()
    return list_slides(_, db, payload.language)


class NewsletterFields(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    file_url: str = Field(max_length=500)
    thumbnail_url: str = Field(default="", max_length=500)
    published_on: date
    active: bool = True

    validate_title = field_validator("title")(lambda value: check_text(value))

    @field_validator("file_url")
    @classmethod
    def pdf_or_link(cls, value: str) -> str:
        value = value.strip()
        if not (re.fullmatch(r"/media/newsletters/[0-9a-f]{32}\.pdf", value) or
                (check_archive(value) and value.lower().endswith(".pdf")) or
                (value.startswith("https://") and LINK_URL.fullmatch(value))):
            raise ValueError("업로드한 PDF 파일 또는 https:// 링크를 지정하십시오.")
        return value

    @field_validator("thumbnail_url")
    @classmethod
    def thumbnail(cls, value: str) -> str:
        if value and not re.fullmatch(r"/media/thumbs/[0-9a-f]{32}\.(jpg|png)", value):
            raise ValueError("업로드한 썸네일 이미지가 아닙니다.")
        return value


class NewsletterUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=300)
    file_url: str | None = Field(default=None, max_length=500)
    thumbnail_url: str | None = Field(default=None, max_length=500)
    published_on: date | None = None
    active: bool | None = None


def newsletter_json(item: Newsletter) -> dict:
    return {key: getattr(item, key) for key in (
        "id", "title", "file_url", "thumbnail_url", "published_on", "active", "created_at", "updated_at")}


@router.get("/newsletters")
def list_newsletters(_: User, db: DB):
    return [newsletter_json(item) for item in db.scalars(
        select(Newsletter).order_by(Newsletter.published_on.desc(), Newsletter.id.desc()))]


@router.post("/newsletters", status_code=201)
def create_newsletter(payload: NewsletterFields, user: User, db: DB):
    item = Newsletter(**payload.model_dump())
    db.add(item)
    db.commit()
    logger.info("Admin %s registered newsletter %s", user.email, item.id)
    return newsletter_json(item)


@router.patch("/newsletters/{item_id}")
def update_newsletter(item_id: int, payload: NewsletterUpdate, user: User, db: DB):
    item = db.get(Newsletter, item_id, with_for_update=True)
    if not item:
        raise HTTPException(404, "소식지를 찾을 수 없습니다.")
    previous = (item.file_url, item.thumbnail_url)
    values = merged(NewsletterFields, newsletter_json(item), payload)
    for key, value in values.model_dump().items():
        setattr(item, key, value)
    db.commit()
    release(db, *(url for url in previous if url not in {item.file_url, item.thumbnail_url}))
    logger.info("Admin %s updated newsletter %s", user.email, item.id)
    return newsletter_json(item)


@router.delete("/newsletters/{item_id}", status_code=204)
def delete_newsletter(item_id: int, user: User, db: DB):
    item = db.get(Newsletter, item_id)
    if not item:
        raise HTTPException(404, "소식지를 찾을 수 없습니다.")
    db.delete(item)
    db.commit()
    release(db, item.file_url, item.thumbnail_url)
    logger.info("Admin %s deleted newsletter %s", user.email, item_id)


@router.post("/uploads/{kind}", status_code=201)
def upload(kind: Literal["hero", "thumbnail", "newsletter"], _: User, file: Annotated[UploadFile, File()]):
    return {"url": media.save_upload(kind, file)}

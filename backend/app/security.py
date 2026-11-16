import base64
import hashlib
import hmac
import secrets

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**15, 8, 1
PASSWORD_MIN, PASSWORD_MAX = 12, 128


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=128 * 1024 * 1024, dklen=32)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = _scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    encode = lambda value: base64.b64encode(value).decode()
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${encode(salt)}${encode(digest)}"


DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def verify_password(password: str, stored: str | None) -> bool:
    """Always performs one scrypt computation so unknown accounts take as long as known ones."""
    try:
        _, n, r, p, salt, digest = (stored or DUMMY_HASH).split("$")
        actual = _scrypt(password, base64.b64decode(salt), int(n), int(r), int(p))
    except (ValueError, TypeError):
        return False
    return stored is not None and hmac.compare_digest(actual, base64.b64decode(digest))


def password_problem(password: str, email: str) -> str | None:
    if not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
        return f"비밀번호는 {PASSWORD_MIN}~{PASSWORD_MAX}자여야 합니다."
    if password.strip().lower() == email.lower() or len(set(password)) < 5:
        return "추측하기 쉬운 비밀번호는 사용할 수 없습니다."
    return None


def new_token() -> str:
    return secrets.token_urlsafe(32)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"

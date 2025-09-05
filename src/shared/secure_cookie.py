# 📁 shared/secure_cookie.py
# 🕒 Last updated: 2025-07-05 15:25
# =============================================================================
# 1️⃣  Session cookie  (HttpOnly, AES-GCM + HMAC, SameSite=Lax/Strict)
# 2️⃣  CSRF cookie     (plaintext random, *KHÔNG* HttpOnly để JS đọc được)
# -----------------------------------------------------------------------------
# • Session:  “double submit cookie” pattern yêu cầu Keep cookie quét token
#   trong JS, nên CSRF cookie phải *không* HttpOnly. Token ký hay không ký
#   tuỳ bạn; ở đây để đơn giản chỉ dùng secrets.token_urlsafe().
# • Cả hai cookie đều đặt Secure + SameSite=Strict (khi chạy HTTPS) để giảm
#   rủi ro CSRF trên GET. Với OAuth cần mở SameSite=Lax cho *session cookie*
#   – tham số đã có sẵn.
# =============================================================================

from __future__ import annotations
import base64
import hashlib
import secrets
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken
from itsdangerous import BadSignature, BadTimeSignature, URLSafeTimedSerializer
from litestar import Request
from litestar.response import Response

from config import (
    SECRET_KEY,        # chuỗi bí mật (32–64 bytes)
    COOKIE_NAME,       # tên session cookie, ví dụ "session"
    COOKIE_SALT,       # salt cho signature, ví dụ "cookie-signature"
    COOKIE_MAX_AGE,    # thời gian sống cookie (giây)
)

# ──────────────────────────────────────────────────────────────────────────────
# 1.  Session helpers  (đã có từ trước)
# ──────────────────────────────────────────────────────────────────────────────
_serializer: URLSafeTimedSerializer | None = None
_fernet: Fernet | None = None


def _get_serializer() -> URLSafeTimedSerializer:
    global _serializer
    if _serializer is None:
        _serializer = URLSafeTimedSerializer(
            SECRET_KEY,
            salt=COOKIE_SALT,
            serializer=None,
        )
    return _serializer


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        key_bytes = hashlib.sha256(f"{SECRET_KEY}::fernet".encode()).digest()
        _fernet = Fernet(base64.urlsafe_b64encode(key_bytes))
    return _fernet


def set_secure_cookie(
    resp: Response,
    uid: str,
    *,
    max_age: int | None = None,
    secure: bool = True,
    samesite: str = "Lax",   # ⚠️ “Lax” hỗ trợ OAuth redirect
) -> None:
    """Đặt **session cookie** an toàn (HttpOnly)."""
    f = _get_fernet()
    s = _get_serializer()

    encrypted = f.encrypt(uid.encode()).decode()
    signed = s.dumps(encrypted)

    resp.set_cookie(
        COOKIE_NAME,
        signed,
        max_age=max_age or COOKIE_MAX_AGE,
        httponly=True,
        secure=secure,
        samesite=samesite,
        path="/",
    )


def get_secure_cookie(req: Request, *, silent: bool = True) -> Optional[str]:
    """Giải mã & xác thực session cookie → trả về UID hoặc None."""
    signed = req.cookies.get(COOKIE_NAME)
    if not signed:
        return None

    s = _get_serializer()
    f = _get_fernet()
    try:
        encrypted = s.loads(signed, max_age=COOKIE_MAX_AGE)
        return f.decrypt(encrypted.encode()).decode()
    except (BadSignature, BadTimeSignature, InvalidToken):
        if silent:
            return None
        raise


def delete_secure_cookie(resp: Response) -> None:
    """Xoá session cookie."""
    resp.delete_cookie(COOKIE_NAME, path="/")


# ──────────────────────────────────────────────────────────────────────────────
# 2.  CSRF helpers  (mới ✨)
# ──────────────────────────────────────────────────────────────────────────────
CSRF_COOKIE_NAME = "csrftoken"
CSRF_MAX_AGE     = 60 * 60 * 8          # 8 giờ – tuỳ chỉnh nếu cần


def generate_csrf_token() -> str:
    """Sinh token ngẫu nhiên URL-safe (32 bytes ≈ 43 chars)."""
    return secrets.token_urlsafe(32)


def set_csrf_cookie(
    resp: Response,
    token: str,
    *,
    max_age: int | None = None,
    secure: bool = True,
) -> None:
    """
    Đặt cookie CSRF:
    • KHÔNG HttpOnly → JS đọc & gửi header X-CSRFToken.
    • SameSite=Strict để browser không gửi khi request xuất phát từ trang khác.
    """
    resp.set_cookie(
        CSRF_COOKIE_NAME,
        token,
        max_age=max_age or CSRF_MAX_AGE,
        httponly=False,       # JS cần đọc cookie
        secure=secure,
        samesite="Strict",
        path="/",
    )


def get_csrf_cookie(req: Request) -> Optional[str]:
    """Lấy token CSRF (nếu có)."""
    return req.cookies.get(CSRF_COOKIE_NAME)

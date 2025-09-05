# 1. Đường dẫn file: src/modules/auth/routes/auth_google.py
# 2. Thời gian sửa: 2025-07-22 15:20
# 3. Lý do sửa: Bổ sung cập-nhật user_display_name cho tài khoản đã tồn tại
# =============================================================================
# Google OAuth
# ----------------------------------------------------------------------------- 
# • Tôn trọng SystemSettings (system_login, system_register, system_domain_mode)
# • Sau callback: ghi IP & timezone, set secure_cookie + csrftoken.
# • Trả 404 (error/404_error.html) khi vi phạm domain hoặc tài khoản bị khóa …
# =============================================================================

from __future__ import annotations

import uuid
from urllib.parse import urlencode

import httpx
from litestar import get, Request
from litestar.response import Redirect, Template
from sqlalchemy import select

from config import GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
from core.db.engine import SessionLocal
from core.db.models import User, UserSettings, SystemSettings
from shared.request_helpers import client_ip, client_tz
from shared.secure_cookie import (
    set_secure_cookie,
    generate_csrf_token,
    set_csrf_cookie,
)

# Google endpoints & scopes
_AUTH_BASE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL     = "https://oauth2.googleapis.com/token"
_USERINFO_URL  = "https://www.googleapis.com/oauth2/v3/userinfo"
_SCOPES        = ["openid", "email", "profile"]

# ─────────────────────────────── Helpers ────────────────────────────────────
def _is_domain_allowed(email: str, mode: str) -> bool:
    email = email.lower()
    if mode == "none":
        return True
    if mode == "tvu":
        return email.endswith("@tvu.edu.vn")
    if mode == "tvu_and_sttvu":
        return email.endswith("@tvu.edu.vn") or email.endswith("@st.tvu.edu.vn")
    return True

def _deny() -> Template:
    """Trả trang 404 độc lập khi không được phép."""
    return Template("error/404_error.html", status_code=404)

def _is_oauth_login_enabled() -> bool:
    with SessionLocal() as db:
        sys = db.query(SystemSettings).first()
        return bool(sys and sys.system_login)

# ─────────────────────────────── OAuth start ────────────────────────────────
@get("/auth/oauth/google")
def google_oauth() -> Redirect | Template:
    if not _is_oauth_login_enabled():
        return _deny()

    params = {
        "client_id":     GOOGLE_CLIENT_ID,
        "redirect_uri":  GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope":         " ".join(_SCOPES),
        "access_type":   "offline",
        "prompt":        "select_account",
    }
    return Redirect(f"{_AUTH_BASE_URL}?{urlencode(params)}", status_code=302)

# ─────────────────────────────── Callback ───────────────────────────────────
@get("/auth/oauth/google/callback")
async def google_oauth_callback(request: Request) -> Redirect | Template:
    if not _is_oauth_login_enabled():
        return _deny()

    code = request.query_params.get("code")
    if not code:
        return Redirect("/auth/login?err=google_oauth", status_code=302)

    with SessionLocal() as db:
        sys: SystemSettings | None = db.query(SystemSettings).first()
        domain_mode      = sys.system_domain_mode if sys else "none"
        register_allowed = bool(sys is None or sys.system_register)

    # ─────── Exchange code → token → userinfo ───────
    try:
        async with httpx.AsyncClient() as client:
            token_json = (
                await client.post(
                    _TOKEN_URL,
                    data={
                        "code":          code,
                        "client_id":     GOOGLE_CLIENT_ID,
                        "client_secret": GOOGLE_CLIENT_SECRET,
                        "redirect_uri":  GOOGLE_REDIRECT_URI,
                        "grant_type":    "authorization_code",
                    },
                    headers={"Accept": "application/json"},
                    timeout=10,
                )
            ).json()
            access_token = token_json.get("access_token")

            info = (
                await client.get(
                    _USERINFO_URL,
                    headers={"Authorization": f"Bearer {access_token}"},
                    timeout=10,
                )
            ).json()
    except httpx.HTTPError as exc:
        request.app.logger.error("Google OAuth error: %s", exc)
        return Redirect("/auth/login?err=google_oauth", status_code=302)

    # ─────── Extract fields ───────
    email          = info.get("email", "").lower()
    sub            = info.get("sub")
    display_name   = info.get("name")
    avatar_url     = info.get("picture")
    email_verified = info.get("email_verified", False)
    if not sub or not email:
        return Redirect("/auth/login?err=google_oauth", status_code=302)

    # ─────── Domain check ───────
    if not _is_domain_allowed(email, domain_mode):
        return _deny()

    ip_addr  = client_ip(request)
    timezone = client_tz(request)

    # ─────── Upsert user ───────
    with SessionLocal() as db:
        user: User | None = db.scalars(
            select(User).where(
                User.user_oauth_provider == "google",
                User.user_oauth_sub      == sub,
            )
        ).first()

        # Liên kết tài khoản email có sẵn
        if not user:
            user = db.scalars(select(User).where(User.user_email == email)).first()
            if user:
                user.user_oauth_provider = "google"
                user.user_oauth_sub      = sub
                user.user_email_verified = user.user_email_verified or email_verified

        # Tạo mới
        if not user:
            if not register_allowed:
                return _deny()

            user = User(
                user_id             = str(uuid.uuid4()),
                user_display_name   = display_name,
                user_email          = email,
                user_password_hash  = "",
                user_role           = "user",
                user_status         = "active",
                user_oauth_provider = "google",
                user_oauth_sub      = sub,
                user_email_verified = email_verified,
                user_register_ip    = ip_addr,
            )
            db.add(user)
            db.add(
                UserSettings(
                    setting_user_id         = user.user_id,
                    setting_user_avatar_url = avatar_url,
                    setting_theme           = "system",
                    setting_timezone        = timezone,
                )
            )
        # Đã tồn tại
        else:
            if ip_addr:
                user.user_register_ip = ip_addr
            # ✨ NEW: cập-nhật display name nếu thay đổi / chưa có
            if display_name and display_name != user.user_display_name:
                user.user_display_name = display_name
            if not user.settings:
                db.add(
                    UserSettings(
                        setting_user_id         = user.user_id,
                        setting_user_avatar_url = avatar_url,
                        setting_theme           = "system",
                        setting_timezone        = timezone,
                    )
                )
            else:
                if timezone:
                    user.settings.setting_timezone = timezone
                if avatar_url:
                    user.settings.setting_user_avatar_url = avatar_url

        db.commit()
        db.refresh(user)

        # ❗ Tài khoản bị khoá → chặn
        if user.user_status != "active":
            return _deny()

    # ─────── Set cookies & redirect ───────
    resp        = Redirect("/", status_code=302)
    secure_flag = request.url.scheme == "https"
    set_secure_cookie(resp, user.user_id, secure=secure_flag)

    csrf_token = generate_csrf_token()
    set_csrf_cookie(resp, csrf_token, secure=secure_flag)

    return resp

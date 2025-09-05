# 📁 src/modules/auth/routes/auth_microsoft.py
# 🕒 Last updated: 2025-07-08 23:58
# =============================================================================
# Microsoft OAuth
# -----------------------------------------------------------------------------
# • Tôn trọng SystemSettings:
#     – system_login     : FALSE → toàn bộ Microsoft OAuth bị tắt
#     – system_register  : FALSE → chỉ cho tài khoản đã tồn tại
#     – system_domain_mode: kiểm domain email
# • Sau callback: update IP / TZ / avatar, set secure_cookie + csrftoken.
# • Vi phạm domain hoặc đăng ký bị khóa → trả 404 (error/404_error.html).
# =============================================================================

from __future__ import annotations

import base64
import uuid
from urllib.parse import urlencode

import httpx
from litestar import get, Request
from litestar.response import Redirect, Template
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from config import (
    MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET,
    MICROSOFT_REDIRECT_URI,
    MICROSOFT_AUTHORITY,
)
from core.db.engine import SessionLocal
from core.db.models import User, UserSettings, SystemSettings
from shared.request_helpers import client_ip, client_tz
from shared.secure_cookie import (
    set_secure_cookie,
    generate_csrf_token,
    set_csrf_cookie,
)

_AUTH_URL  = f"{MICROSOFT_AUTHORITY}/oauth2/v2.0/authorize"
_TOKEN_URL = f"{MICROSOFT_AUTHORITY}/oauth2/v2.0/token"
_ME_URL    = "https://graph.microsoft.com/v1.0/me"
_PHOTO_URL = "https://graph.microsoft.com/v1.0/me/photos/48x48/$value"
_SCOPES    = ["openid", "profile", "email", "User.Read"]

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

@get("/auth/oauth/microsoft")
def ms_oauth_start() -> Redirect | Template:
    if not _is_oauth_login_enabled():
        return _deny()

    params = {
        "client_id":     MICROSOFT_CLIENT_ID,
        "response_type": "code",
        "redirect_uri":  MICROSOFT_REDIRECT_URI,
        "response_mode": "query",
        "scope":         " ".join(_SCOPES),
        "prompt":        "select_account",
    }
    return Redirect(f"{_AUTH_URL}?{urlencode(params)}", status_code=302)

@get("/auth/oauth/microsoft/callback")
async def ms_oauth_callback(request: Request) -> Redirect | Template:
    if not _is_oauth_login_enabled():
        return _deny()

    code = request.query_params.get("code")
    if not code:
        return Redirect("/auth/login?err=ms_oauth", status_code=302)

    # ── 0. SystemSettings ────────────────────────────────────────────────────
    with SessionLocal() as db:
        sys: SystemSettings | None = db.query(SystemSettings).first()
        domain_mode      = sys.system_domain_mode if sys else "none"
        register_allowed = bool(sys is None or sys.system_register)

    # ── 1. Exchange code ------------------------------------------------------
    try:
        async with httpx.AsyncClient() as client:
            token_resp = await client.post(
                _TOKEN_URL,
                data={
                    "client_id":     MICROSOFT_CLIENT_ID,
                    "client_secret": MICROSOFT_CLIENT_SECRET,
                    "grant_type":    "authorization_code",
                    "code":          code,
                    "redirect_uri":  MICROSOFT_REDIRECT_URI,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=10,
            )
            access_token = token_resp.json().get("access_token")

            info = (
                await client.get(
                    _ME_URL,
                    headers={"Authorization": f"Bearer {access_token}"},
                    timeout=10,
                )
            ).json()

            avatar_url: str | None = None
            photo_resp = await client.get(
                _PHOTO_URL,
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=10,
            )
            if photo_resp.status_code == 200:
                avatar_url = (
                    "data:image/jpeg;base64,"
                    + base64.b64encode(photo_resp.content).decode()
                )
    except httpx.HTTPError as exc:
        request.app.logger.error("Microsoft OAuth error: %s", exc)
        return Redirect("/auth/login?err=ms_oauth", status_code=302)

    # ── 2. Trích thông tin ───────────────────────────────────────────────────
    sub            = info.get("id")
    display_name   = info.get("displayName")
    email          = (info.get("mail") or info.get("userPrincipalName") or "").lower()
    email_verified = True
    if not sub or not email:
        return Redirect("/auth/login?err=ms_oauth", status_code=302)

    # ── 3. Domain check ──────────────────────────────────────────────────────
    if not _is_domain_allowed(email, domain_mode):
        return _deny()

    ip_addr  = client_ip(request)
    timezone = client_tz(request)

    # ── 4. DB logic ──────────────────────────────────────────────────────────
    with SessionLocal() as db:
        user: User | None = db.scalars(
            select(User).where(
                User.user_oauth_provider == "microsoft",
                User.user_oauth_sub      == sub,
            )
        ).first()

        if not user:
            user = db.scalars(select(User).where(User.user_email == email)).first()
            if user:
                user.user_oauth_provider = "microsoft"
                user.user_oauth_sub      = sub
                user.user_email_verified = user.user_email_verified or email_verified

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
                user_oauth_provider = "microsoft",
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
        else:
            if ip_addr:
                user.user_register_ip = ip_addr
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

        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            user = db.scalars(select(User).where(User.user_email == email)).first()
        db.refresh(user)

        # ❗ Nếu tài khoản bị khóa, không cho login
        if user.user_status != "active":
            return _deny()

    # ── 5. Set cookies & redirect ────────────────────────────────────────────
    resp        = Redirect("/", status_code=302)
    secure_flag = request.url.scheme == "https"
    set_secure_cookie(resp, user.user_id, secure=secure_flag)

    csrf_token = generate_csrf_token()
    set_csrf_cookie(resp, csrf_token, secure=secure_flag)

    return resp

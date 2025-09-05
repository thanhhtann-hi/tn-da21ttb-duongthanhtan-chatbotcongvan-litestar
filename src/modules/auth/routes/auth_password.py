# file: src/modules/auth/routes/auth_password.py
# updated: 2025-08-13
# note: [AUTH-PW-000] Đồng bộ password-flow theo system_login & system_domain_mode; force scrypt on reset.

import os
import re
import datetime
import secrets
from typing import Annotated, Optional

from litestar import get, post, Request
from litestar.response import Template, Redirect, Response
from litestar.params import Body
from litestar.enums import RequestEncodingType
from litestar.background_tasks import BackgroundTask
from litestar.exceptions import HTTPException

from sqlalchemy import select, delete

from core.db.engine import SessionLocal
from core.db.models import User, PasswordResetToken, SystemSettings
from werkzeug.security import generate_password_hash
from shared.mailer import send_mail

# [AUTH-PW-001] no-cache header
_NO_CACHE = {
    "Cache-Control": "no-store, must-revalidate",
    "Pragma": "no-cache",
}

# [AUTH-PW-002] Flag helper – enable forgot/reset theo system flags
def _is_password_flow_enabled() -> bool:
    """
    Cho phép Forgot/Reset password khi:
    • system_login == FALSE  (password-flow hoàn toàn mở)
         ──HOẶC──
    • system_login == TRUE  &  system_domain_mode == 'none'
    """
    with SessionLocal() as db:
        sys: SystemSettings | None = db.query(SystemSettings).first()
        if not sys:
            return False
        # (1) login-flag tắt  → luôn cho phép
        if not sys.system_login:
            return True
        # (2) login-flag bật nhưng domain-mode “none” → cho phép
        return sys.system_domain_mode == "none"

# ──────────────────────────── Forgot-Password form ───────────────────────────
# [AUTH-PW-003] GET /auth/forgot-password
@get("/auth/forgot-password")
def forgot_password_form(request: Request) -> Template:
    if not _is_password_flow_enabled():
        return Template("error/404_error.html", status_code=404)
    return Template("auth/password/forgot_password.html")

# ─────────────────────────── Forgot-Password submit ──────────────────────────
# [AUTH-PW-004] POST /auth/forgot-password
@post("/auth/forgot-password")
def forgot_password_submit(
    request: Request,
    data: Annotated[dict[str, str], Body(media_type=RequestEncodingType.URL_ENCODED)],
) -> Response | Template:
    if not _is_password_flow_enabled():
        return Template("error/404_error.html", status_code=404)

    email = data.get("email", "").strip()
    now   = datetime.datetime.utcnow()
    bg_task: Optional[BackgroundTask] = None

    with SessionLocal() as db:
        user = db.scalars(select(User).where(User.user_email == email)).first()

        # [AUTH-PW-004-1] Chặn quên mật khẩu cho tài khoản đăng nhập OAuth
        if user and user.user_oauth_provider:
            msg = (
                f"Tài khoản này đăng nhập bằng {user.user_oauth_provider.capitalize()}. "
                "Vui lòng đăng nhập bằng phương thức đó."
            )
            if request.headers.get("hx-request", "").lower() == "true":
                return Response(msg, status_code=200, media_type="text/plain", headers={"X-OAuth": "true"})
            return Template("auth/password/forgot_password.html", context={"error": msg})

        if user:
            # [AUTH-PW-004-2] Huỷ token cũ – tạo token mới
            db.execute(delete(PasswordResetToken).where(PasswordResetToken.prt_user_id == user.user_id))
            token   = secrets.token_urlsafe(32)
            expires = now + datetime.timedelta(minutes=5)
            db.add(
                PasswordResetToken(
                    prt_user_id    = user.user_id,
                    prt_token      = token,
                    prt_expires_at = expires,
                )
            )
            db.commit()

            # [AUTH-PW-004-3] Gửi email reset (hết hạn 5 phút)
            domain     = os.getenv("APP_DOMAIN", "http://localhost:8000")
            reset_url  = f"{domain}/auth/reset-password?token={token}"
            html_body  = (
                "<p>Để đặt lại mật khẩu, vui lòng nhấn vào liên kết dưới đây "
                "(liên kết hết hạn sau 5 phút):</p>"
                f'<p><a href="{reset_url}">{reset_url}</a></p>'
            )
            bg_task = BackgroundTask(
                send_mail,
                to=email,
                subject="TvuMoE: Đặt lại mật khẩu",
                html_body=html_body,
            )

    # [AUTH-PW-004-4] Phản hồi HTMX / full page
    if request.headers.get("hx-request", "").lower() == "true":
        return Response(
            "",
            status_code=204,
            background=bg_task,
            headers={"HX-Redirect": "/auth/forgot-password/sent"},
        )
    return Template("auth/password/forgot_password_sent.html", background=bg_task)

# ─────────────────────────────  Thông báo đã gửi ─────────────────────────────
# [AUTH-PW-005] GET /auth/forgot-password/sent
@get("/auth/forgot-password/sent")
def forgot_password_sent_page(request: Request) -> Template:
    if not _is_password_flow_enabled():
        return Template("error/404_error.html", status_code=404)
    return Template("auth/password/forgot_password_sent.html")

# ─────────────────────────────── Reset-Password ──────────────────────────────
# [AUTH-PW-006] GET /auth/reset-password
@get("/auth/reset-password", name="reset_password_form")
def reset_password_form(request: Request, token: str | None = None) -> Template | Redirect:
    if not _is_password_flow_enabled():
        return Template("error/404_error.html", status_code=404)

    if not token:
        return Redirect("/auth/forgot-password", status_code=302)

    now = datetime.datetime.utcnow()
    with SessionLocal() as db:
        prt = db.scalars(
            select(PasswordResetToken).where(
                PasswordResetToken.prt_token == token,
                PasswordResetToken.prt_expires_at > now,
            )
        ).first()

    if not prt:
        return Template("auth/password/reset_password_invalid.html", headers=_NO_CACHE)

    tpl = (
        "auth/password/reset_password_fragment.html"
        if request.headers.get("hx-request", "").lower() == "true"
        else "auth/password/reset_password.html"
    )
    return Template(tpl, context={"token": token, "request": request}, headers=_NO_CACHE)

# ──────────────────────────── Reset-Password submit ──────────────────────────
# [AUTH-PW-007] POST /auth/reset-password
@post("/auth/reset-password")
def reset_password_submit(
    request: Request,
    data: Annotated[dict[str, str], Body(media_type=RequestEncodingType.URL_ENCODED)],
) -> Response | Redirect:
    if not _is_password_flow_enabled():
        return Template("error/404_error.html", status_code=404)

    token       = data.get("token", "").strip()
    new_pw      = data.get("password", "")
    confirm_pw  = data.get("confirm_password", "")

    def _err(msg: str) -> Response:
        if request.headers.get("hx-request", "").lower() == "true":
            return Response(msg, status_code=200, media_type="text/plain")
        raise HTTPException(status_code=400, detail=msg)

    # [AUTH-PW-007-1] Validate input
    if not token:
        return _err("Liên kết không hợp lệ")
    if not new_pw:
        return _err("Vui lòng nhập mật khẩu mới")
    if len(new_pw) < 6:
        return _err("Mật khẩu phải có ít nhất 6 ký tự")
    if not re.search(r"\d", new_pw):
        return _err("Mật khẩu phải có ít nhất một số")
    if not re.search(r"[!@#$%^&*(),.?\":{}|<>]", new_pw):
        return _err("Mật khẩu phải có ít nhất một ký tự đặc biệt")
    if new_pw != confirm_pw:
        return _err("Hai mật khẩu không khớp")

    now = datetime.datetime.utcnow()
    with SessionLocal() as db:
        # [AUTH-PW-007-2] Kiểm tra token hợp lệ
        prt = db.scalars(
            select(PasswordResetToken).where(
                PasswordResetToken.prt_token == token,
                PasswordResetToken.prt_expires_at > now,
            )
        ).first()
        if not prt:
            return _err("Liên kết không hợp lệ hoặc đã hết hạn")

        # [AUTH-PW-007-3] Lấy user & chặn user bị khoá
        user = db.get(User, prt.prt_user_id)
        if not user or user.user_status != "active":
            return _err("Tài khoản đã bị khóa hoặc không tồn tại")

        # [AUTH-PW-007-4] Force scrypt khi đặt lại mật khẩu
        user.user_password_hash = generate_password_hash(new_pw, method="scrypt")

        # [AUTH-PW-007-5] Xoá token & commit
        db.execute(delete(PasswordResetToken).where(PasswordResetToken.prt_id == prt.prt_id))
        db.commit()

    # [AUTH-PW-007-6] Redirect về trang login (HTMX / full page)
    if request.headers.get("hx-request", "").lower() == "true":
        return Response("", status_code=204, headers={"HX-Redirect": "/auth/login"})
    return Redirect("/auth/login", status_code=303)

# file: src/core/middleware/auth_guard.py
# updated: 2025-08-24 (v2.0 – add /admin gate: login redirect or 404 for non-admin)
# Lý do sửa: Giữ session mở đến hết request để tránh DetachedInstanceError, đồng thời
#            chặn /admin/** ngay tại middleware: chưa login → 302 login?next=...,
#            đã login nhưng không phải admin → 404.

from __future__ import annotations

import uuid
from urllib.parse import quote

from litestar import Request
from litestar.middleware.base import AbstractMiddleware
from litestar.response import Template, Redirect
from litestar.types import ASGIApp, Receive, Scope, Send

from core.db.engine import SessionLocal
from core.db.models import User, UserSettings, SystemSettings
from shared.secure_cookie import get_secure_cookie, delete_secure_cookie
from shared.request_helpers import client_ip, client_tz


def _is_domain_allowed(email: str, mode: str) -> bool:
    """Kiểm tra email theo system_domain_mode."""
    email = email.lower()
    if mode == "none":
        return True
    if mode == "tvu":
        return email.endswith("@tvu.edu.vn")
    if mode == "tvu_and_sttvu":
        return email.endswith("@tvu.edu.vn") or email.endswith("@st.tvu.edu.vn")
    return True  # fallback an toàn


class AuthGuardMiddleware(AbstractMiddleware):
    """Bảo vệ toàn bộ request HTTP (trừ static, ping, websocket, lifespan)."""

    _ASSET_PREFIXES = ("/static", "/images", "/js", "/css", "/favicon", "/ping")

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        request = Request(scope=scope, receive=receive, send=send)
        path = request.url.path

        # 1️⃣ Bỏ qua static assets, ping, v.v.
        if any(path.startswith(p) for p in self._ASSET_PREFIXES):
            return await self.app(scope, receive, send)

        db = SessionLocal()
        try:
            # Load system settings
            sys = db.query(SystemSettings).first()
            scope["sys"] = sys  # type: ignore

            # 2️⃣ Nếu đang bảo trì → trả 503
            if sys and sys.system_maintenance:
                tmpl = Template("maintenance/503_maintenance.html", status_code=503)
                asgi = tmpl.to_asgi_response(app=self.app, request=request)
                return await asgi(scope, receive, send)

            # 3️⃣ Nếu login tắt → chặn /auth/** trừ logout
            if sys and not sys.system_login and path.startswith("/auth") and path != "/auth/logout":
                tmpl = Template("error/404_error.html", status_code=404)
                asgi = tmpl.to_asgi_response(app=self.app, request=request)
                return await asgi(scope, receive, send)

            # 3.5️⃣ Nếu đăng ký tắt → chặn /auth/register*
            if sys and not sys.system_register and path.startswith("/auth/register"):
                tmpl = Template("error/404_error.html", status_code=404)
                asgi = tmpl.to_asgi_response(app=self.app, request=request)
                return await asgi(scope, receive, send)

            # 4️⃣ Nếu có session cookie → kiểm tra user
            uid = get_secure_cookie(request)
            if uid:
                # Eager load settings relationship nếu cần (đang để trống options để tránh lazy load)
                user = db.query(User).get(uid)  # noqa: get vs get()

                # 🚫 User không tồn tại hoặc status khác 'active' → 404 + xóa cookie
                if not user or user.user_status != "active":
                    tmpl = Template("error/404_error.html", status_code=404)
                    delete_secure_cookie(tmpl)
                    asgi = tmpl.to_asgi_response(app=self.app, request=request)
                    return await asgi(scope, receive, send)

                # 🚫 Domain không được phép → 404 + xóa cookie
                mode = sys.system_domain_mode if sys else "none"
                if not _is_domain_allowed(user.user_email, mode):
                    tmpl = Template("error/404_error.html", status_code=404)
                    delete_secure_cookie(tmpl)
                    asgi = tmpl.to_asgi_response(app=self.app, request=request)
                    return await asgi(scope, receive, send)

                # ✅ Đồng bộ IP & timezone nếu thay đổi
                ip_addr = client_ip(request)
                tz = client_tz(request)
                updated = False

                if ip_addr and ip_addr != user.user_register_ip:
                    user.user_register_ip = ip_addr
                    updated = True

                if not user.settings:
                    db.add(UserSettings(setting_user_id=user.user_id, setting_timezone=tz))
                    updated = True
                elif tz and tz != user.settings.setting_timezone:
                    user.settings.setting_timezone = tz
                    updated = True

                if updated:
                    db.commit()

                # Đưa user (với session vẫn mở) vào scope để xử lý tiếp
                scope["user"] = user  # type: ignore

            # 4.5️⃣ Gate toàn bộ /admin/**
            if path.startswith("/admin"):
                user_obj = scope.get("user")  # type: ignore
                # Chưa login → ép login (kèm next)
                if not user_obj:
                    next_url = quote(str(request.url), safe="")
                    redir = Redirect(f"/auth/login?next={next_url}", status_code=302)
                    asgi = redir.to_asgi_response(app=self.app, request=request)
                    return await asgi(scope, receive, send)
                # Đã login nhưng không phải admin → 404 "biệt ly"
                if getattr(user_obj, "user_role", None) != "admin":
                    tmpl = Template("error/404_error.html", status_code=404)
                    asgi = tmpl.to_asgi_response(app=self.app, request=request)
                    return await asgi(scope, receive, send)

            # 5️⃣ Tiếp tục chuỗi middleware
            return await self.app(scope, receive, send)
        finally:
            db.close()

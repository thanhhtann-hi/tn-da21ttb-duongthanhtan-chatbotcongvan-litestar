# ---------------------------------------------------------------------------
# 1. Đường dẫn file : src/modules/admin/routes/admin_security.py
# 2. Thời gian sửa  : 2025-07-23 07:40
# 3. Lý do sửa      : Fix UndefinedError 'user' (bổ sung user vào context & HTMX)
# ---------------------------------------------------------------------------

from __future__ import annotations

import datetime as dt
from typing import Annotated

from litestar import Request, get, post
from litestar.exceptions import HTTPException
from litestar.params import Body
from litestar.response import Redirect, Template, Response
from sqlalchemy.exc import IntegrityError

from core.db.engine import SessionLocal
from core.db.models import SystemSettings, SystemAdminLog
from shared.secure_cookie import generate_csrf_token, set_csrf_cookie, get_csrf_cookie


# ─────────────────────────────────────────────────────────────
# Helper
# ─────────────────────────────────────────────────────────────
def _ensure_admin(request: Request) -> None:
    user = request.scope.get("user")
    if not user:
        raise HTTPException(status_code=302, headers={"Location": "/auth/login"})
    if user.user_role != "admin":
        raise HTTPException(status_code=403, detail="Forbidden")


def _inject_csrf(request: Request, response: Template) -> None:
    token = get_csrf_cookie(request) or generate_csrf_token()
    set_csrf_cookie(response, token, secure=request.url.scheme == "https")
    response.context["csrf_token"] = token  # type: ignore[attr-defined]


def _current_settings(db) -> SystemSettings:
    settings = db.query(SystemSettings).first()
    if not settings:
        settings = SystemSettings()
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


# ─────────────────────────────────────────────────────────────
# GET 1️⃣   /admin/security            (full page)
# ─────────────────────────────────────────────────────────────
@get("/admin/security")
def admin_security(request: Request) -> Template:
    _ensure_admin(request)
    with SessionLocal() as db:
        settings = _current_settings(db)

    user = request.scope.get("user")                                       # 🆕
    resp = Template(
        template_name="admin/security/admin_security.html",
        context={"settings": settings, "user": user},                      # 🆕
    )
    _inject_csrf(request, resp)
    return resp


# ─────────────────────────────────────────────────────────────
# GET 2️⃣   /admin/security/fragment   (SPA fragment)
# ─────────────────────────────────────────────────────────────
@get("/admin/security/fragment")
def admin_security_fragment_get(request: Request) -> Template:
    _ensure_admin(request)
    with SessionLocal() as db:
        settings = _current_settings(db)

    user = request.scope.get("user")                                       # 🆕
    resp = Template(
        template_name="admin/security/admin_security_container_fragment.html",
        context={"settings": settings, "user": user},                      # 🆕
    )
    _inject_csrf(request, resp)
    return resp


# ─────────────────────────────────────────────────────────────
# POST      /admin/security            (update)
# ─────────────────────────────────────────────────────────────
@post("/admin/security")
def admin_security_update(
    request: Request,
    data: Annotated[dict[str, str], Body(media_type="application/x-www-form-urlencoded")],
) -> Template | Redirect | Response:
    _ensure_admin(request)
    user = request.scope["user"]  # type: ignore[assignment]

    # ── Trích xuất form ───────────────────────────────────────────
    raw_register    = "system_register" in data
    raw_login       = "system_login" in data
    raw_maintenance = "system_maintenance" in data
    domain_mode     = data.get("system_domain_mode", "none")

    allowed_models = [m.strip() for m in data.get("system_allowed_models", "").split(",") if m.strip()]
    enabled_tools  = [t.strip() for t in data.get("system_enabled_tools", "").split(",") if t.strip()]

    # ── Logic A-B-C ───────────────────────────────────────────────
    if raw_maintenance:
        register_flag = login_flag = False
        maintenance_flag = True
    else:
        if not (raw_register or raw_login):
            raise HTTPException(
                status_code=422,
                detail="Phải bật ít nhất một trong hai: “Cho phép đăng ký” hoặc “Bắt buộc đăng nhập OAuth”.",
            )
        register_flag = raw_register
        login_flag = raw_login
        maintenance_flag = False

    with SessionLocal() as db:
        settings = _current_settings(db)

        # Lưu trước
        log_before = {
            "system_register": settings.system_register,
            "system_login": settings.system_login,
            "system_maintenance": settings.system_maintenance,
            "system_domain_mode": settings.system_domain_mode,
            "system_allowed_models": settings.system_allowed_models or [],
            "system_enabled_tools": settings.system_enabled_tools or [],
        }

        # Ghi đè
        settings.system_register        = register_flag
        settings.system_login           = login_flag
        settings.system_maintenance     = maintenance_flag
        settings.system_domain_mode     = domain_mode
        settings.system_allowed_models  = allowed_models
        settings.system_enabled_tools   = enabled_tools
        settings.setting_updated_at     = dt.datetime.now(dt.timezone.utc)
        settings.updated_by_user_id     = user.user_id

        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=400, detail="Giá trị không hợp lệ")
        db.refresh(settings)

        # Log sau
        log_after = {
            "system_register": settings.system_register,
            "system_login": settings.system_login,
            "system_maintenance": settings.system_maintenance,
            "system_domain_mode": settings.system_domain_mode,
            "system_allowed_models": settings.system_allowed_models or [],
            "system_enabled_tools": settings.system_enabled_tools or [],
        }
        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="update_system_settings",
                log_target_table="system_settings",
                log_target_id=settings.system_id,
                log_description="Admin cập nhật cấu hình hệ thống",
                log_before=log_before,
                log_after=log_after,
            )
        )
        db.commit()

    # ── Response ─────────────────────────────────────────────────

    # Bật maintenance → ép refresh toàn site
    if maintenance_flag:
        if request.headers.get("hx-request", "").lower() == "true":
            return Response("", status_code=204, headers={"HX-Refresh-All": "true", "Cache-Control": "no-store"})
        return Redirect("/admin/security", status_code=302, headers={"Cache-Control": "no-store"})

    # Nếu là HTMX → trả fragment form (KHÔNG reload)
    if request.headers.get("hx-request", "").lower() == "true":
        fragment = Template(
            template_name="admin/security/admin_security_fragment.html",
            context={"settings": settings, "user": user},                  # 🆕
        )
        _inject_csrf(request, fragment)
        return fragment

    # Fallback: redirect
    return Redirect("/admin/security", status_code=302, headers={"Cache-Control": "no-store"})


# Alias thuận tiện (Litestar cho phép dùng route handler nhiều tên)
admin_security_fragment = admin_security_update

# file: src/modules/admin/routes/admin_tools.py
# updated: 2025-08-23
# note:
# - Trang quản trị "Tiện ích hệ thống" (ToolDefinition): list + filter + paging + CRUD + bulk + export CSV
# - Semantics delete: Ẩn tool (tool_enabled=False) thay vì hard delete (tránh vướng FK từ chat_features).
# - Tương thích HTMX fragment như admin_models.* / admin_notify.*; có HX-Trigger cho kết quả bulk.
# - CSRF: dùng middleware CsrfGuard; POST/PUT/DELETE hợp lệ (không cần validate_csrf thủ công).
# - Logging: ghi SystemAdminLog cho các thao tác mutating.
# - Ràng buộc {tool_id:uuid} cho các route có ID (tránh 405 khi trùng static path).
# - FIX DetachedInstanceError: validate quyền qua DB nhưng trả về user trong request.scope (không trả ORM User cho template).

from __future__ import annotations

from datetime import datetime, date
from typing import NamedTuple, Tuple, List
from uuid import UUID

import csv
import io
import json

from litestar import get, post, put, delete, Request
from litestar.exceptions import HTTPException
from litestar.response import Template, Redirect, Response
from sqlalchemy import select, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from core.db.engine import SessionLocal
from core.db.models import ToolDefinition, SystemAdminLog, User
from shared.secure_cookie import generate_csrf_token, get_csrf_cookie, set_csrf_cookie
from shared.timezone import now_tz


# ──────────────────────────────────────────────────────────────────────────────
# Config chung
# ──────────────────────────────────────────────────────────────────────────────
PP_MIN = 5
PP_MAX = 50
PP_DEFAULT = 10

ALLOWED_ENABLED = {"all", "enabled", "disabled"}
ALLOWED_SCOPE = {"all", "user", "internal", "admin", "any"}  # 'any' = không lọc

# canonical sort keys
ALLOWED_SORT = {
    "created_desc",
    "created_asc",
    "name_az",
    "name_za",
    "order_asc",      # theo tool_sort_order ASC (NULLS LAST)
    "order_desc",     # theo tool_sort_order DESC (NULLS LAST)
}

# map → khóa UI (new|old|az|za|order_up|order_down) cho template dùng
UI_SORT_MAP = {
    "created_desc": "new",
    "created_asc": "old",
    "name_az": "az",
    "name_za": "za",
    "order_asc": "order_up",
    "order_desc": "order_down",
}


# ──────────────────────────────────────────────────────────────────────────────
# Helpers chung
# ──────────────────────────────────────────────────────────────────────────────
def _ensure_admin(request: Request, db: Session):
    """
    Đảm bảo user đăng nhập là admin & active.
    Validate bằng DB nhưng *trả về user trong scope* thay vì ORM User để tránh DetachedInstanceError khi render template.
    """
    user_in_scope = request.scope.get("user")
    if not user_in_scope:
        # chuyển sang login nếu chưa đăng nhập
        raise HTTPException(status_code=302, headers={"Location": "/auth/login"})

    row = db.execute(
        select(User.user_role, User.user_status).where(User.user_id == user_in_scope.user_id)
    ).first()
    if not row:
        raise HTTPException(status_code=404)

    role, status = row
    if role != "admin" or status != "active":
        raise HTTPException(status_code=404)

    # Trả về scoped user (DTO / session-agnostic), an toàn cho Jinja
    return user_in_scope


def _parse_int(s: str | None, default: int | None) -> int | None:
    try:
        return int(str(s).strip())
    except Exception:
        return default


def _clamp_per_page(n: int) -> int:
    if n < PP_MIN:
        return PP_MIN
    if n > PP_MAX:
        return PP_MAX
    return n


def _normalize_sort(k: str) -> str:
    """Chấp nhận cả khóa UI và canonical; trả về canonical."""
    kk = (k or "").strip().lower()
    if kk in ALLOWED_SORT:
        return kk
    if kk == "new":
        return "created_desc"
    if kk == "old":
        return "created_asc"
    if kk == "az":
        return "name_az"
    if kk == "za":
        return "name_za"
    if kk in {"order", "order_up", "sort_order_asc"}:
        return "order_asc"
    if kk in {"order_down", "sort_order_desc"}:
        return "order_desc"
    return "created_desc"


def _parse_ids_csv(s: str | None) -> list[str]:
    if not s:
        return []
    parts = [p.strip() for p in s.split(",")]
    return [p for p in parts if p]


def parse_date_str(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Filter model
# ──────────────────────────────────────────────────────────────────────────────
class ToolFilter(NamedTuple):
    enabled: str = "all"   # enabled|disabled|all
    scope: str = "any"     # all|user|internal|admin|any(=no filter)
    q: str = ""            # tìm theo name/description
    sort: str = "created_desc"
    page: int = 1
    per_page: int = PP_DEFAULT


def _extract_filters(request: Request, form: dict | None = None) -> ToolFilter:
    """Ưu tiên FORM (POST/PUT/DELETE), fallback QUERY."""
    def _get_from(source: dict, name: str) -> str:
        return (source.get(name) or "").strip() if source and name in source else ""

    def _get_any(names: tuple[str, ...], default: str = "") -> str:
        for n in names:
            v = _get_from(form or {}, n)
            if v:
                return v
        for n in names:
            v = (request.query_params.get(n) or "").strip()
            if v:
                return v
        return default

    enabled = (_get_any(("enabled",), "all") or "all").lower()
    if enabled not in ALLOWED_ENABLED:
        enabled = "all"

    scope = (_get_any(("scope",), "any") or "any").lower()
    if scope not in ALLOWED_SCOPE:
        scope = "any"

    q = _get_any(("q", "search"), "")

    sort = _normalize_sort(_get_any(("sort",), "created_desc"))

    page = _parse_int(_get_any(("page",), "1"), 1) or 1
    if page < 1:
        page = 1

    per_page_raw = _parse_int(_get_any(("per_page", "limit"), str(PP_DEFAULT)), PP_DEFAULT) or PP_DEFAULT
    per_page = _clamp_per_page(per_page_raw)

    return ToolFilter(enabled=enabled, scope=scope, q=q, sort=sort, page=page, per_page=per_page)


def _build_filter_qs(f: ToolFilter) -> str:
    """Sinh query-string tối giản theo filter hiện tại (bỏ mặc định)."""
    parts: List[str] = []
    if f.enabled != "all":
        parts.append(f"enabled={f.enabled}")
    if f.scope != "any":
        parts.append(f"scope={f.scope}")
    if f.q:
        parts.append(f"q={f.q}")
    if f.sort != "created_desc":
        parts.append(f"sort={f.sort}")
    if f.page and f.page != 1:
        parts.append(f"page={f.page}")
    if f.per_page and f.per_page != PP_DEFAULT:
        parts.append(f"per_page={f.per_page}")
    return ("?" + "&".join(parts)) if parts else ""


# ──────────────────────────────────────────────────────────────────────────────
# Query helpers
# ──────────────────────────────────────────────────────────────────────────────
def _apply_filters_to_stmt(stmt, f: ToolFilter):
    # enabled
    if f.enabled == "enabled":
        stmt = stmt.where(ToolDefinition.tool_enabled.is_(True))
    elif f.enabled == "disabled":
        stmt = stmt.where(ToolDefinition.tool_enabled.is_(False))

    # scope
    if f.scope in {"all", "user", "internal", "admin"}:
        stmt = stmt.where(ToolDefinition.tool_access_scope == f.scope)

    # q ~ name / description
    if f.q:
        like = f"%{f.q}%"
        stmt = stmt.where(or_(ToolDefinition.tool_name.ilike(like), ToolDefinition.tool_description.ilike(like)))

    return stmt


def _apply_sort(stmt, f: ToolFilter):
    if f.sort == "created_asc":
        return stmt.order_by(ToolDefinition.tool_created_at.asc())
    if f.sort == "name_az":
        return stmt.order_by(func.lower(ToolDefinition.tool_name).asc(), ToolDefinition.tool_created_at.desc())
    if f.sort == "name_za":
        return stmt.order_by(func.lower(ToolDefinition.tool_name).desc(), ToolDefinition.tool_created_at.desc())
    if f.sort == "order_asc":
        # NULLS LAST để các mục chưa set sort_order về cuối
        try:
            return stmt.order_by(ToolDefinition.tool_sort_order.asc().nulls_last(), ToolDefinition.tool_created_at.desc())
        except Exception:
            return stmt.order_by(ToolDefinition.tool_sort_order.asc(), ToolDefinition.tool_created_at.desc())
    if f.sort == "order_desc":
        try:
            return stmt.order_by(ToolDefinition.tool_sort_order.desc().nulls_last(), ToolDefinition.tool_created_at.desc())
        except Exception:
            return stmt.order_by(ToolDefinition.tool_sort_order.desc(), ToolDefinition.tool_created_at.desc())
    # default
    return stmt.order_by(ToolDefinition.tool_created_at.desc())


def _query_tools(db: Session, f: ToolFilter) -> Tuple[list[ToolDefinition], int, int, int]:
    """Trả về (items, total, actual_page, total_pages)."""
    total = int(db.scalar(_apply_filters_to_stmt(select(func.count(ToolDefinition.tool_id)), f)) or 0)

    per_page = _clamp_per_page(f.per_page or PP_DEFAULT)
    pages = max(1, (total + per_page - 1) // per_page)
    page = f.page if f.page >= 1 else 1
    if page > pages:
        page = pages

    stmt = _apply_filters_to_stmt(select(ToolDefinition), f)
    stmt = _apply_sort(stmt, f)
    offset = (page - 1) * per_page
    items = db.scalars(stmt.offset(offset).limit(per_page)).all()
    return items, total, page, pages


# ──────────────────────────────────────────────────────────────────────────────
# Render helpers
# ──────────────────────────────────────────────────────────────────────────────
def _render_tools_fragment(request: Request, *, override_filters: ToolFilter | None = None) -> Template:
    f = override_filters or _extract_filters(request, None)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        tools, total, page, pages = _query_tools(db, f)

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/tools/admin_tools_fragment.html",
        context={
            "user": user,
            "tools": tools,
            "csrf_token": token,
            # filters
            "filter_enabled": f.enabled,
            "filter_scope": f.scope,
            "filter_q": f.q,
            # sort
            "filter_sort": f.sort,
            "current_sort": UI_SORT_MAP.get(f.sort, "new"),
            # paging
            "page": page,
            "per_page": f.per_page,
            "total": total,
            "total_pages": pages,
            "has_prev": page > 1,
            "has_next": page < pages,
            "show_first_btn": page >= 3,
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – Full page hoặc fragment
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/tools/fragment")
async def admin_tools_fragment_get(request: Request) -> Template:
    return _render_tools_fragment(request)


@get("/admin/tools")
async def admin_tools_page(request: Request) -> Template:
    hx = request.headers.get("HX-Request", "").lower() == "true"
    if hx:
        return _render_tools_fragment(request)

    f = _extract_filters(request, None)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        tools, total, page, pages = _query_tools(db, f)

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/tools/admin_tools.html",
        context={
            "user": user,
            "tools": tools,
            "csrf_token": token,
            # filters
            "filter_enabled": f.enabled,
            "filter_scope": f.scope,
            "filter_q": f.q,
            # sort
            "filter_sort": f.sort,
            "current_sort": UI_SORT_MAP.get(f.sort, "new"),
            # paging
            "page": page,
            "per_page": f.per_page,
            "total": total,
            "total_pages": pages,
            "has_prev": page > 1,
            "has_next": page < pages,
            "show_first_btn": page >= 3,
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – Modals
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/tools/new-modal")
async def admin_tools_new_modal(request: Request) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/tools/admin_tools_new_modal.html",
        context={"user": user, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/tools/{tool_id:uuid}/edit-modal")
async def admin_tools_edit_modal(request: Request, tool_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        tool = db.get(ToolDefinition, str(tool_id))
        if not tool:
            raise HTTPException(status_code=404)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/tools/admin_tools_edit_modal.html",
        context={"user": user, "tool": tool, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/tools/{tool_id:uuid}/detail-modal")
async def admin_tools_detail_modal(request: Request, tool_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        tool = db.get(ToolDefinition, str(tool_id))
        if not tool:
            raise HTTPException(status_code=404)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/tools/admin_tools_detail_modal.html",
        context={"user": user, "tool": tool, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/tools/{tool_id:uuid}/delete-modal")
async def admin_tools_delete_modal(request: Request, tool_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        tool = db.get(ToolDefinition, str(tool_id))
        if not tool:
            raise HTTPException(status_code=404)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/tools/admin_tools_delete_modal.html",
        context={
            "user": user,
            "tool": tool,
            "csrf_token": token,
            "already_disabled": (not tool.tool_enabled),
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# Bulk delete modal (ẩn nhiều tool)
@get("/admin/tools/bulk-delete-modal")
async def admin_tools_bulk_delete_modal(request: Request) -> Template:
    ids_raw = (request.query_params.get("ids") or "").strip()
    ids = _parse_ids_csv(ids_raw)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/tools/admin_tools_bulk_delete_modal.html",
        context={
            "user": user,
            "csrf_token": token,
            "ids_csv": ",".join(ids),
            "selected_ids": ",".join(ids),
            "selected_count": len(ids),
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# Bulk export modal
@get("/admin/tools/bulk-export-modal")
async def admin_tools_bulk_export_modal(request: Request) -> Template:
    ids_raw = (request.query_params.get("ids") or "").strip()
    ids = _parse_ids_csv(ids_raw)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/tools/admin_tools_bulk_export_modal.html",
        context={
            "user": user,
            "csrf_token": token,
            "ids_csv": ",".join(ids),
            "selected_ids": ",".join(ids),
            "selected_count": len(ids),
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# POST – Create
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/tools")
async def admin_tools_create(request: Request) -> Template | Redirect:
    form = await request.form()

    name = (form.get("tool_name") or "").strip()
    description = (form.get("tool_description") or "").strip()
    enabled = "tool_enabled" in form
    scope = (form.get("tool_access_scope") or "all").strip().lower()
    sort_order = _parse_int(form.get("tool_sort_order"), None)

    f = _extract_filters(request, form)

    if not name:
        raise HTTPException(status_code=422, detail="Tên tiện ích (tool_name) không được để trống")
    if scope not in {"all", "user", "internal", "admin"}:
        raise HTTPException(status_code=422, detail="Giá trị tool_access_scope không hợp lệ")

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        tool = ToolDefinition(
            tool_name=name,
            tool_description=description or None,
            tool_enabled=bool(enabled),
            tool_access_scope=scope,
            tool_sort_order=sort_order,
        )
        db.add(tool)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=400, detail="Tên tiện ích đã tồn tại")

        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="create_tool_definition",
                log_target_table="tool_definitions",
                log_target_id=tool.tool_id,
                log_after={
                    "name": tool.tool_name,
                    "description": tool.tool_description,
                    "enabled": tool.tool_enabled,
                    "scope": tool.tool_access_scope,
                    "sort_order": tool.tool_sort_order,
                },
                log_created_at=now_tz(),
            )
        )
        db.commit()

    if request.headers.get("HX-Request", "").lower() == "true":
        return _render_tools_fragment(request, override_filters=f)
    return Redirect("/admin/tools" + _build_filter_qs(f), status_code=302)


# ──────────────────────────────────────────────────────────────────────────────
# PUT – Update
# ──────────────────────────────────────────────────────────────────────────────
@put("/admin/tools/{tool_id:uuid}")
async def admin_tools_update(request: Request, tool_id: UUID) -> Template | Redirect:
    form = await request.form()

    name = (form.get("tool_name") or "").strip()
    description = (form.get("tool_description") or "").strip()
    enabled = "tool_enabled" in form
    scope = (form.get("tool_access_scope") or "all").strip().lower()
    sort_order = _parse_int(form.get("tool_sort_order"), None)

    f = _extract_filters(request, form)

    if not name:
        raise HTTPException(status_code=422, detail="Tên tiện ích (tool_name) không được để trống")
    if scope not in {"all", "user", "internal", "admin"}:
        raise HTTPException(status_code=422, detail="Giá trị tool_access_scope không hợp lệ")

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        tool = db.get(ToolDefinition, str(tool_id))
        if not tool:
            raise HTTPException(status_code=404)

        before = {
            "name": tool.tool_name,
            "description": tool.tool_description,
            "enabled": tool.tool_enabled,
            "scope": tool.tool_access_scope,
            "sort_order": tool.tool_sort_order,
        }

        tool.tool_name = name
        tool.tool_description = description or None
        tool.tool_enabled = bool(enabled)
        tool.tool_access_scope = scope
        tool.tool_sort_order = sort_order

        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=400, detail="Tên tiện ích đã tồn tại")
        db.refresh(tool)

        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="update_tool_definition",
                log_target_table="tool_definitions",
                log_target_id=tool.tool_id,
                log_before=before,
                log_after={
                    "name": tool.tool_name,
                    "description": tool.tool_description,
                    "enabled": tool.tool_enabled,
                    "scope": tool.tool_access_scope,
                    "sort_order": tool.tool_sort_order,
                },
                log_created_at=now_tz(),
            )
        )
        db.commit()

    if request.headers.get("HX-Request", "").lower() == "true":
        return _render_tools_fragment(request, override_filters=f)
    return Redirect("/admin/tools" + _build_filter_qs(f), status_code=302)


# ──────────────────────────────────────────────────────────────────────────────
# DELETE – Ẩn (disable) 1 tiện ích
# ──────────────────────────────────────────────────────────────────────────────
@delete("/admin/tools/{tool_id:uuid}", status_code=200)
async def admin_tools_hide(request: Request, tool_id: UUID) -> Template:
    # DELETE đôi khi có body (HTMX), cố gắng đọc form trước – nếu lỗi thì bỏ qua
    try:
        form = await request.form()
    except Exception:
        form = None
    f = _extract_filters(request, form)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        tool = db.get(ToolDefinition, str(tool_id))
        if not tool:
            raise HTTPException(status_code=404)

        if tool.tool_enabled:
            tool.tool_enabled = False
            db.add(
                SystemAdminLog(
                    log_admin_id=user.user_id,
                    log_action="hide_tool_definition",
                    log_target_table="tool_definitions",
                    log_target_id=tool.tool_id,
                    log_after={"enabled": False},
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    return _render_tools_fragment(request, override_filters=f)


# ──────────────────────────────────────────────────────────────────────────────
# POST – Toggle enabled (1 item)
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/tools/{tool_id:uuid}/toggle-enabled")
async def admin_tools_toggle_enabled(request: Request, tool_id: UUID) -> Template:
    form = await request.form()
    f = _extract_filters(request, form)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        tool = db.get(ToolDefinition, str(tool_id))
        if not tool:
            raise HTTPException(status_code=404)

        tool.tool_enabled = not tool.tool_enabled
        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="toggle_tool_enabled",
                log_target_table="tool_definitions",
                log_target_id=tool.tool_id,
                log_after={"enabled": tool.tool_enabled},
                log_created_at=now_tz(),
            )
        )
        db.commit()

    return _render_tools_fragment(request, override_filters=f)


# ──────────────────────────────────────────────────────────────────────────────
# POST – Bulk enable/disable/delete(=hide)
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/tools/bulk-enable")
async def admin_tools_bulk_enable(request: Request) -> Template:
    form = await request.form()
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        tools = db.query(ToolDefinition).filter(ToolDefinition.tool_id.in_(ids)).all()

        affected = 0
        already_enabled = 0

        for t in tools:
            if not t.tool_enabled:
                t.tool_enabled = True
                affected += 1
            else:
                already_enabled += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=user.user_id,
                    log_action="bulk_enable_tools",
                    log_target_table="tool_definitions",
                    log_description=f"Bulk enable {affected} / {len(ids)} tools",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    resp = _render_tools_fragment(request, override_filters=f)

    payload = {
        "entity": "tools",
        "action": "enable",
        "total": len(ids),
        "affected": affected,
        "already_enabled": already_enabled,
        "msg": ("Đã bật enabled cho các mục đã chọn." if affected > 0 else "Tất cả mục đã bật sẵn."),
    }
    resp.headers["HX-Trigger"] = json.dumps({"tools-bulk-result": payload})
    return resp


@post("/admin/tools/bulk-disable")
async def admin_tools_bulk_disable(request: Request) -> Template:
    form = await request.form()
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        tools = db.query(ToolDefinition).filter(ToolDefinition.tool_id.in_(ids)).all()

        affected = 0
        already_disabled = 0

        for t in tools:
            if t.tool_enabled:
                t.tool_enabled = False
                affected += 1
            else:
                already_disabled += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=user.user_id,
                    log_action="bulk_disable_tools",
                    log_target_table="tool_definitions",
                    log_description=f"Bulk disable {affected} / {len(ids)} tools",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    resp = _render_tools_fragment(request, override_filters=f)

    payload = {
        "entity": "tools",
        "action": "disable",
        "total": len(ids),
        "affected": affected,
        "already_disabled": already_disabled,
        "msg": ("Đã tắt enabled cho các mục đã chọn." if affected > 0 else "Tất cả mục đã bị tắt sẵn."),
    }
    resp.headers["HX-Trigger"] = json.dumps({"tools-bulk-result": payload})
    return resp


@post("/admin/tools/bulk-delete")
async def admin_tools_bulk_delete(request: Request) -> Template:
    """
    Ẩn nhiều tool (soft hide): set tool_enabled=False.
    Luôn trả về fragment #tools-list-region để HTMX swap.
    """
    form = await request.form()
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        q = db.query(ToolDefinition).filter(ToolDefinition.tool_id.in_(ids))
        affected = 0
        for t in q.all():
            if t.tool_enabled:
                t.tool_enabled = False
                affected += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=user.user_id,
                    log_action="bulk_hide_tools",
                    log_target_table="tool_definitions",
                    log_description=f"Bulk hide {affected} / {len(ids)} tools",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    return _render_tools_fragment(request, override_filters=f)


# ──────────────────────────────────────────────────────────────────────────────
# GET – Export CSV (+ redirect path cũ)
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/tools/export-csv")
async def admin_tools_export_csv(request: Request) -> Response:
    """
    Xuất danh sách tool ra CSV.
    Nếu có ?ids=... sẽ xuất theo danh sách đó; nếu không sẽ xuất theo filter hiện tại.
    Sort không ảnh hưởng CSV (mặc định created_at DESC).
    """
    ids = _parse_ids_csv(request.query_params.get("ids"))
    f = _extract_filters(request, None)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        stmt = select(ToolDefinition)
        if ids:
            stmt = stmt.where(ToolDefinition.tool_id.in_(ids))
        else:
            stmt = _apply_filters_to_stmt(stmt, f)

        tools = db.scalars(stmt.order_by(ToolDefinition.tool_created_at.desc())).all()

        rows = [
            (
                t.tool_name,
                t.tool_description or "",
                t.tool_access_scope,
                "1" if t.tool_enabled else "0",
                t.tool_sort_order if t.tool_sort_order is not None else "",
                (t.tool_created_at.astimezone().strftime("%d/%m/%Y %H:%M") if t.tool_created_at else ""),
                (t.tool_updated_at.astimezone().strftime("%d/%m/%Y %H:%M") if t.tool_updated_at else ""),
            )
            for t in tools
        ]

        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="export_tools_csv",
                log_target_table="tool_definitions",
                log_description=(f"Export selected {len(ids)} tools" if ids else f"Export {len(tools)} tools"),
                log_created_at=now_tz(),
            )
        )
        db.commit()

    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(
        [
            "tool_name",
            "tool_description",
            "tool_access_scope",
            "tool_enabled",
            "tool_sort_order",
            "created_at",
            "updated_at",
        ]
    )
    for r in rows:
        w.writerow(r)

    csv_data = "\ufeff" + out.getvalue()
    return Response(
        csv_data,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="admin_tools_{now_tz().strftime("%Y%m%d_%H%M%S")}.csv"',
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


# Backward-compat: đường dẫn cũ '/admin/tools/export' → redirect sang '/admin/tools/export-csv'
@get("/admin/tools/export")
async def admin_tools_export_redirect(request: Request) -> Redirect:
    qs = request.url.query or ""
    target = "/admin/tools/export-csv" + (("?" + qs) if qs else "")
    return Redirect(target, status_code=302)

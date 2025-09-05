# file: src/modules/admin/routes/admin_notify.py
# updated: 2025-08-25 (v5.2)
# note:
# - Thêm phân trang: page / per_page (clamp 5..50), auto-snap page khi vượt total_pages.
# - _extract_filters() đọc đủ v/sort/q/start/end + page/per_page (ưu tiên FORM rồi đến QUERY; hỗ trợ alias sort UI).
# - _query_notifications() trả (items, total, page, pages) với limit/offset + sort.
# - Tất cả render fragment đều kèm meta phân trang cho template/JS.
# - Các hành vi ẩn/xoá mềm/bulk giữ nguyên, trả về fragment đã phân trang.
# - Fix: sửa tên template calendar từ 'calender' -> 'calendar'.

from __future__ import annotations

from datetime import date, datetime
from typing import NamedTuple, Optional, Tuple

import csv
import io
from urllib.parse import quote_plus

from litestar import delete, get, post, put, Request
from litestar.exceptions import HTTPException
from litestar.response import Redirect, Response, Template
from sqlalchemy import select, func
from sqlalchemy.orm import Session, joinedload, selectinload

from core.db.engine import SessionLocal
from core.db.models import (
    NotificationRecipient,
    SystemAdminLog,
    SystemNotification,
    User,
)
from shared.csrf import validate_csrf
from shared.secure_cookie import (
    generate_csrf_token,
    get_csrf_cookie,
    set_csrf_cookie,
)
from shared.timezone import now_tz


# ──────────────────────────────
# Phân trang – hằng số
# ──────────────────────────────
PP_MIN = 5
PP_MAX = 50
PP_DEFAULT = 10  # client sẽ auto-fit; server để mặc định hợp lý


# ──────────────────────────────
# Helpers chung
# ──────────────────────────────
def _ensure_admin(request: Request, db: Session) -> User:
    user_in_scope = request.scope.get("user")
    if not user_in_scope:
        raise HTTPException(status_code=302, headers={"Location": "/auth/login"})

    user = (
        db.execute(
            select(User)
            .options(selectinload(User.settings))
            .where(User.user_id == user_in_scope.user_id)
        )
        .scalars()
        .first()
    )
    if not user or user.user_role != "admin" or user.user_status != "active":
        raise HTTPException(status_code=404)

    _ = user.settings.setting_theme if user.settings else None
    return user


def parse_date_str(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None


def _truthy(v: str | None) -> bool:
    return str(v or "").lower() in {"1", "true", "yes", "on"}


def _parse_ids_list(s: str | None) -> list[str]:
    if not s:
        return []
    parts = [p.strip() for p in str(s).split(",")]
    return [p for p in parts if p]


def _parse_int(s: str | None, default: int) -> int:
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


# ──────────────────────────────
# Toolbar v2 – Filter model
# ──────────────────────────────
ALLOWED_VIS = {"all", "visible", "hidden"}
ALLOWED_SORT = {"created_desc", "created_asc", "az", "za"}

# map về khóa UI (new|old|az|za) để template dùng
UI_SORT_MAP = {"created_desc": "new", "created_asc": "old", "az": "az", "za": "za"}


def _normalize_sort(k: str) -> str:
    """Chấp nhận cả khóa UI và khóa canonical; trả về canonical."""
    kk = (k or "").strip().lower()
    if kk in ALLOWED_SORT:
        return kk
    if kk == "new":
        return "created_desc"
    if kk == "old":
        return "created_asc"
    return "created_desc"


class NotifyFilter(NamedTuple):
    v: str = "all"  # all | visible | hidden
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    sort: str = "created_desc"  # created_desc | created_asc | az | za
    q: str = ""
    page: int = 1
    per_page: int = PP_DEFAULT


def _extract_filters(request: Request, form: dict | None = None) -> NotifyFilter:
    """Ưu tiên FORM (POST/PUT/DELETE), fallback query. Hỗ trợ alias view~v và sort UI."""
    def _get_from(source: dict, name: str) -> str:
        return (source.get(name) or "").strip() if source and name in source else ""

    def _get_any(names: tuple[str, ...], default: str = "") -> str:
        # 1) từ form, 2) từ query
        for n in names:
            val = _get_from(form or {}, n)
            if val:
                return val
        for n in names:
            val = (request.query_params.get(n) or "").strip()
            if val:
                return val
        return default

    # view / v
    v = (_get_any(("v", "view"), "all") or "all").lower()
    if v not in ALLOWED_VIS:
        v = "all"

    # sort (chấp nhận new|old của UI)
    sort = _normalize_sort(_get_any(("sort",), "created_desc"))

    # search
    q = _get_any(("q",), "")

    # date range
    start_date = parse_date_str(_get_any(("start_date",), ""))
    end_date = parse_date_str(_get_any(("end_date",), ""))

    # paging
    page = _parse_int(_get_any(("page",), "1"), 1)
    if page < 1:
        page = 1
    per_page_raw = _parse_int(_get_any(("per_page", "limit"), str(PP_DEFAULT)), PP_DEFAULT)
    per_page = _clamp_per_page(per_page_raw)

    return NotifyFilter(v=v, start_date=start_date, end_date=end_date, sort=sort, q=q, page=page, per_page=per_page)


def _build_filter_qs(f: NotifyFilter) -> str:
    """Tạo query-string tối giản: chỉ đẩy param khi KHÔNG phải mặc định."""
    parts: list[str] = []
    if f.v and f.v != "all":
        parts.append(f"v={f.v}")
    if f.sort and f.sort != "created_desc":
        parts.append(f"sort={f.sort}")
    if f.q:
        parts.append(f"q={quote_plus(f.q)}")  # encode an toàn
    if f.start_date and f.end_date:
        parts.append(f"start_date={f.start_date.strftime('%Y-%m-%d')}")
        parts.append(f"end_date={f.end_date.strftime('%Y-%m-%d')}")
    if f.page and f.page != 1:
        parts.append(f"page={f.page}")
    if f.per_page and f.per_page != PP_DEFAULT:
        parts.append(f"per_page={f.per_page}")
    return ("?" + "&".join(parts)) if parts else ""


# ──────────────────────────────
# Query helpers
# ──────────────────────────────
def _apply_filters_to_stmt(stmt, f: NotifyFilter):
    # visibility
    if f.v == "visible":
        stmt = stmt.where(SystemNotification.notify_visible.is_(True))
    elif f.v == "hidden":
        stmt = stmt.where(SystemNotification.notify_visible.is_(False))

    # date range
    if f.start_date and f.end_date and f.end_date >= f.start_date:
        stmt = stmt.where(
            SystemNotification.notify_created_at
            >= datetime.combine(f.start_date, datetime.min.time()),
            SystemNotification.notify_created_at
            <= datetime.combine(f.end_date, datetime.max.time()),
        )

    # search
    if f.q:
        stmt = stmt.where(SystemNotification.notify_content.ilike(f"%{f.q}%"))

    return stmt


def _apply_sort(stmt, f: NotifyFilter):
    if f.sort == "created_asc":
        return stmt.order_by(SystemNotification.notify_created_at.asc())
    elif f.sort == "az":
        return stmt.order_by(
            func.lower(SystemNotification.notify_content).asc(),
            SystemNotification.notify_created_at.desc(),
        )
    elif f.sort == "za":
        return stmt.order_by(
            func.lower(SystemNotification.notify_content).desc(),
            SystemNotification.notify_created_at.desc(),
        )
    else:
        return stmt.order_by(SystemNotification.notify_created_at.desc())


def _query_notifications(db: Session, f: NotifyFilter) -> Tuple[list[SystemNotification], int, int, int]:
    """
    Trả về: (items, total, actual_page, total_pages)
    """
    # Count
    count_stmt = _apply_filters_to_stmt(select(func.count(SystemNotification.notify_id)), f)
    total = int(db.scalar(count_stmt) or 0)

    # Tính trang hợp lệ
    per_page = _clamp_per_page(f.per_page or PP_DEFAULT)
    pages = max(1, (total + per_page - 1) // per_page)
    page = f.page if f.page >= 1 else 1
    if page > pages:
        page = pages

    # Data
    data_stmt = _apply_filters_to_stmt(select(SystemNotification), f)
    data_stmt = _apply_sort(data_stmt, f)
    offset = (page - 1) * per_page
    data_stmt = data_stmt.offset(offset).limit(per_page)
    items = db.scalars(data_stmt).all()

    return items, total, page, pages


# ──────────────────────────────
# Render fragment (theo filter v2 + paging)
# ──────────────────────────────
def _render_notify_fragment(
    request: Request,
    *,
    override_filters: NotifyFilter | None = None,
) -> Template:
    f = override_filters or _extract_filters(request, None)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        notifications, total, page, pages = _query_notifications(db, f)

    # đồng bộ key cho HTML
    current_sort_ui = UI_SORT_MAP.get(f.sort, "new")

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/notify/admin_notify_fragment.html",
        context={
            "notifications": notifications,
            "csrf_token": token,
            "user": user,
            # filter states for toolbar
            "filter_v": f.v,
            "filter_sort": f.sort,
            "filter_q": f.q,
            "filter_start_date": f.start_date,
            "filter_end_date": f.end_date,
            # compat với template
            "current_sort": current_sort_ui,  # new|old|az|za
            "q": f.q,
            # paging meta
            "page": page,
            "per_page": f.per_page,
            "total": total,
            "total_pages": pages,
            "has_prev": page > 1,
            "has_next": page < pages,
            "show_first_btn": page >= 3,  # phục vụ Fix 3
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────
# GET /admin/notify/fragment – fragment SPA/HTMX
# ──────────────────────────────
@get("/admin/notify/fragment")
async def admin_notify_fragment_get(request: Request) -> Template:
    return _render_notify_fragment(request)


# ──────────────────────────────
# GET /admin/notify – full page hoặc fragment
# ──────────────────────────────
@get("/admin/notify")
async def admin_notify_page(request: Request) -> Template:
    hx_request = request.headers.get("HX-Request", "").lower() == "true"
    if hx_request:
        return _render_notify_fragment(request)

    f = _extract_filters(request, None)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        notifications, total, page, pages = _query_notifications(db, f)

    current_sort_ui = UI_SORT_MAP.get(f.sort, "new")

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/notify/admin_notify.html",
        context={
            "user": user,
            "notifications": notifications,
            "csrf_token": token,
            # filter states
            "filter_v": f.v,
            "filter_sort": f.sort,
            "filter_q": f.q,
            "filter_start_date": f.start_date,
            "filter_end_date": f.end_date,
            # compat
            "current_sort": current_sort_ui,
            "q": f.q,
            # paging
            "page": page,
            "per_page": f.per_page,
            "total": total,
            "total_pages": pages,
            "has_prev": page > 1,
            "has_next": page < pages,
            "show_first_btn": page >= 3,  # phục vụ Fix 3
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────
# GET /admin/notify/calendar-modal – Modal lịch (SPA)
# ──────────────────────────────
@get("/admin/notify/calendar-modal")
async def admin_notify_calendar_modal(request: Request) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    today = now_tz().date()
    resp = Template(
        template_name="admin/notify/admin_notify_calendar_modal.html",  # ← fixed name
        context={
            "csrf_token": token,
            "user": user,
            "start_date": today,
            "end_date": today,
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────
# GET /admin/notify/new-modal – Modal tạo mới
# ──────────────────────────────
@get("/admin/notify/new-modal")
async def admin_notify_new_modal(request: Request) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/notify/admin_notify_new_modal.html",
        context={"csrf_token": token, "user": user},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────
# GET /admin/notify/{notify_id}/edit-modal – Modal chỉnh sửa
# ──────────────────────────────
@get("/admin/notify/{notify_id:str}/edit-modal")
async def admin_notify_edit_modal(request: Request, notify_id: str) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        notif = (
            db.query(SystemNotification)
            .options(joinedload(SystemNotification.created_by))
            .filter_by(notify_id=notify_id)
            .first()
        )
        if not notif:
            raise HTTPException(status_code=404)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/notify/admin_notify_edit_modal.html",
        context={"notification": notif, "csrf_token": token, "user": user},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────
# GET /admin/notify/{notify_id}/detail-modal – Modal chi tiết
# ──────────────────────────────
@get("/admin/notify/{notify_id:str}/detail-modal")
async def admin_notify_detail_modal(request: Request, notify_id: str) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        notif = (
            db.query(SystemNotification)
            .options(joinedload(SystemNotification.created_by))
            .filter_by(notify_id=notify_id)
            .first()
        )
        if not notif:
            raise HTTPException(status_code=404)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/notify/admin_notify_detail_modal.html",
        context={"notification": notif, "csrf_token": token, "user": user},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────
# GET /admin/notify/{notify_id}/delete-modal – Modal xoá mềm
# ──────────────────────────────
@get("/admin/notify/{notify_id:str}/delete-modal")
async def admin_notify_delete_modal(request: Request, notify_id: str) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        notif = db.get(SystemNotification, notify_id)
        if not notif:
            raise HTTPException(status_code=404)
    token = get_csrf_cookie(request) or generate_csrf_token()
    delete_url = f"/admin/notify/{notify_id}/hide"
    delete_url_delete = f"/admin/notify/{notify_id}"
    resp = Template(
        template_name="admin/notify/admin_notify_delete_modal.html",
        context={
            "csrf_token": token,
            "delete_url": delete_url,
            "delete_url_delete": delete_url_delete,
            "already_hidden": (not notif.notify_visible),
            "user": user,
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────
# NEW: GET /admin/notify/bulk-delete-modal – Modal ẩn nhiều mục
# ──────────────────────────────
@get("/admin/notify/bulk-delete-modal")
async def admin_notify_bulk_delete_modal(request: Request) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    ids_csv = (request.query_params.get("ids") or "").strip()
    selected_count = len([p for p in (ids_csv.split(",") if ids_csv else []) if p])
    resp = Template(
        template_name="admin/notify/admin_notify_bulk_delete_modal.html",
        context={"csrf_token": token, "user": user, "ids_csv": ids_csv, "selected_count": selected_count},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────
# NEW: GET /admin/notify/bulk-export-modal – Modal export CSV
# ──────────────────────────────
@get("/admin/notify/bulk-export-modal")
async def admin_notify_bulk_export_modal(request: Request) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    ids_csv = (request.query_params.get("ids") or "").strip()
    selected_count = len([p for p in (ids_csv.split(",") if ids_csv else []) if p])
    resp = Template(
        template_name="admin/notify/admin_notify_bulk_export_modal.html",
        context={"csrf_token": token, "user": user, "ids_csv": ids_csv, "selected_count": selected_count},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────
# POST – Tạo mới thông báo (giữ filter)
# ──────────────────────────────
@post("/admin/notify")
async def admin_notify_create(request: Request) -> Template | Redirect:
    form = await request.form()

    content = (form.get("notify_content") or "").strip()
    roles = (
        form.getall("notify_target_roles")
        if hasattr(form, "getall")
        else form.get("notify_target_roles")
    )
    if isinstance(roles, str):
        roles = [roles]
    if roles is None:
        roles = []
    visible = _truthy(form.get("notify_visible"))

    f = _extract_filters(request, form)

    if not content:
        raise HTTPException(status_code=422, detail="Nội dung không được để trống")
    if not roles:
        raise HTTPException(status_code=422, detail="Phải chọn ít nhất một nhóm nhận")

    with SessionLocal() as db:
        user = _ensure_admin(request, db)

        notif = SystemNotification(
            notify_content=content,
            notify_target_roles=roles,
            notify_created_by=user.user_id,
            notify_visible=visible,
            notify_created_at=now_tz(),
        )
        db.add(notif)
        db.flush()

        stmt = select(User.user_id).where(User.user_role.in_(roles))
        for (uid,) in db.execute(stmt):
            db.add(NotificationRecipient(notify_id=notif.notify_id, user_id=uid))

        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="create_notification",
                log_target_table="system_notifications",
                log_target_id=notif.notify_id,
                log_after={"content": content, "roles": roles, "visible": visible},
                log_created_at=now_tz(),
            )
        )
        db.commit()

    if request.headers.get("HX-Request", "").lower() == "true":
        return _render_notify_fragment(request, override_filters=f)
    return Redirect("/admin/notify" + _build_filter_qs(f), status_code=302)


# ──────────────────────────────
# PUT – Cập nhật thông báo (giữ filter)
# ──────────────────────────────
@put("/admin/notify/{notify_id:str}")
async def admin_notify_update(request: Request, notify_id: str) -> Template | Redirect:
    form = await request.form()

    content = (form.get("notify_content") or "").strip()
    roles = (
        form.getall("notify_target_roles")
        if hasattr(form, "getall")
        else form.get("notify_target_roles")
    )
    if isinstance(roles, str):
        roles = [roles]
    if roles is None:
        roles = []
    visible = _truthy(form.get("notify_visible"))

    f = _extract_filters(request, form)

    if not content:
        raise HTTPException(status_code=422, detail="Nội dung không được để trống")
    if not roles:
        raise HTTPException(status_code=422, detail="Phải chọn ít nhất một nhóm nhận")

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        notif = db.get(SystemNotification, notify_id)
        if not notif:
            raise HTTPException(status_code=404)

        before = {
            "content": notif.notify_content,
            "roles": notif.notify_target_roles,
            "visible": notif.notify_visible,
        }

        notif.notify_content = content
        notif.notify_target_roles = roles
        notif.notify_visible = visible
        db.commit()

        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="update_notification",
                log_target_table="system_notifications",
                log_target_id=notif.notify_id,
                log_before=before,
                log_after={"content": content, "roles": roles, "visible": visible},
                log_created_at=now_tz(),
            )
        )
        db.commit()

    if request.headers.get("HX-Request", "").lower() == "true":
        return _render_notify_fragment(request, override_filters=f)
    return Redirect("/admin/notify" + _build_filter_qs(f), status_code=302)


# ──────────────────────────────
# POST (fallback) – Ẩn một thông báo
# ──────────────────────────────
@post("/admin/notify/{notify_id:str}/hide")
async def admin_notify_hide_post(request: Request, notify_id: str) -> Template:
    await validate_csrf(request)
    form = await request.form()                 # ← lấy form
    f = _extract_filters(request, form)         # ← ưu tiên form

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        notif = db.get(SystemNotification, notify_id)
        if not notif:
            raise HTTPException(status_code=404)

        if notif.notify_visible:
            notif.notify_visible = False
            db.add(
                SystemAdminLog(
                    log_admin_id=user.user_id,
                    log_action="hide_notification",
                    log_target_table="system_notifications",
                    log_target_id=notif.notify_id,
                    log_after={"visible": False},
                    log_created_at=now_tz(),
                )
            )
            db.commit()
        # nếu đã ẩn rồi: idempotent, không log thêm

    return _render_notify_fragment(request, override_filters=f)


# ──────────────────────────────
# POST – Bulk hide (ids="id1,id2,...")
# ──────────────────────────────
@post("/admin/notify/bulk-hide")
async def admin_notify_bulk_hide(request: Request) -> Template:
    await validate_csrf(request)
    form = await request.form()
    ids = _parse_ids_list(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        q = db.query(SystemNotification).filter(SystemNotification.notify_id.in_(ids))
        affected = 0
        for notif in q.all():
            if notif.notify_visible:
                notif.notify_visible = False
                affected += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=user.user_id,
                    log_action="bulk_hide_notification",
                    log_target_table="system_notifications",
                    log_description=f"Bulk hide {affected} / {len(ids)} notifications",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    return _render_notify_fragment(request, override_filters=f)


# ──────────────────────────────
# DELETE – Ẩn / “xoá mềm”
# ──────────────────────────────
@delete("/admin/notify/{notify_id:str}", status_code=200)
async def admin_notify_hide(request: Request, notify_id: str) -> Template:
    await validate_csrf(request)
    # DELETE đôi khi có body (HTMX), cố gắng đọc form trước – nếu lỗi thì bỏ qua
    try:
        form = await request.form()
    except Exception:
        form = None
    f = _extract_filters(request, form)          # ← ưu tiên form nếu có

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        notif = db.get(SystemNotification, notify_id)
        if not notif:
            raise HTTPException(status_code=404)

        if notif.notify_visible:
            notif.notify_visible = False
            db.add(
                SystemAdminLog(
                    log_admin_id=user.user_id,
                    log_action="hide_notification",
                    log_target_table="system_notifications",
                    log_target_id=notif.notify_id,
                    log_after={"visible": False},
                    log_created_at=now_tz(),
                )
            )
        # nếu đã ẩn rồi: idempotent, không log thêm
        db.commit()

    return _render_notify_fragment(request, override_filters=f)


# ──────────────────────────────
# GET /admin/notify/export-csv – Xuất CSV (hỗ trợ ids=...)
# ──────────────────────────────
@get("/admin/notify/export-csv")
async def admin_notify_export_csv(request: Request) -> Response:
    """
    Xuất danh sách thông báo ra file CSV. Nếu có ?ids=... thì ưu tiên danh sách đó,
    nếu không có thì áp dụng filter hiện tại (v/view, q, start/end). Sort không ảnh hưởng CSV.
    """
    ids = _parse_ids_list(request.query_params.get("ids"))

    f = _extract_filters(request, None)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        stmt = select(SystemNotification).options(joinedload(SystemNotification.created_by))

        if ids:
            stmt = stmt.where(SystemNotification.notify_id.in_(ids))
        else:
            stmt = _apply_filters_to_stmt(stmt, f)

        notifications = db.scalars(
            stmt.order_by(SystemNotification.notify_created_at.desc())
        ).all()

        export_rows = [
            (
                (n.notify_content or "").replace("\r", " ").replace("\n", " "),
                ", ".join(n.notify_target_roles or []),
                "Hiện" if n.notify_visible else "Đã ẩn",
                n.notify_created_at.astimezone().strftime("%d/%m/%Y %H:%M"),
                n.created_by.user_display_name if n.created_by else "",
            )
            for n in notifications
        ]

        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="export_notify_csv",
                log_target_table="system_notifications",
                log_description=(
                    f"Export selected {len(ids)} notifications" if ids
                    else f"Export {len(notifications)} notifications (v={f.v}, q={'yes' if f.q else 'no'})"
                ),
                log_created_at=now_tz(),
            )
        )
        db.commit()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["noi_dung", "nhom_nhan", "hien_thi", "ngay_tao", "nguoi_tao"])
    for row in export_rows:
        writer.writerow(row)
    csv_data = "\ufeff" + output.getvalue()  # BOM UTF-8

    return Response(
        csv_data,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="thong_bao_admin_{now_tz().strftime("%Y%m%d_%H%M%S")}.csv"',
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )

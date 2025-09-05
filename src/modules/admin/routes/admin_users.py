# file: src/modules/admin/routes/admin_users.py
# updated: 2025-08-24 (v1.4.2 – thêm eager-load User.settings cho avatar)
# note:
# - Trang quản trị "Người dùng" (User): list + filter + paging + bulk + export CSV
# - Modal đơn lẻ (new/detail/edit/delete) + create/update/delete (DELETE soft)
# - Soft delete: set user_status = 'deactivated'
# - HTMX fragment; trả về fragment sau thao tác + HX-Trigger cho toast
# - CSRF: dùng middleware CsrfGuard (POST/PUT/DELETE); GET modal/fragment/export là skip
# - NEW:
#   • GET /admin/users/check_email_unique -> trả {"unique": true|false}
#   • Update: tài khoản OAuth không cho đổi email/verified; Local đổi email -> ép verified=False
#   • Duplicate email khi UPDATE: trả HX-Trigger reason="duplicate_email"
#   • Server enforce: SSO verified read-only (chặn toggle + bulk verify/unverify bỏ qua SSO)
#   • Bulk multiplexer: POST /admin/users/bulk (map action -> các handler bulk sẵn có)
#   • FIX: bỏ monkey-patch request.form; dùng form_override cho các helper bulk
#   • NEW UI helpers:
#       - GET /admin/users/bulk-confirm-modal (modal xác nhận bulk + tính trước affected / skipped)
#       - GET /admin/users/sort (fix UI sắp xếp)
# - IMPROVE (v1.4.0):
#   • An toàn bulk: mô phỏng giảm dần số admin active trong cùng batch để không bao giờ hạ hết admin active.
#   • Sort “last_login_desc/asc” (nếu model có cột user_last_login; nếu không thì fallback created_at).
#   • /check_email_unique: chuẩn hoá so sánh exclude_id bằng str().
#   • HX-Trigger khi UPDATE: thêm password_changed=False cho UI không phải đoán.
# - IMPROVE (v1.4.1):
#   • UPDATE (local): hỗ trợ đổi mật khẩu (scrypt) + force re-verify khi có thay đổi nhạy cảm.
from __future__ import annotations

from datetime import datetime, date
from typing import NamedTuple, Tuple, List, Dict, Any
from uuid import UUID
import csv
import io
import json

from litestar import get, post, put, delete, Request
from litestar.exceptions import HTTPException
from litestar.response import Template, Redirect, Response
from litestar.status_codes import HTTP_422_UNPROCESSABLE_ENTITY
from sqlalchemy import select, func, or_, and_
from sqlalchemy.orm import Session, joinedload  # <— v1.4.2: joinedload để eager-load avatar
from werkzeug.security import generate_password_hash  # v1.4.1: dùng scrypt khi đổi mật khẩu

from core.db.engine import SessionLocal
from core.db.models import User, SystemAdminLog
from shared.secure_cookie import generate_csrf_token, get_csrf_cookie, set_csrf_cookie
from shared.timezone import now_tz
# (optional) nếu sau này muốn gửi mã ngay tại đây:
# from modules.auth.routes.auth import _send_verify_code  # noqa


# ──────────────────────────────────────────────────────────────────────────────
# Config chung
# ──────────────────────────────────────────────────────────────────────────────
PP_MIN = 5
PP_MAX = 50
PP_DEFAULT = 10

ALLOWED_STATUS = {"all", "active", "suspended", "banned", "deactivated"}
ALLOWED_ROLE = {"all", "admin", "user", "internal"}
ALLOWED_VERIFIED = {"all", "yes", "no"}

# canonical sort keys
ALLOWED_SORT = {
    "created_desc",
    "created_asc",
    "name_az",
    "name_za",
    "email_az",
    "email_za",
    "role_az",
    "role_za",
    "status_az",
    "status_za",
    # optional nếu có cột last login
    "last_login_desc",
    "last_login_asc",
}

# map → khóa UI cho template
UI_SORT_MAP = {
    "created_desc": "new",
    "created_asc": "old",
    "name_az": "name_az",
    "name_za": "name_za",
    "email_az": "email_az",
    "email_za": "email_za",
    "role_az": "role_az",
    "role_za": "role_za",
    "status_az": "status_az",
    "status_za": "status_za",
    "last_login_desc": "login_new",
    "last_login_asc": "login_old",
}

ROLE_OPTIONS = ["admin", "user", "internal"]
STATUS_OPTIONS = ["active", "suspended", "banned", "deactivated"]


# ──────────────────────────────────────────────────────────────────────────────
# Helpers chung
# ──────────────────────────────────────────────────────────────────────────────
def _ensure_admin(request: Request, db: Session):
    """
    Đảm bảo user đăng nhập là admin & active.
    (Middleware đã gate /admin/**, nên nhánh này chỉ là hàng rào thứ 2.)
    """
    user_in_scope = request.scope.get("user")
    if not user_in_scope:
        raise HTTPException(status_code=302, headers={"Location": "/auth/login"})

    row = db.execute(
        select(User.user_role, User.user_status).where(User.user_id == user_in_scope.user_id)
    ).first()
    if not row:
        raise HTTPException(status_code=404)

    role, status = row
    if role != "admin" or status != "active":
        raise HTTPException(status_code=404)

    return user_in_scope


def _get_user_or_404(db: Session, user_id: UUID) -> User:
    u = db.get(User, str(user_id))
    if not u:
        raise HTTPException(status_code=404)
    return u


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
    if kk in {"az", "name", "name_asc"}:
        return "name_az"
    if kk in {"za", "name_desc"}:
        return "name_za"
    if kk in {"email", "email_asc"}:
        return "email_az"
    if kk == "email_desc":
        return "email_za"
    if kk in {"role", "role_asc"}:
        return "role_az"
    if kk == "role_desc":
        return "role_za"
    if kk in {"status", "status_asc"}:
        return "status_az"
    if kk == "status_desc":
        return "status_za"
    # sort theo last login (UI)
    if kk in {"login_new", "last_login_desc"}:
        return "last_login_desc"
    if kk in {"login_old", "last_login_asc"}:
        return "last_login_asc"
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
class UserFilter(NamedTuple):
    status: str = "all"      # active|suspended|banned|deactivated|all
    role: str = "all"        # admin|user|internal|all
    verified: str = "all"    # yes|no|all
    provider: str = ""       # oauth provider exact; 'local' = None
    q: str = ""              # tìm theo name/display_name/email
    sort: str = "created_desc"
    page: int = 1
    per_page: int = PP_DEFAULT


def _extract_filters(request: Request, form: dict | None = None) -> UserFilter:
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

    status = (_get_any(("status",), "all") or "all").lower()
    if status not in ALLOWED_STATUS:
        status = "all"

    role = (_get_any(("role",), "all") or "all").lower()
    if role not in ALLOWED_ROLE:
        role = "all"

    verified = (_get_any(("verified",), "all") or "all").lower()
    if verified not in ALLOWED_VERIFIED:
        verified = "all"

    provider = _get_any(("provider",), "")

    q = _get_any(("q", "search"), "")

    sort = _normalize_sort(_get_any(("sort",), "created_desc"))

    page = _parse_int(_get_any(("page",), "1"), 1) or 1
    if page < 1:
        page = 1

    per_page_raw = _parse_int(_get_any(("per_page", "limit"), str(PP_DEFAULT)), PP_DEFAULT) or PP_DEFAULT
    per_page = _clamp_per_page(per_page_raw)

    return UserFilter(status=status, role=role, verified=verified, provider=provider, q=q, sort=sort, page=page, per_page=per_page)


def _build_filter_qs(f: UserFilter) -> str:
    """Sinh query-string tối giản theo filter hiện tại (bỏ mặc định)."""
    parts: List[str] = []
    if f.status != "all":
        parts.append(f"status={f.status}")
    if f.role != "all":
        parts.append(f"role={f.role}")
    if f.verified != "all":
        parts.append(f"verified={f.verified}")
    if f.provider:
        parts.append(f"provider={f.provider}")
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
def _is_sso_expr():
    """Biểu thức: account có oauth_provider khác null & khác rỗng."""
    return and_(User.user_oauth_provider.is_not(None), User.user_oauth_provider != "")


def _is_local_expr():
    return or_(User.user_oauth_provider.is_(None), User.user_oauth_provider == "")


def _apply_filters_to_stmt(stmt, f: UserFilter):
    # status
    if f.status in {"active", "suspended", "banned", "deactivated"}:
        stmt = stmt.where(User.user_status == f.status)

    # role
    if f.role in {"admin", "user", "internal"}:
        stmt = stmt.where(User.user_role == f.role)

    # verified
    # YES: coi SSO là verified; NO: chỉ local chưa verified
    if f.verified == "yes":
        stmt = stmt.where(
            or_(User.user_email_verified.is_(True), _is_sso_expr())
        )
    elif f.verified == "no":
        stmt = stmt.where(
            and_(_is_local_expr(), User.user_email_verified.is_(False))
        )

    # provider
    if f.provider:
        if f.provider.lower() == "local":
            stmt = stmt.where(_is_local_expr())  # local login
        else:
            stmt = stmt.where(User.user_oauth_provider == f.provider)

    # q ~ name/display/email
    if f.q:
        like = f"%{f.q}%"
        stmt = stmt.where(
            or_(
                User.user_name.ilike(like),
                User.user_display_name.ilike(like),
                User.user_email.ilike(like),
            )
        )

    return stmt


def _apply_sort(stmt, f: UserFilter):
    if f.sort == "created_asc":
        return stmt.order_by(User.user_created_at.asc())
    if f.sort == "name_az":
        return stmt.order_by(func.lower(User.user_display_name).asc(), func.lower(User.user_name).asc(), User.user_created_at.desc())
    if f.sort == "name_za":
        return stmt.order_by(func.lower(User.user_display_name).desc(), func.lower(User.user_name).desc(), User.user_created_at.desc())
    if f.sort == "email_az":
        return stmt.order_by(func.lower(User.user_email).asc(), User.user_created_at.desc())
    if f.sort == "email_za":
        return stmt.order_by(func.lower(User.user_email).desc(), User.user_created_at.desc())
    if f.sort == "role_az":
        return stmt.order_by(func.lower(User.user_role).asc(), User.user_created_at.desc())
    if f.sort == "role_za":
        return stmt.order_by(func.lower(User.user_role).desc(), User.user_created_at.desc())
    if f.sort == "status_az":
        return stmt.order_by(func.lower(User.user_status).asc(), User.user_created_at.desc())
    if f.sort == "status_za":
        return stmt.order_by(func.lower(User.user_status).desc(), User.user_created_at.desc())
    if f.sort in {"last_login_desc", "last_login_asc"}:
        col = getattr(User, "user_last_login", None)
        if col is not None:
            if f.sort == "last_login_desc":
                return stmt.order_by(col.desc(), User.user_created_at.desc())
            else:
                return stmt.order_by(col.asc(), User.user_created_at.desc())
        return stmt.order_by(User.user_created_at.desc())
    return stmt.order_by(User.user_created_at.desc())


def _query_users(db: Session, f: UserFilter) -> Tuple[list[User], int, int, int]:
    """Trả về (items, total, actual_page, total_pages)."""
    total = int(db.scalar(_apply_filters_to_stmt(select(func.count(User.user_id)), f)) or 0)

    per_page = _clamp_per_page(f.per_page or PP_DEFAULT)
    pages = max(1, (total + per_page - 1) // per_page)
    page = f.page if f.page >= 1 else 1
    if page > pages:
        page = pages

    # v1.4.2: Eager-load settings để lấy avatar trong template mà không lazy-load sau khi session đóng
    base = select(User).options(joinedload(User.settings))
    stmt = _apply_filters_to_stmt(base, f)
    stmt = _apply_sort(stmt, f)
    offset = (page - 1) * per_page
    items = db.scalars(stmt.offset(offset).limit(per_page)).all()
    return items, total, page, pages


# ──────────────────────────────────────────────────────────────────────────────
# Render helpers
# ──────────────────────────────────────────────────────────────────────────────
def _render_users_fragment(request: Request, *, override_filters: UserFilter | None = None) -> Template:
    f = override_filters or _extract_filters(request, None)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        users, total, page, pages = _query_users(db, f)

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/users/admin_users_fragment.html",
        context={
            "user": user,
            "users": users,
            "csrf_token": token,
            # filters
            "filter_status": f.status,
            "filter_role": f.role,
            "filter_verified": f.verified,
            "filter_provider": f.provider,
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
@get("/admin/users/fragment")
async def admin_users_fragment_get(request: Request) -> Template:
    return _render_users_fragment(request)


@get("/admin/users")
async def admin_users_page(request: Request) -> Template:
    hx = request.headers.get("HX-Request", "").lower() == "true"
    if hx:
        return _render_users_fragment(request)

    f = _extract_filters(request, None)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        users, total, page, pages = _query_users(db, f)

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/users/admin_users.html",
        context={
            "user": user,
            "users": users,
            "csrf_token": token,
            # filters
            "filter_status": f.status,
            "filter_role": f.role,
            "filter_verified": f.verified,
            "filter_provider": f.provider,
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
# GET – Modals (single)
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/users/new-modal")
async def admin_users_new_modal(request: Request) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/users/admin_users_new_modal.html",
        context={
            "user": user,
            "csrf_token": token,
            "roles": ROLE_OPTIONS,
            "statuses": STATUS_OPTIONS,
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/users/{user_id:uuid}/detail-modal")
async def admin_users_detail_modal(request: Request, user_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        row = _get_user_or_404(db, user_id)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/users/admin_users_detail_modal.html",
        context={"user": user, "row": row, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/users/{user_id:uuid}/edit-modal")
async def admin_users_edit_modal(request: Request, user_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        row = _get_user_or_404(db, user_id)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/users/admin_users_edit_modal.html",
        context={
            "user": user,
            "row": row,
            "csrf_token": token,
            "roles": ROLE_OPTIONS,
            "statuses": STATUS_OPTIONS,
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/users/{user_id:uuid}/delete-modal")
async def admin_users_delete_modal(request: Request, user_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        row = _get_user_or_404(db, user_id)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/users/admin_users_delete_modal.html",
        context={"user": user, "row": row, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – Bulk modals (giữ API cũ)
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/users/bulk-delete-modal")
async def admin_users_bulk_delete_modal(request: Request) -> Template:
    ids_raw = (request.query_params.get("ids") or "").strip()
    ids = _parse_ids_csv(ids_raw)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/users/admin_users_bulk_delete_modal.html",
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


@get("/admin/users/bulk-export-modal")
async def admin_users_bulk_export_modal(request: Request) -> Template:
    ids_raw = (request.query_params.get("ids") or "").strip()
    ids = _parse_ids_csv(ids_raw)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/users/admin_users_bulk_export_modal.html",
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
# POST – Single create
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/users")
async def admin_users_create(request: Request) -> Template:
    form = await request.form()
    f = _extract_filters(request, form)

    email = (form.get("user_email") or "").strip()
    name = (form.get("user_name") or "").strip()
    display = (form.get("user_display_name") or "").strip()
    role = (form.get("user_role") or "user").strip().lower()
    status = (form.get("user_status") or "active").strip().lower()
    verified = (form.get("user_email_verified") or "").strip() in {"1", "true", "on", "yes"}

    if not email:
        raise HTTPException(status_code=422, detail="Thiếu email người dùng")
    if role not in ROLE_OPTIONS:
        role = "user"
    if status not in STATUS_OPTIONS:
        status = "active"

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)

        # unique email
        exists = db.scalar(select(func.count(User.user_id)).where(func.lower(User.user_email) == email.lower())) or 0
        if exists:
            raise HTTPException(status_code=422, detail="Email đã tồn tại")

        u = User(
            user_email=email,
            user_name=name or email.split("@")[0],
            user_display_name=display or name or email.split("@")[0],
            user_role=role,
            user_status=status,
            user_email_verified=bool(verified),
            user_oauth_provider=None,   # local
            user_oauth_sub=None,
            user_register_ip=str(request.client.host) if request.client else None,
            user_created_at=now_tz(),
            user_updated_at=now_tz(),
        )
        db.add(u)
        db.flush()

        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="create_user",
                log_target_table="users",
                log_target_id=u.user_id,
                log_after={
                    "email": u.user_email,
                    "role": u.user_role,
                    "status": u.user_status,
                    "verified": u.user_email_verified,
                },
                log_created_at=now_tz(),
            )
        )
        db.commit()

    resp = _render_users_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({"users-single-result": {"action": "create", "ok": True}})
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# PUT – Single update (siết logic local/OAuth + duplicate email + password + reverify)
# ──────────────────────────────────────────────────────────────────────────────
@put("/admin/users/{user_id:uuid}")
async def admin_users_update(request: Request, user_id: UUID) -> Template:
    form = await request.form()
    f = _extract_filters(request, form)

    name = (form.get("user_name") or "").strip()
    display = (form.get("user_display_name") or "").strip()
    role = (form.get("user_role") or "").strip().lower()
    status = (form.get("user_status") or "").strip().lower()
    verified_str = (form.get("user_email_verified") or "").strip()
    email_new = (form.get("user_email") or "").strip()

    # v1.4.1 – mật khẩu
    pw1 = (form.get("user_password") or "").strip()
    pw2 = (form.get("user_password_confirm") or "").strip()
    force_reverify = (form.get("force_reverify") or "").strip() in {"1", "true", "on", "yes"}

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        u = _get_user_or_404(db, user_id)

        is_local = not (u.user_oauth_provider and str(u.user_oauth_provider).strip())
        email_changed = False
        username_changed = False
        display_changed = False
        password_changed = False
        reverify_triggered = False

        # 1) Email & verified rules
        if is_local:
            if email_new and email_new != u.user_email:
                # unique (case-insensitive, exclude self)
                exists = db.scalar(
                    select(func.count(User.user_id)).where(
                        func.lower(User.user_email) == email_new.lower(),
                        User.user_id != str(u.user_id),
                    )
                ) or 0
                if exists:
                    resp = _render_users_fragment(request, override_filters=f)
                    resp.headers["HX-Trigger"] = json.dumps(
                        {"users-single-result": {"action": "update", "ok": False, "reason": "duplicate_email"}}
                    )
                    return resp
                u.user_email = email_new
                email_changed = True
                u.user_email_verified = False  # force re-verify khi đổi email
        else:
            # OAuth: bỏ qua mọi thay đổi email/verified từ form
            email_new = u.user_email

        # 2) Profile basics
        if name and name != (u.user_name or ""):
            u.user_name = name
            username_changed = True
        if display and display != (u.user_display_name or ""):
            u.user_display_name = display
            display_changed = True

        # 3) Role
        if role and role in ROLE_OPTIONS:
            u.user_role = role

        # 4) Status (bảo vệ self & last admin)
        if status and status in STATUS_OPTIONS:
            if u.user_id == acting.user_id and status in {"suspended", "banned", "deactivated"}:
                pass
            else:
                if u.user_role == "admin" and u.user_status == "active" and status in {"suspended", "banned", "deactivated"}:
                    active_admin_count = db.scalar(
                        select(func.count(User.user_id)).where(and_(User.user_role == "admin", User.user_status == "active"))
                    ) or 0
                    if active_admin_count > 1:
                        u.user_status = status
                else:
                    u.user_status = status

        # 5) Đổi mật khẩu (LOCAL ONLY)
        if is_local and (pw1 or pw2):
            # UI đã khoá submit nếu mismatch, nhưng vẫn check server-side
            if pw1 != pw2:
                resp = _render_users_fragment(request, override_filters=f)
                resp.headers["HX-Trigger"] = json.dumps(
                    {"users-single-result": {"action": "update", "ok": False, "reason": "password_mismatch"}}
                )
                return resp
            if len(pw1) < 6:
                resp = _render_users_fragment(request, override_filters=f)
                resp.headers["HX-Trigger"] = json.dumps(
                    {"users-single-result": {"action": "update", "ok": False, "reason": "password_too_short"}}
                )
                return resp
            u.user_password_hash = generate_password_hash(pw1, method="scrypt")
            password_changed = True

        # 6) Verified:
        # - Nếu LOCAL và có thay đổi nhạy cảm (email/username/display/password) hoặc force_reverify → ép False.
        # - Ngược lại (LOCAL) nếu không đổi nhạy cảm và form có gửi verified → cập nhật theo form.
        sensitive_changed = any([email_changed, username_changed, display_changed, password_changed])
        if is_local:
            if sensitive_changed or force_reverify:
                if u.user_email_verified:
                    u.user_email_verified = False
                    reverify_triggered = True
                # (nếu muốn gửi mã ngay tại đây, bật _send_verify_code và gắn background task vào Response HTML)
            else:
                if verified_str != "":
                    u.user_email_verified = verified_str in {"1", "true", "on", "yes"}

        u.user_updated_at = now_tz()

        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="update_user",
                log_target_table="users",
                log_target_id=u.user_id,
                log_description=f"Update profile/role/status for {u.user_email}",
                log_after={
                    "email_changed": email_changed,
                    "username_changed": username_changed,
                    "display_changed": display_changed,
                    "password_changed": password_changed,
                    "reverify_triggered": reverify_triggered,
                },
                log_created_at=now_tz(),
            )
        )
        db.commit()

    resp = _render_users_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({
        "users-single-result": {
            "action": "update",
            "ok": True,
            "password_changed": password_changed,
            "reverify": reverify_triggered
        }
    })
    return resp


# DELETE – Single (soft delete)
@delete("/admin/users/{user_id:uuid}", status_code=200, media_type="text/html")
async def admin_users_delete(request: Request, user_id: UUID) -> Template:
    form = await request.form() if request.method in {"POST", "PUT", "DELETE"} else {}
    f = _extract_filters(request, form)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        u = _get_user_or_404(db, user_id)

        # không xoá (deactivate) chính mình
        if u.user_id == acting.user_id:
            db.add(
                SystemAdminLog(
                    log_admin_id=acting.user_id,
                    log_action="skip_delete_self_user",
                    log_target_table="users",
                    log_target_id=u.user_id,
                    log_created_at=now_tz(),
                )
            )
            db.commit()
            resp = _render_users_fragment(request, override_filters=f)
            resp.headers["HX-Trigger"] = json.dumps(
                {"users-single-result": {"action": "delete", "ok": False, "reason": "self"}}
            )
            return resp

        # bảo vệ admin active cuối cùng
        if u.user_role == "admin" and u.user_status == "active":
            active_admin_count = db.scalar(
                select(func.count(User.user_id)).where(and_(User.user_role == "admin", User.user_status == "active"))
            ) or 0
            if active_admin_count <= 1:
                db.add(
                    SystemAdminLog(
                        log_admin_id=acting.user_id,
                        log_action="skip_delete_last_admin",
                        log_target_table="users",
                        log_target_id=u.user_id,
                        log_created_at=now_tz(),
                    )
                )
                db.commit()
                resp = _render_users_fragment(request, override_filters=f)
                resp.headers["HX-Trigger"] = json.dumps(
                    {"users-single-result": {"action": "delete", "ok": False, "reason": "last_admin"}}
                )
                return resp

        # soft delete
        if u.user_status != "deactivated":
            u.user_status = "deactivated"
            u.user_updated_at = now_tz()

        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="deactivate_user",
                log_target_table="users",
                log_target_id=u.user_id,
                log_created_at=now_tz(),
            )
        )
        db.commit()

    resp = _render_users_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({"users-single-result": {"action": "delete", "ok": True}})
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – API: check email unique
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/users/check_email_unique")
async def admin_users_check_email_unique(request: Request) -> Response:
    email = (request.query_params.get("email") or "").strip().lower()
    exclude_id = (request.query_params.get("exclude_id") or "").strip()
    if not email:
        return Response(json.dumps({"unique": False, "reason": "missing_email"}), media_type="application/json", status_code=400)

    with SessionLocal() as db:
        q = select(func.count(User.user_id)).where(func.lower(User.user_email) == email)
        if exclude_id:
            q = q.where(User.user_id != str(exclude_id))
        cnt = int(db.scalar(q) or 0)

    return Response(json.dumps({"unique": cnt == 0}), media_type="application/json", status_code=200)


# ──────────────────────────────────────────────────────────────────────────────
# POST – Single toggles
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/users/{user_id:uuid}/toggle-verified")
async def admin_users_toggle_verified(request: Request, user_id: UUID) -> Template:
    form = await request.form()
    f = _extract_filters(request, form)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        u = _get_user_or_404(db, user_id)

        # SSO read-only: không cho toggle
        if u.user_oauth_provider and str(u.user_oauth_provider).strip():
            resp = _render_users_fragment(request, override_filters=f)
            resp.headers["HX-Trigger"] = json.dumps({"users-single-result": {"action": "toggle_verified", "ok": False, "reason": "sso_readonly"}})
            return resp

        u.user_email_verified = not u.user_email_verified

        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="toggle_user_verified",
                log_target_table="users",
                log_target_id=u.user_id,
                log_after={"verified": u.user_email_verified},
                log_created_at=now_tz(),
            )
        )
        db.commit()

    resp = _render_users_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({"users-single-result": {"action": "toggle_verified", "ok": True}})
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# POST – Bulk helpers (nhận form_override)
# ──────────────────────────────────────────────────────────────────────────────
def _protect_self_and_last_admin(db: Session, acting_admin_id: str, target_users: List[User], target_status: str | None):
    """
    Trả về (skipped_self, skipped_last_admin).
    (Giữ lại để dùng ở vài nhánh; v1.4.0 đã thay cơ chế chính bằng mô phỏng động trong preview/execute.)
    """
    skipped_self = 0
    skipped_last_admin = 0

    active_admin_ids = set(
        x[0]
        for x in db.execute(
            select(User.user_id).where(
                and_(User.user_role == "admin", User.user_status == "active")
            )
        ).all()
    )
    active_admin_count = len(active_admin_ids)

    for u in target_users:
        if u.user_id == acting_admin_id:
            skipped_self += 1
            continue
        if target_status in {"suspended", "banned", "deactivated"} and u.user_id in active_admin_ids:
            if active_admin_count <= 1:
                skipped_last_admin += 1
                continue

    return skipped_self, skipped_last_admin


def _compute_bulk_preview(db: Session, acting_id: str, users: List[User], action: str) -> Dict[str, Any]:
    """Tính số affected / skipped_* để hiển thị trên modal confirm.
    v1.4.0: mô phỏng số admin active còn lại trong chính batch này để không “hết admin”."""
    action = (action or "").lower()
    affected = 0
    skipped_self = 0
    skipped_last_admin = 0
    skipped_sso = 0

    if action in {"activate", "active"}:
        for u in users:
            if u.user_status != "active":
                affected += 1
        return {"affected": affected, "skipped_self": 0, "skipped_last_admin": 0, "skipped_sso": 0}

    if action in {"suspend", "suspended", "pause", "ban", "banned", "deactivate", "deactivated", "disable", "disabled", "delete", "remove"}:
        target = "suspended" if action in {"suspend", "suspended", "pause"} else "banned" if action in {"ban", "banned"} else "deactivated"

        # mô phỏng động:
        active_admin_ids = set(
            x[0]
            for x in db.execute(
                select(User.user_id).where(and_(User.user_role == "admin", User.user_status == "active"))
            ).all()
        )
        active_left = len(active_admin_ids)

        for u in users:
            if u.user_id == acting_id:
                skipped_self += 1
                continue
            is_active_admin = (u.user_id in active_admin_ids)
            will_change = (u.user_status != target)

            if is_active_admin and target in {"suspended", "banned", "deactivated"}:
                if active_left <= 1:
                    skipped_last_admin += 1
                    continue
                if will_change:
                    active_left -= 1

            if will_change:
                affected += 1

        return {"affected": affected, "skipped_self": skipped_self, "skipped_last_admin": skipped_last_admin, "skipped_sso": 0}

    if action in {"verify", "unverify"}:
        for u in users:
            if u.user_oauth_provider and str(u.user_oauth_provider).strip():
                skipped_sso += 1
                continue
            if action == "verify":
                if not u.user_email_verified:
                    affected += 1
            else:
                if u.user_email_verified:
                    affected += 1
        return {"affected": affected, "skipped_self": 0, "skipped_last_admin": 0, "skipped_sso": skipped_sso}

    return {"affected": 0, "skipped_self": 0, "skipped_last_admin": 0, "skipped_sso": 0}


async def _bulk_update_status(request: Request, new_status: str, form_override: dict | None = None) -> Template:
    form = form_override or (await request.form())
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        users = db.query(User).filter(User.user_id.in_(ids)).all()

        # v1.4.0: an toàn – mô phỏng active admin còn lại trong chính batch
        active_admin_ids = set(
            x[0]
            for x in db.execute(
                select(User.user_id).where(and_(User.user_role == "admin", User.user_status == "active"))
            ).all()
        )
        active_left = len(active_admin_ids)

        skipped_self = 0
        skipped_last_admin = 0
        affected = 0

        for u in users:
            if u.user_id == acting.user_id:
                skipped_self += 1
                continue

            is_active_admin = (u.user_id in active_admin_ids)
            will_change = (u.user_status != new_status)

            if is_active_admin and new_status in {"suspended", "banned", "deactivated"}:
                if active_left <= 1:
                    skipped_last_admin += 1
                    continue
                if will_change:
                    active_left -= 1

            if will_change:
                u.user_status = new_status
                u.user_updated_at = now_tz()
                affected += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=acting.user_id,
                    log_action=f"bulk_set_user_status_{new_status}",
                    log_target_table="users",
                    log_description=f"Bulk set status={new_status} {affected} / {len(ids)} users",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    resp = _render_users_fragment(request, override_filters=f)
    payload = {
        "entity": "users",
        "action": f"status_{new_status}",
        "total": len(ids),
        "affected": affected,
        "skipped_self": skipped_self,
        "skipped_last_admin": skipped_last_admin,
    }
    resp.headers["HX-Trigger"] = json.dumps({"users-bulk-result": payload})
    return resp


async def _bulk_verify(request: Request, form_override: dict | None = None) -> Template:
    form = form_override or (await request.form())
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        users = db.query(User).filter(User.user_id.in_(ids)).all()

        affected = 0
        already = 0
        skipped_sso = 0
        for u in users:
            # SSO read-only
            if u.user_oauth_provider and str(u.user_oauth_provider).strip():
                skipped_sso += 1
                continue
            if not u.user_email_verified:
                u.user_email_verified = True
                u.user_updated_at = now_tz()
                affected += 1
            else:
                already += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=acting.user_id,
                    log_action="bulk_verify_users",
                    log_target_table="users",
                    log_description=f"Bulk verify {affected} / {len(ids)} users (skipped_sso={skipped_sso})",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    resp = _render_users_fragment(request, override_filters=f)
    payload = {
        "entity": "users",
        "action": "verify",
        "total": len(ids),
        "affected": affected,
        "already": already,
        "skipped_sso": skipped_sso,
    }
    resp.headers["HX-Trigger"] = json.dumps({"users-bulk-result": payload})
    return resp


async def _bulk_unverify(request: Request, form_override: dict | None = None) -> Template:
    form = form_override or (await request.form())
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        users = db.query(User).filter(User.user_id.in_(ids)).all()

    affected = 0
    already = 0
    skipped_sso = 0
    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        users = db.query(User).filter(User.user_id.in_(ids)).all()
        for u in users:
            # SSO read-only
            if u.user_oauth_provider and str(u.user_oauth_provider).strip():
                skipped_sso += 1
                continue
            if u.user_email_verified:
                u.user_email_verified = False
                u.user_updated_at = now_tz()
                affected += 1
            else:
                already += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=acting.user_id,
                    log_action="bulk_unverify_users",
                    log_target_table="users",
                    log_description=f"Bulk unverify {affected} / {len(ids)} users (skipped_sso={skipped_sso})",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    resp = _render_users_fragment(request, override_filters=f)
    payload = {
        "entity": "users",
        "action": "unverify",
        "total": len(ids),
        "affected": affected,
        "already": already,
        "skipped_sso": skipped_sso,
    }
    resp.headers["HX-Trigger"] = json.dumps({"users-bulk-result": payload})
    return resp


async def _bulk_delete(request: Request, form_override: dict | None = None) -> Template:
    form = form_override or (await request.form())
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        users = db.query(User).filter(User.user_id.in_(ids)).all()

        # v1.4.0: tương tự bulk_update_status – mô phỏng để không hạ hết admin active
        active_admin_ids = set(
            x[0]
            for x in db.execute(
                select(User.user_id).where(and_(User.user_role == "admin", User.user_status == "active"))
            ).all()
        )
        active_left = len(active_admin_ids)

        skipped_self = 0
        skipped_last_admin = 0
        affected = 0

        for u in users:
            if u.user_id == acting.user_id:
                skipped_self += 1
                continue

            is_active_admin = (u.user_id in active_admin_ids)
            will_change = (u.user_status != "deactivated")

            if is_active_admin:
                if active_left <= 1:
                    skipped_last_admin += 1
                    continue
                if will_change:
                    active_left -= 1

            if will_change:
                u.user_status = "deactivated"
                u.user_updated_at = now_tz()
                affected += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=acting.user_id,
                    log_action="bulk_deactivate_users",
                    log_target_table="users",
                    log_description=f"Bulk deactivate {affected} / {len(ids)} users",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    resp = _render_users_fragment(request, override_filters=f)
    payload = {
        "entity": "users",
        "action": "deactivate",
        "total": len(ids),
        "affected": affected,
        "skipped_self": skipped_self,
        "skipped_last_admin": skipped_last_admin,
    }
    resp.headers["HX-Trigger"] = json.dumps({"users-bulk-result": payload})
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# POST – Bulk routes (giữ API cũ, dùng helper mới)
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/users/bulk-activate")
async def admin_users_bulk_activate(request: Request) -> Template:
    return await _bulk_update_status(request, "active")


@post("/admin/users/bulk-suspend")
async def admin_users_bulk_suspend(request: Request) -> Template:
    return await _bulk_update_status(request, "suspended")


@post("/admin/users/bulk-ban")
async def admin_users_bulk_ban(request: Request) -> Template:
    return await _bulk_update_status(request, "banned")


@post("/admin/users/bulk-deactivate")
async def admin_users_bulk_deactivate(request: Request) -> Template:
    return await _bulk_update_status(request, "deactivated")


@post("/admin/users/bulk-verify")
async def admin_users_bulk_verify(request: Request) -> Template:
    return await _bulk_verify(request)


@post("/admin/users/bulk-unverify")
async def admin_users_bulk_unverify(request: Request) -> Template:
    return await _bulk_unverify(request)


@post("/admin/users/bulk-delete")
async def admin_users_bulk_delete(request: Request) -> Template:
    return await _bulk_delete(request)


# ──────────────────────────────────────────────────────────────────────────────
# POST – Bulk multiplexer (/admin/users/bulk)
# Map action|do|op + ids|selected_ids|ids_csv → các handler bulk sẵn có
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/users/bulk")
async def admin_users_bulk(request: Request) -> Template:
    form = await request.form()
    cached = dict(form)

    # Chuẩn hóa danh sách IDs
    if "ids" not in cached or not cached.get("ids"):
        alt_ids = cached.get("selected_ids") or cached.get("ids_csv")
        if alt_ids:
            cached["ids"] = alt_ids

    # Action synonyms
    action = (cached.get("action") or cached.get("do") or cached.get("op") or "").strip().lower()

    # Map → helper
    if action in {"activate", "active"}:
        return await _bulk_update_status(request, "active", form_override=cached)
    if action in {"suspend", "suspended", "pause"}:
        return await _bulk_update_status(request, "suspended", form_override=cached)
    if action in {"ban", "banned"}:
        return await _bulk_update_status(request, "banned", form_override=cached)
    if action in {"deactivate", "deactivated", "disable", "disabled"}:
        return await _bulk_update_status(request, "deactivated", form_override=cached)
    if action in {"verify"}:
        return await _bulk_verify(request, form_override=cached)
    if action in {"unverify"}:
        return await _bulk_unverify(request, form_override=cached)
    if action in {"delete", "remove"}:
        return await _bulk_delete(request, form_override=cached)

    # Action không hợp lệ → trả fragment + trigger cho UI
    f = _extract_filters(request, cached)
    resp = _render_users_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({
        "users-bulk-result": {
            "entity": "users",
            "action": action or "unknown",
            "ok": False,
            "reason": "unknown_action",
        }
    })
    resp.status_code = HTTP_422_UNPROCESSABLE_ENTITY
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – Bulk confirm modal (đẹp hơn confirm() của trình duyệt)
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/users/bulk-confirm-modal")
async def admin_users_bulk_confirm_modal(request: Request) -> Template:
    action = (request.query_params.get("action") or request.query_params.get("do") or request.query_params.get("op") or "").strip().lower()
    ids_csv = (request.query_params.get("ids") or request.query_params.get("selected_ids") or request.query_params.get("ids_csv") or "").strip()
    ids = _parse_ids_csv(ids_csv)

    if not action or not ids:
        raise HTTPException(status_code=422, detail="Thiếu action hoặc ids")

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        users = db.query(User).filter(User.user_id.in_(ids)).all()
        preview = _compute_bulk_preview(db, acting.user_id, users, action)

    ACTION_LABEL = {
        "activate": "Kích hoạt",
        "active": "Kích hoạt",
        "suspend": "Tạm ngưng",
        "suspended": "Tạm ngưng",
        "pause": "Tạm ngưng",
        "ban": "Cấm",
        "banned": "Cấm",
        "deactivate": "Vô hiệu hoá",
        "deactivated": "Vô hiệu hoá",
        "disable": "Vô hiệu hoá",
        "disabled": "Vô hiệu hoá",
        "verify": "Đánh dấu đã xác minh",
        "unverify": "Bỏ xác minh",
        "delete": "Vô hiệu hoá",
        "remove": "Vô hiệu hoá",
    }
    label = ACTION_LABEL.get(action, action.capitalize())

    token = get_csrf_cookie(request) or generate_csrf_token()
    ctx = {
        "csrf_token": token,
        "ids_csv": ",".join(ids),
        "action": action,
        "action_label": label,
        "total": len(ids),
        "affected": int(preview.get("affected", 0)),
        "skipped_self": int(preview.get("skipped_self", 0)),
        "skipped_last_admin": int(preview.get("skipped_last_admin", 0)),
        "skipped_sso": int(preview.get("skipped_sso", 0)),
    }
    resp = Template(template_name="admin/users/admin_users_bulk_confirm_modal.html", context=ctx)
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – Sort via HTMX (fix sort UI không ăn)
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/users/sort")
async def admin_users_sort(request: Request) -> Template:
    sort_key = _normalize_sort(request.query_params.get("sort") or request.query_params.get("k") or "")
    f0 = _extract_filters(request, None)
    f = f0._replace(sort=sort_key, page=1)
    return _render_users_fragment(request, override_filters=f)


# ──────────────────────────────────────────────────────────────────────────────
# GET – Export CSV (+ redirect path cũ)
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/users/export-csv")
async def admin_users_export_csv(request: Request) -> Response:
    """
    Xuất danh sách user ra CSV.
    Nếu có ?ids=... sẽ xuất theo danh sách đó; nếu không sẽ xuất theo filter hiện tại.
    Sort không ảnh hưởng CSV (mặc định created_at DESC).
    """
    ids = _parse_ids_csv(request.query_params.get("ids"))
    f = _extract_filters(request, None)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)

        stmt = select(User)
        if ids:
            stmt = stmt.where(User.user_id.in_(ids))
        else:
            stmt = _apply_filters_to_stmt(stmt, f)

        users = db.scalars(stmt.order_by(User.user_created_at.desc())).all()

        rows = [
            (
                u.user_email,
                u.user_name or "",
                u.user_display_name or "",
                u.user_role,
                u.user_status,
                u.user_oauth_provider or "local",
                u.user_oauth_sub or "",
                "1" if u.user_email_verified else "0",
                (u.user_register_ip or ""),
                (u.user_created_at.astimezone().strftime("%d/%m/%Y %H:%M") if u.user_created_at else ""),
                (u.user_updated_at.astimezone().strftime("%d/%m/%Y %H:%M") if u.user_updated_at else ""),
            )
            for u in users
        ]

        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="export_users_csv",
                log_target_table="users",
                log_description=(f"Export selected {len(ids)} users" if ids else f"Export {len(users)} users"),
                log_created_at=now_tz(),
            )
        )
        db.commit()

    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(
        [
            "user_email",
            "user_name",
            "user_display_name",
            "user_role",
            "user_status",
            "user_oauth_provider",
            "user_oauth_sub",
            "user_email_verified",
            "user_register_ip",
            "created_at",
            "updated_at",
        ]
    )
    for r in rows:
        w.writerow(r)

    csv_data = "\ufeff" + out.getvalue()  # UTF-8 BOM
    return Response(
        csv_data,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="admin_users_{now_tz().strftime("%Y%m%d_%H%M%S")}.csv"',
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@get("/admin/users/export")
async def admin_users_export_redirect(request: Request) -> Redirect:
    qs = request.url.query or ""
    target = "/admin/users/export-csv" + (("?" + qs) if qs else "")
    return Redirect(target, status_code=302)

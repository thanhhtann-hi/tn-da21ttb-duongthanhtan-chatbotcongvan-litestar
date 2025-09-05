# file: src/modules/admin/routes/admin_departments.py
# updated: 2025-08-25 (clean URL via HX-Push-Url + highlight id + stable sort)
# note:
#   - Fragment responses set HX-Push-Url (pretty URL, no per_page).
#   - HX-Trigger for create/update/delete includes the affected id.
#   - Stable ordering for pagination: add dept_id as tie-breaker in all sorts.

from __future__ import annotations

from datetime import datetime
from typing import NamedTuple, Tuple, List
import csv
import io
import json
from uuid import UUID
from urllib.parse import urlencode  # ← keep

from litestar import get, post, put, delete, Request
from litestar.exceptions import HTTPException
from litestar.response import Template, Redirect, Response
from sqlalchemy import select, func, or_
from sqlalchemy.orm import Session

from core.db.engine import SessionLocal
from core.db.models import Department, SystemAdminLog
from shared.secure_cookie import generate_csrf_token, get_csrf_cookie, set_csrf_cookie
from shared.timezone import now_tz


# ──────────────────────────────────────────────────────────────────────────────
# Config & constants
# ──────────────────────────────────────────────────────────────────────────────
PP_MIN = 5
PP_MAX = 50
PP_DEFAULT = 10

# canonical sort keys
ALLOWED_SORT = {
    "created_desc",
    "created_asc",
    "name_az",
    "name_za",
    "alias_az",
    "alias_za",
    "email_az",
    "email_za",
}

# map → khóa UI cho template
UI_SORT_MAP = {
    "created_desc": "new",
    "created_asc": "old",
    "name_az": "az",
    "name_za": "za",
    "alias_az": "alias_az",
    "alias_za": "alias_za",
    "email_az": "email_az",
    "email_za": "email_za",
}


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

    from core.db.models import User  # import cục bộ để tránh import vòng

    row = db.execute(
        select(User.user_role, User.user_status).where(User.user_id == user_in_scope.user_id)
    ).first()
    if not row:
        raise HTTPException(status_code=404)

    role, status = row
    if role != "admin" or status != "active":
        raise HTTPException(status_code=404)

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
    if kk in {"az", "name", "name_asc"}:
        return "name_az"
    if kk in {"za", "name_desc"}:
        return "name_za"
    if kk in {"alias", "alias_asc"}:
        return "alias_az"
    if kk == "alias_desc":
        return "alias_za"
    if kk in {"email", "email_asc"}:
        return "email_az"
    if kk == "email_desc":
        return "email_za"
    return "created_desc"


def _parse_ids_csv(s: str | None) -> list[str]:
    if not s:
        return []
    parts = [p.strip() for p in s.split(",")]
    return [p for p in parts if p]


# ──────────────────────────────────────────────────────────────────────────────
# Filter model
# ──────────────────────────────────────────────────────────────────────────────
class DeptFilter(NamedTuple):
    q: str = ""               # tìm theo name/alias/email/phone/website
    sort: str = "created_desc"
    page: int = 1
    per_page: int = PP_DEFAULT


def _extract_filters(request: Request, form: dict | None = None) -> DeptFilter:
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

    q = _get_any(("q", "search"), "")
    sort = _normalize_sort(_get_any(("sort",), "created_desc"))

    page = _parse_int(_get_any(("page",), "1"), 1) or 1
    if page < 1:
        page = 1

    per_page_raw = _parse_int(_get_any(("per_page", "limit"), str(PP_DEFAULT)), PP_DEFAULT) or PP_DEFAULT
    per_page = _clamp_per_page(per_page_raw)

    return DeptFilter(q=q, sort=sort, page=page, per_page=per_page)


# ──────────────────────────────────────────────────────────────────────────────
# Query helpers
# ──────────────────────────────────────────────────────────────────────────────
def _apply_filters_to_stmt(stmt, f: DeptFilter):
    if f.q:
        like = f"%{f.q}%"
        stmt = stmt.where(
            or_(
                Department.dept_name.ilike(like),
                Department.dept_alias.ilike(like),
                Department.dept_email.ilike(like),
                Department.dept_phone.ilike(like),
                Department.dept_website.ilike(like),
            )
        )
    return stmt


def _apply_sort(stmt, f: DeptFilter):
    """Bảo đảm sort ổn định bằng tie-breaker dept_id."""
    ID_ASC = Department.dept_id.asc()
    ID_DESC = Department.dept_id.desc()
    CREATED_ASC = Department.dept_created_at.asc()
    CREATED_DESC = Department.dept_created_at.desc()
    NAME = func.lower(Department.dept_name)
    ALIAS = func.lower(Department.dept_alias)
    EMAIL = func.lower(Department.dept_email)

    if f.sort == "created_asc":
        # thời gian cũ → mới; nếu trùng timestamp thì id tăng dần
        return stmt.order_by(CREATED_ASC, ID_ASC)

    if f.sort == "name_az":
        return stmt.order_by(NAME.asc(), CREATED_DESC, ID_DESC)
    if f.sort == "name_za":
        return stmt.order_by(NAME.desc(), CREATED_DESC, ID_DESC)

    if f.sort == "alias_az":
        return stmt.order_by(ALIAS.asc(), CREATED_DESC, ID_DESC)
    if f.sort == "alias_za":
        return stmt.order_by(ALIAS.desc(), CREATED_DESC, ID_DESC)

    if f.sort == "email_az":
        return stmt.order_by(EMAIL.asc().nulls_last(), CREATED_DESC, ID_DESC)
    if f.sort == "email_za":
        return stmt.order_by(EMAIL.desc().nulls_last(), CREATED_DESC, ID_DESC)

    # Mặc định: mới → cũ; nếu trùng timestamp thì id giảm dần
    return stmt.order_by(CREATED_DESC, ID_DESC)


def _query_departments(db: Session, f: DeptFilter) -> Tuple[list[Department], int, int, int]:
    """Trả về (items, total, actual_page, total_pages)."""
    total = int(db.scalar(_apply_filters_to_stmt(select(func.count(Department.dept_id)), f)) or 0)

    per_page = _clamp_per_page(f.per_page or PP_DEFAULT)
    pages = max(1, (total + per_page - 1) // per_page)
    page = f.page if f.page >= 1 else 1
    if page > pages:
        page = pages

    base = select(Department)
    stmt = _apply_filters_to_stmt(base, f)
    stmt = _apply_sort(stmt, f)
    offset = (page - 1) * per_page
    items = db.scalars(stmt.offset(offset).limit(per_page)).all()
    return items, total, page, pages


# ──────────────────────────────────────────────────────────────────────────────
# Render helpers
# ──────────────────────────────────────────────────────────────────────────────
def _clean_push_url_for_departments(q: str, sort: str, page: int) -> str:
    """Tạo URL gọn: không per_page; bỏ sort=created_desc, page=1, q rỗng."""
    params = {}
    if q:
        params["q"] = q
    if (sort or "created_desc") != "created_desc":
        params["sort"] = sort
    if (page or 1) > 1:
        params["page"] = page
    qs = urlencode(params)
    return "/admin/departments" + (("?" + qs) if qs else "")


def _render_dept_fragment(request: Request, *, override_filters: DeptFilter | None = None) -> Template:
    f = override_filters or _extract_filters(request, None)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        departments, total, page, pages = _query_departments(db, f)

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/departments/admin_departments_fragment.html",
        context={
            "user": user,
            "departments": departments,
            "csrf_token": token,
            # filters
            "filter_q": f.q,
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

    # Ép trình duyệt cập nhật lịch sử bằng URL "đẹp"
    resp.headers["HX-Push-Url"] = _clean_push_url_for_departments(f.q, f.sort, page)

    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – Full page hoặc fragment
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/departments/fragment")
async def admin_departments_fragment_get(request: Request) -> Template:
    return _render_dept_fragment(request)


@get("/admin/departments")
async def admin_departments_page(request: Request) -> Template:
    hx = request.headers.get("HX-Request", "").lower() == "true"
    if hx:
        return _render_dept_fragment(request)

    f = _extract_filters(request, None)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        departments, total, page, pages = _query_departments(db, f)

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/departments/admin_departments.html",
        context={
            "user": user,
            "departments": departments,
            "csrf_token": token,
            # filters
            "filter_q": f.q,
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
@get("/admin/departments/new-modal")
async def admin_departments_new_modal(request: Request) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/departments/admin_departments_new_modal.html",
        context={"user": user, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


def _get_dept_or_404(db: Session, dept_id: UUID) -> Department:
    d = db.get(Department, str(dept_id))
    if not d:
        raise HTTPException(status_code=404)
    return d


@get("/admin/departments/{dept_id:uuid}/detail-modal")
async def admin_departments_detail_modal(request: Request, dept_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        row = _get_dept_or_404(db, dept_id)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/departments/admin_departments_detail_modal.html",
        context={"user": user, "row": row, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/departments/{dept_id:uuid}/edit-modal")
async def admin_departments_edit_modal(request: Request, dept_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        row = _get_dept_or_404(db, dept_id)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/departments/admin_departments_edit_modal.html",
        context={"user": user, "row": row, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/departments/{dept_id:uuid}/delete-modal")
async def admin_departments_delete_modal(request: Request, dept_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        row = _get_dept_or_404(db, dept_id)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/departments/admin_departments_delete_modal.html",
        context={"user": user, "row": row, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – Bulk modals
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/departments/bulk-delete-modal")
async def admin_departments_bulk_delete_modal(request: Request) -> Template:
    ids_raw = (request.query_params.get("ids") or "").strip()
    ids = _parse_ids_csv(ids_raw)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/departments/admin_departments_bulk_delete_modal.html",
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


@get("/admin/departments/bulk-export-modal")
async def admin_departments_bulk_export_modal(request: Request) -> Template:
    ids_raw = (request.query_params.get("ids") or "").strip()
    ids = _parse_ids_csv(ids_raw)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/departments/admin_departments_bulk_export_modal.html",
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
@post("/admin/departments")
async def admin_departments_create(request: Request) -> Template:
    form = await request.form()
    f = _extract_filters(request, form)

    name = (form.get("dept_name") or "").strip()
    alias = (form.get("dept_alias") or "").strip()
    email = (form.get("dept_email") or "").strip()
    phone = (form.get("dept_phone") or "").strip()
    website = (form.get("dept_website") or "").strip()

    if not name:
        resp = _render_dept_fragment(request, override_filters=f)
        resp.headers["HX-Trigger"] = json.dumps({"departments-single-result": {"action": "create", "ok": False, "reason": "missing_name"}})
        resp.status_code = 422
        return resp

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)

        # unique name (case-insensitive)
        exists = db.scalar(select(func.count(Department.dept_id)).where(func.lower(Department.dept_name) == name.lower())) or 0
        if exists:
            resp = _render_dept_fragment(request, override_filters=f)
            resp.headers["HX-Trigger"] = json.dumps({"departments-single-result": {"action": "create", "ok": False, "reason": "duplicate_name"}})
            resp.status_code = 422
            return resp

        d = Department(
            dept_name=name,
            dept_alias=alias or None,
            dept_email=email or None,
            dept_phone=phone or None,
            dept_website=website or None,
            dept_created_at=now_tz(),
            dept_updated_at=now_tz(),
        )
        db.add(d)
        db.flush()

        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="create_department",
                log_target_table="departments",
                log_target_id=d.dept_id,
                log_after={
                    "name": d.dept_name,
                    "alias": d.dept_alias,
                    "email": d.dept_email,
                    "phone": d.dept_phone,
                    "website": d.dept_website,
                },
                log_created_at=now_tz(),
            )
        )
        db.commit()

    resp = _render_dept_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({
        "departments-single-result": {"action": "create", "ok": True, "id": str(d.dept_id)}
    })
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# PUT – Single update
# ──────────────────────────────────────────────────────────────────────────────
@put("/admin/departments/{dept_id:uuid}")
async def admin_departments_update(request: Request, dept_id: UUID) -> Template:
    form = await request.form()
    f = _extract_filters(request, form)

    name = (form.get("dept_name") or "").strip()
    alias = (form.get("dept_alias") or "").strip()
    email = (form.get("dept_email") or "").strip()
    phone = (form.get("dept_phone") or "").strip()
    website = (form.get("dept_website") or "").strip()

    if not name:
        resp = _render_dept_fragment(request, override_filters=f)
        resp.headers["HX-Trigger"] = json.dumps({"departments-single-result": {"action": "update", "ok": False, "reason": "missing_name"}})
        resp.status_code = 422
        return resp

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        d = _get_dept_or_404(db, dept_id)

        if name.lower() != (d.dept_name or "").lower():
            exists = db.scalar(
                select(func.count(Department.dept_id)).where(
                    func.lower(Department.dept_name) == name.lower(),
                    Department.dept_id != str(d.dept_id),
                )
            ) or 0
            if exists:
                resp = _render_dept_fragment(request, override_filters=f)
                resp.headers["HX-Trigger"] = json.dumps({"departments-single-result": {"action": "update", "ok": False, "reason": "duplicate_name"}})
                resp.status_code = 422
                return resp

        d.dept_name = name
        d.dept_alias = alias or None
        d.dept_email = email or None
        d.dept_phone = phone or None
        d.dept_website = website or None
        d.dept_updated_at = now_tz()

        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="update_department",
                log_target_table="departments",
                log_target_id=d.dept_id,
                log_description=f"Update info for {d.dept_name}",
                log_after={
                    "name": d.dept_name,
                    "alias": d.dept_alias,
                    "email": d.dept_email,
                    "phone": d.dept_phone,
                    "website": d.dept_website,
                },
                log_created_at=now_tz(),
            )
        )
        db.commit()

    resp = _render_dept_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({
        "departments-single-result": {"action": "update", "ok": True, "id": str(dept_id)}
    })
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# DELETE – Single (hard delete)
# ──────────────────────────────────────────────────────────────────────────────
@delete("/admin/departments/{dept_id:uuid}", status_code=200, media_type="text/html")
async def admin_departments_delete(request: Request, dept_id: UUID) -> Template:
    form = await request.form() if request.method in {"POST", "PUT", "DELETE"} else {}
    f = _extract_filters(request, form)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        d = _get_dept_or_404(db, dept_id)

        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="delete_department",
                log_target_table="departments",
                log_target_id=d.dept_id,
                log_description=f"Delete department {d.dept_name}",
                log_before={
                    "name": d.dept_name,
                    "alias": d.dept_alias,
                    "email": d.dept_email,
                    "phone": d.dept_phone,
                    "website": d.dept_website,
                },
                log_created_at=now_tz(),
            )
        )
        db.delete(d)
        db.commit()

    resp = _render_dept_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({
        "departments-single-result": {"action": "delete", "ok": True, "id": str(dept_id)}
    })
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – API: check name unique
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/departments/check_name_unique")
async def admin_departments_check_name_unique(request: Request) -> Response:
    name = (request.query_params.get("name") or "").strip()
    exclude_id = (request.query_params.get("exclude_id") or "").strip()
    if not name:
        return Response(json.dumps({"unique": False, "reason": "missing_name"}), media_type="application/json", status_code=400)

    with SessionLocal() as db:
        q = select(func.count(Department.dept_id)).where(func.lower(Department.dept_name) == name.lower())
        if exclude_id:
            q = q.where(Department.dept_id != str(exclude_id))
        cnt = int(db.scalar(q) or 0)

    return Response(json.dumps({"unique": cnt == 0}), media_type="application/json", status_code=200)


# ──────────────────────────────────────────────────────────────────────────────
# POST – Bulk helpers
# ──────────────────────────────────────────────────────────────────────────────
async def _bulk_delete(request: Request, form_override: dict | None = None) -> Template:
    form = form_override or (await request.form())
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    affected = 0
    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        rows = db.query(Department).filter(Department.dept_id.in_(ids)).all()

        for d in rows:
            db.add(
                SystemAdminLog(
                    log_admin_id=acting.user_id,
                    log_action="delete_department",
                    log_target_table="departments",
                    log_target_id=d.dept_id,
                    log_description=f"Bulk delete {d.dept_name}",
                    log_before={
                        "name": d.dept_name,
                        "alias": d.dept_alias,
                        "email": d.dept_email,
                        "phone": d.dept_phone,
                        "website": d.dept_website,
                    },
                    log_created_at=now_tz(),
                )
            )
            db.delete(d)
            affected += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=acting.user_id,
                    log_action="bulk_delete_departments",
                    log_target_table="departments",
                    log_description=f"Bulk delete {affected} / {len(ids)} departments",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    resp = _render_dept_fragment(request, override_filters=f)
    payload = {
        "entity": "departments",
        "action": "delete",
        "total": len(ids),
        "affected": affected,
    }
    resp.headers["HX-Trigger"] = json.dumps({"departments-bulk-result": payload})
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# POST – Bulk routes & multiplexer
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/departments/bulk-delete")
async def admin_departments_bulk_delete(request: Request) -> Template:
    return await _bulk_delete(request)


@post("/admin/departments/bulk")
async def admin_departments_bulk(request: Request) -> Template:
    form = await request.form()
    cached = dict(form)

    # Chuẩn hóa danh sách IDs
    if "ids" not in cached or not cached.get("ids"):
        alt_ids = cached.get("selected_ids") or cached.get("ids_csv")
        if alt_ids:
            cached["ids"] = alt_ids

    # Action synonyms
    action = (cached.get("action") or cached.get("do") or cached.get("op") or "").strip().lower()

    if action in {"delete", "remove"}:
        return await _bulk_delete(request, form_override=cached)

    # Action không hợp lệ
    f = _extract_filters(request, cached)
    resp = _render_dept_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({
        "departments-bulk-result": {
            "entity": "departments",
            "action": action or "unknown",
            "ok": False,
            "reason": "unknown_action",
        }
    })
    from litestar.status_codes import HTTP_422_UNPROCESSABLE_ENTITY
    resp.status_code = HTTP_422_UNPROCESSABLE_ENTITY
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – Sort via HTMX (fix sort UI)
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/departments/sort")
async def admin_departments_sort(request: Request) -> Template:
    sort_key = _normalize_sort(request.query_params.get("sort") or request.query_params.get("k") or "")
    f0 = _extract_filters(request, None)
    f = f0._replace(sort=sort_key, page=1)
    return _render_dept_fragment(request, override_filters=f)


# ──────────────────────────────────────────────────────────────────────────────
# GET – Export CSV (+ redirect path cũ)
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/departments/export-csv")
async def admin_departments_export_csv(request: Request) -> Response:
    """
    Xuất danh sách phòng ban ra CSV.
    Nếu có ?ids=... sẽ xuất theo danh sách đó; nếu không sẽ xuất theo filter hiện tại.
    Sort không ảnh hưởng CSV (mặc định created_at DESC + id DESC để ổn định).
    """
    ids = _parse_ids_csv(request.query_params.get("ids"))
    f = _extract_filters(request, None)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)

        stmt = select(Department)
        if ids:
            stmt = stmt.where(Department.dept_id.in_(ids))
        else:
            stmt = _apply_filters_to_stmt(stmt, f)

        rows = db.scalars(stmt.order_by(Department.dept_created_at.desc(), Department.dept_id.desc())).all()

        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["dept_name", "dept_alias", "dept_email", "dept_phone", "dept_website", "created_at", "updated_at"])
        for d in rows:
            w.writerow([
                d.dept_name,
                d.dept_alias or "",
                d.dept_email or "",
                d.dept_phone or "",
                d.dept_website or "",
                (d.dept_created_at.astimezone().strftime("%d/%m/%Y %H:%M") if d.dept_created_at else ""),
                (d.dept_updated_at.astimezone().strftime("%d/%m/%Y %H:%M") if d.dept_updated_at else ""),
            ])

        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="export_departments_csv",
                log_target_table="departments",
                log_description=(f"Export selected {len(ids)} departments" if ids else f"Export {len(rows)} departments"),
                log_created_at=now_tz(),
            )
        )
        db.commit()

    csv_data = "\ufeff" + out.getvalue()  # UTF-8 BOM
    return Response(
        csv_data,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="admin_departments_{now_tz().strftime("%Y%m%d_%H%M%S")}.csv"',
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@get("/admin/departments/export")
async def admin_departments_export_redirect(request: Request) -> Redirect:
    qs = request.url.query or ""
    target = "/admin/departments/export-csv" + (("?" + qs) if qs else "")
    return Redirect(target, status_code=302)

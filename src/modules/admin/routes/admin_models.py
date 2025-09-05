# file: src/modules/admin/routes/admin_models.py
# updated: 2025-08-23
# note:
# - Trang quản trị "Mô hình AI" (ModelVariant): list + filter + paging + CRUD + bulk + export CSV
# - Tương thích HTMX fragment như admin_notify.*
# - CSRF: dùng middleware CsrfGuard; các POST/PUT/DELETE đều hợp lệ (không cần gọi validate_csrf thủ công).
# - Logging: ghi SystemAdminLog cho các thao tác mutating.
# - Bổ sung: bulk delete modal + bulk delete action, bulk export modal; route export-csv thống nhất với frontend.
# - Hotfix: ràng buộc {model_id:uuid} để tránh 405 khi GET các path tĩnh như /bulk-export-modal.

from __future__ import annotations

from datetime import datetime, date
from typing import NamedTuple, Tuple, List
from uuid import UUID

import csv
import io
import json  # <-- dùng cho HX-Trigger payload

from litestar import get, post, put, delete, Request
from litestar.exceptions import HTTPException
from litestar.response import Template, Redirect, Response
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from core.db.engine import SessionLocal
from core.db.models import ModelVariant, SystemAdminLog, User
from shared.secure_cookie import generate_csrf_token, get_csrf_cookie, set_csrf_cookie
from shared.timezone import now_tz


# ──────────────────────────────────────────────────────────────────────────────
# Config chung
# ──────────────────────────────────────────────────────────────────────────────
PP_MIN = 5
PP_MAX = 50
PP_DEFAULT = 10

ALLOWED_STATUS = {"all", "active", "preview", "deprecated", "retired"}
ALLOWED_SCOPE = {"all", "user", "internal", "admin", "any"}  # 'any' ~ không lọc
ALLOWED_TIER = {"all", "auto", "low", "medium", "high"}
ALLOWED_ENABLED = {"all", "enabled", "disabled"}

# canonical sort keys
ALLOWED_SORT = {"created_desc", "created_asc", "name_az", "name_za", "provider_az", "provider_za"}

# map về khóa UI (new|old|az|za|prov_az|prov_za) để template dùng
UI_SORT_MAP = {
    "created_desc": "new",
    "created_asc": "old",
    "name_az": "az",
    "name_za": "za",
    "provider_az": "prov_az",
    "provider_za": "prov_za",
}


# ──────────────────────────────────────────────────────────────────────────────
# Helpers chung
# ──────────────────────────────────────────────────────────────────────────────
def _ensure_admin(request: Request, db: Session) -> User:
    """Đảm bảo user đăng nhập là admin & active; trả thực thể User mới nhất từ DB."""
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
    _ = user.settings.setting_theme if user.settings else None  # warm relationship
    return user


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
    if kk == "prov_az":
        return "provider_az"
    if kk == "prov_za":
        return "provider_za"
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
class ModelFilter(NamedTuple):
    status: str = "all"       # active|preview|deprecated|retired|all
    scope: str = "any"        # all|user|internal|admin|any(=no filter)
    tier: str = "all"         # auto|low|medium|high|all
    enabled: str = "all"      # enabled|disabled|all
    provider: str = ""        # exact/fuzzy (LIKE)
    mtype: str = ""           # model_type
    q: str = ""               # name search
    sort: str = "created_desc"
    page: int = 1
    per_page: int = PP_DEFAULT


def _extract_filters(request: Request, form: dict | None = None) -> ModelFilter:
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

    scope = (_get_any(("scope",), "any") or "any").lower()
    if scope not in ALLOWED_SCOPE:
        scope = "any"

    tier = (_get_any(("tier",), "all") or "all").lower()
    if tier not in ALLOWED_TIER:
        tier = "all"

    enabled = (_get_any(("enabled",), "all") or "all").lower()
    if enabled not in ALLOWED_ENABLED:
        enabled = "all"

    provider = _get_any(("provider",), "")
    mtype = _get_any(("type", "mtype"), "")

    q = _get_any(("q",), "")
    sort = _normalize_sort(_get_any(("sort",), "created_desc"))

    page = _parse_int(_get_any(("page",), "1"), 1) or 1
    if page < 1:
        page = 1

    per_page_raw = _parse_int(_get_any(("per_page", "limit"), str(PP_DEFAULT)), PP_DEFAULT) or PP_DEFAULT
    per_page = _clamp_per_page(per_page_raw)

    return ModelFilter(
        status=status, scope=scope, tier=tier, enabled=enabled,
        provider=provider, mtype=mtype, q=q, sort=sort, page=page, per_page=per_page
    )


def _build_filter_qs(f: ModelFilter) -> str:
    """Sinh query-string tối giản theo filter hiện tại (bỏ mặc định)."""
    parts: List[str] = []
    if f.status != "all":
        parts.append(f"status={f.status}")
    if f.scope != "any":
        parts.append(f"scope={f.scope}")
    if f.tier != "all":
        parts.append(f"tier={f.tier}")
    if f.enabled != "all":
        parts.append(f"enabled={f.enabled}")
    if f.provider:
        parts.append(f"provider={f.provider}")
    if f.mtype:
        parts.append(f"type={f.mtype}")
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
def _apply_filters_to_stmt(stmt, f: ModelFilter):
    # status
    if f.status in {"active", "preview", "deprecated", "retired"}:
        stmt = stmt.where(ModelVariant.model_status == f.status)

    # enabled
    if f.enabled == "enabled":
        stmt = stmt.where(ModelVariant.model_enabled.is_(True))
    elif f.enabled == "disabled":
        stmt = stmt.where(ModelVariant.model_enabled.is_(False))

    # scope
    if f.scope in {"all", "user", "internal", "admin"}:
        stmt = stmt.where(ModelVariant.model_access_scope == f.scope)

    # tier
    if f.tier in {"auto", "low", "medium", "high"}:
        stmt = stmt.where(ModelVariant.model_tier == f.tier)

    # provider
    if f.provider:
        stmt = stmt.where(ModelVariant.model_provider.ilike(f"%{f.provider}%"))

    # type
    if f.mtype:
        stmt = stmt.where(ModelVariant.model_type.ilike(f"%{f.mtype}%"))

    # q ~ name
    if f.q:
        stmt = stmt.where(ModelVariant.model_name.ilike(f"%{f.q}%"))

    return stmt


def _apply_sort(stmt, f: ModelFilter):
    if f.sort == "created_asc":
        return stmt.order_by(ModelVariant.model_created_at.asc())
    if f.sort == "name_az":
        return stmt.order_by(func.lower(ModelVariant.model_name).asc(), ModelVariant.model_created_at.desc())
    if f.sort == "name_za":
        return stmt.order_by(func.lower(ModelVariant.model_name).desc(), ModelVariant.model_created_at.desc())
    if f.sort == "provider_az":
        return stmt.order_by(func.lower(ModelVariant.model_provider).asc(), ModelVariant.model_created_at.desc())
    if f.sort == "provider_za":
        return stmt.order_by(func.lower(ModelVariant.model_provider).desc(), ModelVariant.model_created_at.desc())
    # default
    return stmt.order_by(ModelVariant.model_created_at.desc())


def _query_models(db: Session, f: ModelFilter) -> Tuple[list[ModelVariant], int, int, int]:
    """Trả về (items, total, actual_page, total_pages)."""
    total = int(db.scalar(_apply_filters_to_stmt(select(func.count(ModelVariant.model_id)), f)) or 0)

    per_page = _clamp_per_page(f.per_page or PP_DEFAULT)
    pages = max(1, (total + per_page - 1) // per_page)
    page = f.page if f.page >= 1 else 1
    if page > pages:
        page = pages

    stmt = _apply_filters_to_stmt(select(ModelVariant), f)
    stmt = _apply_sort(stmt, f)
    offset = (page - 1) * per_page
    items = db.scalars(stmt.offset(offset).limit(per_page)).all()
    return items, total, page, pages


# ──────────────────────────────────────────────────────────────────────────────
# Render helpers
# ──────────────────────────────────────────────────────────────────────────────
def _render_models_fragment(request: Request, *, override_filters: ModelFilter | None = None) -> Template:
    f = override_filters or _extract_filters(request, None)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        models, total, page, pages = _query_models(db, f)

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/models/admin_models_fragment.html",
        context={
            "user": user,
            "models": models,
            "csrf_token": token,
            # filters
            "filter_status": f.status,
            "filter_scope": f.scope,
            "filter_tier": f.tier,
            "filter_enabled": f.enabled,
            "filter_provider": f.provider,
            "filter_type": f.mtype,
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
@get("/admin/models/fragment")
async def admin_models_fragment_get(request: Request) -> Template:
    return _render_models_fragment(request)


@get("/admin/models")
async def admin_models_page(request: Request) -> Template:
    hx = request.headers.get("HX-Request", "").lower() == "true"
    if hx:
        return _render_models_fragment(request)

    f = _extract_filters(request, None)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        models, total, page, pages = _query_models(db, f)

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/models/admin_models.html",
        context={
            "user": user,
            "models": models,
            "csrf_token": token,
            # filters
            "filter_status": f.status,
            "filter_scope": f.scope,
            "filter_tier": f.tier,
            "filter_enabled": f.enabled,
            "filter_provider": f.provider,
            "filter_type": f.mtype,
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
@get("/admin/models/new-modal")
async def admin_models_new_modal(request: Request) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/models/admin_models_new_modal.html",
        context={"user": user, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/models/{model_id:uuid}/edit-modal")
async def admin_models_edit_modal(request: Request, model_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        model = db.get(ModelVariant, str(model_id))
        if not model:
            raise HTTPException(status_code=404)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/models/admin_models_edit_modal.html",
        context={"user": user, "model": model, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/models/{model_id:uuid}/detail-modal")
async def admin_models_detail_modal(request: Request, model_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        model = db.get(ModelVariant, str(model_id))
        if not model:
            raise HTTPException(status_code=404)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/models/admin_models_detail_modal.html",
        context={"user": user, "model": model, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/models/{model_id:uuid}/delete-modal")
async def admin_models_delete_modal(request: Request, model_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        model = db.get(ModelVariant, str(model_id))
        if not model:
            raise HTTPException(status_code=404)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/models/admin_models_delete_modal.html",
        context={
            "user": user,
            "model": model,
            "csrf_token": token,
            "already_retired": (model.model_status == "retired"),
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# Bulk delete modal
@get("/admin/models/bulk-delete-modal")
async def admin_models_bulk_delete_modal(request: Request) -> Template:
    ids_raw = (request.query_params.get("ids") or "").strip()
    ids = _parse_ids_csv(ids_raw)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/models/admin_models_bulk_delete_modal.html",
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
@get("/admin/models/bulk-export-modal")
async def admin_models_bulk_export_modal(request: Request) -> Template:
    ids_raw = (request.query_params.get("ids") or "").strip()
    ids = _parse_ids_csv(ids_raw)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/models/admin_models_bulk_export_modal.html",
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
@post("/admin/models")
async def admin_models_create(request: Request) -> Template | Redirect:
    form = await request.form()

    name = (form.get("model_name") or "").strip()
    provider = (form.get("model_provider") or "").strip()
    mtype = (form.get("model_type") or "").strip()
    provider_model_id = (form.get("provider_model_id") or "").strip()
    description = (form.get("model_description") or "").strip()

    enabled = "model_enabled" in form
    scope = (form.get("model_access_scope") or "all").strip().lower()
    tier = (form.get("model_tier") or "auto").strip().lower()
    status = (form.get("model_status") or "active").strip().lower()
    sort_order = _parse_int(form.get("model_sort_order"), None)

    f = _extract_filters(request, form)

    if not name:
        raise HTTPException(status_code=422, detail="Tên mô hình (model_name) không được để trống")
    if scope not in {"all", "user", "internal", "admin"}:
        raise HTTPException(status_code=422, detail="Giá trị model_access_scope không hợp lệ")
    if tier not in {"auto", "low", "medium", "high"}:
        raise HTTPException(status_code=422, detail="Giá trị model_tier không hợp lệ")
    if status not in {"active", "preview", "deprecated", "retired"}:
        raise HTTPException(status_code=422, detail="Giá trị model_status không hợp lệ")

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        model = ModelVariant(
            model_name=name,
            model_provider=provider or None,
            model_type=mtype or None,
            provider_model_id=provider_model_id or None,
            model_description=description or None,
            model_enabled=bool(enabled and status != "retired"),
            model_access_scope=scope,
            model_tier=tier,
            model_status=status,
            model_sort_order=sort_order,
        )
        db.add(model)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=400, detail="Tên mô hình đã tồn tại")

        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="create_model_variant",
                log_target_table="model_variants",
                log_target_id=model.model_id,
                log_after={
                    "name": model.model_name,
                    "provider": model.model_provider,
                    "type": model.model_type,
                    "provider_model_id": model.provider_model_id,
                    "enabled": model.model_enabled,
                    "scope": model.model_access_scope,
                    "tier": model.model_tier,
                    "status": model.model_status,
                    "sort_order": model.model_sort_order,
                },
                log_created_at=now_tz(),
            )
        )
        db.commit()

    if request.headers.get("HX-Request", "").lower() == "true":
        return _render_models_fragment(request, override_filters=f)
    return Redirect("/admin/models" + _build_filter_qs(f), status_code=302)


# ──────────────────────────────────────────────────────────────────────────────
# PUT – Update
# ──────────────────────────────────────────────────────────────────────────────
@put("/admin/models/{model_id:uuid}")
async def admin_models_update(request: Request, model_id: UUID) -> Template | Redirect:
    form = await request.form()

    name = (form.get("model_name") or "").strip()
    provider = (form.get("model_provider") or "").strip()
    mtype = (form.get("model_type") or "").strip()
    provider_model_id = (form.get("provider_model_id") or "").strip()
    description = (form.get("model_description") or "").strip()

    enabled = "model_enabled" in form
    scope = (form.get("model_access_scope") or "all").strip().lower()
    tier = (form.get("model_tier") or "auto").strip().lower()
    status = (form.get("model_status") or "active").strip().lower()
    sort_order = _parse_int(form.get("model_sort_order"), None)

    f = _extract_filters(request, form)

    if not name:
        raise HTTPException(status_code=422, detail="Tên mô hình (model_name) không được để trống")
    if scope not in {"all", "user", "internal", "admin"}:
        raise HTTPException(status_code=422, detail="Giá trị model_access_scope không hợp lệ")
    if tier not in {"auto", "low", "medium", "high"}:
        raise HTTPException(status_code=422, detail="Giá trị model_tier không hợp lệ")
    if status not in {"active", "preview", "deprecated", "retired"}:
        raise HTTPException(status_code=422, detail="Giá trị model_status không hợp lệ")

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        model = db.get(ModelVariant, str(model_id))
        if not model:
            raise HTTPException(status_code=404)

        before = {
            "name": model.model_name,
            "provider": model.model_provider,
            "type": model.model_type,
            "provider_model_id": model.provider_model_id,
            "description": model.model_description,
            "enabled": model.model_enabled,
            "scope": model.model_access_scope,
            "tier": model.model_tier,
            "status": model.model_status,
            "sort_order": model.model_sort_order,
        }

        model.model_name = name
        model.model_provider = provider or None
        model.model_type = mtype or None
        model.provider_model_id = provider_model_id or None
        model.model_description = description or None
        model.model_access_scope = scope
        model.model_tier = tier
        model.model_status = status
        model.model_enabled = bool(enabled and status != "retired")
        model.model_sort_order = sort_order

        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=400, detail="Tên mô hình đã tồn tại")
        db.refresh(model)

        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="update_model_variant",
                log_target_table="model_variants",
                log_target_id=model.model_id,
                log_before=before,
                log_after={
                    "name": model.model_name,
                    "provider": model.model_provider,
                    "type": model.model_type,
                    "provider_model_id": model.provider_model_id,
                    "description": model.model_description,
                    "enabled": model.model_enabled,
                    "scope": model.model_access_scope,
                    "tier": model.model_tier,
                    "status": model.model_status,
                    "sort_order": model.model_sort_order,
                },
                log_created_at=now_tz(),
            )
        )
        db.commit()

    if request.headers.get("HX-Request", "").lower() == "true":
        return _render_models_fragment(request, override_filters=f)
    return Redirect("/admin/models" + _build_filter_qs(f), status_code=302)


# ──────────────────────────────────────────────────────────────────────────────
# DELETE – Retire (soft-delete) 1 mô hình
# ──────────────────────────────────────────────────────────────────────────────
@delete("/admin/models/{model_id:uuid}", status_code=200)
async def admin_models_retire(request: Request, model_id: UUID) -> Template:
    # DELETE đôi khi có body (HTMX), cố gắng đọc form trước – nếu lỗi thì bỏ qua
    try:
        form = await request.form()
    except Exception:
        form = None
    f = _extract_filters(request, form)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        model = db.get(ModelVariant, str(model_id))
        if not model:
            raise HTTPException(status_code=404)

        changed = False
        if model.model_status != "retired":
            model.model_status = "retired"
            changed = True
        if model.model_enabled:
            model.model_enabled = False
            changed = True

        if changed:
            db.add(
                SystemAdminLog(
                    log_admin_id=user.user_id,
                    log_action="retire_model_variant",
                    log_target_table="model_variants",
                    log_target_id=model.model_id,
                    log_after={"status": "retired", "enabled": False},
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    return _render_models_fragment(request, override_filters=f)


# ──────────────────────────────────────────────────────────────────────────────
# POST – Toggle enabled (1 item)
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/models/{model_id:uuid}/toggle-enabled")
async def admin_models_toggle_enabled(request: Request, model_id: UUID) -> Template:
    form = await request.form()
    f = _extract_filters(request, form)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        model = db.get(ModelVariant, str(model_id))
        if not model:
            raise HTTPException(status_code=404)

        # Không cho bật enabled nếu đã retired
        if model.model_status == "retired" and not model.model_enabled:
            raise HTTPException(status_code=400, detail="Không thể bật enabled cho mô hình đã 'retired'.")

        model.model_enabled = not model.model_enabled
        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="toggle_model_enabled",
                log_target_table="model_variants",
                log_target_id=model.model_id,
                log_after={"enabled": model.model_enabled},
                log_created_at=now_tz(),
            )
        )
        db.commit()

    return _render_models_fragment(request, override_filters=f)


# ──────────────────────────────────────────────────────────────────────────────
# POST – Bulk enable/disable (có HX-Trigger thông báo ngữ cảnh)
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/models/bulk-enable")
async def admin_models_bulk_enable(request: Request) -> Template:
    form = await request.form()
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        models = db.query(ModelVariant).filter(ModelVariant.model_id.in_(ids)).all()

        affected = 0
        already_enabled = 0
        retired_blocked = 0
        retired_names: list[str] = []

        for m in models:
            if m.model_status == "retired":
                retired_blocked += 1
                if len(retired_names) < 5:
                    retired_names.append(m.model_name or str(m.model_id))
                continue
            if not m.model_enabled:
                m.model_enabled = True
                affected += 1
            else:
                already_enabled += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=user.user_id,
                    log_action="bulk_enable_model_variants",
                    log_target_table="model_variants",
                    log_description=f"Bulk enable {affected} / {len(ids)} models",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    # render list như cũ
    resp = _render_models_fragment(request, override_filters=f)

    # gửi event cho JS hiển thị modal kết quả (có hướng dẫn với retired)
    payload = {
        "action": "enable",
        "total": len(ids),
        "affected": affected,
        "already_enabled": already_enabled,
        "retired_blocked": retired_blocked,
        "retired_names": retired_names,
        "msg": (
            "Đã bật enabled cho các mục đã chọn."
            if affected > 0 and retired_blocked == 0
            else "Một số mục không thể bật do trạng thái 'retired'."
        ),
        "hint": (
            "Không thể bật Enabled cho mô hình đang 'retired'. Vui lòng chuyển Trạng thái sang Active/Preview trước."
            if retired_blocked > 0 else ""
        ),
    }
    resp.headers["HX-Trigger"] = json.dumps({"models-bulk-result": payload})
    return resp


@post("/admin/models/bulk-disable")
async def admin_models_bulk_disable(request: Request) -> Template:
    form = await request.form()
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        models = db.query(ModelVariant).filter(ModelVariant.model_id.in_(ids)).all()

        affected = 0
        already_disabled = 0

        for m in models:
            if m.model_enabled:
                m.model_enabled = False
                affected += 1
            else:
                already_disabled += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=user.user_id,
                    log_action="bulk_disable_model_variants",
                    log_target_table="model_variants",
                    log_description=f"Bulk disable {affected} / {len(ids)} models",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    resp = _render_models_fragment(request, override_filters=f)

    payload = {
        "action": "disable",
        "total": len(ids),
        "affected": affected,
        "already_disabled": already_disabled,
        "msg": ("Đã tắt enabled cho các mục đã chọn." if affected > 0 else "Tất cả mục đã bị tắt sẵn."),
    }
    resp.headers["HX-Trigger"] = json.dumps({"models-bulk-result": payload})
    return resp


# POST – Bulk delete (retire) nhiều model
@post("/admin/models/bulk-delete")
async def admin_models_bulk_delete(request: Request) -> Template:
    """
    Retire nhiều model (soft delete): set status='retired', enabled=False.
    Luôn trả về fragment #models-list-region để HTMX swap.
    """
    form = await request.form()
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        q = db.query(ModelVariant).filter(ModelVariant.model_id.in_(ids))
        affected = 0
        for m in q.all():
            changed = False
            if m.model_status != "retired":
                m.model_status = "retired"
                changed = True
            if m.model_enabled:
                m.model_enabled = False
                changed = True
            if changed:
                affected += 1
        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=user.user_id,
                    log_action="bulk_retire_model_variants",
                    log_target_table="model_variants",
                    log_description=f"Bulk retire {affected} / {len(ids)} models",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    return _render_models_fragment(request, override_filters=f)


# ──────────────────────────────────────────────────────────────────────────────
# GET – Export CSV (+ redirect path cũ)
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/models/export-csv")
async def admin_models_export_csv(request: Request) -> Response:
    """
    Xuất danh sách model ra CSV.
    Nếu có ?ids=... sẽ xuất theo danh sách đó; nếu không sẽ xuất theo filter hiện tại.
    Sort không ảnh hưởng CSV (mặc định created_at DESC).
    """
    ids = _parse_ids_csv(request.query_params.get("ids"))
    f = _extract_filters(request, None)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        stmt = select(ModelVariant)
        if ids:
            stmt = stmt.where(ModelVariant.model_id.in_(ids))
        else:
            stmt = _apply_filters_to_stmt(stmt, f)

        models = db.scalars(stmt.order_by(ModelVariant.model_created_at.desc())).all()

        rows = [
            (
                m.model_name,
                m.model_provider or "",
                m.model_type or "",
                m.provider_model_id or "",
                m.model_access_scope,
                m.model_tier or "",
                m.model_status,
                "1" if m.model_enabled else "0",
                m.model_sort_order if m.model_sort_order is not None else "",
                (m.model_created_at.astimezone().strftime("%d/%m/%Y %H:%M") if m.model_created_at else ""),
                (m.model_updated_at.astimezone().strftime("%d/%m/%Y %H:%M") if m.model_updated_at else ""),
            )
            for m in models
        ]

        db.add(
            SystemAdminLog(
                log_admin_id=user.user_id,
                log_action="export_models_csv",
                log_target_table="model_variants",
                log_description=(f"Export selected {len(ids)} models" if ids else f"Export {len(models)} models"),
                log_created_at=now_tz(),
            )
        )
        db.commit()

    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(
        [
            "model_name",
            "model_provider",
            "model_type",
            "provider_model_id",
            "model_access_scope",
            "model_tier",
            "model_status",
            "model_enabled",
            "model_sort_order",
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
            "Content-Disposition": f'attachment; filename="admin_models_{now_tz().strftime("%Y%m%d_%H%M%S")}.csv"',
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


# Backward-compat: đường dẫn cũ '/admin/models/export' → redirect sang '/admin/models/export-csv'
@get("/admin/models/export")
async def admin_models_export_redirect(request: Request) -> Redirect:
    qs = request.url.query or ""
    target = "/admin/models/export-csv" + (("?" + qs) if qs else "")
    return Redirect(target, status_code=302)

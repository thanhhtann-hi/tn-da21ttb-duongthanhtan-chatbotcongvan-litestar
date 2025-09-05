# file: src/modules/admin/routes/admin_documents.py
# updated: 2025-08-25 (v1.1.0 – remove EDIT; hard delete; CSV export; bulk delete)
# note:
# - Admin “Documents”: list + filter + sort + paging + bulk delete + export CSV
# - Single modals: new / detail / delete (NO edit)
# - Create: requires chat_id, file_path, ocr_text_path; status is forced to "new"
# - Hard delete (CASCADE attachments if modeled)
# - HTMX fragment swap; returns fragment after actions + HX-Trigger for toasts
# - CSRF: guarded by middleware for POST/DELETE; GET modal/fragment/export skip

from __future__ import annotations

from typing import NamedTuple, Tuple, List
from uuid import UUID
import csv
import io
import json

from litestar import get, post, delete, Request
from litestar.exceptions import HTTPException
from litestar.response import Template, Redirect, Response
from sqlalchemy import select, func, or_
from sqlalchemy.orm import Session, joinedload

from core.db.engine import SessionLocal
from core.db.models import User, Document, ChatHistory, SystemAdminLog
from shared.secure_cookie import generate_csrf_token, get_csrf_cookie, set_csrf_cookie
from shared.timezone import now_tz


# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────
PP_MIN = 5
PP_MAX = 50
PP_DEFAULT = 10

ALLOWED_STATUS = {"all", "new", "routed", "reviewed"}

# canonical sort keys
ALLOWED_SORT = {
    "created_desc",
    "created_asc",
    "title_az",
    "title_za",
    "status_az",
    "status_za",
}

# map → UI key (template uses these)
UI_SORT_MAP = {
    "created_desc": "new",
    "created_asc": "old",
    "title_az": "title_az",
    "title_za": "title_za",
    "status_az": "status_az",
    "status_za": "status_za",
}


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────
def _ensure_admin(request: Request, db: Session):
    """Require signed-in admin with active status."""
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
    """Accept both UI and canonical keys; return canonical."""
    kk = (k or "").strip().lower()
    if kk in ALLOWED_SORT:
        return kk
    if kk == "new":
        return "created_desc"
    if kk == "old":
        return "created_asc"
    if kk in {"title", "az", "title_asc"}:
        return "title_az"
    if kk in {"za", "title_desc"}:
        return "title_za"
    if kk in {"status", "status_asc"}:
        return "status_az"
    if kk == "status_desc":
        return "status_za"
    return "created_desc"


def _parse_ids_csv(s: str | None) -> list[str]:
    if not s:
        return []
    parts = [p.strip() for p in s.split(",")]
    return [p for p in parts if p]


# ──────────────────────────────────────────────────────────────────────────────
# Filter model
# ──────────────────────────────────────────────────────────────────────────────
class DocumentFilter(NamedTuple):
    status: str = "all"      # new|routed|reviewed|all
    chat_id: str = ""        # exact chat filter
    q: str = ""              # title / file path contains
    sort: str = "created_desc"
    page: int = 1
    per_page: int = PP_DEFAULT


def _extract_filters(request: Request, form: dict | None = None) -> DocumentFilter:
    """Prefer FORM (POST/DELETE), fallback QUERY."""
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

    chat_id = _get_any(("chat_id", "doc_chat_id", "chat", "c"), "")

    q = _get_any(("q", "search"), "")

    sort = _normalize_sort(_get_any(("sort",), "created_desc"))

    page = _parse_int(_get_any(("page",), "1"), 1) or 1
    if page < 1:
        page = 1

    per_page_raw = _parse_int(_get_any(("per_page", "limit"), str(PP_DEFAULT)), PP_DEFAULT) or PP_DEFAULT
    per_page = _clamp_per_page(per_page_raw)

    return DocumentFilter(status=status, chat_id=chat_id, q=q, sort=sort, page=page, per_page=per_page)


# ──────────────────────────────────────────────────────────────────────────────
# Query helpers
# ──────────────────────────────────────────────────────────────────────────────
def _apply_filters_to_stmt(stmt, f: DocumentFilter):
    # status
    if f.status in {"new", "routed", "reviewed"}:
        stmt = stmt.where(Document.doc_status == f.status)

    # chat exact
    if f.chat_id:
        stmt = stmt.where(Document.doc_chat_id == f.chat_id)

    # q ~ title/file path (case-insensitive)
    if f.q:
        like = f"%{f.q}%"
        # use ILIKE semantics via lower() for x-db compatibility
        stmt = stmt.where(
            or_(
                func.lower(Document.doc_title).like(func.lower(like)),
                func.lower(Document.doc_file_path).like(func.lower(like)),
            )
        )

    return stmt


def _apply_sort(stmt, f: DocumentFilter):
    if f.sort == "created_asc":
        return stmt.order_by(Document.doc_created_at.asc())
    if f.sort == "title_az":
        return stmt.order_by(func.lower(Document.doc_title).asc(), Document.doc_created_at.desc())
    if f.sort == "title_za":
        return stmt.order_by(func.lower(Document.doc_title).desc(), Document.doc_created_at.desc())
    if f.sort == "status_az":
        return stmt.order_by(func.lower(Document.doc_status).asc(), Document.doc_created_at.desc())
    if f.sort == "status_za":
        return stmt.order_by(func.lower(Document.doc_status).desc(), Document.doc_created_at.desc())
    return stmt.order_by(Document.doc_created_at.desc())


def _query_documents(db: Session, f: DocumentFilter) -> Tuple[list[Document], int, int, int]:
    """Return (items, total, actual_page, total_pages)."""
    total = int(db.scalar(_apply_filters_to_stmt(select(func.count(Document.doc_id)), f)) or 0)

    per_page = _clamp_per_page(f.per_page or PP_DEFAULT)
    pages = max(1, (total + per_page - 1) // per_page)
    page = f.page if f.page >= 1 else 1
    if page > pages:
        page = pages

    base = select(Document).options(joinedload(Document.chat))
    stmt = _apply_filters_to_stmt(base, f)
    stmt = _apply_sort(stmt, f)
    offset = (page - 1) * per_page
    items = db.scalars(stmt.offset(offset).limit(per_page)).all()
    return items, total, page, pages


# ──────────────────────────────────────────────────────────────────────────────
# Render helpers
# ──────────────────────────────────────────────────────────────────────────────
def _render_documents_fragment(request: Request, *, override_filters: DocumentFilter | None = None) -> Template:
    f = override_filters or _extract_filters(request, None)

    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        docs, total, page, pages = _query_documents(db, f)

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/documents/admin_documents_fragment.html",
        context={
            "user": user,
            "documents": docs,
            "csrf_token": token,
            # filters
            "filter_status": f.status,
            "filter_chat_id": f.chat_id,
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
# GET – Full page / fragment
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/documents/fragment")
async def admin_documents_fragment_get(request: Request) -> Template:
    return _render_documents_fragment(request)


@get("/admin/documents")
async def admin_documents_page(request: Request) -> Template:
    hx = request.headers.get("HX-Request", "").lower() == "true"
    if hx:
        return _render_documents_fragment(request)

    f = _extract_filters(request, None)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        docs, total, page, pages = _query_documents(db, f)

    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/documents/admin_documents.html",
        context={
            "user": user,
            "documents": docs,
            "csrf_token": token,
            # filters
            "filter_status": f.status,
            "filter_chat_id": f.chat_id,
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
# GET – Single modals (new / detail / delete)
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/documents/new-modal")
async def admin_documents_new_modal(request: Request) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/documents/admin_documents_new_modal.html",
        context={
            "user": user,
            "csrf_token": token,
            # status is not selectable in UI; always "new" on create
        },
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/documents/{doc_id:uuid}/detail-modal")
async def admin_documents_detail_modal(request: Request, doc_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        row = db.get(Document, str(doc_id))
        if not row:
            raise HTTPException(status_code=404)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/documents/admin_documents_detail_modal.html",
        context={"user": user, "row": row, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


@get("/admin/documents/{doc_id:uuid}/delete-modal")
async def admin_documents_delete_modal(request: Request, doc_id: UUID) -> Template:
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
        row = db.get(Document, str(doc_id))
        if not row:
            raise HTTPException(status_code=404)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/documents/admin_documents_delete_modal.html",
        context={"user": user, "row": row, "csrf_token": token},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – Bulk modals
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/documents/bulk-delete-modal")
async def admin_documents_bulk_delete_modal(request: Request) -> Template:
    ids_raw = (request.query_params.get("ids") or "").strip()
    ids = _parse_ids_csv(ids_raw)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/documents/admin_documents_bulk_delete_modal.html",
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


@get("/admin/documents/bulk-export-modal")
async def admin_documents_bulk_export_modal(request: Request) -> Template:
    ids_raw = (request.query_params.get("ids") or "").strip()
    ids = _parse_ids_csv(ids_raw)
    with SessionLocal() as db:
        user = _ensure_admin(request, db)
    token = get_csrf_cookie(request) or generate_csrf_token()
    resp = Template(
        template_name="admin/documents/admin_documents_bulk_export_modal.html",
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
# POST – Single create (status forced to "new")
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/documents")
async def admin_documents_create(request: Request) -> Template:
    form = await request.form()
    f = _extract_filters(request, form)

    chat_id = (form.get("doc_chat_id") or "").strip()
    file_path = (form.get("doc_file_path") or "").strip()
    ocr_path = (form.get("doc_ocr_text_path") or "").strip()
    title = (form.get("doc_title") or "").strip()

    if not chat_id:
        raise HTTPException(status_code=422, detail="Thiếu chat_id")
    if not file_path:
        raise HTTPException(status_code=422, detail="Thiếu đường dẫn tệp")
    if not ocr_path:
        raise HTTPException(status_code=422, detail="Thiếu đường dẫn OCR")

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)

        # verify chat exists
        if not db.get(ChatHistory, chat_id):
            raise HTTPException(status_code=422, detail="Chat không tồn tại")

        doc = Document(
            doc_chat_id=chat_id,
            doc_file_path=file_path,
            doc_ocr_text_path=ocr_path,
            doc_title=title or None,
            doc_status="new",           # forced
            doc_created_at=now_tz(),
            doc_updated_at=now_tz(),
        )
        db.add(doc)
        db.flush()

        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="create_document",
                log_target_table="documents",
                log_target_id=doc.doc_id,
                log_after={
                    "chat_id": chat_id,
                    "title": title,
                    "status": "new",
                },
                log_created_at=now_tz(),
            )
        )
        db.commit()

    resp = _render_documents_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({"documents-single-result": {"action": "create", "ok": True}})
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# DELETE – Single (hard delete)
# ──────────────────────────────────────────────────────────────────────────────
@delete("/admin/documents/{doc_id:uuid}", status_code=200, media_type="text/html")
async def admin_documents_delete(request: Request, doc_id: UUID) -> Template:
    form = await request.form() if request.method in {"POST", "PUT", "DELETE"} else {}
    f = _extract_filters(request, form)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        doc = db.get(Document, str(doc_id))
        if not doc:
            raise HTTPException(status_code=404)

        db.delete(doc)
        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="delete_document",
                log_target_table="documents",
                log_target_id=str(doc_id),
                log_created_at=now_tz(),
            )
        )
        db.commit()

    resp = _render_documents_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({"documents-single-result": {"action": "delete", "ok": True}})
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# POST – Bulk delete
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/documents/bulk-delete")
async def admin_documents_bulk_delete(request: Request) -> Template:
    form = await request.form()
    ids = _parse_ids_csv(form.get("ids"))
    if not ids:
        raise HTTPException(status_code=422, detail="Thiếu danh sách ids")

    f = _extract_filters(request, form)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)
        docs = db.query(Document).filter(Document.doc_id.in_(ids)).all()

        affected = 0
        for d in docs:
            db.delete(d)
            affected += 1

        if affected > 0:
            db.add(
                SystemAdminLog(
                    log_admin_id=acting.user_id,
                    log_action="bulk_delete_documents",
                    log_target_table="documents",
                    log_description=f"Bulk delete {affected} / {len(ids)} documents",
                    log_created_at=now_tz(),
                )
            )
        db.commit()

    resp = _render_documents_fragment(request, override_filters=f)
    payload = {"entity": "documents", "action": "delete", "total": len(ids), "affected": affected}
    resp.headers["HX-Trigger"] = json.dumps({"documents-bulk-result": payload})
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# POST – Bulk multiplexer (/admin/documents/bulk) → currently only delete
# ──────────────────────────────────────────────────────────────────────────────
@post("/admin/documents/bulk")
async def admin_documents_bulk(request: Request) -> Template:
    form = await request.form()
    cached = dict(form)

    if "ids" not in cached or not cached.get("ids"):
        alt_ids = cached.get("selected_ids") or cached.get("ids_csv")
        if alt_ids:
            cached["ids"] = alt_ids

    action = (cached.get("action") or cached.get("do") or cached.get("op") or "").strip().lower()

    if action in {"delete", "remove"}:
        # inline execution (reuse logic from bulk-delete)
        ids = _parse_ids_csv(cached.get("ids"))
        if not ids:
            raise HTTPException(status_code=422, detail="Thiếu danh sách ids")
        f = _extract_filters(request, cached)
        with SessionLocal() as db:
            acting = _ensure_admin(request, db)
            docs = db.query(Document).filter(Document.doc_id.in_(ids)).all()
            affected = 0
            for d in docs:
                db.delete(d)
                affected += 1
            if affected > 0:
                db.add(
                    SystemAdminLog(
                        log_admin_id=acting.user_id,
                        log_action="bulk_delete_documents",
                        log_target_table="documents",
                        log_description=f"Bulk delete {affected} / {len(ids)} documents",
                        log_created_at=now_tz(),
                    )
                )
            db.commit()
        resp = _render_documents_fragment(request, override_filters=f)
        payload = {"entity": "documents", "action": "delete", "total": len(ids), "affected": affected}
        resp.headers["HX-Trigger"] = json.dumps({"documents-bulk-result": payload})
        return resp

    # unknown action → fragment + trigger
    f = _extract_filters(request, cached)
    resp = _render_documents_fragment(request, override_filters=f)
    resp.headers["HX-Trigger"] = json.dumps({
        "documents-bulk-result": {
            "entity": "documents",
            "action": action or "unknown",
            "ok": False,
            "reason": "unknown_action",
        }
    })
    from litestar.status_codes import HTTP_422_UNPROCESSABLE_ENTITY
    resp.status_code = HTTP_422_UNPROCESSABLE_ENTITY
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# GET – Sort via HTMX
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/documents/sort")
async def admin_documents_sort(request: Request) -> Template:
    sort_key = _normalize_sort(request.query_params.get("sort") or request.query_params.get("k") or "")
    f0 = _extract_filters(request, None)
    f = f0._replace(sort=sort_key, page=1)
    return _render_documents_fragment(request, override_filters=f)


# ──────────────────────────────────────────────────────────────────────────────
# GET – Export CSV (+ compat redirect)
# ──────────────────────────────────────────────────────────────────────────────
@get("/admin/documents/export-csv")
async def admin_documents_export_csv(request: Request) -> Response:
    """
    Export documents to CSV.
    If ?ids=... present → export selected list; else export current filters.
    Sort does not affect CSV (always created_at DESC).
    """
    ids = _parse_ids_csv(request.query_params.get("ids"))
    f = _extract_filters(request, None)

    with SessionLocal() as db:
        acting = _ensure_admin(request, db)

        stmt = select(Document)
        if ids:
            stmt = stmt.where(Document.doc_id.in_(ids))
        else:
            stmt = _apply_filters_to_stmt(stmt, f)

        docs = db.scalars(stmt.order_by(Document.doc_created_at.desc())).all()

        rows = [
            (
                d.doc_id,
                d.doc_chat_id,
                d.doc_title or "",
                d.doc_status,
                d.doc_file_path,
                d.doc_ocr_text_path,
                (d.doc_created_at.astimezone().strftime("%d/%m/%Y %H:%M") if d.doc_created_at else ""),
                (d.doc_updated_at.astimezone().strftime("%d/%m/%Y %H:%M") if d.doc_updated_at else ""),
            )
            for d in docs
        ]

        db.add(
            SystemAdminLog(
                log_admin_id=acting.user_id,
                log_action="export_documents_csv",
                log_target_table="documents",
                log_description=(f"Export selected {len(ids)} documents" if ids else f"Export {len(docs)} documents"),
                log_created_at=now_tz(),
            )
        )
        db.commit()

    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(
        [
            "doc_id",
            "doc_chat_id",
            "doc_title",
            "doc_status",
            "doc_file_path",
            "doc_ocr_text_path",
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
            "Content-Disposition": f'attachment; filename="admin_documents_{now_tz().strftime("%Y%m%d_%H%M%S")}.csv"',
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@get("/admin/documents/export")
async def admin_documents_export_redirect(request: Request) -> Redirect:
    qs = request.url.query or ""
    target = "/admin/documents/export-csv" + (("?" + qs) if qs else "")
    return Redirect(target, status_code=302)

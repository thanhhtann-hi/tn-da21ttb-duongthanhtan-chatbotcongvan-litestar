# file: src/modules/chat/routes/chat_footer.py
# updated: 2025-09-03
# note:
#   - GET  /chat/tools         → JSON danh sách tool (lọc: enabled + access_scope + system_enabled_tools)
#                                SẮP XẾP: tool_sort_order DESC (5→1), nulls last; rồi name ASC
#   - POST /chat/tools/select  → Lưu lựa chọn tool (cookie 'cf_tools' = CSV tool_id). Nếu không chọn → XÓA COOKIE (max_age=0)
#   - Trường trả về: id, name(code), label(description), access_scope, sort_order
#   - JS hiện ưu tiên lưu lựa chọn THEO CUỘC TRÒ CHUYỆN ở localStorage; cookie vẫn được đồng bộ để có mặc định ở /chat/.
#   - NEW (2025-09-02):
#       * Trả kèm meta.user_status + headers X-User-Role / X-User-Status ở GET /chat/tools
#       * Hỗ trợ form array: tool_ids[] / tool_names[] bên cạnh JSON & CSV
#       * Redirect “an toàn” dùng Response(status_code=302, headers={"Location": ...})
#   - NEW (2025-09-03):
#       * Bổ sung các trường tiện ích cho FE: slug, requires_text (giúp khóa tool 'text_classifier' khi chưa có văn bản)
from __future__ import annotations

import re
import logging
from typing import Optional, Set, List, Tuple, Dict, Any

from litestar import get, post, Request
from litestar.response import Response
from sqlalchemy import select

from core.db.engine import SessionLocal
from core.db.models import User, SystemSettings, ToolDefinition
from shared.secure_cookie import get_secure_cookie
from shared.request_helpers import client_ip

logger = logging.getLogger("docaix.chat.footer")

# ───────── helpers chung ─────────
def _role_allows(scope: Optional[str], user_role: str) -> bool:
    s = (scope or "all").lower()
    if s == "all":
        return True
    if s == "user":
        return user_role in ("user", "internal", "admin")
    if s == "internal":
        return user_role in ("internal", "admin")
    if s == "admin":
        return user_role == "admin"
    return False


def _ensure_user(request: Request, db) -> tuple[Optional[User], Optional[SystemSettings]]:
    """
    Lấy user và system settings từ scope nếu có; nếu không, fallback DB.
    """
    sys: Optional[SystemSettings] = request.scope.get("sys")  # type: ignore[assignment]
    user: Optional[User] = request.scope.get("user")  # type: ignore[assignment]
    if not sys:
        sys = db.query(SystemSettings).first()
    if not user:
        uid = get_secure_cookie(request)
        if uid:
            user = db.get(User, uid)
    return user, sys


# system_enabled_tools: cho phép id / tool_name
def _parse_enabled_tools(sys: Optional[SystemSettings]) -> tuple[Optional[Set[str]], Optional[Set[str]]]:
    if not sys or not sys.system_enabled_tools:
        return None, None
    ids: Set[str] = set()
    names: Set[str] = set()
    for raw in sys.system_enabled_tools:
        if not raw:
            continue
        s = str(raw).strip()
        if not s:
            continue
        # đơn giản: xem như UUID nếu có gạch và đủ dài
        if len(s) >= 32 and "-" in s:
            ids.add(s)
        else:
            names.add(s.lower())
    return (ids or None), (names or None)


def _apply_enabled_filters(
    tools: List[ToolDefinition],
    enabled_ids: Optional[Set[str]],
    enabled_names: Optional[Set[str]],
) -> List[ToolDefinition]:
    if not (enabled_ids or enabled_names):
        return list(tools)
    out: List[ToolDefinition] = []
    for t in tools:
        name_lc = (t.tool_name or "").lower()
        if (enabled_ids and t.tool_id in enabled_ids) or (enabled_names and name_lc in enabled_names):
            out.append(t)
    # fallback an toàn nếu cấu hình hệ thống không khớp
    return out or list(tools)


# ───────── FE helpers (slug & flags) ─────────
def _slugify(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s

def _tool_requires_text(t: ToolDefinition) -> bool:
    """
    Đánh dấu tool cần văn bản nhập trước khi kích hoạt (giúp FE khóa item ngay trong menu).
    - Ưu tiên dựa vào code/name
    - Có thể mở rộng: dựa vào cột cấu hình nếu schema bổ sung (chưa bắt buộc)
    """
    name = (t.tool_name or "").lower()
    desc = (t.tool_description or "").lower()
    # phổ biến: text_classifier / classifier
    if "text_classifier" in name or "classifier" in name:
        return True
    # tên/nhãn tiếng Việt
    if re.search(r"phân\s*loại\s*văn\s*bản", desc):
        return True
    return False


def _json_of_tools(tools: List[ToolDefinition]) -> list[dict]:
    out: list[dict] = []
    for t in tools:
        name_code = t.tool_name or ""
        item = {
            "id": t.tool_id,
            "name": name_code,                 # code (answer_mode / web_search / ...)
            "slug": _slugify(name_code),       # NEW: khoá/biểu tượng ổn định
            "label": t.tool_description,       # nhãn hiển thị
            "access_scope": t.tool_access_scope,
            "sort_order": t.tool_sort_order,
            "requires_text": _tool_requires_text(t),  # NEW: hint cho FE
        }
        out.append(item)
    return out


def _sort_key_desc(t: ToolDefinition) -> Tuple[int, int, str]:
    """
    Sắp xếp: tool_sort_order DESC (nulls last), rồi name ASC.
    Trả về tuple so sánh: (null_flag, -sort_order, name_lc)
      - null_flag: 0 nếu có sort_order (đứng trước), 1 nếu None (đứng sau)
      - -sort_order: đảo dấu để có DESC ổn định
    """
    has = isinstance(t.tool_sort_order, int)
    order = int(t.tool_sort_order) if has else 0
    name_lc = (t.tool_name or "").lower()
    return (0, -order, name_lc) if has else (1, 0, name_lc)


# ───────── routes ─────────
@get("/chat/tools")
def list_tools(request: Request) -> Response:
    """
    Trả về danh sách tool dành cho user hiện tại, đã qua các bước lọc:
      - tool_enabled = true
      - role/user_role phù hợp tool_access_scope
      - system_enabled_tools (nếu có)
    """
    uid = get_secure_cookie(request)
    if not uid:
        return Response(status_code=302, headers={"Location": "/auth/login"})

    with SessionLocal() as db:
        user, sys = _ensure_user(request, db)
        if not user or user.user_status != "active":
            return Response(status_code=302, headers={"Location": "/auth/login"})

        rows = db.scalars(select(ToolDefinition).where(ToolDefinition.tool_enabled.is_(True))).all()
        by_role = [t for t in rows if _role_allows(t.tool_access_scope, user.user_role)]

        enabled_ids, enabled_names = _parse_enabled_tools(sys)
        filtered = _apply_enabled_filters(by_role, enabled_ids, enabled_names)

        # sort: order DESC (nulls last), rồi name ASC
        filtered.sort(key=_sort_key_desc)

        payload: Dict[str, Any] = {
            "ok": True,
            "tools": _json_of_tools(filtered),
            "meta": {
                "user_role": user.user_role,
                "user_status": user.user_status,  # NEW
                "allowed_by_system": bool(sys and sys.system_enabled_tools),
                "count": len(filtered),
                "sort": "desc",
            },
        }
        return Response(
            media_type="application/json",
            content=payload,
            headers={
                "Cache-Control": "no-store",
                "Vary": "Cookie, HX-Request",
                "X-User-Role": user.user_role,       # NEW
                "X-User-Status": user.user_status,   # NEW
            },
        )


@post("/chat/tools/select")
async def select_tools(request: Request) -> Response:
    """
    Lưu danh sách tool đã chọn (multi-select) vào cookie 'cf_tools' (CSV id).
    Nếu danh sách rỗng → xóa cookie để tránh F5 bị dính tool mặc định.

    Frontend có thể gửi:
      - JSON: { "tool_ids": ["id1","id2",...], "tool_names": ["code1", ...] }
      - hoặc form-url-encoded:
            ids=csv&tool_names=csv
         hoặc mảng:
            tool_ids[]=...&tool_ids[]=...&tool_names[]=...
    """
    uid = get_secure_cookie(request)
    if not uid:
        return Response(status_code=302, headers={"Location": "/auth/login"})

    # đọc body json/form
    data: dict = {}
    try:
        ctype = (request.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if ctype == "application/json":
            data = (await request.json()) or {}
        else:
            form = await request.form()
            data = dict(form)
            # Kéo thêm mảng nếu có (để không bị mất khi dict(form) chỉ lấy 1 phần tử)
            try:
                data.setdefault("tool_ids[]", form.getlist("tool_ids[]"))
            except Exception:
                data.setdefault("tool_ids[]", [])
            try:
                data.setdefault("tool_names[]", form.getlist("tool_names[]"))
            except Exception:
                data.setdefault("tool_names[]", [])
    except Exception:
        data = {}

    # Hỗ trợ đủ các biến thể: JSON keys, csv, và mảng [] của form
    raw_ids = data.get("tool_ids") or data.get("ids") or data.get("tool_ids[]") or []
    raw_names = data.get("tool_names") or data.get("names") or data.get("tool_names[]") or []

    if isinstance(raw_ids, str):
        raw_ids = [x.strip() for x in raw_ids.split(",") if x.strip()]
    if isinstance(raw_names, str):
        raw_names = [x.strip() for x in raw_names.split(",") if x.strip()]

    with SessionLocal() as db:
        user, sys = _ensure_user(request, db)
        if not user or user.user_status != "active":
            return Response(status_code=302, headers={"Location": "/auth/login"})

        # lấy tập allowed theo role + system
        allowed = db.scalars(select(ToolDefinition).where(ToolDefinition.tool_enabled.is_(True))).all()
        allowed = [t for t in allowed if _role_allows(t.tool_access_scope, user.user_role)]
        enabled_ids, enabled_names = _parse_enabled_tools(sys)
        allowed = _apply_enabled_filters(allowed, enabled_ids, enabled_names)

        allowed_by_id = {t.tool_id: t for t in allowed}
        allowed_by_name = {(t.tool_name or "").lower(): t for t in allowed}

        # chuẩn hoá danh sách chọn (không duplicate, chỉ nhận id/name hợp lệ)
        chosen: list[ToolDefinition] = []

        def _add_tool(t: ToolDefinition) -> None:
            if t and t not in chosen:
                chosen.append(t)

        for tid in (raw_ids or []):
            t = allowed_by_id.get(str(tid))
            if t:
                _add_tool(t)

        for nm in (raw_names or []):
            t = allowed_by_name.get(str(nm).lower())
            if t:
                _add_tool(t)

        # set / clear cookie
        ids_csv = ",".join([t.tool_id for t in chosen])

        resp = Response(
            media_type="application/json",
            content={
                "ok": True,
                "selected": [{"id": t.tool_id, "name": t.tool_name, "label": t.tool_description} for t in chosen],
                "count": len(chosen),
            },
            headers={
                "Cache-Control": "no-store",
                "HX-Trigger": "chat-tools-selected",
            },
        )

        secure_flag = request.url.scheme == "https"

        if chosen:
            # Lưu cookie 30 ngày
            resp.set_cookie(
                key="cf_tools",
                value=ids_csv,
                max_age=30 * 24 * 3600,
                secure=secure_flag,
                httponly=False,
                samesite="Lax",
                path="/",
            )
        else:
            # Không chọn gì → xóa cookie ngay
            resp.set_cookie(
                key="cf_tools",
                value="",
                max_age=0,  # hết hạn ngay
                secure=secure_flag,
                httponly=False,
                samesite="Lax",
                path="/",
            )

        ip = client_ip(request) or "-"
        logger.info("tools.select user=%s ip=%s selected=%s", getattr(user, "user_id", "-"), ip, ids_csv or "-")
        return resp

# file: src/modules/chat/routes/chat_index.py
# updated: 2025-09-02
# purpose: Trang chat (UI) – truyền biến 'user' vào template,
#          và danh sách model đã lọc (id|name|tier|provider_model_id) để dropdown “Đổi mô hình” hoạt động.
# changes:
#   - Không còn ép tier 'auto' → 'low' ở UI; FE có thể hiển thị "Auto (smart)" (router 2-pass sẽ xử lý ở BE)
#   - Lọc model theo status: chỉ hiển thị ('active','preview')
#   - Thêm headers X-User-Role / X-User-Status, Vary: Cookie,HX-Request
#   - Redirect an toàn dùng Response(status_code=302, headers={"Location": ...})

from __future__ import annotations

import logging
import json
from types import SimpleNamespace
from typing import Optional, List, Iterable, Set, Tuple

from litestar import get, Request
from litestar.response import Template, Response
from sqlalchemy import select, desc, and_

from core.db.engine import SessionLocal
from core.db.models import User, ChatHistory, ChatMessage, ModelVariant, SystemSettings
from shared.secure_cookie import get_secure_cookie

log = logging.getLogger(__name__)


def _redirect(location: str) -> Response:
    return Response(content="", status_code=302, headers={"Location": location})


def _anon_user() -> SimpleNamespace:
    return SimpleNamespace(
        user_id=None,
        user_display_name="User",
        user_email="",
        user_role="user",
        user_status="active",
    )


def _safe_user(u: Optional[User]) -> SimpleNamespace:
    if not u:
        return _anon_user()
    # Detach các field cơ bản để dùng ngoài session
    return SimpleNamespace(
        user_id=u.user_id,
        user_display_name=u.user_display_name or (u.user_name or "User"),
        user_email=u.user_email,
        user_role=u.user_role,
        user_status=u.user_status,
    )


def _trim_preview(s: Optional[str], limit: int = 160) -> str:
    if not s:
        return ""
    s = " ".join(s.split())  # nén khoảng trắng/newline
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _chat_list(uid: str) -> List[ChatHistory]:
    """
    Lấy 50 chat gần nhất của user, gắn thêm thuộc tính động:
      - last_preview: snippet của message mới nhất (ưu tiên AI response, fallback question)
    """
    with SessionLocal() as db:
        q = (
            select(ChatHistory)
            .where(and_(ChatHistory.chat_user_id == uid, ChatHistory.chat_status == "active"))
            .order_by(desc(ChatHistory.chat_updated_at))
            .limit(50)
        )
        chats = list(db.scalars(q).all())

        # Gắn preview cho từng chat (đơn giản, chấp nhận N+1 với N<=50)
        for ch in chats:
            last_msg = db.execute(
                select(ChatMessage)
                .where(ChatMessage.message_chat_id == ch.chat_id)
                .order_by(desc(ChatMessage.message_created_at))
                .limit(1)
            ).scalar_one_or_none()
            preview = ""
            if last_msg:
                preview = last_msg.message_ai_response or last_msg.message_question or ""
            setattr(ch, "last_preview", _trim_preview(preview))
        return chats


# ─────────────── Model filtering (đồng bộ với chat_header.py / chat_api) ───────────────

_TIER_ORDER = {"auto": 0, "low": 1, "medium": 2, "high": 3}  # auto để trước khi tie-break

def _normalize_tier(val: Optional[str]) -> Optional[str]:
    """
    UI hiển thị đúng tier gốc, bao gồm 'auto' (router 2-pass sẽ chọn tier thực sự khi gọi model).
    """
    if not val:
        return None
    v = val.strip().lower()
    return v if v in ("auto", "low", "medium", "high") else None


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


def _parse_allowed(sys: Optional[SystemSettings]) -> tuple[Optional[Set[str]], Optional[Set[str]], Optional[Set[str]]]:
    """
    system_allowed_models hỗ trợ:
      - UUID model_id
      - model_name (lower)
      - tier: auto|low|medium|high (không ép auto→low)
    """
    if not sys or not sys.system_allowed_models:
        return None, None, None
    ids: Set[str] = set()
    names: Set[str] = set()
    tiers: Set[str] = set()
    for raw in sys.system_allowed_models:
        if not raw:
            continue
        s = str(raw).strip()
        if not s:
            continue
        sl = s.lower()
        if len(s) >= 32 and "-" in s:
            ids.add(s)
            continue
        t = _normalize_tier(sl)
        if t:
            tiers.add(t)
            continue
        names.add(sl)
    return (ids or None), (names or None), (tiers or None)


def _apply_allowed(
    models: List[ModelVariant],
    allowed_ids: Optional[Set[str]],
    allowed_names_lc: Optional[Set[str]],
    allowed_tiers: Optional[Set[str]],
) -> List[ModelVariant]:
    if not (allowed_ids or allowed_names_lc or allowed_tiers):
        return list(models)
    out: List[ModelVariant] = []
    for m in models:
        name_lc = (m.model_name or "").lower()
        tier = _normalize_tier(m.model_tier)
        if (allowed_ids and m.model_id in allowed_ids) \
           or (allowed_names_lc and name_lc in allowed_names_lc) \
           or (allowed_tiers and tier in allowed_tiers):
            out.append(m)
    return out


def _filter_models_for(user: User, sys: Optional[SystemSettings], db) -> list[ModelVariant]:
    # chỉ lấy enabled + status in ('active','preview') để đồng bộ với BE
    rows = db.scalars(
        select(ModelVariant).where(
            ModelVariant.model_enabled.is_(True),
            ModelVariant.model_status.in_(("active", "preview")),
        )
    ).all()
    by_role = [m for m in rows if _role_allows(m.model_access_scope, user.user_role)]
    allowed_ids, allowed_names_lc, allowed_tiers = _parse_allowed(sys)
    filtered = _apply_allowed(by_role, allowed_ids, allowed_names_lc, allowed_tiers)
    if (allowed_ids or allowed_names_lc or allowed_tiers) and not filtered and by_role:
        log.warning("system_allowed_models loại bỏ toàn bộ model. Fallback theo role.")
        filtered = by_role

    def sort_key(x: ModelVariant):
        order_hint = x.model_sort_order if isinstance(x.model_sort_order, int) else 9999
        return (
            order_hint,
            _TIER_ORDER.get(_normalize_tier(x.model_tier) or "", 999),
            (x.model_provider or "").lower(),
            (x.model_name or "").lower(),
        )
    filtered.sort(key=sort_key)
    return filtered


def _models_json(models: Iterable[ModelVariant]) -> list[dict]:
    out: list[dict] = []
    for m in models:
        out.append(
            {
                "id": m.model_id,
                "name": m.model_name,
                "tier": _normalize_tier(m.model_tier),  # có thể là 'auto'
                "provider": m.model_provider,
                "provider_model_id": m.provider_model_id,  # cho FE dùng khi regenerate (nếu cần)
            }
        )
    return out


def _selected_from_cookie(request: Request, models: list[ModelVariant]) -> Optional[ModelVariant]:
    if not models:
        return None
    sel_id = (request.cookies.get("moe_model_id") or "").strip()
    sel_name = (request.cookies.get("moe_model_name") or "").strip().lower()
    for m in models:
        if (sel_id and m.model_id == sel_id) or (sel_name and (m.model_name or "").lower() == sel_name):
            return m
    return None


# ─────────────── Routes ───────────────

@get("/chat")
def chat_index(request: Request) -> Template | Response:
    uid = get_secure_cookie(request)
    if not uid:
        return _redirect("/auth/login")

    with SessionLocal() as db:
        user_db: Optional[User] = db.get(User, uid)
        if not user_db or user_db.user_status != "active":
            return _redirect("/auth/login")
        user = _safe_user(user_db)

        # Lấy system settings & danh sách model đã lọc
        sys = db.query(SystemSettings).first()
        models = _filter_models_for(user_db, sys, db)
        selected = _selected_from_cookie(request, models)

        allowed_models_json = json.dumps(_models_json(models))
        moe_selected_json = json.dumps(
            {
                "id": selected.model_id,
                "name": selected.model_name,
                "tier": _normalize_tier(selected.model_tier),  # giữ 'auto' nếu có
            }
        ) if selected else "null"

    chats = _chat_list(uid)

    return Template(
        template_name="chat_index.html",
        context={
            "user": user,
            "chats": chats,
            # FE đọc từ #chat-header[data-allowed-models] để render dropdown “Đổi mô hình”
            "allowed_models_json": allowed_models_json,
            # Tuỳ chọn: FE có thể dùng để set trạng thái chọn ngay
            "moe_selected_json": moe_selected_json,
        },
        headers={
            "Cache-Control": "no-store",
            "Vary": "Cookie, HX-Request",
            "X-User-Role": user.user_role,
            "X-User-Status": user.user_status,
        },
    )


@get("/chat/{chat_id:str}")
def chat_detail(request: Request, chat_id: str) -> Template | Response:
    uid = get_secure_cookie(request)
    if not uid:
        return _redirect("/auth/login")

    with SessionLocal() as db:
        user_db: Optional[User] = db.get(User, uid)
        if not user_db or user_db.user_status != "active":
            return _redirect("/auth/login")
        user = _safe_user(user_db)

        chat: Optional[ChatHistory] = db.get(ChatHistory, chat_id)
        if not chat or chat.chat_user_id != uid or chat.chat_status != "active":
            return _redirect("/chat")

        msgs = list(
            db.scalars(
                select(ChatMessage)
                .where(ChatMessage.message_chat_id == chat.chat_id)
                .order_by(ChatMessage.message_created_at.asc())
                .limit(200)
            ).all()
        )

        # Lấy system settings & models trong cùng session
        sys = db.query(SystemSettings).first()
        models = _filter_models_for(user_db, sys, db)
        selected = _selected_from_cookie(request, models)

        allowed_models_json = json.dumps(_models_json(models))
        moe_selected_json = json.dumps(
            {
                "id": selected.model_id,
                "name": selected.model_name,
                "tier": _normalize_tier(selected.model_tier),  # giữ 'auto' nếu có
            }
        ) if selected else "null"

    chats = _chat_list(uid)

    return Template(
        template_name="chat_index.html",  # ✅ giống /chat
        context={
            "user": user,
            "chats": chats,
            "active_chat_id": chat.chat_id,
            "messages": msgs,
            "allowed_models_json": allowed_models_json,  # ⬅️ FE đọc từ #chat-header[data-allowed-models]
            "moe_selected_json": moe_selected_json,
        },
        headers={
            "Cache-Control": "no-store",
            "Vary": "Cookie, HX-Request",
            "X-User-Role": user.user_role,
            "X-User-Status": user.user_status,
        },
    )

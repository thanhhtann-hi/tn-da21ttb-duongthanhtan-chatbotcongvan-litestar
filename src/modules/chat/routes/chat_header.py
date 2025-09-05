# file: src/modules/chat/routes/chat_header.py
# updated: 2025-09-02
# note:
#   - COOKIE-driven selection, expose selected in meta/context
#   - CHUẨN HOÁ TIER: hỗ trợ đủ 4 mức: auto | low | medium | high
#     (KHÔNG ép 'auto' → 'low'; router 2-pass ở BE sẽ quyết định tier thật khi gọi model)
#   - Chỉ hiển thị model enabled + status ∈ ('active','preview')
#   - Endpoints:
#       • GET  /chat/models            → JSON danh sách model (kèm tier & provider_model_id) + meta.selected
#       • GET  /chat/header/fragment   → Render partial header (moe_models + moe_selected)
#       • POST /chat/model/select      → Lưu chọn model (cookie) + trả selected.tier (có thể là 'auto')
#   - Lọc theo role + system_allowed_models (hỗ trợ: id, name, tier). Token lạ bị bỏ qua.
#   - Không cache (no-store), Vary theo Cookie & HX-Request. Trả kèm X-User-Role / X-User-Status.

from __future__ import annotations

from typing import Iterable, Tuple, Set, List, Optional, Dict, Any
import logging

from litestar import get, post, Request
from litestar.response import Template, Response, Redirect
from sqlalchemy import select, and_, func as sa_func

from core.db.engine import SessionLocal
from core.db.models import User, SystemSettings, ModelVariant  # type: ignore[attr-defined]
from shared.secure_cookie import get_secure_cookie
from shared.request_helpers import client_ip

logger = logging.getLogger("docaix.chat.header")


# ───────────────────────── helpers ─────────────────────────

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
    """Lấy user & system settings từ scope, fallback DB khi thiếu."""
    sys: Optional[SystemSettings] = request.scope.get("sys")  # type: ignore[assignment]
    user: Optional[User] = request.scope.get("user")          # type: ignore[assignment]
    if not sys:
        sys = db.query(SystemSettings).first()
    if not user:
        uid = get_secure_cookie(request)
        if uid:
            user = db.get(User, uid)
    return user, sys


# === Tier helpers (chuẩn hoá 4 mức) ===

_TIER_ORDER = {"auto": 0, "low": 1, "medium": 2, "high": 3}

def _normalize_tier(val: Optional[str]) -> Optional[str]:
    """
    Trả về 'auto' | 'low' | 'medium' | 'high' hoặc None.
    KHÔNG ép 'auto' → 'low'; BE sẽ router 2-pass khi gọi model.
    """
    if not val:
        return None
    v = val.strip().lower()
    return v if v in ("auto", "low", "medium", "high") else None


def _tier_order(v: Optional[str]) -> int:
    t = _normalize_tier(v)
    return _TIER_ORDER.get(t or "", 999)


# === System allowed parsing ===

def _parse_allowed(sys: Optional[SystemSettings]) -> tuple[Optional[Set[str]], Optional[Set[str]], Optional[Set[str]]]:
    """
    Tách allowed thành 3 nhóm: ids / names (lower-case) / tiers (auto|low|medium|high).
    Bỏ qua token lạ (fast/pro/thinking/research...).
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

        # UUID-like id (thường 36 + '-')
        if len(s) >= 32 and "-" in s:
            ids.add(s)
            continue

        # Tier token
        t = _normalize_tier(sl)
        if t:
            tiers.add(t)
            continue

        # Name fallback (lower-case)
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
    # 1) enabled + status ∈ ('active','preview')
    rows = db.scalars(
        select(ModelVariant).where(
            ModelVariant.model_enabled.is_(True),
            ModelVariant.model_status.in_(("active", "preview")),
        )
    ).all()

    # 2) theo role
    by_role = [m for m in rows if _role_allows(m.model_access_scope, user.user_role)]

    # 3) theo allowed (id / name / tier)
    allowed_ids, allowed_names_lc, allowed_tiers = _parse_allowed(sys)
    filtered = _apply_allowed(by_role, allowed_ids, allowed_names_lc, allowed_tiers)

    # 3.5) fallback an toàn nếu cấu hình loại bỏ hết
    if (allowed_ids or allowed_names_lc or allowed_tiers) and not filtered and by_role:
        logger.warning("system_allowed_models loại bỏ toàn bộ model. Fallback theo role.")
        filtered = by_role

    # 4) sort ổn định: order tự khai báo > tier > provider > name
    def sort_key(x: ModelVariant):
        order_hint = x.model_sort_order if isinstance(x.model_sort_order, int) else 9999
        return (
            order_hint,
            _tier_order(x.model_tier),
            (x.model_provider or "").lower(),
            (x.model_name or "").lower(),
        )

    filtered.sort(key=sort_key)
    return filtered


def _short_label(m: ModelVariant) -> str:
    """
    Nhãn ngắn cho dropdown:
      - Ưu tiên model_name (cắt gọn nếu cần).
    """
    name = (m.model_name or "").strip()
    if len(name) <= 64:
        return name
    return name[:61] + "..."


def _json_of_models(models: Iterable[ModelVariant]) -> list[dict]:
    out: list[dict] = []
    for m in models:
        tier = _normalize_tier(m.model_tier)
        out.append(
            {
                "id": m.model_id,
                "name": m.model_name,
                "provider": m.model_provider,
                "type": m.model_type,
                "tier": tier,                          # <-- CHUẨN: có thể là 'auto'
                "short_label": _short_label(m),
                "description": m.model_description,
                "access_scope": m.model_access_scope,
                "provider_model_id": m.provider_model_id,  # tiện cho FE debug/hiển thị
            }
        )
    return out


def _selected_from_cookie(request: Request, models: list[ModelVariant]) -> Optional[ModelVariant]:
    """
    Tìm model đang chọn dựa vào cookie: moe_model_id | moe_model_name.
    So khớp trong tập `models` (đã lọc theo role + allowed).
    """
    if not models:
        return None
    sel_id = (request.cookies.get("moe_model_id") or "").strip()
    sel_name = (request.cookies.get("moe_model_name") or "").strip().lower()
    for m in models:
        if (sel_id and m.model_id == sel_id) or (sel_name and (m.model_name or "").lower() == sel_name):
            return m
    return None


# ───────────────────────── routes ─────────────────────────

@get("/chat/models")
def list_models(request: Request) -> Response | Redirect:
    uid = get_secure_cookie(request)
    if not uid:
        return Redirect("/auth/login", status_code=302)

    with SessionLocal() as db:
        user, sys = _ensure_user(request, db)
        if not user or user.user_status != "active":
            return Redirect("/auth/login", status_code=302)

        models = _filter_models_for(user, sys, db)
        selected = _selected_from_cookie(request, models)

        payload: Dict[str, Any] = {
            "ok": True,
            "models": _json_of_models(models),
            "meta": {
                "user_role": user.user_role,
                "allowed_by_system": bool(sys and sys.system_allowed_models),
                "count": len(models),
                "selected": (
                    {
                        "id": selected.model_id,
                        "name": selected.model_name,
                        "tier": _normalize_tier(selected.model_tier),  # có thể là 'auto'
                        "provider_model_id": selected.provider_model_id,
                    }
                    if selected
                    else None
                ),
            },
        }
        return Response(
            media_type="application/json",
            content=payload,
            headers={
                "Cache-Control": "no-store",
                "Vary": "Cookie, HX-Request",
                "X-User-Role": user.user_role,
                "X-User-Status": user.user_status,
            },
        )


@get("/chat/header/fragment")
def header_fragment(request: Request) -> Template | Redirect:
    uid = get_secure_cookie(request)
    if not uid:
        return Redirect("/auth/login", status_code=302)

    with SessionLocal() as db:
        user, sys = _ensure_user(request, db)
        if not user or user.user_status != "active":
            return Redirect("/auth/login", status_code=302)

        models = _filter_models_for(user, sys, db)
        selected = _selected_from_cookie(request, models)

        # Hiển thị: để JS thiết lập .moe-variant theo tier → server không áp đặt
        default_label = "MoE"
        default_variant = ""  # không còn "Fast/Pro/Thinking" legacy

        return Template(
            template_name="partials/chat_header.html",
            context={
                "user": user,
                "is_home": request.query_params.get("is_home") in ("1", "true", "yes"),
                "moe_models": _json_of_models(models),
                "moe_selected": (
                    {
                        "id": selected.model_id,
                        "name": selected.model_name,
                        "tier": _normalize_tier(selected.model_tier),  # có thể là 'auto'
                        "provider_model_id": selected.provider_model_id,
                    }
                    if selected
                    else None
                ),
                "moe_default_label": default_label,
                "moe_default_variant": default_variant,
            },
            headers={
                "Cache-Control": "no-store",
                "Vary": "Cookie, HX-Request",
                "X-User-Role": user.user_role,
                "X-User-Status": user.user_status,
            },
        )


@post("/chat/model/select")
async def select_model(request: Request) -> Response | Redirect:
    uid = get_secure_cookie(request)
    if not uid:
        return Redirect("/auth/login", status_code=302)

    # Đọc body linh hoạt
    data: dict = {}
    try:
        ctype = (request.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if ctype == "application/json":
            data = (await request.json()) or {}
        elif ctype in {"application/x-www-form-urlencoded", "multipart/form-data"}:
            form = await request.form()
            data = dict(form)
        else:
            data = {**(request.query_params or {}), **(request.headers or {})}
    except Exception:
        data = {}

    model_id = (str(data.get("model_id") or "")).strip()
    model_name = (str(data.get("model_name") or "")).strip()

    with SessionLocal() as db:
        user, sys = _ensure_user(request, db)
        if not user or user.user_status != "active":
            return Redirect("/auth/login", status_code=302)

        # Tìm theo id/name (case-insensitive cho name)
        m: Optional[ModelVariant] = None
        if model_id:
            m = db.get(ModelVariant, model_id)
        elif model_name:
            m = db.scalars(
                select(ModelVariant).where(
                    and_(
                        sa_func.lower(ModelVariant.model_name) == model_name.lower(),
                        ModelVariant.model_enabled.is_(True),
                        ModelVariant.model_status.in_(("active", "preview")),
                    )
                )
            ).first()

        # Chỉ cho phép chọn trong tập đã lọc theo role + allowed
        allowed_ids = {mv.model_id for mv in _filter_models_for(user, sys, db)}
        if not m or (m.model_id not in allowed_ids):
            return Response(
                media_type="application/json",
                content={"ok": False, "error": "MODEL_NOT_ALLOWED"},
                status_code=400,
                headers={"Cache-Control": "no-store"},
            )

        t = _normalize_tier(m.model_tier)

        resp = Response(
            media_type="application/json",
            content={
                "ok": True,
                "selected": {
                    "id": m.model_id,
                    "name": m.model_name,
                    "provider": m.model_provider,
                    "tier": t,  # có thể là 'auto'
                    "provider_model_id": m.provider_model_id,
                },
            },
            headers={
                "Cache-Control": "no-store",
                "HX-Trigger": "moe-model-selected",
                "X-User-Role": user.user_role,
                "X-User-Status": user.user_status,
            },
        )
        # Cookies để nhớ lựa chọn (UI + server dùng)
        resp.set_cookie(
            "moe_model_id",
            m.model_id,
            max_age=30 * 24 * 3600,
            secure=request.url.scheme == "https",
            httponly=False,
            samesite="Lax",
            path="/",
        )
        resp.set_cookie(
            "moe_model_name",
            m.model_name or "",
            max_age=30 * 24 * 3600,
            secure=request.url.scheme == "https",
            httponly=False,
            samesite="Lax",
            path="/",
        )

        ip = client_ip(request) or "-"
        logger.info(
            "model.select user=%s ip=%s model=%s (%s) tier=%s",
            user.user_id, ip, m.model_name, m.model_id, t or "-"
        )
        return resp

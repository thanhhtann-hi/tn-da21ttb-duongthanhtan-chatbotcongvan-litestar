# file: src/modules/chat/service/chat_auto_tier.py
# updated: 2025-09-02 (v1.1.0)
# purpose:
#   - Router 2-pass cho reasoning tier (low/medium/high) + chọn ModelVariant tương ứng từ DB
#   - Ưu tiên "cùng họ" với model người dùng đang chọn (provider_model_id / model_provider)
#   - Tôn trọng access_scope theo vai trò ("all","user","internal","admin")
#   - Hỗ trợ LLM router (Runpod/OpenAI compatible) và heuristic fallback khi thiếu cấu hình
#   - HARD RULES (ưu tiên tuyệt đối):
#       * Có dấu hiệu code → HIGH
#       * Prompt ≥ LENGTH_HIGH_THRESHOLD_CHARS (mặc định 1000) → HIGH
#       * Có chuỗi gợi ý tệp .pdf / .doc / .docx trong prompt → HIGH
#       * (Các rule cứng này override kết quả router nếu router trả thấp)
#
from __future__ import annotations

import os
import re
import math
import asyncio
from typing import TYPE_CHECKING, Optional, Tuple, List, Any

# Type-only imports
if TYPE_CHECKING:
    from openai import OpenAI as OpenAIClient
else:
    OpenAIClient = Any  # type: ignore[assignment,misc]

from core.db.models import ModelVariant

# ─────────────────────────────────────────────────────────────────────────────
# ENV & helpers
# ─────────────────────────────────────────────────────────────────────────────
def _env_bool(name: str, default: bool) -> bool:
    v = (os.getenv(name, "") or "").strip().lower()
    if v in ("1", "true", "yes", "y", "on"):
        return True
    if v in ("0", "false", "no", "n", "off"):
        return False
    return default

def _env_int(name: str, default: int) -> int:
    try:
        v = os.getenv(name, "")
        return int(v.strip()) if v and v.strip() else default
    except Exception:
        return default

RUNPOD_BASE_URL = (os.getenv("RUNPOD_BASE_URL", "").strip() or "")
RUNPOD_API_KEY = (os.getenv("RUNPOD_API_KEY", "").strip() or "")
RUNPOD_TIMEOUT = _env_int("RUNPOD_TIMEOUT", 60)

RUNPOD_DEFAULT_MODEL = os.getenv("RUNPOD_DEFAULT_MODEL", "openai/gpt-oss-20b").strip()
RUNPOD_DEFAULT_REASONING = (os.getenv("RUNPOD_DEFAULT_REASONING", "low") or "low").strip().lower()

AUTO_TIER_ENABLED = _env_bool("AUTO_TIER_ENABLED", True)
AUTO_TIER_ROUTER_MODEL = os.getenv("AUTO_TIER_ROUTER_MODEL", RUNPOD_DEFAULT_MODEL).strip()
AUTO_TIER_ROUTER_MAXTOK = _env_int("AUTO_TIER_ROUTER_MAXTOK", 16)

# New: hard-rule knobs
AUTO_TIER_HARD_RULES = _env_bool("AUTO_TIER_HARD_RULES", True)
LENGTH_HIGH_THRESHOLD_CHARS = _env_int("LENGTH_HIGH_THRESHOLD_CHARS", 1000)   # yêu cầu: >= 1k ký tự → HIGH
VERY_LONG_THRESHOLD_CHARS   = _env_int("VERY_LONG_THRESHOLD_CHARS", 8000)    # safety

# ─────────────────────────────────────────────────────────────────────────────
# OpenAI/Runpod client (lazy)
# ─────────────────────────────────────────────────────────────────────────────
_client: Optional[OpenAIClient] = None
def _get_client() -> Optional[OpenAIClient]:
    global _client
    if _client is not None:
        return _client
    if not AUTO_TIER_ENABLED or not RUNPOD_BASE_URL or not RUNPOD_API_KEY:
        return None
    try:
        from openai import OpenAI as SDKOpenAI  # type: ignore
    except Exception:
        return None
    base_url = RUNPOD_BASE_URL.rstrip("/")
    if not base_url.endswith("/v1"):
        base_url += "/v1"
    try:
        _client = SDKOpenAI(base_url=base_url, api_key=RUNPOD_API_KEY, timeout=RUNPOD_TIMEOUT)  # type: ignore
        return _client
    except Exception:
        return None

# ─────────────────────────────────────────────────────────────────────────────
# Tier helpers
# ─────────────────────────────────────────────────────────────────────────────
TIERS = ("low", "medium", "high", "auto")
def normalize_tier(val: Optional[str]) -> Optional[str]:
    if not val:
        return None
    v = val.strip().lower()
    return v if v in TIERS else None

def system_text_for_reasoning(tier: str) -> str:
    t = normalize_tier(tier) or "low"
    if t == "auto":
        t = "low"
    return f"Reasoning: {t}"

# ─────────────────────────────────────────────────────────────────────────────
# Scope/Status filters
# ─────────────────────────────────────────────────────────────────────────────
_ALLOWED_STATUS = {"active", "preview"}

def _scope_allowed(user_role: str, access_scope: str) -> bool:
    r = (user_role or "user").strip().lower()
    s = (access_scope or "all").strip().lower()
    if s == "all":
        return True
    if s == "user":
        return r in ("user", "internal", "admin")
    if s == "internal":
        return r in ("internal", "admin")
    if s == "admin":
        return r == "admin"
    return False

# ─────────────────────────────────────────────────────────────────────────────
# Heuristic classifier + HARD RULES
# ─────────────────────────────────────────────────────────────────────────────
# code-like
_CODE_PAT = re.compile(r"(```|^#include\b|^\s*def\s|\bclass\s|\bSELECT\b|\bfunction\s|\bconsole\.|<\s*script|\bregex\b)", re.I | re.M)
# math-ish
_MATH_PAT = re.compile(r"(\b\d+(\.\d+)?\s*[%\*/\+\-]\s*\d|\=|∑|∏|√|∫|≈|≤|≥|≠)")
# multi-step hints
_STEPS_PAT = re.compile(r"\bbước\s*\d|\b(step|steps)\b|\bquy trình\b|\bworkflow\b|\bbullet\b", re.I)
# risk domain
_RISK_PAT = re.compile(r"\b(luật|pháp lý|legal|hợp đồng|kế toán|tài chính|chứng khoán|đầu tư|y tế|medical|chuẩn|tiêu chuẩn)\b", re.I)
# doc-like ext in-text (tên file xuất hiện trong prompt/appendix)
_DOC_EXT_PAT = re.compile(r"\.(pdf|docx?|pptx?)\b", re.I)

def _approx_tokens(text_len: int) -> int:
    return math.ceil(max(0, text_len) / 4)

def _has_code(t: str) -> bool:
    return bool(_CODE_PAT.search(t))

def _has_doc_ext(t: str) -> bool:
    return bool(_DOC_EXT_PAT.search(t))

def _force_high_rules(t: str) -> bool:
    """
    HARD override → True => HIGH, bất kể router trả gì:
      - có dấu hiệu code
      - độ dài >= LENGTH_HIGH_THRESHOLD_CHARS
      - có .pdf / .doc / .docx / .pptx trong prompt
    """
    if not AUTO_TIER_HARD_RULES:
        return False
    tt = (t or "").strip()
    if not tt:
        return False
    if _has_code(tt):
        return True
    if len(tt) >= max(1, LENGTH_HIGH_THRESHOLD_CHARS):
        return True
    if _has_doc_ext(tt):
        return True
    return False

def classify_reasoning_heuristic(
    text: str,
    attachments_count: int = 0,
    long_threshold_chars: int = LENGTH_HIGH_THRESHOLD_CHARS,   # >= 1k → HIGH
    very_long_threshold_chars: int = VERY_LONG_THRESHOLD_CHARS,
) -> str:
    t = (text or "").strip()
    length = len(t)
    tokens = _approx_tokens(length)

    # HARD rules trước
    if _force_high_rules(t):
        return "high"

    # Nhạy cảm / rủi ro
    if _RISK_PAT.search(t):
        return "high"

    # Rất dài / quá nhiều file → high
    if length >= very_long_threshold_chars or tokens >= 2000 or attachments_count >= 5:
        return "high"

    # Dài vừa hoặc có nhiều file → medium/high
    if length >= long_threshold_chars or tokens >= 450 or attachments_count >= 2:
        if _STEPS_PAT.search(t) or _MATH_PAT.search(t) or _has_code(t):
            return "high"
        return "medium"

    # Có toán/tính toán nhưng ngắn → medium
    if _MATH_PAT.search(t):
        return "medium"

    return "low"

# ─────────────────────────────────────────────────────────────────────────────
# LLM router (async/sync)
# ─────────────────────────────────────────────────────────────────────────────
_ROUTER_SYS = (
    "You are a STRICT, deterministic router that returns ONE reasoning tier token ONLY.\n"
    "Output MUST be exactly one of: low | medium | high (lowercase, no punctuation).\n"
    "\n"
    "Upgrade to HIGH if ANY of the following is true:\n"
    " - The user text contains code snippets, code fences (```), SQL, regex, or programming APIs.\n"
    " - The text length is >= 1000 characters.\n"
    " - Mentions or includes files with extensions .pdf, .doc, .docx, or .pptx.\n"
    " - Complex multi-step reasoning, multi-hop synthesis, heavy math/proofs, or safety-critical domains (legal/finance/medical/standards).\n"
    " - Very long context or many attachments.\n"
    "\n"
    "Choose MEDIUM for moderate complexity: multi-part Q&A, a few steps, light math, short code-like patterns without full programs.\n"
    "Choose LOW only when the task is simple, short, and requires minimal reasoning.\n"
    "\n"
    "Examples (-> expected):\n"
    " - Short factual Q with no steps -> low\n"
    " - 3–4 bullet requirements or steps -> medium\n"
    " - Has ```code``` block OR length >= 1000 OR mentions *.pdf/*.doc(x) -> high\n"
)

async def decide_reasoning_auto(prompt: str) -> str:
    if not AUTO_TIER_ENABLED:
        return "low"
    # HARD rules override trước khi gọi LLM để khỏi tốn call
    if _force_high_rules(prompt):
        return "high"

    client = _get_client()
    if client is None:
        return classify_reasoning_heuristic(prompt)

    def _call() -> str:
        try:
            resp = client.chat.completions.create(  # type: ignore[attr-defined]
                model=(AUTO_TIER_ROUTER_MODEL or RUNPOD_DEFAULT_MODEL),
                messages=[
                    {"role": "system", "content": _ROUTER_SYS},
                    {"role": "user", "content": (prompt or "")[:8000]},  # cho router xem đủ ngữ cảnh & file names
                ],
                temperature=0,
                max_tokens=AUTO_TIER_ROUTER_MAXTOK,
            )
            out = (resp.choices[0].message.content or "").strip().lower()
            tier = "low"
            if "high" in out:
                tier = "high"
            elif "medium" in out or "med" in out:
                tier = "medium"
            # HARD rules lần nữa (phòng LLM phán thấp)
            if _force_high_rules(prompt):
                return "high"
            return tier
        except Exception:
            return classify_reasoning_heuristic(prompt)

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _call)

def decide_reasoning_auto_sync(prompt: str) -> str:
    if not AUTO_TIER_ENABLED:
        return "low"
    if _force_high_rules(prompt):
        return "high"
    client = _get_client()
    if client is None:
        return classify_reasoning_heuristic(prompt)
    try:
        resp = client.chat.completions.create(  # type: ignore[attr-defined]
            model=(AUTO_TIER_ROUTER_MODEL or RUNPOD_DEFAULT_MODEL),
            messages=[
                {"role": "system", "content": _ROUTER_SYS},
                {"role": "user", "content": (prompt or "")[:8000]},
            ],
            temperature=0,
            max_tokens=AUTO_TIER_ROUTER_MAXTOK,
        )
        out = (resp.choices[0].message.content or "").strip().lower()
        tier = "low"
        if "high" in out:
            tier = "high"
        elif "medium" in out or "med" in out:
            tier = "medium"
        if _force_high_rules(prompt):
            return "high"
        return tier
    except Exception:
        return classify_reasoning_heuristic(prompt)

# ─────────────────────────────────────────────────────────────────────────────
# DB selection helpers
# ─────────────────────────────────────────────────────────────────────────────
def _status_ok(v: str) -> bool:
    return (v or "").strip().lower() in _ALLOWED_STATUS

def _enabled_ok(b: Any) -> bool:
    try:
        return bool(b)
    except Exception:
        return False

def _prefer_siblings(base: Optional[ModelVariant], cand: ModelVariant) -> int:
    score = 0
    if not base:
        return score
    if (cand.provider_model_id or "") == (base.provider_model_id or ""):
        score += 100
    if (cand.model_provider or "") == (base.model_provider or ""):
        score += 50
    return score

def _scope_score(user_role: str, cand: ModelVariant) -> int:
    if not _scope_allowed(user_role, cand.model_access_scope or "all"):
        return -10_000
    order = {"admin": 3, "internal": 2, "user": 1, "all": 0}
    return order.get((cand.model_access_scope or "all").strip().lower(), 0)

def _sort_key_for_candidates(base: Optional[ModelVariant], user_role: str, cand: ModelVariant) -> tuple:
    try:
        so = int(getattr(cand, "model_sort_order", None)) if getattr(cand, "model_sort_order", None) is not None else 9999
    except Exception:
        so = 9999
    return (-_prefer_siblings(base, cand), -_scope_score(user_role, cand), so, (cand.model_name or "").lower())

def select_variant_by_tier(
    session: Any,
    tier: str,
    *,
    user_role: str = "user",
    prefer_family_of: Optional[ModelVariant] = None,
) -> Optional[ModelVariant]:
    t = normalize_tier(tier)
    if t not in ("low", "medium", "high"):
        return prefer_family_of
    q = session.query(ModelVariant).filter(
        ModelVariant.model_enabled.is_(True),
        ModelVariant.model_tier == t,
    )
    cands: List[ModelVariant] = []
    try:
        for c in q.all():
            if not _enabled_ok(c.model_enabled):
                continue
            if not _status_ok(c.model_status or "active"):
                continue
            if not _scope_allowed(user_role, c.model_access_scope or "all"):
                continue
            cands.append(c)
    except Exception:
        cands = []
    if not cands:
        return None
    cands.sort(key=lambda x: _sort_key_for_candidates(prefer_family_of, user_role, x))
    return cands[0]

# ─────────────────────────────────────────────────────────────────────────────
# High-level: route & select
# ─────────────────────────────────────────────────────────────────────────────
async def route_and_select_variant(
    session: Any,
    *,
    user_role: str,
    prompt: str,
    selected_variant: Optional[ModelVariant],
    attachments_count: int = 0,
) -> Tuple[str, ModelVariant, str]:
    """
    1) Quyết định tier:
       - Nếu selected_variant.model_tier == 'auto' → dùng router (LLM/heuristic) + HARD RULES
       - Ngược lại → dùng tier của selected_variant
    2) Chọn ModelVariant theo tier (ưu tiên cùng họ)
    3) Trả: (tier, mv_final, "Reasoning: <tier>")
    """
    requested_tier = normalize_tier(getattr(selected_variant, "model_tier", None)) or RUNPOD_DEFAULT_REASONING
    if requested_tier == "auto":
        if AUTO_TIER_ENABLED:
            tier = await decide_reasoning_auto(prompt)
        else:
            tier = classify_reasoning_heuristic(prompt, attachments_count=attachments_count)
    else:
        tier = requested_tier if requested_tier != "auto" else "low"

    # Bump bằng heuristic nếu router trả quá thấp trong bối cảnh thực tế
    if tier != "high":
        bump = classify_reasoning_heuristic(prompt, attachments_count=attachments_count)
        if bump == "high":
            tier = "high"
        elif bump == "medium" and tier == "low":
            tier = "medium"

    mv_final = select_variant_by_tier(session, tier, user_role=user_role, prefer_family_of=selected_variant) \
               or (selected_variant or _fallback_variant(session))

    sys_text = system_text_for_reasoning(tier)
    return tier, mv_final, sys_text

def _fallback_variant(session: Any) -> ModelVariant:
    try:
        mv = session.query(ModelVariant).filter(
            ModelVariant.model_enabled.is_(True),
            ModelVariant.provider_model_id == RUNPOD_DEFAULT_MODEL,
        ).order_by(ModelVariant.model_sort_order.asc().nulls_last()).first()
        if mv:
            return mv
    except Exception:
        pass
    mv = session.query(ModelVariant).filter(
        ModelVariant.model_enabled.is_(True),
        ModelVariant.model_status.in_(list(_ALLOWED_STATUS)),
    ).order_by(ModelVariant.model_sort_order.asc().nulls_last(), ModelVariant.model_name.asc()).first()
    if mv:
        return mv
    raise RuntimeError("No enabled/active model variants found")

# ─────────────────────────────────────────────────────────────────────────────
# Optional sync
# ─────────────────────────────────────────────────────────────────────────────
def route_and_select_variant_sync(
    session: Any,
    *,
    user_role: str,
    prompt: str,
    selected_variant: Optional[ModelVariant],
    attachments_count: int = 0,
) -> Tuple[str, ModelVariant, str]:
    requested_tier = normalize_tier(getattr(selected_variant, "model_tier", None)) or RUNPOD_DEFAULT_REASONING
    if requested_tier == "auto":
        if AUTO_TIER_ENABLED and _get_client() is not None:
            tier = decide_reasoning_auto_sync(prompt)
        else:
            tier = classify_reasoning_heuristic(prompt, attachments_count=attachments_count)
    else:
        tier = requested_tier if requested_tier != "auto" else "low"

    if tier != "high":
        bump = classify_reasoning_heuristic(prompt, attachments_count=attachments_count)
        if bump == "high":
            tier = "high"
        elif bump == "medium" and tier == "low":
            tier = "medium"

    mv_final = select_variant_by_tier(session, tier, user_role=user_role, prefer_family_of=selected_variant) \
               or (selected_variant or _fallback_variant(session))
    sys_text = system_text_for_reasoning(tier)
    return tier, mv_final, sys_text

# ─────────────────────────────────────────────────────────────────────────────
__all__ = [
    "normalize_tier",
    "system_text_for_reasoning",
    "classify_reasoning_heuristic",
    "decide_reasoning_auto",
    "decide_reasoning_auto_sync",
    "select_variant_by_tier",
    "route_and_select_variant",
    "route_and_select_variant_sync",
]

# file: src/modules/chat/routes/chat_api.py
# updated: 2025-09-03 (v2.11.0)
# changes (v2.11.0):
#   - SIMPLE MODE cho tool “Phân loại phòng ban”: 1 bước tự nhiên, không JSON, không ép định dạng 2 dòng.
#     • Khi người dùng chọn tool này, prompt sẽ:
#         - Nói rõ “bạn đang giúp phân loại văn bản gần nhất”
#         - Chèn FULL TEXT văn bản gần nhất (raw, full)
#         - Chèn block RAG (A: ví dụ để học; B: phạm vi tên phòng ban — rút từ “NHÃN MỤC TIÊU”)
#         - Chèn bộ nhớ & đoạn chat gần đây
#         - Yêu cầu trả lời tự nhiên: chỉ liệt kê tên phòng ban phù hợp (không bảng/JSON), không hỏi lại
#     • Không còn B-nhỏ/B-lớn, không vote fallback, không ép 2 dòng.
#     • Khi chạy tool phân loại, KHÔNG chèn “chú thích kết quả công cụ gần nhất” để hội thoại tự nhiên.
#
#   - Giữ nguyên tool “Cập nhật email” end-to-end (v2.10.2).
#   - Dọn bỏ toàn bộ helper cũ dành cho B-nhỏ/B-lớn, vote/union, ép 2 dòng…
#
# changes (v2.10.2):
#   - TÍCH HỢP TOOL “Cập nhật email” end-to-end (lưu pin state, compose prompt, parse JSON plan, schedule, tóm tắt)
#   - FE sync: /chat/tools trả thêm slug + requires_text; set headers X-User-Role/X-User-Status
#
# (Các thay đổi cũ hơn đã được dọn bỏ nếu không cần cho simple-mode)

from __future__ import annotations

import os
import uuid
import math
import time
import asyncio
import logging
import hashlib
import json
import re
import unicodedata
from typing import Any, Optional, Dict, List, Tuple
from collections.abc import Iterable
from collections import OrderedDict

from litestar import post, get, Request
from litestar.response import Response
from openai import OpenAI

from sqlalchemy import select, func, or_
from sqlalchemy.exc import SQLAlchemyError, IntegrityError

from shared.secure_cookie import get_secure_cookie

# DB
from core.db.engine import SessionLocal
from core.db.models import (
    ChatHistory,
    ChatMessage,
    ModelVariant,
    Document,
    User,
    ToolDefinition,      # dùng cho /chat/tools động
    SystemSettings,      # lọc theo system_enabled_tools
)

try:
    from core.db.models import ChatHistoryVersion  # type: ignore
except Exception:
    ChatHistoryVersion = None  # type: ignore

# Memory module (best-effort import)
_mem = None
try:
    from modules.memory.service import memory as _mem  # type: ignore
except Exception:
    _mem = None

# Auto-tier service
try:
    from modules.chat.service import chat_auto_tier as auto  # type: ignore
except Exception:
    auto = None  # type: ignore

# Prompt compose
pc = None  # type: ignore
try:
    from modules.chat.service import prompt_compose as pc  # type: ignore
except Exception:
    pc = None  # type: ignore

# Classifier (for tool auto-pick)
try:
    from modules.tools.text_classifier import TextClassifier, resolve_tool_id  # type: ignore
except Exception:
    TextClassifier = None  # type: ignore

    def resolve_tool_id(tools: List[Dict[str, Any]], predicted_tool_name: Optional[str]) -> Optional[str]:  # type: ignore
        return None

# Email scheduler tool
try:
    from modules.chat.service import email_scheduler as es  # type: ignore
except Exception:
    es = None  # type: ignore

logger = logging.getLogger("docaix.chat_api")

# ───────────────── env helpers ─────────────────
def _env_int(name: str, default: Optional[int] = None) -> Optional[int]:
    try:
        v = os.getenv(name, "")
        return int(v.strip()) if v.strip() else default
    except Exception:
        return default

def _fmt_bytes(n: Optional[int]) -> Optional[str]:
    if not n or n <= 0:
        return None
    mb = n / (1024 * 1024)
    if mb >= 1:
        return f"{mb:.0f} MB" if abs(round(mb) - mb) < 1e-6 else f"{mb:.1f} MB"
    kb = n / 1024
    return f"{kb:.0f} KB" if abs(round(kb) - kb) < 1e-6 else f"{kb:.1f} KB"

# ✅ Nhận diện tool phân loại văn bản
def _is_doc_classify_tool(incoming_tool_id: Optional[str], predicted_tool_name: Optional[str]) -> bool:
    s = (incoming_tool_id or "").strip().lower()
    if s in ("doc_email_routing", "doc_email_classifier", "doc_classify", "doc_email_routing", "doc_email_routing".lower()):
        return True
    if any(k in s for k in ("classify", "classification", "phan loai", "phân loại")):
        return True
    p = (predicted_tool_name or "").strip().lower()
    return p in ("doc_email_routing", "doc_email_classifier", "doc_classify", "classifier")

# ✅ Nhận diện tool cập nhật email
def _is_email_update_tool(incoming_tool_id: Optional[str], predicted_tool_name: Optional[str]) -> bool:
    s = (incoming_tool_id or "").strip().lower()
    if s in ("doc_email_update", "email_update", "cap nhat email", "cập nhật email"):
        return True
    p = (predicted_tool_name or "").strip().lower()
    return p in ("doc_email_update", "email_update")

# ───────────────── config (model/provider) ─────────────────
RUNPOD_BASE_URL = (os.getenv("RUNPOD_BASE_URL", "").strip() or "")
RUNPOD_API_KEY = (os.getenv("RUNPOD_API_KEY", "").strip() or "")
RUNPOD_DEFAULT_MODEL = os.getenv("RUNPOD_DEFAULT_MODEL", "openai/gpt-oss-20b").strip()
RUNPOD_TIMEOUT = int(os.getenv("RUNPOD_TIMEOUT", "60"))
RUNPOD_MAX_TOKENS = int(os.getenv("RUNPOD_MAX_TOKENS", "100000"))

# 🔎 Reasoning tiers
RUNPOD_DEFAULT_REASONING = os.getenv("RUNPOD_DEFAULT_REASONING", "low").strip().lower()

# 🔎 SIMPLE CLASSIFY mode (new)
CLASSIFY_SIMPLE_MODE = (os.getenv("CLASSIFY_SIMPLE_MODE", "1").strip() != "0")

# --- latest tool note ---
LATEST_TOOL_NOTE_ENABLE = (os.getenv("LATEST_TOOL_NOTE_ENABLE", "1").strip() != "0")
LATEST_TOOL_NOTE_ALWAYS = (os.getenv("LATEST_TOOL_NOTE_ALWAYS", "1").strip() != "0")
LATEST_TOOL_NOTE_PREFIX = os.getenv("LATEST_TOOL_NOTE_PREFIX", "Kết quả công cụ gần nhất").strip()
LATEST_TOOL_NOTE_MAX_LABELS = _env_int("LATEST_TOOL_NOTE_MAX_LABELS", 30) or 30

# ───────────────── memory + debug dump ─────────────────
MEMORY_ENABLED = (os.getenv("MEMORY_ENABLED", "1").strip() != "0")
MEMORY_AUTO_SUMMARY = (os.getenv("MEMORY_AUTO_SUMMARY", "1").strip() != "0")
CHAT_DUMP_MODEL_INPUT = (os.getenv("CHAT_DUMP_MODEL_INPUT", "1").strip() != "0")

# ───────────────── recent transcript limits ─────────────────
CHAT_RECENT_CONTEXT_CHARS = int(os.getenv("CHAT_RECENT_CONTEXT_CHARS", "25000"))
CHAT_RECENT_CONTEXT_MAX_MSGS = int(os.getenv("CHAT_RECENT_CONTEXT_MAX_MSGS", "50"))

# ───────────────── upload limits ─────────────────
REQUEST_MAX_SIZE = _env_int("REQUEST_MAX_SIZE", _env_int("MAX_UPLOAD_BYTES", 50 * 1024 * 1024))  # default 50MB
MULTIPART_MAX_FILE_SIZE = _env_int("MULTIPART_MAX_FILE_SIZE", None)      # per file
MULTIPART_MAX_BODY_SIZE = _env_int("MULTIPART_MAX_BODY_SIZE", None)      # whole body
MULTIPART_MAX_FILES     = _env_int("MULTIPART_MAX_FILES", 10)

def _effective_body_cap() -> int:
    candidates = [REQUEST_MAX_SIZE, MULTIPART_MAX_BODY_SIZE]
    vals = [c for c in candidates if isinstance(c, int) and c > 0]
    return min(vals) if vals else (REQUEST_MAX_SIZE or 50 * 1024 * 1024)

def _limit_headers() -> dict:
    return {
        "X-Upload-Limit-Bytes": str(_effective_body_cap()),
        "X-Upload-Per-File-Bytes": str(MULTIPART_MAX_FILE_SIZE or 0),
        "X-Upload-Max-Files": str(MULTIPART_MAX_FILES or 0),
        "Cache-Control": "no-store",
    }

# ───────────────── uploads / OCR / text-extract ─────────────────
UPLOAD_ROOT = os.path.abspath(os.getenv("UPLOAD_ROOT", os.path.join("uploads")))
OCR_ENABLED = (os.getenv("OCR_ENABLED", "1").strip() != "0")

# budgets (0 => unlimited)
OCR_MAX_APPEND_TOKENS = int(os.getenv("OCR_MAX_APPEND_TOKENS", "10000"))
OCR_MAX_PAGES_PER_FILE = int(os.getenv("OCR_MAX_PAGES_PER_FILE", "500"))
OCR_MAX_APPEND_CHARS = int(os.getenv("OCR_MAX_APPEND_CHARS", "8000"))
OCR_SNIPPET_PER_FILE = int(os.getenv("OCR_SNIPPET_PER_FILE", "2000"))

# page policy
OCR_APPEND_FULL_THRESHOLD = int(os.getenv("OCR_APPEND_FULL_THRESHOLD", "25"))
OCR_APPEND_FIRST_LAST     = int(os.getenv("OCR_APPEND_FIRST_LAST", "5"))

UPLOAD_DEDUP_WINDOW_SEC = int(os.getenv("UPLOAD_DEDUP_WINDOW_SEC", "300"))
_RECENT_UPLOADS: "OrderedDict[Tuple[str, str], float]" = OrderedDict()

_client: Optional[OpenAI] = None

def get_client() -> OpenAI:
    global _client
    if _client is None:
        if not RUNPOD_BASE_URL or not RUNPOD_API_KEY:
            raise RuntimeError("RUNPOD_BASE_URL / RUNPOD_API_KEY chưa cấu hình.")
        base_url = RUNPOD_BASE_URL.rstrip("/")
        if not base_url.endswith("/v1"):
            base_url += "/v1"
        _client = OpenAI(base_url=base_url, api_key=RUNPOD_API_KEY, timeout=RUNPOD_TIMEOUT)
    return _client

# RAM cache cho polling nhanh
_MSGS: Dict[str, Dict[str, Optional[str]]] = {}
# Cancel flags
_CANCEL_REQS: "OrderedDict[str, float]" = OrderedDict()

def _mark_cancel(message_id: str) -> None:
    if not message_id:
        return
    now = time.time()
    _CANCEL_REQS[message_id] = now
    try:
        while len(_CANCEL_REQS) > 4096:
            _CANCEL_REQS.popitem(last=False)
        for mid, ts in list(_CANCEL_REQS.items()):
            if now - ts > 600:
                _CANCEL_REQS.pop(mid, None)
    except Exception:
        pass

def _is_canceled(message_id: str) -> bool:
    ts = _CANCEL_REQS.get(message_id)
    if not ts:
        return False
    return (time.time() - ts) <= 600

def _set_msg_status(message_id: str, status: str, ai_text: Optional[str] = None, error: Optional[str] = None) -> None:
    _MSGS[message_id] = {"status": status, "ai_response": (ai_text or None), "error": error or None}

# ───────────────── model/helpers ─────────────────
def _get_model_variant(session: Any, provider_model_id: str) -> Optional[ModelVariant]:
    return session.execute(
        select(ModelVariant).where(
            ModelVariant.provider_model_id == provider_model_id,
            ModelVariant.model_enabled.is_(True),
        ).limit(1)
    ).scalar_one_or_none()

def _get_model_variant_by_any(session: Any, ident: str) -> Optional[ModelVariant]:
    if not ident:
        return _get_model_variant(session, RUNPOD_DEFAULT_MODEL)
    ident_lc = ident.lower()
    return session.execute(
        select(ModelVariant).where(
            ModelVariant.model_enabled.is_(True),
            or_(
                ModelVariant.provider_model_id == ident,
                ModelVariant.model_id == ident,
                func.lower(ModelVariant.model_name) == ident_lc,
            ),
        ).limit(1)
    ).scalar_one_or_none()

def _selected_ident_from_cookie(request: Request) -> str:
    return (request.cookies.get("moe_model_id") or "").strip() \
        or (request.cookies.get("moe_model_name") or "").strip()

def _choose_model_variant(session: Any, request: Request, override: Optional[str] = None) -> Optional[ModelVariant]:
    ident = (override or "").strip() or _selected_ident_from_cookie(request)
    mv = _get_model_variant_by_any(session, ident)
    if mv:
        return mv
    return _get_model_variant(session, RUNPOD_DEFAULT_MODEL)

# ───────────────── upload form helpers ─────────────────
def _extract_files(form: Any, *names: str) -> List[Any]:
    def _is_file(o: Any) -> bool:
        if o is None:
            return False
        if hasattr(o, "filename"):
            return True
        if hasattr(o, "name") and not isinstance(getattr(o, "name"), str):
            return True
        return bool(getattr(o, "filename", None))

    out: List[Any] = []
    seen = set()
    for nm in names:
        vals: Iterable[Any] = []
        try:
            vals = form.getlist(nm)  # type: ignore[attr-defined]
        except Exception:
            vals = []
        for v in (vals or []):
            if _is_file(v):
                k = id(v)
                if k not in seen:
                    out.append(v); seen.add(k)
        try:
            single = form.get(nm)
            if single is not None and _is_file(single):
                k = id(single)
                if k not in seen:
                    out.append(single); seen.add(k)
        except Exception:
            pass
    return out

# ───────────────── versioning helpers ─────────────────
def _next_version_index(session: Any, parent_message_id: str) -> int:
    if not ChatHistoryVersion:
        return 1
    curr = session.execute(
        select(func.max(ChatHistoryVersion.version_index)).where(
            ChatHistoryVersion.parent_message_id == parent_message_id
        )
    ).scalar()
    return (curr or 0) + 1

def _maybe_save_version(
    session: Any,
    *,
    chat_id: str,
    message_id: Optional[str],
    question: str,
    ai: str,
    kind: str = "edit",
) -> None:
    if not ChatHistoryVersion or not message_id:
        return
    vk = "edit" if kind not in ("edit", "regenerate") else kind
    for _ in range(3):
        try:
            idx = _next_version_index(session, message_id)
            item = ChatHistoryVersion(  # type: ignore[call-arg]
                version_id=str(uuid.uuid4()),
                parent_chat_id=chat_id,
                parent_message_id=message_id,
                version_index=idx,
                version_kind=vk,
                version_question=question or "",
                version_ai_response=ai or "",
            )
            session.add(item)
            session.flush()
            break
        except IntegrityError:
            session.rollback()
            continue
        except Exception:
            session.rollback()
            break

# ───────────────── OCR / TextExtract helpers ─────────────────
_IMG_EXT = {"png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"}
_PDF_EXT = {"pdf"}

def _ext_of(name: str) -> str:
    try:
        return (os.path.splitext(name or "")[1][1:] or "").lower()
    except Exception:
        return ""

def _approx_tokens(text_len: int) -> int:
    return math.ceil(max(0, text_len) / 4)

def _trim_to_tokens(s: str, token_budget: int) -> str:
    if token_budget <= 0 or not s:
        return ""
    char_budget = max(1, token_budget * 4)
    if len(s) <= char_budget:
        return s
    chunk = s[:char_budget]
    sp = chunk.rfind(" ")
    if sp > 120:
        chunk = s[:sp] + " …"
    else:
        chunk = chunk.rstrip() + " …"
    return chunk

def _build_per_file_snippet(
    *,
    file_name: str,
    total_pages: int,
    pages_text: List[str] | None,
    full_text: str,
    token_budget: int,
    page_limit: int,
    unlimited: bool = False,
) -> Tuple[str, int]:
    used = 0
    if pages_text and len(pages_text) == total_pages:
        thr = max(1, OCR_APPEND_FULL_THRESHOLD)
        k = max(1, min(OCR_APPEND_FIRST_LAST, total_pages))
        if total_pages <= thr:
            selected = list(range(1, min(page_limit, total_pages) + 1))
            label = f"{selected[0]}–{selected[-1]}" if selected else ""
        else:
            first = list(range(1, min(k, total_pages) + 1))
            last  = list(range(max(1, total_pages - k + 1), total_pages + 1))
            selected = sorted(set(first + last))
            left  = f"{first[0]}–{first[-1]}" if first else ""
            right = f"{last[0]}–{last[-1]}" if last else ""
            label = f"{left}, …, {right}" if left and right else (left or right)

        parts: List[str] = []
        header = f"[{file_name}] (trang {label}/{total_pages})" if selected else f"[{file_name}]"
        parts.append(header); used += _approx_tokens(len(header))

        for p in selected:
            body = (pages_text[p - 1] or "").strip()
            if not body:
                continue
            head = f"p{p}: "
            if unlimited:
                seg = head + body
            else:
                budget_left = max(0, token_budget - used) - _approx_tokens(len(head))
                if budget_left <= 0:
                    break
                seg = head + _trim_to_tokens(body, budget_left)
            parts.append(seg)
            used += _approx_tokens(len(seg))
        return ("\n".join(parts)).strip(), used

    header = f"[{file_name}]"
    body = (full_text or "").strip()
    if unlimited:
        used = _approx_tokens(len(header) + len(body))
        return (header + ("\n" + body if body else "")).strip(), used
    used = _approx_tokens(len(header))
    body_budget = max(0, token_budget - used)
    body = _trim_to_tokens(body, body_budget)
    return (header + ("\n" + body if body else "")).strip(), used + _approx_tokens(len(body))

_textex = None
try:
    from modules.chat.service import text_extract as _textex  # type: ignore
except Exception:
    _textex = None

def _is_text_extractable(ext: str) -> bool:
    if not _textex:
        return False
    e = (ext or "").lower()
    return (e in _textex.DOCS) or (e in _textex.SHEETS) or (e in _textex.SLIDES) or (e in _textex.CODE) or (e in _textex.OTHERS)

def _hash_of_upload(up: Any) -> Optional[str]:
    f = getattr(up, "file", None) or getattr(up, "_file", None) or None
    if f is None:
        if hasattr(up, "read"):
            f = up
        else:
            return None
    try:
        pos = f.tell() if hasattr(f, "tell") else None
    except Exception:
        pos = None
    try:
        if hasattr(f, "seek"):
            try:
                f.seek(0)
            except Exception:
                pass
        h = hashlib.sha256()
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            if isinstance(chunk, str):
                chunk = chunk.encode("utf-8", "ignore")
            h.update(chunk)
        digest = h.hexdigest()
        return digest
    except Exception:
        return None
    finally:
        try:
            if hasattr(f, "seek"):
                if pos is not None:
                    f.seek(pos)
                else:
                    f.seek(0)
        except Exception:
            pass

def _mark_recent(uid: str, digest: str) -> bool:
    if not uid or not digest:
        return False
    now = time.time()
    key = (uid, digest)
    try:
        while len(_RECENT_UPLOADS) > 2048:
            _RECENT_UPLOADS.popitem(last=False)
        to_del = []
        for k, ts in list(_RECENT_UPLOADS.items()):
            if now - ts > max(60, UPLOAD_DEDUP_WINDOW_SEC * 2):
                to_del.append(k)
        for k in to_del:
            _RECENT_UPLOADS.pop(k, None)
    except Exception:
        pass
    last = _RECENT_UPLOADS.get(key)
    _RECENT_UPLOADS[key] = now
    if last is None:
        return False
    return (now - last) <= UPLOAD_DEDUP_WINDOW_SEC

# ───────────────── save files + build OCR/TextExtract appendix ─────────────────
async def _save_files_and_build_appendix(
    *,
    session: Any,
    uid: str,
    chat_row: ChatHistory,
    message_id: str,
    files: List[Any],
    classification_only_ocr: bool = False,  # Force EasyOCR khi tool = “Phân loại phòng ban”
) -> Tuple[str, List[Document]]:
    if not files:
        return "", []
    ocr_mod: Any = None
    if OCR_ENABLED:
        try:
            from modules.chat.service import ocr_text as _ocr_mod  # type: ignore
            ocr_mod = _ocr_mod
        except Exception:
            ocr_mod = None

    from shared.file_storage import safe_filename, save_upload_async, ensure_dir

    base_dir = os.path.join(UPLOAD_ROOT, "chat", chat_row.chat_id, message_id)
    ensure_dir(base_dir)

    appended_chunks: List[str] = []
    docs: List[Document] = []
    total_tokens_used = 0

    seen_digests: set[str] = set()

    for up in files:
        raw_name = getattr(up, "filename", None) or getattr(up, "name", None) or "file.bin"
        fname = safe_filename(raw_name)
        ext = _ext_of(fname)

        digest = _hash_of_upload(up) or ""
        if digest:
            if digest in seen_digests:
                logger.info("Skip duplicate in-message: %s", fname)
                continue
            if _mark_recent(uid, digest):
                logger.info("Skip duplicate recent (user-window): %s", fname)
                continue
            seen_digests.add(digest)

        abs_path = os.path.join(base_dir, fname)
        saved_path = await save_upload_async(up, abs_path, make_unique=True)
        rel_path = os.path.relpath(saved_path, start=UPLOAD_ROOT).replace(os.sep, "/")

        doc = Document(  # type: ignore[call-arg]
            doc_id=str(uuid.uuid4()),
            doc_chat_id=chat_row.chat_id,
            doc_file_path=rel_path,
            doc_ocr_text_path="",
            doc_title=os.path.basename(saved_path),
            doc_status="new",
        )
        session.add(doc)
        session.flush()
        docs.append(doc)

        snippet_text = ""
        pages_text: Optional[List[str]] = None
        total_pages = 1

        # Chính sách cho tool phân loại: chỉ OCR PDF/Ảnh bằng EasyOCR (ocr_all=True)
        if classification_only_ocr:
            if ext in _IMG_EXT or ext in _PDF_EXT:
                if ocr_mod:
                    try:
                        old_engine = getattr(ocr_mod, "OCR_ENGINE", "auto")
                        try:
                            setattr(ocr_mod, "OCR_ENGINE", "easyocr")  # force EasyOCR
                            if hasattr(ocr_mod, "extract_text_async"):
                                res = await ocr_mod.extract_text_async(saved_path, ocr_all=True)  # type: ignore
                            else:
                                loop = asyncio.get_running_loop()
                                res = await loop.run_in_executor(None, lambda: ocr_mod.extract_text(saved_path, ocr_all=True))
                        finally:
                            try:
                                setattr(ocr_mod, "OCR_ENGINE", old_engine)
                            except Exception:
                                pass
                    except Exception as e:
                        logger.warning("OCR (force easyocr) error for %s: %s", fname, e)
                        res = None
                    text = (res.text if res and getattr(res, "ok", False) else "") if res else ""
                    text = (text or "").strip()
                    if text:
                        ocr_txt_name = os.path.splitext(fname)[0] + ".txt"
                        ocr_abs = os.path.join(base_dir, ocr_txt_name)
                        try:
                            with open(ocr_abs, "w", encoding="utf-8") as f:
                                f.write(text)
                            doc.doc_ocr_text_path = os.path.relpath(ocr_abs, start=UPLOAD_ROOT).replace(os.sep, "/")
                            doc.doc_status = "reviewed"
                        except Exception as e:
                            logger.debug("Cannot write OCR txt for %s: %s", fname, e)
                        pages_text = getattr(res, "pages_text", None) if res else None
                        total_pages = int(getattr(res, "total_pages", 1) or 1)
                        snippet_text = text
            else:
                logger.info("Classification-only-OCR: skip non OCR-able file %s", fname)

        else:
            # Luồng bình thường
            need_ocr = ext in _IMG_EXT or ext in _PDF_EXT
            if need_ocr and ocr_mod:
                try:
                    if hasattr(ocr_mod, "extract_text_async"):
                        res = await ocr_mod.extract_text_async(saved_path)  # type: ignore[attr-defined]
                    else:
                        loop = asyncio.get_running_loop()
                        res = await loop.run_in_executor(None, lambda: ocr_mod.extract_text(saved_path))
                except Exception as e:
                    logger.warning("OCR error for %s: %s", fname, e)
                    res = None
                text = (res.text if res and getattr(res, "ok", False) else "") if res else ""
                text = (text or "").strip()
                if text:
                    ocr_txt_name = os.path.splitext(fname)[0] + ".txt"
                    ocr_abs = os.path.join(base_dir, ocr_txt_name)
                    try:
                        with open(ocr_abs, "w", encoding="utf-8") as f:
                            f.write(text)
                        doc.doc_ocr_text_path = os.path.relpath(ocr_abs, start=UPLOAD_ROOT).replace(os.sep, "/")
                        doc.doc_status = "reviewed"
                    except Exception as e:
                        logger.debug("Cannot write OCR txt for %s: %s", fname, e)
                    pages_text = getattr(res, "pages_text", None) if res else None
                    total_pages = int(getattr(res, "total_pages", 1) or 1)
                    snippet_text = text
            else:
                if _is_text_extractable(ext):
                    try:
                        loop = asyncio.get_running_loop()
                        result = await loop.run_in_executor(
                            None,
                            lambda: _textex.extract_text(saved_path, ext)  # type: ignore
                        )
                    except Exception as e:
                        logger.warning("TextExtract error for %s: %s", fname, e)
                        result = None
                    if result and getattr(result, "ok", False):
                        snippet_text = (result.text or "").strip()
                        pages_text = getattr(result, "pages_text", None)
                        tp = getattr(result, "total_pages", None)
                        total_pages = int(tp or (len(pages_text or []) or 1))
                        try:
                            txt_name = os.path.splitext(fname)[0] + ".txt"
                            txt_abs = os.path.join(base_dir, txt_name)
                            with open(txt_abs, "w", encoding="utf-8") as f:
                                f.write(snippet_text)
                            doc.doc_ocr_text_path = os.path.relpath(txt_abs, start=UPLOAD_ROOT).replace(os.sep, "/")
                            doc.doc_status = "reviewed"
                        except Exception as e:
                            logger.debug("Cannot write extract txt for %s: %s", fname, e)

        if snippet_text or (pages_text and any(pages_text)):
            unlimited_all = (OCR_MAX_APPEND_TOKENS or 0) <= 0 and (OCR_MAX_APPEND_CHARS or 0) <= 0 and (OCR_SNIPPET_PER_FILE or 0) <= 0
            if unlimited_all:
                per_file_budget = 10**9
            else:
                remaining_tok = (OCR_MAX_APPEND_TOKENS or 0) - total_tokens_used if (OCR_MAX_APPEND_TOKENS or 0) > 0 else 10**9
                per_file_hint = (OCR_SNIPPET_PER_FILE or 0) // 4 if (OCR_SNIPPET_PER_FILE or 0) > 0 else 10**9
                per_file_budget = max(256, min(remaining_tok, max(256, per_file_hint)))

            if per_file_budget > 0:
                snip, used_tok = _build_per_file_snippet(
                    file_name=os.path.basename(saved_path),
                    total_pages=total_pages,
                    pages_text=pages_text if isinstance(pages_text, list) else None,
                    full_text=snippet_text or "",
                    token_budget=per_file_budget,
                    page_limit=OCR_MAX_PAGES_PER_FILE,
                    unlimited=unlimited_all,
                )
                if snip:
                    appended_chunks.append(snip)
                    total_tokens_used += used_tok

        try:
            session.add(doc)
            session.flush()
        except Exception:
            session.rollback()

        if (OCR_MAX_APPEND_TOKENS or 0) > 0 and total_tokens_used >= (OCR_MAX_APPEND_TOKENS or 0):
            break

    session.commit()

    if not appended_chunks:
        return "", docs

    merged = "\n\n".join(appended_chunks).strip()

    if (OCR_MAX_APPEND_TOKENS or 0) > 0 and _approx_tokens(len(merged)) > (OCR_MAX_APPEND_TOKENS or 0):
        merged = _trim_to_tokens(merged, (OCR_MAX_APPEND_TOKENS or 0))
    if (OCR_MAX_APPEND_CHARS or 0) > 0 and len(merged) > (OCR_MAX_APPEND_CHARS or 0):
        merged = merged[:(OCR_MAX_APPEND_CHARS or 0)]
        cut = merged.rfind(" ")
        if (cut or -1) > 200:
            merged = merged[:cut] + " …"

    appendix = "\n\n---\n(Trích nội dung từ tệp đính kèm; đã rút gọn theo giới hạn)\n" + merged
    return appendix, docs

# ───────────────── debug dump helpers ─────────────────
def _base_msg_dir(chat_id: str, message_id: str) -> str:
    return os.path.join(UPLOAD_ROOT, "chat", chat_id, message_id)

def _dump_json_txt(chat_id: str, message_id: str, filename: str, data: dict) -> None:
    if not CHAT_DUMP_MODEL_INPUT:
        return
    try:
        base = _base_msg_dir(chat_id, message_id)
        os.makedirs(base, exist_ok=True)
        path = os.path.join(base, filename)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

# ───────────────── latest tool note helpers ─────────────────
def _chat_dir(chat_id: str) -> str:
    return os.path.join(UPLOAD_ROOT, "chat", chat_id)

def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def _extract_labels_from_candidates_obj(obj: Any) -> List[str]:
    # Support nhiều dạng: {"candidates":[{"label":...}]}, {"labels":[...]}, list [...]
    def _labels_from_arr(arr: Any) -> List[str]:
        out: List[str] = []
        if isinstance(arr, list):
            for it in arr:
                if isinstance(it, dict):
                    lab = str(it.get("label") or it.get("name") or "").strip()
                    if lab:
                        out.append(lab)
                elif isinstance(it, str):
                    s = it.strip()
                    if s:
                        out.append(s)
        return out

    if isinstance(obj, dict):
        for key in ("final_candidates", "candidates", "voted", "result", "predictions", "labels"):
            if key in obj:
                labs = _labels_from_arr(obj.get(key))
                if labs:
                    return labs
    elif isinstance(obj, list):
        labs = _labels_from_arr(obj)
        if labs:
            return labs
    return []

def _latest_tool_file_for_chat(chat_id: str) -> Optional[Tuple[str, str]]:
    # Tìm file kết quả tool gần nhất (cũ): ưu tiên classify dumps
    base = _chat_dir(chat_id)
    if not os.path.isdir(base):
        return None
    dirs: List[Tuple[float, str]] = []
    try:
        for de in os.scandir(base):
            if de.is_dir():
                try:
                    dirs.append((de.stat().st_mtime, de.path))
                except Exception:
                    continue
    except Exception:
        return None
    if not dirs:
        return None
    dirs.sort(key=lambda x: x[0], reverse=True)
    candidates = [
        ("classify", "model_output.classify.candidates.json.txt"),
        ("classify", "model_output.classify.voted.candidates.json.txt"),
    ]
    for _, d in dirs:
        for tool_key, name in candidates:
            p = os.path.join(d, name)
            if os.path.isfile(p):
                return (tool_key, p)
    return None

def _tool_human_name(tool_key: str) -> str:
    if tool_key == "classify":
        return "Phân loại văn bản"
    return tool_key

def _latest_tool_note_text(chat_id: str) -> str:
    found = _latest_tool_file_for_chat(chat_id)
    if not found:
        return ""
    tool_key, path = found
    data = _read_json(path) or {}
    labels = _extract_labels_from_candidates_obj(data)
    if not labels:
        return ""
    if LATEST_TOOL_NOTE_MAX_LABELS > 0:
        labels = labels[:LATEST_TOOL_NOTE_MAX_LABELS]
    tool_name = _tool_human_name(tool_key)
    return f"{LATEST_TOOL_NOTE_PREFIX}: {tool_name} — " + ", ".join(labels)

def _inject_latest_tool_note_block(prompt_text: str, note_line: str) -> str:
    if not note_line:
        return prompt_text
    block = "\n\n[CHÚ THÍCH KẾT QUẢ CÔNG CỤ GẦN NHẤT] (tham khảo, KHÔNG in lại)\n" + note_line
    return (prompt_text or "").rstrip() + block

# ───────────────── recent transcript helpers ─────────────────
def _strip_appendix(q: str) -> str:
    if not q:
        return q
    marker = "\n\n---\n(Trích nội dung từ tệp đính kèm"
    i = q.find(marker)
    return q if i < 0 else q[:i].rstrip()

def _recent_chat_transcript(session: Any, chat_id: str, limit_chars: int, max_msgs: int) -> str:
    try:
        q = select(ChatMessage).where(ChatMessage.message_chat_id == chat_id)
        for col in ("message_created_at", "created_at", "updated_at"):
            if hasattr(ChatMessage, col):
                q = q.order_by(getattr(ChatMessage, col).asc())
                break
        rows = session.execute(q).scalars().all()
    except Exception:
        rows = []

    pairs = []
    for r in rows:
        u = _strip_appendix(r.message_question or "")
        a = (r.message_ai_response or "").strip()
        if not u or not a or a in ("(queued)", "(canceled)"):
            continue
        pairs.append(f"User: {u}\nAssistant: {a}")

    if max_msgs > 0 and len(pairs) > max_msgs:
        pairs = pairs[-max_msgs:]

    text = "\n\n".join(pairs).strip()
    if limit_chars > 0 and len(text) > limit_chars:
        text = text[-limit_chars:]
        cut = text.find("\n")
        if cut > 200:
            text = text[cut+1:]
    return text

# ─────────────── Label helpers từ RAG ───────────────
def _norm_key(s: str) -> str:
    s = (s or "").strip()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = re.sub(r"\s+", " ", s).strip()
    return s

def _extract_allowed_labels_from_rag(rag_block: str) -> List[str]:
    """
    Hợp nhất tất cả nhãn trong các dòng 'NHÃN MỤC TIÊU: ...' của block RAG.
    - Tách theo ';', strip 2 đầu, khử trùng lặp theo chuỗi gốc, giữ nguyên thứ tự.
    """
    out: List[str] = []
    seen = set()
    if not rag_block:
        return out
    for line in (rag_block or "").splitlines():
        line_stripped = (line or "").strip()
        if not line_stripped:
            continue
        low = line_stripped.lower()
        key = "nhãn mục tiêu:"
        pos = low.find(key)
        if pos < 0:
            continue
        payload = line_stripped[pos + len(key):].strip()
        if not payload:
            continue
        parts = [p.strip() for p in payload.split(";")]
        for p in parts:
            if p and _norm_key(p) not in seen:
                seen.add(_norm_key(p))
                out.append(p)
    return out

# ───────────────── provider call (simple) ─────────────────
async def _call_provider_simple(*, provider_model_id: str, messages: List[dict], tier: str = "low") -> Tuple[str, dict]:
    client = get_client()
    resp = await asyncio.get_running_loop().run_in_executor(
        None,
        lambda: client.chat.completions.create(
            model=provider_model_id,
            messages=messages,
            temperature=0.3,
            max_tokens=RUNPOD_MAX_TOKENS,
        ),
    )
    text = (resp.choices[0].message.content or "").strip()
    usage = getattr(resp, "usage", None)
    usage_dict = {
        "prompt_tokens": getattr(usage, "prompt_tokens", None) or 0,
        "completion_tokens": getattr(usage, "completion_tokens", None) or 0,
    }
    return text, usage_dict

async def _call_provider_and_update(
    *,
    session: Any,
    mv: ModelVariant,
    chat_row: ChatHistory,
    message_row: ChatMessage,
    tier: str,
    user_override: Optional[str] = None,
    ack_prefix: Optional[str] = None,
) -> str:
    if _is_canceled(message_row.message_id):
        message_row.message_ai_response = "(canceled)"
        message_row.message_tokens_input = 0
        message_row.message_tokens_output = 0
        try:
            if hasattr(message_row, "message_reasoning_requested"):
                message_row.message_reasoning_requested = tier
            if hasattr(message_row, "message_reasoning_used"):
                message_row.message_reasoning_used = "(canceled)"
            session.commit()
        except Exception:
            session.rollback()
        _set_msg_status(message_row.message_id, "ready", "(canceled)")
        _dump_json_txt(chat_row.chat_id, message_row.message_id, "model_input.json.txt", {
            "canceled": True,
            "ts": int(time.time()),
            "model": mv.provider_model_id or RUNPOD_DEFAULT_MODEL,
            "reasoning": tier,
            "messages": [],
        })
        _dump_json_txt(chat_row.chat_id, message_row.message_id, "model_output.json.txt", {
            "canceled": True,
            "ts": int(time.time()),
        })
        return "(canceled)"

    try:
        if hasattr(message_row, "message_reasoning_requested"):
            message_row.message_reasoning_requested = tier
        if hasattr(message_row, "message_reasoning_used"):
            message_row.message_reasoning_used = tier
        session.commit()
    except Exception:
        session.rollback()

    provider_model_id = (mv.provider_model_id or RUNPOD_DEFAULT_MODEL)
    client = get_client()

    sys_text = f"Reasoning: {(tier or RUNPOD_DEFAULT_REASONING or 'low').lower()}"
    user_content = (user_override or message_row.message_question or "Hi")

    messages = [
        {"role": "system", "content": sys_text},
        {"role": "user", "content": user_content},
    ]

    _dump_json_txt(chat_row.chat_id, message_row.message_id, "model_input.json.txt", {
        "ts": int(time.time()),
        "model": provider_model_id,
        "reasoning": tier,
        "message_id": message_row.message_id,
        "chat_id": chat_row.chat_id,
        "messages": messages,
    })

    logger.info(
        "[ChatAPI] model=%s (mv=%s/%s) tier=%s user=%s chat=%s msg=%s",
        provider_model_id, mv.model_name, mv.model_id, tier,
        chat_row.chat_user_id, chat_row.chat_id, message_row.message_id
    )
    resp = await asyncio.get_running_loop().run_in_executor(
        None,
        lambda: client.chat.completions.create(
            model=provider_model_id,
            messages=messages,
            temperature=0.3,
            max_tokens=RUNPOD_MAX_TOKENS,
        ),
    )
    ai = (resp.choices[0].message.content or "").strip()
    usage = getattr(resp, "usage", None)
    in_tok = getattr(usage, "prompt_tokens", None) if usage else 0
    out_tok = getattr(usage, "completion_tokens", None) if usage else 0

    if ack_prefix:
        ai = f"{ack_prefix}\n\n{ai}".strip()

    message_row.message_ai_response = ai or ""
    message_row.message_tokens_input = in_tok or 0
    message_row.message_tokens_output = out_tok or 0
    chat_row.chat_tokens_input = (chat_row.chat_tokens_input or 0) + (in_tok or 0)
    chat_row.chat_tokens_output = (chat_row.chat_tokens_output or 0) + (out_tok or 0)
    session.commit()

    _dump_json_txt(chat_row.chat_id, message_row.message_id, "model_output.json.txt", {
        "ts": int(time.time()),
        "ai_response": ai,
        "usage": {
            "prompt_tokens": in_tok or 0,
            "completion_tokens": out_tok or 0,
        }
    })

    if MEMORY_ENABLED and MEMORY_AUTO_SUMMARY and _mem and hasattr(_mem, "update_chat_summary_async"):
        try:
            await _mem.update_chat_summary_async(chat_row.chat_id, message_row.message_question or "", ai or "")
        except Exception:
            pass

    _set_msg_status(message_row.message_id, "ready", ai)
    return ai

# ───────────────── user info helper ─────────────────
def _user_info(request: Request) -> dict:
    uid = get_secure_cookie(request)
    info = {
        "id": None,
        "role": "guest",
        "status": "guest",
        "is_admin": False,
        "is_internal": False,
    }
    if not uid:
        return info
    session = SessionLocal()
    try:
        u = session.get(User, uid)
        if not u:
            return info
        role = (u.user_role or "user").lower()
        status = (u.user_status or "active").lower()
        info.update(
            {
                "id": u.user_id,
                "role": role,
                "status": status,
                "is_admin": role == "admin",
                "is_internal": role in ("internal", "admin"),
            }
        )
        return info
    finally:
        session.close()

# ───────────────── tools catalog (cho FE menu) ─────────────────
# name khớp icon bank FE: answer_mode, web_search, deep_research, doc_email_update, doc_email_routing
def _default_tools_catalog(uinfo: dict) -> List[Dict[str, Any]]:
    tools = [
        {"id": "ANSWER_MODE",       "name": "answer_mode",       "slug": "answer_mode",       "label": "Hỏi đáp",              "sort_order": 100, "requires_text": False},
        {"id": "WEB_SEARCH",        "name": "web_search",        "slug": "web_search",        "label": "Tìm kiếm mạng",        "sort_order": 90,  "requires_text": False},
        {"id": "DEEP_RESEARCH",     "name": "deep_research",     "slug": "deep_research",     "label": "Nghiên cứu sâu",       "sort_order": 80,  "requires_text": False},
        {"id": "DOC_EMAIL_UPDATE",  "name": "doc_email_update",  "slug": "doc_email_update",  "label": "Cập nhật email",       "sort_order": 70,  "requires_text": False},
        {"id": "DOC_EMAIL_ROUTING", "name": "doc_email_routing", "slug": "doc_email_routing", "label": "Phân loại văn bản",
         "sort_order": 60, "needs_document": True, "requires_text": True},
    ]
    if uinfo.get("role") == "user":
        return [t for t in tools]
    return tools

def _scope_allows(scope: Optional[str], role: str) -> bool:
    s = (scope or "all").lower()
    r = (role or "guest").lower()
    if s == "all":
        return True
    if s == "user":
        return r in ("user", "internal", "admin")
    if s == "internal":
        return r in ("internal", "admin")
    if s == "admin":
        return r == "admin"
    return False

def _db_tools_catalog(session: Any, uinfo: dict) -> List[Dict[str, Any]]:
    """Đọc ToolDefinition + SystemSettings để build menu động."""
    role = uinfo.get("role") or "guest"

    # Lấy danh sách tool đang bật
    try:
        rows = session.execute(
            select(ToolDefinition).where(ToolDefinition.tool_enabled.is_(True))
        ).scalars().all()
    except Exception:
        rows = []

    if not rows:
        return _default_tools_catalog(uinfo)

    # Lọc theo scope
    rows = [r for r in rows if _scope_allows(r.tool_access_scope, role)]

    # Lọc theo SystemSettings.system_enabled_tools (nếu có)
    try:
        sysr = session.execute(select(SystemSettings).limit(1)).scalars().first()
    except Exception:
        sysr = None
    allow_names = None
    if sysr and sysr.system_enabled_tools:
        allow_names = set([str(x).strip() for x in (sysr.system_enabled_tools or []) if str(x).strip()])

    out: List[Dict[str, Any]] = []
    label_map = {
        "answer_mode": "Hỏi đáp",
        "web_search": "Tìm kiếm mạng",
        "deep_research": "Nghiên cứu sâu",
        "doc_email_update": "Cập nhật email",
        "doc_email_routing": "Phân loại văn bản",
    }
    needs_doc = {"doc_email_routing"}
    requires_text_names = {"doc_email_routing"}  # FE cần để khoá tool khi chưa có text

    for r in rows:
        name = (r.tool_name or "").strip()
        if not name:
            continue
        if allow_names is not None and name not in allow_names:
            continue
        out.append({
            "id": name.upper(),
            "name": name,
            "slug": name,  # FE dùng slug để map icon/templates
            "label": label_map.get(name, name),
            "sort_order": r.tool_sort_order if (r.tool_sort_order is not None) else 50,
            "needs_document": name in needs_doc,
            "requires_text": name in requires_text_names,
        })

    if not out:
        return _default_tools_catalog(uinfo)

    out.sort(key=lambda t: (-int(t.get("sort_order", 0)), str(t.get("name", ""))))
    return out

@get("/chat/tools")
def chat_tools(request: Request) -> Response:
    """Danh sách tools cho menu FE (động theo DB; fallback danh sách mặc định)."""
    uinfo = _user_info(request)
    session = SessionLocal()
    try:
        tools = _db_tools_catalog(session, uinfo)
    finally:
        session.close()
    headers = {
        "Cache-Control": "no-store",
        "X-User-Role": uinfo["role"],
        "X-User-Status": uinfo["status"],
    }
    return Response(
        media_type="application/json",
        content={"ok": True, "tools": tools},
        headers=headers,
    )

@post("/chat/tools/select")
async def chat_tools_select(request: Request) -> Response:
    """Nhận lựa chọn tool từ FE và lưu nhẹ nhàng (cookie)."""
    try:
        data = await request.json()
    except Exception:
        data = {}
    ids = data.get("tool_ids") or []
    if not isinstance(ids, list):
        ids = []
    csv = ",".join([str(x) for x in ids if x])
    headers = {"Cache-Control": "no-store"}
    if csv or (request.cookies.get("cf_tools") or ""):
        headers["Set-Cookie"] = f"cf_tools={csv}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"
    return Response(media_type="application/json", content={"ok": True, "selected": ids}, headers=headers)

@get("/chat/api/upload_limits")
def chat_api_upload_limits(request: Request) -> Response:  # noqa: ARG001
    eff = _effective_body_cap()
    uinfo = _user_info(request)

    payload = {
        "ok": True,
        "limits": {
            "request_max_bytes": REQUEST_MAX_SIZE or 0,
            "multipart_per_file_bytes": MULTIPART_MAX_FILE_SIZE or 0,
            "multipart_body_bytes": MULTIPART_MAX_BODY_SIZE or 0,
            "effective_request_cap_bytes": eff,
            "max_files": MULTIPART_MAX_FILES or 0,
        },
        "human": {
            "request_max": _fmt_bytes(REQUEST_MAX_SIZE),
            "multipart_per_file": _fmt_bytes(MULTIPART_MAX_FILE_SIZE),
            "multipart_body": _fmt_bytes(MULTIPART_MAX_BODY_SIZE),
            "effective_request_cap": _fmt_bytes(eff),
        },
        "user": uinfo,
    }
    headers = _limit_headers()
    headers.update({"X-User-Role": uinfo["role"], "X-User-Status": uinfo["status"]})
    return Response(media_type="application/json", content=payload, headers=headers)

@get("/chat/api/me")
def chat_api_me(request: Request) -> Response:
    return Response(
        media_type="application/json",
        content={"ok": True, "user": _user_info(request)},
        headers={"Cache-Control": "no-store"},
    )

# ───────────────── Email update summary ─────────────────
def _format_email_update_summary(res: Any) -> str:
    try:
        if not isinstance(res, dict):
            return "Đã xử lý bản kế hoạch email."
        created = res.get("created") or res.get("scheduled") or []
        updated = res.get("updated") or []
        skipped = res.get("skipped") or res.get("ignored") or []
        conflicts = res.get("conflicts") or []
        def _fmt_item(it: dict) -> str:
            title = (it.get("title") or it.get("subject") or "").strip() or "(không tiêu đề)"
            tm = (it.get("send_time") or it.get("time") or "").strip()
            r = it.get("recipients") or it.get("recipient") or []
            if isinstance(r, list):
                rcpt = ", ".join([str(x) for x in r[:3]]) + ("…" if len(r) > 3 else "")
            else:
                rcpt = str(r or "")
            return f"- {title} — {tm} → {rcpt}".strip()
        lines: List[str] = []
        if created:
            lines.append(f"✅ Đã lên lịch {len(created)} email:")
            lines += [_fmt_item(x) for x in created]
        if updated:
            lines.append(f"\n♻️ Cập nhật {len(updated)} email:")
            lines += [_fmt_item(x) for x in updated]
        if conflicts:
            lines.append(f"\n⚠️ Trùng/xung đột {len(conflicts)} mục (bỏ qua):")
            lines += [_fmt_item(x) for x in conflicts]
        if skipped:
            lines.append(f"\nℹ️ Bỏ qua {len(skipped)} mục không hợp lệ/thiếu dữ liệu.")
        return ("\n".join(lines)).strip() or "Đã xử lý bản kế hoạch email."
    except Exception:
        return "Đã xử lý bản kế hoạch email."

# ───────────────── SIMPLE classify prompt (fallback nếu thiếu pc.*) ─────────────────
def _compose_classify_natural_prompt_fallback(
    *,
    user_question: str,
    last_doc_text_full: str,
    rag_block: str,
    allowed_labels: List[str],
    global_memory_text: str,
    recent_transcript: str,
) -> str:
    q = (_strip_appendix(user_question or "") or "").strip()
    doc_block = (last_doc_text_full or "").strip()
    rag_a = (rag_block or "").strip()

    B = "\n".join([f"- {l}" for l in (allowed_labels or [])])
    B_block = B if B else "(không có — nếu vậy hãy chọn theo hiểu biết từ [A])"

    parts: List[str] = []
    parts.append("Người dùng vừa chọn tool “Phân loại phòng ban”. Hãy giúp họ xác định văn bản gần nhất cần chuyển cho PHÒNG/BAN nào là phù hợp.")
    parts.append(f"Câu hỏi người dùng:\n{q or '(trống)'}")

    ctx_blocks: List[str] = []
    if doc_block:
        ctx_blocks.append("• DỮ LIỆU VĂN BẢN CẦN PHÂN LOẠI (raw, full):\n" + doc_block)
    else:
        ctx_blocks.append("• DỮ LIỆU VĂN BẢN CẦN PHÂN LOẠI: (không tìm thấy văn bản gần nhất)")

    ctx_blocks.append("• DỮ LIỆU RAG — ĐỀ XUẤT HỌC (A):\n" + (rag_a or "(không có)"))
    ctx_blocks.append("• DẠNG TỪ ĐIỂN PHẠM VI TÊN PHÒNG BAN (B — KHÔNG VƯỢT QUÁ DANH SÁCH NÀY):\n" + B_block)
    ctx_blocks.append("• GHI NHỚ CÁ NHÂN (global):\n" + (global_memory_text.strip() or "(trống)"))
    ctx_blocks.append("• MỘT SỐ LƯỢT TRAO ĐỔI GẦN ĐÂY:\n" + (recent_transcript.strip() or "(trống)"))

    parts.append("[NGỮ CẢNH]\n" + "\n\n".join(ctx_blocks))

    guide: List[str] = []
    guide.append("[YÊU CẦU TRẢ LỜI]")
    guide.append("- Chỉ cần LIỆT KÊ tên các phòng/ban phù hợp để xử lý văn bản trên (viết tự nhiên).")
    guide.append("- KHÔNG cần bảng/JSON/đánh số, KHÔNG cần giải thích dài, KHÔNG hỏi lại.")
    guide.append("- Nếu danh sách (B) có sẵn: KHÔNG nêu tên ngoài (B). Nếu (B) trống: chọn theo hiểu biết từ (A).")
    guide.append("- Nếu thông tin chưa đủ rõ ràng, ưu tiên chọn 1–2 phòng tổng quát trong (B) (ví dụ: Phòng Hành chính/Tổng hợp hoặc Bộ phận một cửa nếu có).")

    parts.append("\n".join(guide))
    return "\n\n".join(parts).strip()

# ──────────────────────────────── SEND ────────────────────────────────
@post("/chat/api/send")
async def chat_api_send(request: Request) -> Response:
    uid = get_secure_cookie(request)
    if not uid:
        return Response(status_code=302, headers={"Location": "/auth/login"})

    try:
        clen = int(request.headers.get("content-length") or "0")
        if clen and clen > _effective_body_cap():
            eff = _effective_body_cap()
            return Response(
                media_type="application/json",
                content={
                    "ok": False,
                    "error": "UPLOAD_TOO_LARGE",
                    "limit": eff,
                    "limit_label": _fmt_bytes(eff),
                },
                status_code=413,
                headers=_limit_headers(),
            )
    except Exception:
        pass

    try:
        form = await request.form()
    except Exception as e:
        msg = str(e or "")
        lower = msg.lower()
        too_large = any(k in lower for k in ("too large", "exceed", "payload", "request body is too large", "413"))
        status = 413 if too_large else 400
        eff = _effective_body_cap()
        return Response(
            media_type="application/json",
            content={
                "ok": False,
                "error": "UPLOAD_TOO_LARGE" if too_large else "UPLOAD_PARSE_FAILED",
                "detail": msg,
                "limit": eff,
                "limit_label": _fmt_bytes(eff),
                "per_file_limit": MULTIPART_MAX_FILE_SIZE or 0,
                "per_file_limit_label": _fmt_bytes(MULTIPART_MAX_FILE_SIZE),
                "max_files": MULTIPART_MAX_FILES or 0,
            },
            status_code=status,
            headers=_limit_headers(),
        )

    text = (form.get("text") or "").strip()
    chat_id_raw = (form.get("chat_id") or "").strip() or None
    incoming_tool_id = (form.get("tool_id") or "").strip() or None

    main_files = _extract_files(form, "main_files", "main_files[]", "file", "files", "upload")
    attachments = _extract_files(form, "attachments", "attachments[]")
    all_files = list(main_files) + list(attachments)

    if MULTIPART_MAX_FILES and len(all_files) > MULTIPART_MAX_FILES:
        return Response(
            media_type="application/json",
            content={
                "ok": False,
                "error": "TOO_MANY_FILES",
                "count": len(all_files),
                "max_files": MULTIPART_MAX_FILES,
                "limit": _effective_body_cap(),
                "limit_label": _fmt_bytes(_effective_body_cap()),
            },
            status_code=413,
            headers=_limit_headers(),
        )

    if not text and not all_files:
        return Response(
            media_type="application/json",
            content={"ok": False, "error": "EMPTY_MESSAGE"},
            status_code=400,
            headers={"Cache-Control": "no-store"},
        )

    session = SessionLocal()
    created_new_chat = False
    message_id: Optional[str] = None

    try:
        selected_mv = _choose_model_variant(session, request)
        if not selected_mv:
            return Response(
                media_type="application/json",
                content={"ok": False, "error": "MODEL_NOT_REGISTERED", "provider_model_id": RUNPOD_DEFAULT_MODEL},
                status_code=400,
                headers={"Cache-Control": "no-store"},
            )

        chat_row: Optional[ChatHistory] = None
        if chat_id_raw:
            exist = session.get(ChatHistory, chat_id_raw)
            if exist and exist.chat_user_id == uid and exist.chat_status == "active":
                chat_row = exist

        if not chat_row:
            created_new_chat = True
            chat_row = ChatHistory(  # type: ignore[call-arg]
                chat_id=str(uuid.uuid4()),
                chat_user_id=uid,
                initial_model_id=selected_mv.model_id,
                chat_status="active",
                chat_visibility="public",
            )
            session.add(chat_row)
            session.flush()

        message_id = str(uuid.uuid4())
        _set_msg_status(message_id, "pending")

        # MEMORY (ghi nhớ / forget) xử lý trước
        ack_prefix: Optional[str] = None
        soft_ack_flag = False
        if MEMORY_ENABLED and _mem and hasattr(_mem, "detect_memory_command"):
            try:
                det = _mem.detect_memory_command(text)
            except Exception:
                det = {"is_cmd": False}

            if det.get("is_cmd"):
                op = (det.get("op") or "save").lower()
                payload = (det.get("payload") or "").strip()
                rest = (det.get("rest") or "").strip()

                try:
                    can_store_flag = _mem.can_store(session, uid) if hasattr(_mem, "can_store") else True
                except Exception:
                    can_store_flag = True

                ack = ""
                if op == "forget" and hasattr(_mem, "forget_global_memory"):
                    if can_store_flag:
                        try:
                            ack = _mem.forget_global_memory(session, uid, payload)
                        except Exception as e:
                            ack = f"Đã cố gắng xoá khỏi bộ nhớ nhưng gặp lỗi: {e}"
                    else:
                        ack = "Tính năng ghi nhớ đang tắt cho tài khoản của bạn."
                else:
                    if not can_store_flag:
                        ack = "Tính năng ghi nhớ đang tắt cho tài khoản của bạn."
                    elif payload:
                        try:
                            ack = _mem.save_global_memory(session, uid, payload)
                        except Exception as e:
                            ack = f"Đã cố gắng ghi nhớ nhưng gặp lỗi: {e}"
                    else:
                        ack = "Không có gì để ghi nhớ."

                if not rest:
                    action_label = "Ghi nhớ" if op != "forget" else "Quên"
                    msg_row = ChatMessage(  # type: ignore[call-arg]
                        message_id=message_id,
                        message_chat_id=chat_row.chat_id,
                        message_model_id=selected_mv.model_id,
                        message_question=text or action_label,
                        message_ai_response=ack,
                        message_tokens_input=0,
                        message_tokens_output=0,
                    )
                    session.add(msg_row)
                    session.commit()
                    _set_msg_status(message_id, "ready", ack)
                    _dump_json_txt(chat_row.chat_id, message_id, "model_input.json.txt", {
                        "memory_only": True,
                        "ack": ack,
                        "op": op,
                        "ts": int(time.time()),
                    })
                    _dump_json_txt(chat_row.chat_id, message_id, "model_output.json.txt", {
                        "memory_only": True,
                        "ack": ack,
                        "op": op,
                        "ts": int(time.time()),
                    })
                    return Response(
                        media_type="application/json",
                        content={"ok": True, "chat_id": chat_row.chat_id, "message_id": message_id, "created_new_chat": created_new_chat},
                        headers={"Cache-Control": "no-store"},
                    )
                else:
                    ack_prefix = ack
                    text = rest
                    soft_ack_flag = True

        # Dự đoán tool sớm (trước OCR) để áp EasyOCR-only nếu cần
        predicted_tool_name: Optional[str] = None
        if TextClassifier:
            try:
                clf = TextClassifier()  # type: ignore
                c = clf.classify(_strip_appendix(text))
                predicted_tool_name = c.predicted_tool_name
            except Exception:
                predicted_tool_name = None

        is_doc_classify_early = _is_doc_classify_tool(incoming_tool_id, predicted_tool_name)

        # Lưu file & build appendix (main_files / attachments)
        extra_tail = ""
        docs_main: List[Document] = []
        docs_att: List[Document] = []
        if main_files:
            tail_main, docs_main = await _save_files_and_build_appendix(
                session=session,
                uid=uid,
                chat_row=chat_row,
                message_id=message_id,
                files=main_files,
                classification_only_ocr=is_doc_classify_early,
            )
            if tail_main:
                extra_tail += ("\n\n" + tail_main) if extra_tail else tail_main
        if attachments:
            tail_att, docs_att = await _save_files_and_build_appendix(
                session=session,
                uid=uid,
                chat_row=chat_row,
                message_id=message_id,
                files=attachments,
                classification_only_ocr=is_doc_classify_early,
            )
            if tail_att:
                extra_tail += ("\n\n" + tail_att) if extra_tail else tail_att

        if main_files or attachments:
            try:
                names_main = [
                    (getattr(f, "filename", None) or getattr(f, "name", None) or "file") for f in main_files
                ]
                names_att = [
                    (getattr(f, "filename", None) or getattr(f, "name", None) or "file") for f in attachments
                ]
                parts = []
                if names_main:
                    parts.append(f"Main: {', '.join(map(str, names_main))}")
                if names_att:
                    parts.append(f"Attachments: {', '.join(map(str, names_att))}")
                if parts:
                    text = f"{text}\n\n[Tệp đính kèm] " + " | ".join(parts)
            except Exception:
                pass
            if extra_tail:
                text = (text + "\n\n" + extra_tail).strip()

            # best-effort cập nhật pinned-state cho tool email update
            try:
                if es:
                    payload = {
                        "main_files": [
                            {"doc_id": d.doc_id, "relpath": d.doc_file_path, "name": d.doc_title}
                            for d in (docs_main or [])
                        ],
                        "attachments": [
                            {"doc_id": d.doc_id, "relpath": d.doc_file_path, "name": d.doc_title}
                            for d in (docs_att or [])
                        ],
                    }
                    if hasattr(es, "update_latest_email_update_state"):
                        es.update_latest_email_update_state(session, chat_row.chat_id, payload)  # type: ignore
                    elif hasattr(es, "save_latest_email_update_state"):
                        es.save_latest_email_update_state(session, chat_row.chat_id, payload)  # type: ignore
            except Exception:
                pass

        # Nếu user chưa chọn tool → auto map theo classifier
        chosen_tool_id = incoming_tool_id
        try:
            if not chosen_tool_id and predicted_tool_name:
                tools = _db_tools_catalog(session, _user_info(request))
                chosen_tool_id = resolve_tool_id(tools, predicted_tool_name) or None
        except Exception:
            pass

        # Build common context
        glb = ""
        if MEMORY_ENABLED and _mem and hasattr(_mem, "get_global_memory_text"):
            try:
                glb = _mem.get_global_memory_text(session, uid) or ""
            except Exception:
                glb = ""

        recent = _recent_chat_transcript(session, chat_row.chat_id, CHAT_RECENT_CONTEXT_CHARS, CHAT_RECENT_CONTEXT_MAX_MSGS)
        last_doc = ""
        if pc and hasattr(pc, "latest_doc_text"):
            try:
                last_doc = pc.latest_doc_text(session, chat_row.chat_id, include_header=True) or ""
            except Exception:
                last_doc = ""

        # Chú thích kết quả tool gần nhất (chỉ dùng cho luồng thường)
        latest_tool_note_line = ""
        try:
            if LATEST_TOOL_NOTE_ENABLE:
                latest_tool_note_line = _latest_tool_note_text(chat_row.chat_id) or ""
        except Exception:
            latest_tool_note_line = ""

        # RAG cho phân loại (ưu tiên nội dung tệp)
        rag_top_k = _env_int("RAG_TOP_K", 6) or 6
        rag_block = ""
        try:
            raw_for_rag = (last_doc.split("]\n", 1)[1] if last_doc.startswith("[") and "]\n" in last_doc else last_doc) or _strip_appendix(text)
            if pc and hasattr(pc, "build_tool_block_for_classify"):
                rag_block = pc.build_tool_block_for_classify(raw_for_rag, top_k=rag_top_k) or ""
        except Exception:
            rag_block = ""

        # Rút phạm vi [B] từ RAG
        allowed_labels = _extract_allowed_labels_from_rag(rag_block)

        # ───── Tool “Cập nhật email” ─────
        is_email_update = _is_email_update_tool(chosen_tool_id, predicted_tool_name)
        if is_email_update and es:
            # 1) Compose prompt chuyên dụng
            if pc and hasattr(pc, "compose_email_update_user_prompt_from_db"):
                try:
                    user_override = pc.compose_email_update_user_prompt_from_db(
                        session,
                        chat_id=chat_row.chat_id,
                        user_id=uid,
                        global_memory_text=glb,
                    )
                except Exception:
                    user_override = ""
            else:
                try:
                    schema_block = es.format_email_plan_schema_example() if hasattr(es, "format_email_plan_schema_example") else ""
                except Exception:
                    schema_block = ""
                user_override = (
                    "NHIỆM VỤ: Lập kế hoạch gửi email theo JSON schema. CHỈ in JSON hợp lệ.\n\n"
                    f"{schema_block}\n\n"
                    f"Câu hỏi hiện tại:\n{text or '(trống)'}\n\n"
                    "[GHI NHỚ]\n" + (glb or "(trống)") + "\n"
                ).strip()

            # 2) Chọn model/tier
            role = _user_info(request)["role"]
            if not auto:
                final_tier_default = (RUNPOD_DEFAULT_REASONING or "low").lower()
                final_tier, final_mv = final_tier_default, selected_mv
            else:
                final_tier, final_mv, _ = await auto.route_and_select_variant(
                    session,
                    user_role=role,
                    prompt=user_override,
                    selected_variant=selected_mv,
                    attachments_count=len(all_files),
                )

            # 3) Tạo message "(queued)"
            msg_row = ChatMessage(  # type: ignore[call-arg]
                message_id=message_id,
                message_chat_id=chat_row.chat_id,
                message_model_id=final_mv.model_id,
                message_question=text or "Hi",
                message_ai_response="(queued)",
            )
            session.add(msg_row)
            session.commit()

            # 4) Gọi model để lấy JSON kế hoạch
            sys_text = f"Reasoning: {(final_tier or RUNPOD_DEFAULT_REASONING or 'low').lower()}"
            messages = [{"role": "system", "content": sys_text}, {"role": "user", "content": user_override}]
            _dump_json_txt(chat_row.chat_id, message_id, "model_input.email_update.json.txt", {
                "ts": int(time.time()),
                "model": final_mv.provider_model_id or RUNPOD_DEFAULT_MODEL,
                "reasoning": final_tier,
                "messages": messages,
            })
            ai_raw, usage = await _call_provider_simple(
                provider_model_id=(final_mv.provider_model_id or RUNPOD_DEFAULT_MODEL),
                messages=messages,
                tier=final_tier,
            )
            _dump_json_txt(chat_row.chat_id, message_id, "model_output.email_update.json.txt", {
                "ts": int(time.time()),
                "raw_ai_response": ai_raw,
                "usage": usage,
            })

            # 5) Áp dụng kế hoạch → lên lịch
            try:
                apply_res = es.apply_model_output_and_schedule(
                    session,
                    chat_id=chat_row.chat_id,
                    user_id=uid,
                    model_output_text=ai_raw,
                )
            except Exception as e:
                apply_res = {"ok": False, "error": str(e)}

            # 6) Tóm tắt thân thiện
            summary = _format_email_update_summary(apply_res)
            if ack_prefix:
                summary = f"{ack_prefix}\n\n{summary}".strip()

            # 7) Cập nhật message & thống kê tokens
            msg_row.message_ai_response = summary
            msg_row.message_tokens_input = int(usage.get("prompt_tokens") or 0)
            msg_row.message_tokens_output = int(usage.get("completion_tokens") or 0)
            chat_row.chat_tokens_input = (chat_row.chat_tokens_input or 0) + msg_row.message_tokens_input
            chat_row.chat_tokens_output = (chat_row.chat_tokens_output or 0) + msg_row.message_tokens_output
            try:
                if hasattr(msg_row, "message_reasoning_requested"):
                    msg_row.message_reasoning_requested = final_tier
                if hasattr(msg_row, "message_reasoning_used"):
                    msg_row.message_reasoning_used = final_tier
            except Exception:
                pass
            session.commit()

            if MEMORY_ENABLED and MEMORY_AUTO_SUMMARY and _mem and hasattr(_mem, "update_chat_summary_async"):
                try:
                    await _mem.update_chat_summary_async(chat_row.chat_id, msg_row.message_question or "", summary or "")
                except Exception:
                    pass

            _set_msg_status(message_id, "ready", summary)

            return Response(
                media_type="application/json",
                content={
                    "ok": True,
                    "chat_id": chat_row.chat_id,
                    "message_id": message_id,
                    "created_new_chat": created_new_chat,
                    "selected_tool_id": chosen_tool_id,
                },
                headers={"Cache-Control": "no-store"},
            )

        # ───── Tool “Phân loại phòng ban” — SIMPLE (1 bước) ─────
        is_doc_classify = CLASSIFY_SIMPLE_MODE and _is_doc_classify_tool(chosen_tool_id, predicted_tool_name)
        if is_doc_classify:
            # Compose prompt tự nhiên theo spec
            if pc and hasattr(pc, "compose_user_prompt_for_department_classify_natural"):
                try:
                    user_override = pc.compose_user_prompt_for_department_classify_natural(
                        q_raw=text,
                        last_doc_text_full=last_doc,
                        rag_training_block=rag_block,
                        allowed_labels=allowed_labels,
                        global_memory_text=glb,
                        recent_transcript=recent,
                    )
                except Exception:
                    user_override = ""
            else:
                user_override = _compose_classify_natural_prompt_fallback(
                    user_question=text,
                    last_doc_text_full=last_doc,
                    rag_block=rag_block,
                    allowed_labels=allowed_labels,
                    global_memory_text=glb,
                    recent_transcript=recent,
                )

            # KHÔNG chèn latest_tool_note khi đang chạy tool phân loại
            # Chọn model/tier
            role = _user_info(request)["role"]
            if not auto:
                final_tier_default = (RUNPOD_DEFAULT_REASONING or "low").lower()
                final_tier, final_mv = final_tier_default, selected_mv
            else:
                final_tier, final_mv, _ = await auto.route_and_select_variant(
                    session,
                    user_role=role,
                    prompt=user_override,
                    selected_variant=selected_mv,
                    attachments_count=len(all_files),
                )

            msg_row = ChatMessage(  # type: ignore[call-arg]
                message_id=message_id,
                message_chat_id=chat_row.chat_id,
                message_model_id=final_mv.model_id,
                message_question=text or "Hi",
                message_ai_response="(queued)",
            )
            session.add(msg_row)
            session.commit()

            await _call_provider_and_update(
                session=session,
                mv=final_mv,
                chat_row=chat_row,
                message_row=msg_row,
                tier=final_tier,
                user_override=user_override,
                ack_prefix=ack_prefix,
            )

            return Response(
                media_type="application/json",
                content={
                    "ok": True,
                    "chat_id": chat_row.chat_id,
                    "message_id": message_id,
                    "created_new_chat": created_new_chat,
                    "selected_tool_id": chosen_tool_id,
                },
                headers={"Cache-Control": "no-store"},
            )

        # ───── Luồng thường (không tool phân loại / không email update) ─────
        if pc and hasattr(pc, "compose_user_prompt"):
            user_override = pc.compose_user_prompt(
                q_raw=text,
                glb_text=glb,
                recent_pairs=recent,
                last_doc_text=last_doc,
                memory_soft_ack=soft_ack_flag,
                classification_mode=False,
            )
        else:
            user_override = (
                f"Câu hỏi hiện tại:\n{text}\n\n"
                "[NGỮ CẢNH]\n"
                "• Ghi nhớ cá nhân (global):\n" + (glb or "(trống)") + "\n\n"
                "• Một số lượt trao đổi gần đây:\n" + (recent or "(trống)")
            ).strip()

        # (tùy chọn) chèn chú thích tool gần nhất cho luồng thường
        if LATEST_TOOL_NOTE_ENABLE and latest_tool_note_line:
            user_override = _inject_latest_tool_note_block(user_override, latest_tool_note_line)

        # Chọn model/tier
        role = _user_info(request)["role"]
        if not auto:
            final_tier_default = (RUNPOD_DEFAULT_REASONING or "low").lower()
            final_tier, final_mv = final_tier_default, selected_mv
        else:
            final_tier, final_mv, _ = await auto.route_and_select_variant(
                session,
                user_role=role,
                prompt=user_override,
                selected_variant=selected_mv,
                attachments_count=len(all_files),
            )

        msg_row = ChatMessage(  # type: ignore[call-arg]
            message_id=message_id,
            message_chat_id=chat_row.chat_id,
            message_model_id=final_mv.model_id,
            message_question=text or "Hi",
            message_ai_response="(queued)",
        )
        session.add(msg_row)
        session.commit()

        await _call_provider_and_update(
            session=session,
            mv=final_mv,
            chat_row=chat_row,
            message_row=msg_row,
            tier=final_tier,
            user_override=user_override,
            ack_prefix=ack_prefix,
        )

        return Response(
            media_type="application/json",
            content={
                "ok": True,
                "chat_id": chat_row.chat_id,
                "message_id": message_id,
                "created_new_chat": created_new_chat,
                "selected_tool_id": chosen_tool_id,
            },
            headers={"Cache-Control": "no-store"},
        )

    except Exception as e:
        session.rollback()
        if message_id:
            _set_msg_status(message_id, "error", None, str(e))
        logger.exception("chat_api_send failed: %s", e)
        return Response(
            media_type="application/json",
            content={"ok": False, "error": "CALL_FAILED", "detail": str(e)},
            status_code=500,
            headers={"Cache-Control": "no-store"},
        )
    finally:
        session.close()

@get("/chat/api/message/{message_id:str}")
def chat_api_message(request: Request, message_id: str) -> Response:
    uid = get_secure_cookie(request)
    if not uid:
        return Response(
            media_type="application/json",
            content={"ok": True, "status": "pending"},
            headers={"Cache-Control": "no-store"},
        )
    info = _MSGS.get(message_id)
    if info and info["status"] == "error":
        return Response(
            media_type="application/json",
            content={"ok": False, "status": "error", "error": info.get("error") or "UNKNOWN"},
            headers={"Cache-Control": "no-store"},
        )
    session = SessionLocal()
    try:
        row = session.get(ChatMessage, message_id)
        if not row:
            return Response(
                media_type="application/json",
                content={"ok": True, "status": "pending"},
                headers={"Cache-Control": "no-store"},
            )
        chat = session.get(ChatHistory, row.message_chat_id)
        if not chat or chat.chat_user_id != uid:
            return Response(
                media_type="application/json",
                content={"ok": False, "status": "forbidden"},
                status_code=403,
                headers={"Cache-Control": "no-store"},
            )
        if row.message_ai_response and row.message_ai_response.strip() and row.message_ai_response != "(queued)":
            _set_msg_status(message_id, "ready", row.message_ai_response)
            return Response(
                media_type="application/json",
                content={"ok": True, "status": "ready", "ai_response": row.message_ai_response},
                headers={"Cache-Control": "no-store"},
            )
    except SQLAlchemyError:
        pass
    finally:
        session.close()
    return Response(
        media_type="application/json",
        content={"ok": True, "status": "pending"},
        headers={"Cache-Control": "no-store"},
    )

@post("/chat/api/message/{message_id:str}/edit")
async def chat_api_edit(request: Request, message_id: str) -> Response:
    uid = get_secure_cookie(request)
    if not uid:
        return Response(
            media_type="application/json",
            content={"ok": False, "error": "AUTH_REQUIRED"},
            status_code=403,
            headers={"Cache-Control": "no-store"},
        )
    try:
        form = await request.form()
    except Exception:
        form = {}
    new_text = (form.get("text") or "").strip()
    if not new_text:
        return Response(
            media_type="application/json",
            content={"ok": False, "error": "EMPTY_MESSAGE"},
            status_code=400,
            headers={"Cache-Control": "no-store"},
        )
    session = SessionLocal()
    try:
        old_msg: Optional[ChatMessage] = session.get(ChatMessage, message_id)
        if not old_msg:
            return Response(
                media_type="application/json",
                content={"ok": False, "error": "NOT_FOUND"},
                status_code=404,
                headers={"Cache-Control": "no-store"},
            )
        chat_row: Optional[ChatHistory] = session.get(ChatHistory, old_msg.message_chat_id)
        if not chat_row or chat_row.chat_user_id != uid or chat_row.chat_status != "active":
            return Response(
                media_type="application/json",
                content={"ok": False, "error": "FORBIDDEN"},
                status_code=403,
                headers={"Cache-Control": "no-store"},
            )
        _maybe_save_version(
            session,
            chat_id=chat_row.chat_id,
            message_id=message_id,
            question=old_msg.message_question or "",
            ai=old_msg.message_ai_response or "",
            kind="edit",
        )
        selected_mv = _choose_model_variant(session, request)
        if not selected_mv:
            return Response(
                media_type="application/json",
                content={"ok": False, "error": "MODEL_NOT_REGISTERED", "provider_model_id": RUNPOD_DEFAULT_MODEL},
                status_code=400,
                headers={"Cache-Control": "no-store"},
            )

        glb = ""
        if MEMORY_ENABLED and _mem and hasattr(_mem, "get_global_memory_text"):
            try:
                glb = _mem.get_global_memory_text(session, uid) or ""
            except Exception:
                glb = ""

        recent = _recent_chat_transcript(session, chat_row.chat_id, CHAT_RECENT_CONTEXT_CHARS, CHAT_RECENT_CONTEXT_MAX_MSGS)
        last_doc = ""
        if pc and hasattr(pc, "latest_doc_text"):
            try:
                last_doc = pc.latest_doc_text(session, chat_row.chat_id, include_header=True) or ""
            except Exception:
                last_doc = ""

        if pc and hasattr(pc, "compose_user_prompt"):
            user_override = pc.compose_user_prompt(
                q_raw=new_text,
                glb_text=glb,
                recent_pairs=recent,
                last_doc_text=last_doc,
            )
        else:
            user_override = (
                "Câu hỏi hiện tại:\n"
                f"{new_text}\n\n"
                "[DỮ LIỆU TRƯỚC ĐÓ]\n"
                "• Bộ nhớ cá nhân (global):\n"
                f"{glb or '(trống)'}\n\n"
                "• Các tin nhắn gần đây:\n"
                f"{recent or '(trống)'}"
            ).strip()

        role = _user_info(request)["role"]
        if not auto:
            final_tier_default = (RUNPOD_DEFAULT_REASONING or "low").lower()
            final_tier, final_mv = final_tier_default, selected_mv
        else:
            final_tier, final_mv, _ = await auto.route_and_select_variant(
                session,
                user_role=role,
                prompt=user_override,
                selected_variant=selected_mv,
                attachments_count=0,
            )

        old_msg.message_model_id = final_mv.model_id
        old_msg.message_question = new_text
        old_msg.message_ai_response = "(queued)"
        old_msg.message_tokens_input = 0
        old_msg.message_tokens_output = 0
        session.commit()
        _set_msg_status(message_id, "pending")

        await _call_provider_and_update(
            session=session,
            mv=final_mv,
            chat_row=chat_row,
            message_row=old_msg,
            tier=final_tier,
            user_override=user_override,
        )
        return Response(
            media_type="application/json",
            content={"ok": True, "chat_id": chat_row.chat_id, "message_id": message_id, "in_place": True},
            headers={"Cache-Control": "no-store"},
        )
    except Exception as e:
        session.rollback()
        _set_msg_status(message_id, "error", None, str(e))
        logger.exception("chat_api_edit failed: %s", e)
        return Response(
            media_type="application/json",
            content={"ok": False, "error": "CALL_FAILED", "detail": str(e)},
            status_code=500,
            headers={"Cache-Control": "no-store"},
        )
    finally:
        session.close()

@post("/chat/api/message/{message_id:str}/regenerate")
async def chat_api_regenerate(request: Request, message_id: str) -> Response:
    uid = get_secure_cookie(request)
    if not uid:
        return Response(
            media_type="application/json",
            content={"ok": False, "error": "AUTH_REQUIRED"},
            status_code=403,
            headers={"Cache-Control": "no-store"},
        )
    try:
        form = await request.form()
    except Exception:
        form = {}
    extra_prompt = (form.get("extra_prompt") or "").strip()
    style = ((form.get("style") or "") or "").strip().lower()
    model_override = (form.get("model") or "").strip()
    style_hint = ""
    if style == "shorter":
        style_hint = "Hãy rút gọn câu trả lời, chỉ giữ ý chính (≈70% độ dài)."
    elif style == "longer":
        style_hint = "Hãy mở rộng câu trả lời với ví dụ cụ thể và chi tiết hơn."
    regen_hint = " ".join([x for x in (style_hint, extra_prompt) if x]).strip()

    session = SessionLocal()
    try:
        msg: Optional[ChatMessage] = session.get(ChatMessage, message_id)
        if not msg:
            return Response(
                media_type="application/json",
                content={"ok": False, "error": "NOT_FOUND"},
                status_code=404,
                headers={"Cache-Control": "no-store"},
            )
        chat_row: Optional[ChatHistory] = session.get(ChatHistory, msg.message_chat_id)
        if not chat_row or chat_row.chat_user_id != uid or chat_row.chat_status != "active":
            return Response(
                media_type="application/json",
                content={"ok": False, "error": "FORBIDDEN"},
                status_code=403,
                headers={"Cache-Control": "no-store"},
            )
        _maybe_save_version(
            session,
            chat_id=chat_row.chat_id,
            message_id=message_id,
            question=msg.message_question or "",
            ai=msg.message_ai_response or "",
            kind="regenerate",
        )
        selected_mv = _choose_model_variant(session, request, model_override)
        if not selected_mv:
            return Response(
                media_type="application/json",
                content={"ok": False, "error": "MODEL_NOT_REGISTERED", "provider_model_id": model_override or RUNPOD_DEFAULT_MODEL},
                status_code=400,
                headers={"Cache-Control": "no-store"},
            )

        current = msg.message_question or ""
        if regen_hint:
            current = f"{current}\n\n[HƯỚNG DẪN REGENERATE]\n{regen_hint}"

        glb = ""
        if MEMORY_ENABLED and _mem and hasattr(_mem, "get_global_memory_text"):
            try:
                glb = _mem.get_global_memory_text(session, uid) or ""
            except Exception:
                glb = ""

        recent = _recent_chat_transcript(session, chat_row.chat_id, CHAT_RECENT_CONTEXT_CHARS, CHAT_RECENT_CONTEXT_MAX_MSGS)
        last_doc = ""
        if pc and hasattr(pc, "latest_doc_text"):
            try:
                last_doc = pc.latest_doc_text(session, chat_row.chat_id, include_header=True) or ""
            except Exception:
                last_doc = ""

        if pc and hasattr(pc, "compose_user_prompt"):
            user_override = pc.compose_user_prompt(
                q_raw=current,
                glb_text=glb,
                recent_pairs=recent,
                last_doc_text=last_doc,
                extra_instructions=regen_hint if regen_hint else None,
            )
        else:
            user_override = (
                "Câu hỏi hiện tại:\n"
                f"{current}\n\n"
                "[DỮ LIỆU TRƯỚC ĐÓ]\n"
                "• Bộ nhớ cá nhân (global):\n"
                f"{glb or '(trống)'}\n\n"
                "• Các tin nhắn gần đây:\n"
                f"{recent or '(trống)'}"
            ).strip()

        role = _user_info(request)["role"]
        if not auto:
            final_tier_default = (RUNPOD_DEFAULT_REASONING or "low").lower()
            final_tier, final_mv = final_tier_default, selected_mv
        else:
            final_tier, final_mv, _ = await auto.route_and_select_variant(
                session,
                user_role=role,
                prompt=user_override,
                selected_variant=selected_mv,
                attachments_count=0,
            )

        msg.message_model_id = final_mv.model_id
        msg.message_ai_response = "(queued)"
        msg.message_tokens_input = 0
        msg.message_tokens_output = 0
        session.commit()
        _set_msg_status(message_id, "pending")

        await _call_provider_and_update(
            session=session,
            mv=final_mv,
            chat_row=chat_row,
            message_row=msg,
            tier=final_tier,
            user_override=user_override,
        )
        return Response(
            media_type="application/json",
            content={"ok": True, "chat_id": chat_row.chat_id, "message_id": message_id, "in_place": True},
            headers={"Cache-Control": "no-store"},
        )
    except Exception as e:
        session.rollback()
        _set_msg_status(message_id, "error", None, str(e))
        logger.exception("chat_api_regenerate failed: %s", e)
        return Response(
            media_type="application/json",
            content={"ok": False, "error": "CALL_FAILED", "detail": str(e)},
            status_code=500,
            headers={"Cache-Control": "no-store"},
        )
    finally:
        session.close()

@post("/chat/api/cancel")
async def chat_api_cancel(request: Request) -> Response:
    uid = get_secure_cookie(request)
    if not uid:
        return Response(
            media_type="application/json",
            content={"ok": False, "error": "AUTH_REQUIRED"},
            status_code=403,
            headers={"Cache-Control": "no-store"},
        )
    try:
        form = await request.form()
    except Exception:
        form = {}
    chat_id = (form.get("chat_id") or "").strip() or None
    mids: List[str] = []
    try:
        mids = [m for m in (form.getlist("message_ids[]") or []) if m]
    except Exception:
        pass
    try:
        if not mids:
            v = form.get("message_ids")
            if isinstance(v, list):
                mids = [m for m in v if m]
            elif isinstance(v, str) and v.strip():
                mids = [v.strip()]
    except Exception:
        pass

    session = SessionLocal()
    canceled_count = 0
    try:
        if not mids:
            return Response(
                media_type="application/json",
                content={"ok": True, "canceled": 0},
                headers={"Cache-Control": "no-store"},
            )

        if chat_id:
            chat = session.get(ChatHistory, chat_id)
            if not chat or chat.chat_user_id != uid:
                return Response(
                    media_type="application/json",
                    content={"ok": False, "error": "FORBIDDEN"},
                    status_code=403,
                    headers={"Cache-Control": "no-store"},
                )

        for mid in mids:
            row: Optional[ChatMessage] = session.get(ChatMessage, mid)
            if not row:
                continue
            chat = session.get(ChatHistory, row.message_chat_id)
            if not chat or chat.chat_user_id != uid:
                continue
            _mark_cancel(mid)
            if (row.message_ai_response or "").strip() in ("", "(queued)"):
                row.message_ai_response = "(canceled)"
                row.message_tokens_input = 0
                row.message_tokens_output = 0
                try:
                    session.add(row)
                    session.flush()
                except Exception:
                    session.rollback()
            _set_msg_status(mid, "ready", "(canceled)")
            canceled_count += 1

        try:
            session.commit()
        except Exception:
            session.rollback()

        return Response(
            media_type="application/json",
            content={"ok": True, "canceled": canceled_count},
            headers={"Cache-Control": "no-store"},
        )
    except Exception as e:
        logger.warning("cancel failed: %s", e)
        return Response(
            media_type="application/json",
            content={"ok": False, "error": "CANCEL_FAILED", "detail": str(e)},
            status_code=500,
            headers={"Cache-Control": "no-store"},
        )
    finally:
        session.close()

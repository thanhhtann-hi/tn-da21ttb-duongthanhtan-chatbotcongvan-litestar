# file: src/modules/memory/service/memory.py
# updated: 2025-09-02 (v1.4.0)
# purpose:
#   - Phát hiện lệnh “Ghi nhớ …” (save) & “Quên …” (forget) – hỗ trợ VI/EN
#   - Lưu/xoá bộ nhớ global trong user_settings.setting_remembered_summary (tôn trọng flags)
#   - Chống trùng, cắt theo dòng & ký tự, rate-limit nhẹ (save)
#   - Cập nhật "tóm tắt hội thoại" per-chat theo mô hình 1 dòng C (mỗi vòng chat)
#   - Cung cấp get_global_memory_text() cho Chat API để nạp vào "DỮ LIỆU TRƯỚC ĐÓ"
#   - Không trộn per-chat summary vào prompt model; chỉ lưu để đó

from __future__ import annotations

import os
import re
import json
import time
import logging
import datetime as dt
from typing import Optional, Tuple, List

from sqlalchemy import select
from sqlalchemy.orm import Session
from openai import OpenAI

from core.db.models import UserSettings

# ──────────────────────────────────────────────────────────────────────────────
# ENV / Config
# ──────────────────────────────────────────────────────────────────────────────
RUNPOD_BASE_URL = (os.getenv("RUNPOD_BASE_URL", "").strip() or "")
RUNPOD_API_KEY = (os.getenv("RUNPOD_API_KEY", "").strip() or "")
RUNPOD_DEFAULT_MODEL = os.getenv("RUNPOD_DEFAULT_MODEL", "openai/gpt-oss-20b").strip()
RUNPOD_TIMEOUT = int(os.getenv("RUNPOD_TIMEOUT", "60"))
RUNPOD_MAX_TOKENS = int(os.getenv("RUNPOD_MAX_TOKENS", "4096"))

UPLOAD_ROOT = os.path.abspath(os.getenv("UPLOAD_ROOT", os.path.join("uploads")))

# Giới hạn/budget
MEMORY_GLOBAL_MAX_CHARS = int(os.getenv("MEMORY_GLOBAL_MAX_CHARS", "12000"))
MEMORY_GLOBAL_MAX_LINES = int(os.getenv("MEMORY_GLOBAL_MAX_LINES", "400"))  # trần số dòng
MEMORY_CHAT_MAX_CHARS   = int(os.getenv("MEMORY_CHAT_MAX_CHARS", "4000"))

# Rate-limit (giây) cho thao tác save. 0/âm => tắt
MEMORY_SAVE_MIN_SEC = int(os.getenv("MEMORY_SAVE_MIN_SEC", "5"))

# Regex phát hiện lệnh
_CMD_SAVE_RE = re.compile(
    r"^\s*(?:ghi\s*nh(?:ớ|ơ)|nhớ\s*rằng|remember(?:\s*that)?|lưu\s*vào\s*bộ\s*nhớ)\s*:?\s*(.+?)\s*$",
    re.IGNORECASE | re.DOTALL,
)
_CMD_FORGET_RE = re.compile(
    r"^\s*(?:qu(?:ê|e)n|xoá|xóa|remove|forget|delete)(?:\s*(?:khỏi|từ)\s*(?:bộ\s*nhớ|memory))?\s*:?\s*(.*?)\s*$",
    re.IGNORECASE | re.DOTALL,
)

# Logger
logger = logging.getLogger("docaix.memory")

_client: Optional[OpenAI] = None


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────
def _get_client() -> OpenAI:
    global _client
    if _client is None:
        if not RUNPOD_BASE_URL or not RUNPOD_API_KEY:
            raise RuntimeError("RUNPOD_BASE_URL / RUNPOD_API_KEY chưa cấu hình.")
        base_url = RUNPOD_BASE_URL.rstrip("/")
        if not base_url.endswith("/v1"):
            base_url += "/v1"
        _client = OpenAI(base_url=base_url, api_key=RUNPOD_API_KEY, timeout=RUNPOD_TIMEOUT)
    return _client


def _utc_now_iso() -> str:
    return dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _heuristic_shrink(s: str, *, max_chars: int) -> str:
    s = (s or "").strip()
    if len(s) <= max_chars:
        return s
    cut = s[:max_chars]
    sp = cut.rfind(" ")
    if sp > max_chars * 2 // 3:
        cut = cut[:sp]
    return cut.rstrip() + " …"


def _normalize_payload(s: str) -> str:
    # Thu gọn khoảng trắng, bỏ dấu câu cuối rườm rà
    s = re.sub(r"\s+", " ", (s or "").strip())
    s = re.sub(r"[ \t]+$", "", s)
    s = re.sub(r"[\.、。]+$", "", s)
    return s.strip()


def _get_settings_row(session: Session, user_id: str) -> Optional[UserSettings]:
    if not user_id:
        return None
    return session.execute(
        select(UserSettings).where(UserSettings.setting_user_id == user_id).limit(1)
    ).scalar_one_or_none()


def _extract_braced(s: str) -> str:
    """
    Lấy nội dung đầu tiên nằm trong { ... } (không gồm dấu ngoặc).
    """
    s = (s or "").strip()
    i = s.find("{")
    j = s.find("}", i + 1) if i >= 0 else -1
    if i >= 0 and j > i:
        return s[i + 1:j].strip()
    return ""


def _ratelimit_path(user_id: str) -> str:
    base = os.path.join(UPLOAD_ROOT, "_memory", "ratelimit")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, f"{user_id}.json")


def _check_recent_same(user_id: str, condensed: str) -> bool:
    """
    Trả về True nếu vừa lưu *đúng nội dung* condensed trong khoảng MEMORY_SAVE_MIN_SEC.
    """
    try:
        p = _ratelimit_path(user_id)
        now = time.time()
        data = {}
        if os.path.isfile(p):
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
        last_ts = float(data.get("ts") or 0)
        last_val = (data.get("last") or "").strip()
        if MEMORY_SAVE_MIN_SEC > 0 and (now - last_ts) < MEMORY_SAVE_MIN_SEC and last_val and last_val == condensed.strip():
            return True
    except Exception:
        pass
    return False


def _touch_recent(user_id: str, condensed: str) -> None:
    try:
        p = _ratelimit_path(user_id)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"ts": time.time(), "last": (condensed or "").strip()}, f)
    except Exception:
        pass


def _split_lines(summary: str) -> List[str]:
    return [ln.strip() for ln in (summary or "").splitlines() if ln.strip()]


def _dedup_lines(lines: List[str]) -> List[str]:
    """
    Xoá trùng theo phần nội dung sau dấu ']' (dạng "[ts] text").
    """
    seen = set()
    out: List[str] = []
    for ln in lines:
        m = re.match(r"^\s*\[[^\]]+\]\s*(.+)$", ln)
        content = (m.group(1).strip() if m else ln.strip()).lower()
        key = re.sub(r"\s+", " ", content)
        if key in seen:
            continue
        seen.add(key)
        out.append(ln)
    return out


def _trim_by_line_and_chars(lines: List[str]) -> List[str]:
    if MEMORY_GLOBAL_MAX_LINES > 0 and len(lines) > MEMORY_GLOBAL_MAX_LINES:
        lines = lines[-MEMORY_GLOBAL_MAX_LINES:]
    merged = "\n".join(lines)
    if MEMORY_GLOBAL_MAX_CHARS > 0 and len(merged) > MEMORY_GLOBAL_MAX_CHARS:
        # cắt từ đầu (ưu tiên giữ mới)
        cut = merged[-MEMORY_GLOBAL_MAX_CHARS:]
        p = cut.find("\n")
        if p > 100:
            cut = cut[p + 1:]
        lines = [ln for ln in cut.splitlines() if ln.strip()]
    return lines


def _content_of_line(ln: str) -> str:
    m = re.match(r"^\s*\[[^\]]+\]\s*(.+)$", ln)
    return (m.group(1).strip() if m else ln.strip())


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


# ──────────────────────────────────────────────────────────────────────────────
# Command detection
# ──────────────────────────────────────────────────────────────────────────────
def detect_memory_command(text: str) -> dict:
    """
    Trả về:
      { is_cmd: bool, op: 'save'|'forget', payload: str, rest: str }
    Cho phép:
      - "Ghi nhớ: <nội dung>"
      - "Remember that: <content>"
      - "Quên: <chuỗi> / #n / last / * / all"
      - Có thể kèm phần câu hỏi sau bằng khoảng cách lớn/---/||
    """
    if not text:
        return {"is_cmd": False, "op": "", "payload": "", "rest": ""}

    m = _CMD_SAVE_RE.match(text)
    if m:
        body = _normalize_payload(m.group(1) or "")
        parts = re.split(r"(?:\n{2,}|-{3,}|\|\|)", body, maxsplit=1)
        payload = _normalize_payload(parts[0] or "")
        rest = (parts[1] or "").strip() if len(parts) > 1 else ""
        return {"is_cmd": True, "op": "save", "payload": payload, "rest": rest}

    m = _CMD_FORGET_RE.match(text)
    if m:
        body = _normalize_payload(m.group(1) or "")
        parts = re.split(r"(?:\n{2,}|-{3,}|\|\|)", body, maxsplit=1)
        payload = _normalize_payload(parts[0] or "")
        rest = (parts[1] or "").strip() if len(parts) > 1 else ""
        return {"is_cmd": True, "op": "forget", "payload": payload, "rest": rest}

    return {"is_cmd": False, "op": "", "payload": "", "rest": ""}


# ──────────────────────────────────────────────────────────────────────────────
# Summarizers (save/per-chat)
# ──────────────────────────────────────────────────────────────────────────────
def _summarize_memory_braced(raw_text: str) -> str:
    raw_text = (raw_text or "").strip()
    if not raw_text:
        return ""

    if not RUNPOD_BASE_URL or not RUNPOD_API_KEY:
        return _heuristic_shrink(raw_text, max_chars=200)

    try:
        client = _get_client()
        sys_msg = {"role": "system", "content": "Reasoning: low"}
        user_msg = {
            "role": "user",
            "content": (
                "Người dùng yêu cầu *ghi nhớ* thông tin sau:\n"
                f"<{raw_text}>\n\n"
                "- Tóm tắt lại thành **một câu ngắn gọn nhất có ích cho lần sau**.\n"
                "- Không thêm tiền tố/hậu tố.\n"
                "- Trả duy nhất theo định dạng: {{ nội dung }}\n"
            ),
        }
        resp = client.chat.completions.create(
            model=RUNPOD_DEFAULT_MODEL,
            messages=[sys_msg, user_msg],
            temperature=0,
            max_tokens=min(128, RUNPOD_MAX_TOKENS),
        )
        out = (resp.choices[0].message.content or "").strip()
        got = _extract_braced(out)
        return got or _heuristic_shrink(out, max_chars=200)
    except Exception as e:
        logger.debug("summarize_memory_braced error: %s", e)
        return _heuristic_shrink(raw_text, max_chars=200)


def _summarize_chat_line_braced(prev_c: str, user_text: str, ai_text: str) -> str:
    prompt = (
        "[TÓM TẮT CŨ]\n"
        f"{prev_c}\n\n"
        "[TRAO ĐỔI MỚI]\n"
        f"User: {user_text}\n"
        f"Assistant: {ai_text}\n\n"
        "Hãy tạo đúng MỘT dòng tóm tắt cực ngắn gọn trọng tâm cho toàn bộ bối cảnh đã biết "
        "(ưu tiên mục tiêu, ràng buộc/đã quyết, tiến độ). "
        "Không giải thích. Trả về duy nhất trong: { ... }"
    )

    if not RUNPOD_BASE_URL or not RUNPOD_API_KEY:
        merged = ((prev_c + " | ") if prev_c else "") + f"U:{user_text} A:{ai_text}"
        return _heuristic_shrink(merged, max_chars=240)

    try:
        client = _get_client()
        resp = client.chat.completions.create(
            model=RUNPOD_DEFAULT_MODEL,
            messages=[
                {"role": "system", "content": "Reasoning: low"},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
            max_tokens=min(128, RUNPOD_MAX_TOKENS),
        )
        out = (resp.choices[0].message.content or "").strip()
        got = _extract_braced(out)
        return got or _heuristic_shrink(out, max_chars=240)
    except Exception as e:
        logger.debug("summarize_chat_line_braced error: %s", e)
        merged = ((prev_c + " | ") if prev_c else "") + f"U:{user_text} A:{ai_text}"
        return _heuristic_shrink(merged, max_chars=240)


# ──────────────────────────────────────────────────────────────────────────────
# SAVE — Lưu “bộ nhớ tổng” (global)
# ──────────────────────────────────────────────────────────────────────────────
def save_global_memory(session: Session, user_id: str, raw_text: str) -> str:
    raw_text = _normalize_payload(raw_text)
    if not raw_text:
        return "Không có gì để ghi nhớ."

    row = _get_settings_row(session, user_id)
    if row is None:
        row = UserSettings(  # type: ignore[call-arg]
            setting_user_id=user_id,
            setting_allow_memory_lookup=True,
            setting_allow_memory_storage=True,
            setting_theme="light",
        )
        session.add(row)
        session.flush()

    condensed = _normalize_payload(_summarize_memory_braced(raw_text)) or _heuristic_shrink(raw_text, max_chars=200)

    # Rate-limit: nếu vừa lưu cùng nội dung trong vài giây → bỏ qua
    if _check_recent_same(user_id, condensed):
        return "Ok, tôi đã ghi nhớ rồi!"

    stamp = _utc_now_iso()
    new_line = f"[{stamp}] {condensed}"

    # Merge + dedup + trim
    lines = _split_lines(row.setting_remembered_summary or "")
    lines.append(new_line)
    lines = _dedup_lines(lines)
    lines = _trim_by_line_and_chars(lines)

    row.setting_remembered_summary = "\n".join(lines).strip()
    session.add(row)
    session.commit()

    _touch_recent(user_id, condensed)
    return "Ok, tôi đã ghi nhớ!"


# ──────────────────────────────────────────────────────────────────────────────
# FORGET — Xoá khỏi “bộ nhớ tổng” (global)
# ──────────────────────────────────────────────────────────────────────────────
def _parse_forget_target(payload: str) -> dict:
    """
    Hỗ trợ:
      - "*" / "all" / "all memories": xoá toàn bộ
      - "last" / "gần nhất" / "cuối cùng": xoá mục mới nhất
      - "#n" hoặc "n" (n nguyên dương): xoá mục thứ n tính từ MỚI NHẤT (#1 = mới nhất)
      - chuỗi bất kỳ: xoá các dòng chứa chuỗi đó (case-insensitive)
      - rỗng: mặc định 'last'
    """
    p = (payload or "").strip().lower()
    if not p:
        return {"mode": "last"}
    if p in {"*", "all", "all memories", "tat ca", "tất cả"}:
        return {"mode": "all"}
    if p in {"last", "latest", "most recent", "gần nhất", "cuối cùng"}:
        return {"mode": "last"}
    m = re.fullmatch(r"#?(\d+)", p)
    if m:
        n = int(m.group(1))
        if n >= 1:
            return {"mode": "index", "n": n}
    return {"mode": "substring", "q": p}


def _remove_by_indices(lines: List[str], indices_desc_newest: List[int]) -> Tuple[List[str], int]:
    """
    indices_desc_newest: danh sách chỉ số 1-based từ MỚI → CŨ (#1 là dòng cuối list).
    """
    if not lines:
        return lines, 0
    N = len(lines)
    to_remove_pos = set()
    for idx_newest in indices_desc_newest:
        pos = N - idx_newest
        if 0 <= pos < N:
            to_remove_pos.add(pos)
    keep = [ln for i, ln in enumerate(lines) if i not in to_remove_pos]
    removed_count = N - len(keep)
    return keep, removed_count


def _remove_by_substring(lines: List[str], query: str) -> Tuple[List[str], int]:
    q = _norm(query)
    keep: List[str] = []
    removed = 0
    for ln in lines:
        c = _norm(_content_of_line(ln))
        if q and q in c:
            removed += 1
        else:
            keep.append(ln)
    return keep, removed


def forget_global_memory(session: Session, user_id: str, payload: str) -> str:
    """
    Xoá khỏi bộ nhớ tổng theo payload. ACK ngắn gọn (hoạt động ngầm).
    """
    row = _get_settings_row(session, user_id)
    if row is None or not (row.setting_remembered_summary or "").strip():
        return "Bộ nhớ đang trống."

    lines = _split_lines(row.setting_remembered_summary or "")
    target = _parse_forget_target(payload)

    removed_count = 0
    keep = lines

    mode = target.get("mode")
    if mode == "all":
        removed_count = len(lines)
        keep = []
    elif mode == "last":
        keep, removed_count = _remove_by_indices(lines, [1])
    elif mode == "index":
        keep, removed_count = _remove_by_indices(lines, [int(target.get("n") or 1)])
    elif mode == "substring":
        keep, removed_count = _remove_by_substring(lines, str(target.get("q") or ""))

    if removed_count == 0:
        return "Không tìm thấy mục để xoá."

    keep = _trim_by_line_and_chars(keep)
    row.setting_remembered_summary = "\n".join(keep).strip()
    session.add(row)
    session.commit()

    if mode == "all":
        return f"Ok, đã xoá toàn bộ ({removed_count} mục)."
    return f"Ok, đã xoá {removed_count} mục."


# ──────────────────────────────────────────────────────────────────────────────
# Per-chat summary (1 dòng C, lưu file uploads/chat/<chat_id>/memory.json)
# ──────────────────────────────────────────────────────────────────────────────
def _chat_mem_path(chat_id: str) -> str:
    return os.path.join(UPLOAD_ROOT, "chat", chat_id, "memory.json")


def _read_chat_summary(chat_id: str) -> Tuple[str, dict]:
    p = _chat_mem_path(chat_id)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
            return (data.get("summary") or "").strip(), data
    except Exception:
        return "", {}


def _write_chat_summary(chat_id: str, summary: str) -> None:
    p = _chat_mem_path(chat_id)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    data = {
        "summary": (summary or "").strip(),
        "updated_at": _utc_now_iso(),
        "version": "1",
    }
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


async def update_chat_summary_async(chat_id: str, user_text: str, ai_text: str) -> None:
    try:
        prev, _ = _read_chat_summary(chat_id)
        new_c = _summarize_chat_line_braced(prev, user_text, ai_text)
        if MEMORY_CHAT_MAX_CHARS > 0 and len(new_c) > MEMORY_CHAT_MAX_CHARS:
            new_c = _heuristic_shrink(new_c, max_chars=MEMORY_CHAT_MAX_CHARS)
        _write_chat_summary(chat_id, new_c)
    except Exception as e:
        logger.debug("update_chat_summary_async error: %s", e)


# ──────────────────────────────────────────────────────────────────────────────
# Global memory text cho prompt (DỮ LIỆU TRƯỚC ĐÓ)
# ──────────────────────────────────────────────────────────────────────────────
def get_global_memory_text(session: Session, user_id: str, limit_chars: int = MEMORY_GLOBAL_MAX_CHARS) -> str:
    row = _get_settings_row(session, user_id)
    if not row or not row.setting_remembered_summary:
        return ""
    glb = row.setting_remembered_summary.strip()
    if limit_chars > 0 and len(glb) > limit_chars:
        glb = glb[-limit_chars:]
        p = glb.find("\n")
        if p > 100:
            glb = glb[p + 1:]
    return glb


# ──────────────────────────────────────────────────────────────────────────────
# (Optional) System hint (giữ tương thích – chỉ trả GLOBAL)
# ──────────────────────────────────────────────────────────────────────────────
def build_system_hint(session: Session, user_id: str, chat_id: Optional[str]) -> Optional[str]:
    row = _get_settings_row(session, user_id)
    if row is not None and not bool(row.setting_allow_memory_lookup):
        return None
    glb = get_global_memory_text(session, user_id, limit_chars=MEMORY_GLOBAL_MAX_CHARS)
    if not glb:
        return None
    return "# HINT CHO MÔ HÌNH (ẩn với user):\n## Ghi chú cá nhân (global):\n" + glb

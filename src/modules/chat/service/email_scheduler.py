# file: src/modules/chat/service/email_scheduler.py
# updated: 2025-09-03 (v1.0.0)
# purpose:
#   - Service cho tool "Cập nhật email" (DOC_EMAIL_UPDATE)
#   - Chức năng chính:
#       1) Neo (pin) "văn bản cần chuyển", "văn bản đính kèm", "kết quả phân loại gần nhất"
#          vào ChatFeature.cf_metadata (cf_type_name = 'doc_email_update')
#       2) Gom ngữ cảnh đầy đủ để soạn PROMPT cho model (user question gần nhất,
#          file info, classify result, list lịch gửi mail của user, global memory, transcript)
#       3) Parse output của model (JSON kế hoạch gửi mail), chuẩn hoá & ghi vào DB:
#           - scheduled_emails (+ attachments)
#           - liên kết phòng ban qua bảng nhan_mail (nếu map được)
#       4) Trả tiện ích liệt kê toàn bộ lịch gửi mail của user/chat (động liên tục)
#
#   - Ghi chú:
#       * ScheduledEmail.email_send_time là TIMESTAMP (không timezone) trong schema → hàm parse sẽ
#         convert về naive datetime (UTC hoặc local giữ nguyên; tuỳ upstream).
#       * Nếu 1 item có nhiều recipients → tạo nhiều dòng ScheduledEmail, mỗi dòng 1 recipient.
#       * Nếu model trả 'departments' → map sang bảng departments theo name/alias/email (tolerant).
#       * Đính kèm: nhận theo 'relpath' (từ UPLOAD_ROOT) hoặc 'name' best-effort.
#
# compat: SQLAlchemy ORM hiện có
from __future__ import annotations

import os
import re
import json
import uuid
import logging
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional, Dict, List, Tuple, Iterable

from sqlalchemy import select, or_, func
from sqlalchemy.exc import IntegrityError

# DB session & models
from core.db.engine import SessionLocal  # nếu dùng trực tiếp trong routes khác
from core.db.models import (
    ChatHistory,
    ChatMessage,
    ChatFeature,
    ToolDefinition,
    Document,
    DocumentAttachment,
    ScheduledEmail,
    ScheduledEmailAttachment,
    Department,
    NhanMail,
    User,
)

log = logging.getLogger("docaix.email_scheduler")

# ──────────────────────────────────────────────────────────────────────────────
# Hằng số / id tool
# ──────────────────────────────────────────────────────────────────────────────

TOOL_NAME = "doc_email_update"         # khớp menu động
CF_TYPE_NAME = "doc_email_update"      # cf_type_name trong ChatFeature
UPLOAD_ROOT = os.path.abspath(os.getenv("UPLOAD_ROOT", os.path.join("uploads")))


# ──────────────────────────────────────────────────────────────────────────────
# Dataclasses: Email Plan từ output model
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class EmailPlanItem:
    title: str
    send_time: str                         # ISO/“YYYY-MM-DD HH:MM” string (naive)
    body: Optional[str] = None
    recipients: List[str] = field(default_factory=list)     # email strings
    departments: List[str] = field(default_factory=list)    # department names/alias
    attachments: List[Dict[str, Any]] = field(default_factory=list)  # [{relpath|name, description?}]

@dataclass
class EmailPlan:
    items: List[EmailPlanItem] = field(default_factory=list)
    meta: Dict[str, Any] = field(default_factory=dict)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers: norm / time / text
# ──────────────────────────────────────────────────────────────────────────────

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

def _is_email(s: str) -> bool:
    return bool(_EMAIL_RE.match((s or "").strip()))

def _norm_key(s: str) -> str:
    """Chuẩn hoá tolerant (bỏ dấu, lower, gộp khoảng trắng) để so khớp tên phòng ban."""
    s = (s or "").strip()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = re.sub(r"\s+", " ", s).strip()
    return s

def _as_naive_datetime(s: str) -> Optional[datetime]:
    """
    Parse chuỗi thời gian về datetime naive (theo schema DB).
    Hỗ trợ:
      - "YYYY-MM-DD HH:MM[:SS]"
      - ISO 8601 (có/không timezone) → drop tzinfo (convert UTC nếu muốn mở rộng sau)
    """
    if not s:
        return None
    z = s.strip()
    # ISO with 'T'
    try:
        if "T" in z:
            dt = datetime.fromisoformat(z.replace("Z", "+00:00"))
            # schema yêu cầu naive → drop tzinfo (giữ 'as is')
            return dt.replace(tzinfo=None) if dt.tzinfo else dt
    except Exception:
        pass
    # Common "YYYY-MM-DD HH:MM[:SS]"
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(z, fmt)
        except Exception:
            continue
    # Fallback: date only → 08:00
    try:
        d = datetime.strptime(z, "%Y-%m-%d")
        return d.replace(hour=8, minute=0, second=0, microsecond=0)
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# JSON parsing từ output model
# ──────────────────────────────────────────────────────────────────────────────

def _extract_json(s: str) -> Optional[dict]:
    """
    Ưu tiên block ```json ...```; fallback: cặp {...} lớn nhất hoặc mảng top-level.
    """
    if not s:
        return None
    txt = s.strip()

    m = re.search(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", txt, flags=re.S | re.I)
    if m:
        try:
            obj = json.loads(m.group(1))
            return obj if isinstance(obj, dict) else {"items": obj}
        except Exception:
            pass

    # find largest {...}
    best = None; best_len = 0; stack = []; start = None
    for i, ch in enumerate(txt):
        if ch == "{":
            if not stack:
                start = i
            stack.append("{")
        elif ch == "}":
            if stack:
                stack.pop()
                if not stack and start is not None:
                    seg = txt[start:i+1]
                    if len(seg) > best_len:
                        best, best_len = seg, len(seg)
    if best:
        try:
            obj = json.loads(best)
            return obj if isinstance(obj, dict) else None
        except Exception:
            pass

    # try list [...]
    m2 = re.search(r"(\[.*\])", txt, flags=re.S)
    if m2:
        try:
            arr = json.loads(m2.group(1))
            return {"items": arr} if isinstance(arr, list) else None
        except Exception:
            pass
    return None


def _as_list(v: Any) -> List[Any]:
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]


def normalize_plan(obj: dict) -> EmailPlan:
    """
    Chuẩn hoá object JSON (từ model) về EmailPlan.
    Chấp nhận các dạng:
      - {"items":[{...}]}
      - trực tiếp {"title":..., ...} → items 1 phần tử
      - hoặc mảng [...]. (được bọc bởi _extract_json)
    """
    base: dict = obj or {}
    items_src: List[dict] = []

    if "items" in base and isinstance(base["items"], list):
        items_src = [x for x in base["items"] if isinstance(x, dict)]
    elif all(isinstance(x, dict) for x in base.values()) and {"title","send_time"} <= set(base.keys()):
        items_src = [base]  # one item
    else:
        # quét tìm mảng phù hợp
        maybe = base.get("plan") or base.get("emails") or base.get("schedule") or []
        if isinstance(maybe, list):
            items_src = [x for x in maybe if isinstance(x, dict)]

    items: List[EmailPlanItem] = []
    for it in items_src:
        title = str(it.get("title") or it.get("subject") or "").strip()
        time_s = str(it.get("send_time") or it.get("time") or it.get("schedule_at") or "").strip()
        body = (it.get("body") or it.get("content") or it.get("html") or it.get("text") or None)
        recipients = [str(x).strip() for x in _as_list(it.get("recipients") or it.get("to") or []) if str(x).strip()]
        departments = [str(x).strip() for x in _as_list(it.get("departments") or it.get("dept") or []) if str(x).strip()]

        atts_src = _as_list(it.get("attachments") or it.get("files") or [])
        attachments: List[Dict[str, Any]] = []
        for a in atts_src:
            if isinstance(a, dict):
                rel = a.get("relpath") or a.get("path") or a.get("rel") or ""
                name = a.get("name") or ""
                desc = a.get("description") or a.get("desc") or None
                item = {}
                if str(rel).strip():
                    item["relpath"] = str(rel).strip()
                if str(name).strip():
                    item["name"] = str(name).strip()
                if desc:
                    item["description"] = str(desc)
                if item:
                    attachments.append(item)
            elif isinstance(a, str) and a.strip():
                # chuỗi: ưu tiên coi là relpath, nếu không thì name
                v = a.strip()
                if "/" in v or "\\" in v:
                    attachments.append({"relpath": v})
                else:
                    attachments.append({"name": v})

        if not title or not time_s:
            # bỏ qua phần tử không đủ thông tin tối thiểu
            continue

        items.append(EmailPlanItem(
            title=title,
            send_time=time_s,
            body=body if isinstance(body, str) else None,
            recipients=recipients,
            departments=departments,
            attachments=attachments
        ))

    meta = {k: v for k, v in base.items() if k not in {"items", "plan", "emails", "schedule"}}
    return EmailPlan(items=items, meta=meta)


def parse_model_email_plan(output_text: str) -> EmailPlan:
    """Public API: parse → normalize."""
    obj = _extract_json(output_text) or {}
    return normalize_plan(obj)


# ──────────────────────────────────────────────────────────────────────────────
# Dept resolving
# ──────────────────────────────────────────────────────────────────────────────

def _fetch_all_departments(session) -> List[Department]:
    try:
        return session.execute(select(Department)).scalars().all()
    except Exception:
        return []


def _resolve_departments(session, names_or_emails: Iterable[str]) -> List[Department]:
    """
    Nỗ lực map danh sách tên/alias/email của phòng ban sang rows Department.
    Chiến lược:
      - So khớp email (dept_email) chính xác (lower)
      - So khớp tên hoặc alias tolerant (bỏ dấu, lower, gộp khoảng trắng)
    """
    arr = [str(x or "").strip() for x in (names_or_emails or []) if str(x or "").strip()]
    if not arr:
        return []

    depts = _fetch_all_departments(session)
    if not depts:
        return []

    # Map theo email
    email_map = { (d.dept_email or "").strip().lower(): d for d in depts if (d.dept_email or "").strip() }
    # Map theo name/alias tolerant
    name_map: Dict[str, Department] = {}
    for d in depts:
        if d.dept_name:
            name_map[_norm_key(d.dept_name)] = d
        if d.dept_alias:
            # alias có thể chứa nhiều dạng: tách dấu ; , |
            parts = re.split(r"[;,\|]", d.dept_alias)
            for p in parts:
                p = p.strip()
                if p:
                    name_map[_norm_key(p)] = d

    out: List[Department] = []
    seen = set()
    for token in arr:
        key_email = token.lower()
        d = email_map.get(key_email)
        if not d:
            d = name_map.get(_norm_key(token))
        if d and d.dept_id not in seen:
            out.append(d)
            seen.add(d.dept_id)
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Attachments resolving
# ──────────────────────────────────────────────────────────────────────────────

def _relpath(p: str) -> str:
    return os.path.relpath(os.path.abspath(p), start=UPLOAD_ROOT).replace("\\", "/")

def _find_doc_by_rel_or_name(session, chat_id: str, rel_or_name: str) -> Optional[Document]:
    """
    Tìm Document theo relpath hoặc theo doc_title (file name) gần đúng trong chat.
    """
    if not rel_or_name:
        return None
    key = rel_or_name.strip().replace("\\", "/")
    # trước thử match relpath
    try:
        q = select(Document).where(
            Document.doc_chat_id == chat_id,
            Document.doc_file_path == key
        ).limit(1)
        r = session.execute(q).scalar_one_or_none()
        if r:
            return r
    except Exception:
        pass
    # fallback: match theo tên file (doc_title)
    base = os.path.basename(key)
    try:
        q = select(Document).where(
            Document.doc_chat_id == chat_id,
            or_(Document.doc_title == base, Document.doc_file_path.ilike(f"%/{base}"))
        ).order_by(Document.doc_created_at.desc())
        rs = session.execute(q).scalars().all()
        return rs[0] if rs else None
    except Exception:
        return None


def _resolve_attachments_for_item(
    session,
    chat_id: str,
    item: EmailPlanItem,
    pinned_main: List[Dict[str, Any]],
    pinned_atts: List[Dict[str, Any]],
) -> List[Tuple[str, str, str]]:
    """
    Trả về list tuple (abs_path, mime, filename) để viết vào ScheduledEmailAttachment.
    Nguồn tham chiếu:
      - item.attachments: ưu tiên relpath → Document → abs path; fallback name
      - nếu trống → gợi ý: đính kèm main + pinned_atts (tùy chính sách bạn chỉnh)
    """
    out: List[Tuple[str, str, str]] = []

    def as_tuple_from_document(doc: Document) -> Optional[Tuple[str, str, str]]:
        try:
            rel = (doc.doc_file_path or "").strip()
            if not rel:
                return None
            abs_path = os.path.join(UPLOAD_ROOT, rel)
            if not os.path.isfile(abs_path):
                return None
            filename = os.path.basename(abs_path)
            # đoán MIME rất cơ bản
            import mimetypes
            mime, _ = mimetypes.guess_type(filename, strict=False)
            return (abs_path, mime or "application/octet-stream", filename)
        except Exception:
            return None

    # 1) Nếu item có attachments → resolve từng cái
    picked = 0
    for a in (item.attachments or []):
        rel = str(a.get("relpath") or "").strip()
        name = str(a.get("name") or "").strip()

        doc = None
        if rel:
            # relpath trong context pinned có thể khác thời điểm; ưu tiên tìm doc theo rel
            doc = _find_doc_by_rel_or_name(session, chat_id, rel)
        if not doc and name:
            doc = _find_doc_by_rel_or_name(session, chat_id, name)
        if doc:
            t = as_tuple_from_document(doc)
            if t:
                out.append(t)
                picked += 1

    # 2) Nếu model không chỉ rõ attachments → đính default: main + pinned_atts
    if picked == 0:
        def try_append_from_ctx(ctx: List[Dict[str, Any]]):
            for f in ctx:
                rel = (f.get("relpath") or "").strip()
                if not rel:
                    continue
                try:
                    abs_path = os.path.join(UPLOAD_ROOT, rel)
                    if not os.path.isfile(abs_path):
                        continue
                    fn = os.path.basename(abs_path)
                    import mimetypes
                    mime, _ = mimetypes.guess_type(fn, strict=False)
                    out.append((abs_path, mime or "application/octet-stream", fn))
                except Exception:
                    continue

        try_append_from_ctx(pinned_main)
        try_append_from_ctx(pinned_atts)

    return out


# ──────────────────────────────────────────────────────────────────────────────
# ChatFeature (pin/neo trạng thái "Cập nhật email")
# ──────────────────────────────────────────────────────────────────────────────

def _get_or_create_cf(session, chat_id: str) -> ChatFeature:
    """Lấy ChatFeature cho tool 'doc_email_update'; tạo nếu chưa có."""
    # tìm ToolDefinition (nếu có)
    tool_row = None
    try:
        tool_row = session.execute(
            select(ToolDefinition).where(ToolDefinition.tool_name == TOOL_NAME)
        ).scalar_one_or_none()
    except Exception:
        tool_row = None

    # tìm CF hiện có
    try:
        q = select(ChatFeature).where(
            ChatFeature.cf_chat_id == chat_id,
            ChatFeature.cf_type_name == CF_TYPE_NAME
        ).limit(1)
        cf = session.execute(q).scalar_one_or_none()
    except Exception:
        cf = None

    if cf:
        # đồng bộ tool_id nếu chưa có
        if (cf.cf_tool_id is None) and tool_row:
            try:
                cf.cf_tool_id = tool_row.tool_id
                session.flush()
            except Exception:
                session.rollback()
        return cf

    # tạo mới
    cf = ChatFeature(  # type: ignore[call-arg]
        cf_id=str(uuid.uuid4()),
        cf_chat_id=chat_id,
        cf_tool_id=tool_row.tool_id if tool_row else None,
        cf_type_name=CF_TYPE_NAME,
        cf_metadata={"created_at": datetime.now(timezone.utc).isoformat()},
    )
    session.add(cf)
    session.flush()
    return cf


def _file_info_from_doc(doc: Document) -> Dict[str, Any]:
    return {
        "doc_id": doc.doc_id,
        "relpath": (doc.doc_file_path or ""),
        "name": (doc.doc_title or os.path.basename(doc.doc_file_path or "")),
        "ocr_text_path": (doc.doc_ocr_text_path or ""),
        "status": doc.doc_status,
    }


def pin_latest_email_update_state(
    session,
    *,
    chat_id: str,
    last_user_question: Optional[str],
    main_docs: List[Document],
    attachment_docs: List[Document],
    classify_result: Optional[Dict[str, Any]] = None,
    last_doc_excerpt: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Neo/pin các thực thể liên quan đến tool "Cập nhật email".
    Lưu vào ChatFeature.cf_metadata:
      - last_question
      - main_files[] / attachments[]
      - classify_result (raw JSON từ tool phân loại)
      - last_doc_excerpt (nội dung OCR/Extract gần nhất; rút gọn bởi caller)
      - pinned_at (UTC)
    """
    cf = _get_or_create_cf(session, chat_id)

    data = cf.cf_metadata or {}
    data.update({
        "last_question": (last_user_question or "").strip(),
        "main_files": [_file_info_from_doc(d) for d in (main_docs or [])],
        "attachments": [_file_info_from_doc(d) for d in (attachment_docs or [])],
        "classify_result": classify_result or {},
        "last_doc_excerpt": (last_doc_excerpt or "").strip(),
        "pinned_at": datetime.now(timezone.utc).isoformat(),
        "version": 1,
    })
    cf.cf_metadata = data

    try:
        session.add(cf)
        session.commit()
    except Exception:
        session.rollback()
        raise

    return data


def load_latest_email_update_state(session, chat_id: str) -> Dict[str, Any]:
    """Đọc cf_metadata đã pin cho tool 'Cập nhật email' trong chat."""
    try:
        q = select(ChatFeature).where(
            ChatFeature.cf_chat_id == chat_id,
            ChatFeature.cf_type_name == CF_TYPE_NAME
        ).limit(1)
        cf = session.execute(q).scalar_one_or_none()
        return (cf.cf_metadata or {}) if cf else {}
    except Exception:
        return {}


# ──────────────────────────────────────────────────────────────────────────────
# Ghi kế hoạch vào DB: ScheduledEmail + attachments + nhan_mail
# ──────────────────────────────────────────────────────────────────────────────

def _exists_similar_email(session, chat_id: str, title: str, recipient: str, when: datetime) -> bool:
    """Tránh nhân bản: cùng chat_id + title + recipient + time (±60s) → coi như trùng."""
    try:
        tmin = when.replace(second=0, microsecond=0)
        tmax = tmin.replace(second=59, microsecond=999000)
        q = select(ScheduledEmail).where(
            ScheduledEmail.email_chat_id == chat_id,
            ScheduledEmail.email_title == title,
            ScheduledEmail.email_recipient == recipient,
            ScheduledEmail.email_send_time >= tmin,
            ScheduledEmail.email_send_time <= tmax,
        ).limit(1)
        r = session.execute(q).scalar_one_or_none()
        return r is not None
    except Exception:
        return False


@dataclass
class CreatePlanResult:
    created: int
    skipped: int
    rows: List[ScheduledEmail] = field(default_factory=list)
    detail: List[Dict[str, Any]] = field(default_factory=list)


def create_scheduled_emails_from_plan(
    session,
    *,
    chat_id: str,
    plan: EmailPlan,
    pinned_state: Optional[Dict[str, Any]] = None,
) -> CreatePlanResult:
    """
    Tạo bản ghi ScheduledEmail từ EmailPlan.
    - Mỗi recipient → 1 row (email_recipient)
    - Map departments → NhanMail
    - Gắn attachments từ plan hoặc default (main + attachments đã pin)
    """
    pinned_state = pinned_state or load_latest_email_update_state(session, chat_id)
    pinned_main = list(pinned_state.get("main_files") or [])
    pinned_atts = list(pinned_state.get("attachments") or [])

    created = 0
    skipped = 0
    rows: List[ScheduledEmail] = []
    detail: List[Dict[str, Any]] = []

    for idx, item in enumerate(plan.items or []):
        when = _as_naive_datetime(item.send_time)
        if not when:
            skipped += 1
            detail.append({"index": idx, "reason": "INVALID_TIME", "raw": item.send_time})
            continue

        # resolve departments
        dept_tokens = list(item.departments or [])
        # Nếu model không điền 'departments', có thể suy luận từ classify_result pinned
        if not dept_tokens and pinned_state.get("classify_result"):
            cr = pinned_state.get("classify_result") or {}
            # chấp nhận các field thường gặp
            labs = []
            if isinstance(cr, dict):
                if isinstance(cr.get("final_candidates"), list):
                    labs = [str(x.get("label") or x.get("name") or "").strip()
                            for x in cr["final_candidates"] if isinstance(x, dict)]
                elif isinstance(cr.get("candidates"), list):
                    labs = [str(x.get("label") or x.get("name") or "").strip()
                            for x in cr["candidates"] if isinstance(x, dict)]
                elif isinstance(cr.get("labels"), list):
                    labs = [str(x).strip() for x in cr["labels"] if str(x).strip()]
            dept_tokens = labs or []

        depts = _resolve_departments(session, dept_tokens)

        # resolve recipients: nếu trống → lấy dept_email của depts (nếu có)
        recips = [r for r in (item.recipients or []) if _is_email(r)]
        if not recips and depts:
            for d in depts:
                if (d.dept_email or "").strip():
                    recips.append(d.dept_email.strip())

        # Nếu vẫn không có recipient email → vẫn cho tạo row với 'email_recipient' = dept_name (fallback)
        if not recips:
            if depts:
                recips = [d.dept_name for d in depts if (d.dept_name or "").strip()]
            else:
                skipped += 1
                detail.append({"index": idx, "reason": "NO_RECIPIENTS"})
                continue

        # attachments chuẩn hoá → list tuple (abs_path, mime, filename)
        attach_tuples = _resolve_attachments_for_item(session, chat_id, item, pinned_main, pinned_atts)

        for rc in recips:
            # chống trùng
            if _exists_similar_email(session, chat_id, item.title, rc, when):
                skipped += 1
                detail.append({"index": idx, "recipient": rc, "reason": "DUPLICATE"})
                continue

            row = ScheduledEmail(  # type: ignore[call-arg]
                email_id=str(uuid.uuid4()),
                email_chat_id=chat_id,
                email_title=item.title,
                email_recipient=rc,
                email_body=item.body or None,
                email_send_time=when,
                email_status="scheduled",
            )
            session.add(row)
            session.flush()

            # attachments
            for (abs_path, mime, filename) in attach_tuples:
                try:
                    rel = _relpath(abs_path)
                    att = ScheduledEmailAttachment(  # type: ignore[call-arg]
                        att_id=str(uuid.uuid4()),
                        att_email_id=row.email_id,
                        att_file_path=rel,
                        att_description=None,
                    )
                    session.add(att)
                except Exception as e:
                    log.warning("Cannot attach %s: %s", abs_path, e)

            # N-N với departments
            for d in depts:
                try:
                    link = NhanMail(  # type: ignore[call-arg]
                        nm_email_id=row.email_id,
                        nm_dept_id=d.dept_id,
                    )
                    session.add(link)
                except IntegrityError:
                    session.rollback()
                except Exception:
                    session.rollback()

            rows.append(row)
            created += 1

    try:
        session.commit()
    except Exception as e:
        session.rollback()
        raise

    return CreatePlanResult(created=created, skipped=skipped, rows=rows, detail=detail)


# ──────────────────────────────────────────────────────────────────────────────
# Liệt kê lịch gửi mail (cho user / chat) → “nạp liên tục”
# ──────────────────────────────────────────────────────────────────────────────

def list_scheduled_emails_for_chat(session, chat_id: str) -> List[Dict[str, Any]]:
    """
    Trả về toàn bộ ScheduledEmail của 1 chat (không giới hạn),
    có kèm attachments & departments.
    """
    try:
        q = select(ScheduledEmail).where(
            ScheduledEmail.email_chat_id == chat_id
        ).order_by(ScheduledEmail.email_send_time.desc(), ScheduledEmail.email_created_at.desc())
        rows = session.execute(q).scalars().all()
    except Exception:
        rows = []

    out: List[Dict[str, Any]] = []
    for r in rows:
        # attachments
        atts: List[Dict[str, Any]] = []
        try:
            for a in (r.attachments or []):
                atts.append({
                    "att_id": a.att_id,
                    "relpath": a.att_file_path,
                    "name": os.path.basename(a.att_file_path or ""),
                    "description": a.att_description,
                })
        except Exception:
            pass

        # departments (qua convenience relationship viewonly hoặc links)
        depts: List[Dict[str, Any]] = []
        try:
            if r.departments:
                for d in r.departments:
                    depts.append({
                        "dept_id": d.dept_id,
                        "name": d.dept_name,
                        "alias": d.dept_alias,
                        "email": d.dept_email,
                    })
        except Exception:
            pass

        out.append({
            "email_id": r.email_id,
            "title": r.email_title,
            "recipient": r.email_recipient,
            "body": r.email_body,
            "send_time": r.email_send_time.isoformat(sep=" "),
            "status": r.email_status,
            "attachments": atts,
            "departments": depts,
            "created_at": getattr(r, "email_created_at", None).isoformat() if getattr(r, "email_created_at", None) else None,
            "updated_at": getattr(r, "email_updated_at", None).isoformat() if getattr(r, "email_updated_at", None) else None,
        })
    return out


def list_scheduled_emails_for_user(session, user_id: str) -> List[Dict[str, Any]]:
    """
    Liệt kê toàn bộ ScheduledEmail thuộc các chat của user (không giới hạn).
    """
    try:
        chats = session.execute(
            select(ChatHistory.chat_id).where(ChatHistory.chat_user_id == user_id)
        ).scalars().all()
    except Exception:
        chats = []

    out: List[Dict[str, Any]] = []
    for cid in chats:
        out.extend(list_scheduled_emails_for_chat(session, cid))
    # sắp xếp toàn cục theo send_time desc
    out.sort(key=lambda x: x.get("send_time", ""), reverse=True)
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Gom ngữ cảnh cho PROMPT của tool "Cập nhật email"
# ──────────────────────────────────────────────────────────────────────────────

def _recent_transcript(session, chat_id: str, limit_chars: int = 20000, max_msgs: int = 40) -> str:
    """
    Tiện ích gom transcript (User/Assistant) cho prompt. Chỉ dùng khi cần fallback.
    (Nếu đã có modules.chat.service.prompt_compose thì gọi bên đó)
    """
    try:
        q = select(ChatMessage).where(ChatMessage.message_chat_id == chat_id)
        if hasattr(ChatMessage, "message_created_at"):
            q = q.order_by(ChatMessage.message_created_at.asc())
        rs = session.execute(q).scalars().all()
    except Exception:
        rs = []

    pairs: List[str] = []
    for r in rs:
        u = (r.message_question or "").strip()
        a = (r.message_ai_response or "").strip()
        if not u or not a or a in ("(queued)", "(canceled)"):
            continue
        pairs.append(f"User: {u}\nAssistant: {a}")
    if max_msgs > 0 and len(pairs) > max_msgs:
        pairs = pairs[-max_msgs:]
    text = "\n\n".join(pairs)
    if limit_chars > 0 and len(text) > limit_chars:
        text = text[-limit_chars:]
        cut = text.find("\n")
        if cut > 200:
            text = text[cut+1:]
    return text


def collect_email_update_context(
    session,
    *,
    chat_id: str,
    user_id: str,
    global_memory_text: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Thu thập đủ các "khối dữ liệu" để truyền vào prompt composer:
      + Cũ: Câu hỏi gần nhất của người dùng
      + Cũ: Nội dung file văn bản gần nhất (excerpt)
      + Mới: Kết quả của tools phân loại văn bản gần nhất
      + Mới: Thông tin file (đường dẫn, tên): Văn bản cần chuyển, văn bản đính kèm
      + Mới: List toàn bộ lịch gửi mail của user (không giới hạn)
      + Cũ: Trí nhớ Global
      + Cũ: Ngữ cảnh cuộc trò chuyện trước đó
    """
    pinned = load_latest_email_update_state(session, chat_id)

    # last user question: lấy message cuối có question != "" (ưu tiên record trong pinned)
    last_q = (pinned.get("last_question") or "").strip()
    if not last_q:
        try:
            q = select(ChatMessage).where(ChatMessage.message_chat_id == chat_id)
            if hasattr(ChatMessage, "message_created_at"):
                q = q.order_by(ChatMessage.message_created_at.desc())
            r = session.execute(q).scalars().first()
            if r:
                last_q = (r.message_question or "").strip()
        except Exception:
            last_q = ""

    # last doc text excerpt (đã được upstream chuẩn bị)
    last_doc_excerpt = (pinned.get("last_doc_excerpt") or "").strip()

    # files info
    main_files = pinned.get("main_files") or []
    attachments = pinned.get("attachments") or []

    # classify result (raw JSON)
    classify_result = pinned.get("classify_result") or {}

    # list scheduled emails (toàn bộ user)
    all_emails = list_scheduled_emails_for_user(session, user_id)

    # global memory text (nếu module memory đã cung cấp thì caller truyền vào)
    glb_text = (global_memory_text or "").strip()

    # recent transcript
    recent = _recent_transcript(session, chat_id, limit_chars=25000, max_msgs=50)

    return {
        "last_user_question": last_q,
        "last_doc_excerpt": last_doc_excerpt,
        "classify_result_latest": classify_result,
        "files": {
            "main": main_files,
            "attachments": attachments,
        },
        "scheduled_emails_all": all_emails,
        "global_memory_text": glb_text,
        "recent_transcript": recent,
        "pinned_meta": {
            "pinned_at": pinned.get("pinned_at"),
            "version": pinned.get("version"),
        },
    }


# ──────────────────────────────────────────────────────────────────────────────
# PROMPT schema ví dụ cho model (để bạn tái dùng trong prompt_compose.py)
# ──────────────────────────────────────────────────────────────────────────────

def format_email_plan_schema_example() -> str:
    """
    Trả chuỗi hướng dẫn cho model về schema JSON cần in ra.
    Bạn có thể nhúng block này vào prompt (phần "OUTPUT FORMAT").
    """
    example = {
        "items": [
            {
                "title": "Nhắc việc: bổ sung hồ sơ tuyển dụng",
                "send_time": "2025-09-05 08:30",
                "recipients": ["phongnoivu@tvu.edu.vn"],
                "departments": ["Phòng Nội vụ"],
                "body": "Kính gửi..., nội dung cập nhật ...",
                "attachments": [
                    {"relpath": "chat/<chat_id>/<msg_id>/quyet_dinh.pdf"},
                    {"name": "mau_bieu_m01.docx"}
                ]
            }
        ],
        "meta": {
            "note": "Không giải thích ngoài JSON. Thời gian là dạng local naive."
        }
    }
    lines = json.dumps(example, ensure_ascii=False, indent=2)
    return (
        "Hãy chỉ xuất JSON theo schema sau (KHÔNG giải thích thêm):\n"
        "```json\n" + lines + "\n```\n"
        "- Lưu ý: Nếu nhiều người nhận, tạo nhiều phần tử (recipients) hoặc để danh sách; hệ thống sẽ tự tách."
    )


def format_prompt_fallback(context: Dict[str, Any]) -> str:
    """
    Fallback mini-composer: khi chưa cập nhật modules.chat.service.prompt_compose,
    có thể dùng tạm để gọi model.
    """
    last_q = context.get("last_user_question") or ""
    last_doc = context.get("last_doc_excerpt") or ""
    classify = context.get("classify_result_latest") or {}
    files = context.get("files") or {}
    glb = context.get("global_memory_text") or ""
    recent = context.get("recent_transcript") or ""
    emails = context.get("scheduled_emails_all") or []

    parts = [
        "NHIỆM VỤ: Lên kế hoạch 'Cập nhật email' theo yêu cầu gần nhất và dữ liệu đi kèm.",
        "Chỉ trả về JSON đúng schema. Không giải thích ngoài JSON.",
        "",
        f"[CÂU HỎI GẦN NHẤT]\n{last_q or '(trống)'}",
        f"[TRÍCH TỆP GẦN NHẤT]\n{last_doc or '(trống)'}",
        f"[KẾT QUẢ PHÂN LOẠI GẦN NHẤT]\n{json.dumps(classify, ensure_ascii=False)}",
        f"[TỆP ĐÃ PIN]\n{json.dumps(files, ensure_ascii=False)}",
        f"[LỊCH GỬI MAIL ĐÃ LÊN CỦA BẠN]\n{json.dumps(emails, ensure_ascii=False)}",
        f"[GHI NHỚ GLOBAL]\n{glb or '(trống)'}",
        f"[NGỮ CẢNH TRAO ĐỔI]\n{recent or '(trống)'}",
        "",
        "[OUTPUT FORMAT]",
        format_email_plan_schema_example()
    ]
    return "\n".join(parts).strip()


# ──────────────────────────────────────────────────────────────────────────────
# Convenience entrypoint: từ output model → ghi DB & trả tóm tắt
# ──────────────────────────────────────────────────────────────────────────────

def apply_model_output_and_schedule(
    session,
    *,
    chat_id: str,
    user_id: str,
    model_output_text: str,
) -> Dict[str, Any]:
    """
    Dùng khi bạn đã có output từ model cho tool "Cập nhật email":
      1) Parse & normalize kế hoạch
      2) Ghi vào DB (ScheduledEmail + attachments + nhan_mail)
      3) Trả kết quả tóm tắt để FE hiển thị
    """
    plan = parse_model_email_plan(model_output_text)
    pinned = load_latest_email_update_state(session, chat_id)
    res = create_scheduled_emails_from_plan(session, chat_id=chat_id, plan=plan, pinned_state=pinned)

    return {
        "ok": True,
        "created": res.created,
        "skipped": res.skipped,
        "detail": res.detail,
        "scheduled": [
            {
                "email_id": r.email_id,
                "title": r.email_title,
                "recipient": r.email_recipient,
                "body": r.email_body,
                "send_time": r.email_send_time.isoformat(sep=" "),
                "status": r.email_status,
            }
            for r in res.rows
        ],
        "all_for_user": list_scheduled_emails_for_user(session, user_id),
    }

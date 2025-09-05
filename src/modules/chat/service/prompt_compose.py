# file: src/modules/chat/service/prompt_compose.py
# updated: 2025-09-03 (v1.3.0)
# changes (v1.3.0):
#   - SIMPLE MODE cho “Phân loại phòng ban”: thêm compose_user_prompt_for_department_classify_natural()
#     (1 bước tự nhiên, không ép JSON/2-dòng, không B-nhỏ/B-lớn).
#   - Gỡ toàn bộ helpers cũ của pipeline 2-bước: compose_user_prompt_for_classify(),
#     compose_main_answer_with_tool_json().
#   - Giữ build_tool_block_for_classify() (RAG) và các helper chung khác.
#   - Dedup transcript: chỉ xóa block thực sự xuất hiện trong doc_text (an toàn).
#   - Respect tham số top_k trong build_tool_block_for_classify.
#
# updated: 2025-09-03 (v1.2.x)
# purpose:
#   - Gom helpers compose prompt cho luồng thường và tool “Cập nhật email”.

from __future__ import annotations

import os
import re
import json
from typing import Any, Optional, List, Dict
from sqlalchemy import select

try:
    from core.db.models import Document
except Exception:
    # Cho phép import module ngay cả khi môi trường dev thiếu models
    Document = None  # type: ignore

# Tích hợp email_scheduler (nếu module khả dụng)
try:
    from modules.chat.service import email_scheduler as es
except Exception:
    es = None  # type: ignore

UPLOAD_ROOT = os.path.abspath(os.getenv("UPLOAD_ROOT", os.path.join("uploads")))
DEFAULT_RAG_TOP_K = int(os.getenv("RAG_TOP_K", "6") or "6")

__all__ = [
    # Helpers chung
    "strip_appendix",
    "latest_doc_text",
    "dedup_recent_pairs_against_doc",
    "build_tool_block_for_classify",
    "compose_user_prompt",
    # SIMPLE tool “Phân loại phòng ban”
    "compose_user_prompt_for_department_classify_natural",
    # Hỗ trợ tool “Cập nhật email”
    "latest_pinned_attachment_text",
    "compose_email_update_user_prompt_from_db",
    "compose_email_update_user_prompt",
]

# ──────────────────────────────────────────────────────────────────────────────
# I. Helpers (chuẩn hoá / lọc trùng)
# ──────────────────────────────────────────────────────────────────────────────

def _read_text_file(abs_path: str) -> str:
    try:
        with open(abs_path, "r", encoding="utf-8") as f:
            return (f.read() or "").strip()
    except Exception:
        return ""


def strip_appendix(q: str) -> str:
    """
    Bỏ phần appendix OCR/TextExtract đã auto-chèn vào message_question.
    Giữ lại câu hỏi thô để tránh lặp ngữ cảnh.
    """
    if not q:
        return q
    marker = "\n\n---\n(Trích nội dung từ tệp đính kèm"
    i = q.find(marker)
    return q if i < 0 else q[:i].rstrip()


def _normalize_line(s: str) -> str:
    s = (s or "").strip()
    # Rút gọn khoảng trắng + bỏ bullet/marker phổ biến để tăng xác suất khớp trùng
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"^\s*(?:[-*•–—]+|\d+[\.)-])\s*", "", s)
    return s.strip()


def _tokenize_for_match(s: str) -> list[str]:
    # Tách thành đoạn theo dòng trống / đoạn tương đối dài
    blocks: list[str] = []
    buf: list[str] = []
    for ln in (s or "").splitlines():
        t = _normalize_line(ln)
        if not t:
            if buf:
                blk = " ".join(buf).strip()
                if blk:
                    blocks.append(blk)
                buf = []
            continue
        buf.append(t)
    if buf:
        blk = " ".join(buf).strip()
        if blk:
            blocks.append(blk)
    # Ưu tiên đoạn đủ dài để tránh xoá quá tay
    return [b for b in blocks if len(b) >= 60]


def dedup_recent_pairs_against_doc(recent_pairs: str, doc_text: str) -> str:
    """
    Loại bỏ các đoạn trong transcript gần đây nếu chúng đã nằm *nguyên văn* trong doc_text.
    Chính sách đơn giản, an toàn:
      - cắt transcript thành các đoạn tương đối dài (>= 60 ký tự)
      - chỉ xoá đoạn nếu đoạn đó XUẤT HIỆN trong doc_text
      - giữ nguyên các câu/đoạn ngắn (câu hỏi chỉ dẫn, meta), tránh “xoá quá tay”
    """
    rp = (recent_pairs or "").strip()
    body = (doc_text or "").strip()
    if not rp or not body:
        return rp

    blocks = _tokenize_for_match(rp)
    if not blocks:
        return rp

    # Chỉ giữ những block thực sự xuất hiện trong doc_text để xoá
    removable = [b for b in blocks if b and b in body]
    if not removable:
        return rp

    # Regex OR các block cần xoá — escape literal.
    pattern = "|".join(re.escape(b) for b in sorted(removable, key=len, reverse=True))
    try:
        pruned = re.sub(pattern, "", rp)
        # Gom lại khoảng trắng cho đẹp
        pruned = re.sub(r"[ \t]+", " ", pruned)
        pruned = re.sub(r"\n{3,}", "\n\n", pruned).strip()
        return pruned if pruned else "(trống)"
    except re.error:
        # Fallback an toàn: duyệt từng block
        out = rp
        for b in sorted(removable, key=len, reverse=True):
            out = out.replace(b, "")
        out = re.sub(r"[ \t]+", " ", out)
        out = re.sub(r"\n{3,}", "\n\n", out).strip()
        return out if out else "(trống)"

# ──────────────────────────────────────────────────────────────────────────────
# II. Lấy FULL TEXT của document gần nhất trong chat
# ──────────────────────────────────────────────────────────────────────────────

def _latest_document_row(session: Any, chat_id: str) -> Optional[Any]:
    if not chat_id or Document is None:
        return None
    try:
        q = select(Document).where(Document.doc_chat_id == chat_id)
        # Ưu tiên các cột thời gian nếu có
        for col in ("doc_created_at", "created_at", "updated_at"):
            if hasattr(Document, col):
                q = q.order_by(getattr(Document, col).desc())
                break
        else:
            q = q.order_by(Document.doc_id.desc())
        return session.execute(q.limit(1)).scalar_one_or_none()
    except Exception:
        return None


def latest_doc_text(session: Any, chat_id: str, *, include_header: bool = True) -> str:
    """
    Lấy *toàn bộ* text từ doc_ocr_text_path của Document gần nhất trong chat (nếu có).
    KHÔNG cắt. Trả về chuỗi:
        "[<file_name.txt>]\n<full text>"
    hoặc chuỗi rỗng nếu không có dữ liệu.
    """
    row = _latest_document_row(session, chat_id)
    if not row:
        return ""
    rel_txt = (getattr(row, "doc_ocr_text_path", "") or "").strip()
    if not rel_txt:
        return ""
    abs_txt = os.path.join(UPLOAD_ROOT, rel_txt)
    body = _read_text_file(abs_txt)
    if not body:
        return ""
    if not include_header:
        return body
    label = os.path.basename(rel_txt)
    return f"[{label}]\n{body}"

# ──────────────────────────────────────────────────────────────────────────────
# III. Hỗ trợ RAG “Phân loại văn bản” (tùy chọn)
# ──────────────────────────────────────────────────────────────────────────────

def build_tool_block_for_classify(doc_raw_text: str, *, top_k: Optional[int] = None) -> str:
    """
    Xây khối “2.1. DỮ LIỆU TOOLS PHÂN LOẠI VĂN BẢN” từ RAG nếu khả dụng.
    - Nếu module doc_classify_rag không sẵn, trả về chuỗi rỗng.
    - Nếu dataset trống, trả về thông điệp hướng dẫn kiểm tra dataset (từ module).
    - Trả về *đầy đủ block* đã có tiêu đề; caller có thể chèn thẳng vào [NGỮ CẢNH].
    """
    enable_env = os.getenv("ENABLE_DOC_CLASSIFY_RAG", "").strip()
    # Nếu ENV cấm (="0") thì tắt cứng, kể cả caller bật.
    if enable_env == "0":
        return ""

    try:
        from modules.chat.service import doc_classify_rag as rag  # lazy import
    except Exception:
        return ""

    # Ưu tiên tham số truyền vào; nếu None mới fallback ENV; sau cùng DEFAULT
    k = top_k if top_k is not None else int(os.getenv("RAG_TOP_K", str(DEFAULT_RAG_TOP_K)) or str(DEFAULT_RAG_TOP_K))
    try:
        return rag.build_training_block(doc_raw_text or "", k=int(k))
    except Exception:
        # An toàn: không để crash quy trình compose; chỉ bỏ qua khối này
        return ""

# ──────────────────────────────────────────────────────────────────────────────
# IV. Compose USER prompt — luồng thường (không tool)
# ──────────────────────────────────────────────────────────────────────────────

def compose_user_prompt(
    *,
    q_raw: str,
    glb_text: str,
    recent_pairs: str,
    last_doc_text: str = "",
    memory_soft_ack: bool = False,
    extra_instructions: Optional[str] = None,
    # “classification_mode” giữ để tương thích ngược; mặc định KHÔNG dùng.
    classification_mode: bool = False,
    classification_top_k: Optional[int] = None,
) -> str:
    """
    Hợp nhất “Câu hỏi hiện tại” + “Ngữ cảnh” vào 1 USER prompt (không ép định dạng).
    Nội dung:
      - Câu hỏi hiện tại
      - Dữ liệu text thô của file văn bản gần nhất (nếu có)
      - Dữ liệu bộ nhớ Global
      - Đoạn chat gần đây
    """
    q_clean = strip_appendix(q_raw or "")

    ctx_chunks: list[str] = []
    if last_doc_text:
        ctx_chunks.append("• Trích tệp gần đây nhất (raw, full):\n" + last_doc_text)

    ctx_chunks.append("• Ghi nhớ cá nhân (global):\n" + (glb_text.strip() if (glb_text or "").strip() else "(trống)"))

    if recent_pairs:
        rp = recent_pairs
        if last_doc_text:
            rp = dedup_recent_pairs_against_doc(recent_pairs, last_doc_text)
        ctx_chunks.append("• Một số lượt trao đổi gần đây (đã lọc trùng với tệp):\n" + (rp or "(trống)"))
    else:
        ctx_chunks.append("• Một số lượt trao đổi gần đây (đã lọc trùng với tệp):\n(trống)")

    # KHÔNG tự động chèn block RAG trong luồng thường
    guidance: list[str] = [
        "[HƯỚNG DẪN PHẢN HỒI]",
        "- Trả lời tự nhiên, đi thẳng vào trọng tâm câu hỏi.",
        "- Chỉ trích dẫn nội dung tệp khi thực sự cần thiết; tránh lặp lại dài dòng phần đã nạp ở trên.",
        "- Nếu còn thiếu dữ kiện quan trọng, hãy hỏi lại ngắn gọn, rõ ràng.",
        "- Khi trình bày danh sách/quy trình, ưu tiên gạch đầu dòng ngắn, mạch lạc.",
        "- Khi có mã hoặc cấu hình, đặt trong code block với ngôn ngữ phù hợp.",
    ]
    if memory_soft_ack:
        guidance.append(
            "- Người dùng vừa yêu cầu bạn ghi nhớ một thông tin. Hãy xác nhận ngắn gọn, tự nhiên rằng bạn đã ghi nhận; "
            "KHÔNG mô tả cơ chế hay quy trình nội bộ."
        )
    if (extra_instructions or "").strip():
        guidance.append("- Hướng dẫn bổ sung:\n" + extra_instructions.strip())

    parts: list[str] = []
    parts.append("Câu hỏi hiện tại:\n" + (q_clean or "Hi"))
    parts.append("[NGỮ CẢNH]\n" + "\n\n".join(ctx_chunks))
    parts.append("\n".join(guidance))

    return "\n\n".join(parts).strip()

# ──────────────────────────────────────────────────────────────────────────────
# V. SIMPLE tool “Phân loại phòng ban” — 1 bước tự nhiên (không ép định dạng)
# ──────────────────────────────────────────────────────────────────────────────

def _format_allowed_labels(labels: List[str]) -> str:
    if not labels:
        return "(chưa có — nếu vậy hãy chọn theo hiểu biết từ mục A)"
    return "\n".join(f"- {s}" for s in labels if (s or "").strip())


def compose_user_prompt_for_department_classify_natural(
    *,
    q_raw: str,
    last_doc_text_full: str,
    rag_training_block: str,
    allowed_labels: List[str],
    global_memory_text: str,
    recent_transcript: str,
) -> str:
    """
    Compose prompt theo spec SIMPLE:
      - Không JSON, không ép 2 dòng, không “B-nhỏ/B-lớn”.
      - Nội dung:
        + Intro: người dùng vừa chọn tool “Phân loại phòng ban”.
        + Câu hỏi người dùng.
        + Văn bản cần phân loại (FULL TEXT tệp gần nhất).
        + RAG:
            A. Dữ liệu cần học (ví dụ, ngữ cảnh)
            B. Phạm vi tối đa có thể liệt kê tên phòng ban (không vượt quá danh sách này).
        + Ghi nhớ Global + đoạn chat gần đây.
      - Yêu cầu trả lời: chỉ LIỆT KÊ tên phòng/ban phù hợp; không bảng/JSON/giải thích; không hỏi lại.
    """
    q = strip_appendix(q_raw or "")
    doc_block = (last_doc_text_full or "").strip()
    rag_block = (rag_training_block or "").strip()
    B_block = _format_allowed_labels(allowed_labels or [])

    parts: List[str] = []
    parts.append(
        "Người dùng vừa chọn tools \"Phân loại phòng ban\", thì ở tin nhắn lần này, bạn hãy hỗ trợ giúp người dùng "
        "phân loại văn bản gần nhất chuyển cho PHÒNG/BAN nào nhé? Dựa trên các hướng dẫn sau!"
    )
    parts.append(f"Câu hỏi người dùng:\n{q or '(trống)'}")

    ctx_blocks: List[str] = []

    if doc_block:
        ctx_blocks.append("• DỮ LIỆU VĂN BẢN GẦN NHẤT CẦN PHÂN LOẠI (raw, full):\n" + doc_block)
    else:
        ctx_blocks.append("• DỮ LIỆU VĂN BẢN GẦN NHẤT CẦN PHÂN LOẠI: (không tìm thấy)")

    rag_lines: List[str] = []
    rag_lines.append("• DỮ LIỆU RAG ĐỀ XUẤT CÁC PHÒNG BAN LIÊN QUAN — bạn chỉ cần đọc và lựa chọn theo là xong:")
    rag_lines.append("- A. Là các dữ liệu cần học:\n" + (rag_block or "(không có)"))
    rag_lines.append("- B. Là phạm vi tối đa mà bạn có thể liệt kê tên các phòng ban, không vượt quá các list này:\n" + B_block)
    rag_lines.append("=> Bạn phải đọc và SO SÁNH thật sự!")
    ctx_blocks.append("\n".join(rag_lines))

    ctx_blocks.append("• DỮ LIỆU BỘ NHỚ GLOBAL:\n" + (global_memory_text.strip() or "(trống)"))
    ctx_blocks.append("• DỮ LIỆU ĐOẠN CHAT TRƯỚC ĐÓ TRONG HỘI THOẠI HIỆN TẠI:\n" + (recent_transcript.strip() or "(trống)"))

    parts.append("[NGỮ CẢNH]\n" + "\n\n".join(ctx_blocks))

    guide: List[str] = []
    guide.append("[YÊU CẦU TRẢ LỜI]")
    guide.append("- Kết quả sau cùng: CHỈ cần trả lời tên các phòng ban phù hợp chuyển cho văn bản trên.")
    guide.append("- KHÔNG cần trình bày bảng, KHÔNG cần giải thích, và KHÔNG hỏi lại người dùng.")
    guide.append("- Không ép kiểu trả lời theo bất kỳ định dạng nào (KHÔNG JSON). Viết tự nhiên.")
    guide.append("- Nếu danh sách (B) đã có, KHÔNG nêu tên ngoài (B). Nếu (B) trống, lựa chọn theo hiểu biết từ (A).")

    parts.append("\n".join(guide))
    return "\n\n".join(parts).strip()

# ──────────────────────────────────────────────────────────────────────────────
# VI. Hỗ trợ tool “Cập nhật email”
# ──────────────────────────────────────────────────────────────────────────────

def _pick_latest_document_from_pinned(session: Any, chat_id: str, pinned_list: List[Dict[str, Any]]) -> Optional[Any]:
    """
    Nhận list dict (từ cf_metadata: main_files/attachments), tìm Document mới nhất theo doc_id hoặc thời gian.
    """
    if not pinned_list or Document is None:
        return None
    doc_ids = [d.get("doc_id") for d in pinned_list if d.get("doc_id")]
    if not doc_ids:
        return None
    try:
        q = select(Document).where(Document.doc_chat_id == chat_id, Document.doc_id.in_(doc_ids))
        # Thử ưu tiên theo cột thời gian nếu có
        for col in ("doc_created_at", "created_at", "updated_at"):
            if hasattr(Document, col):
                q = q.order_by(getattr(Document, col).desc())
                break
        else:
            q = q.order_by(Document.doc_id.desc())
        return session.execute(q.limit(1)).scalar_one_or_none()
    except Exception:
        return None


def latest_pinned_attachment_text(session: Any, chat_id: str, *, include_header: bool = True, prefer_main_when_empty: bool = True) -> str:
    """
    Lấy FULL TEXT của *văn bản đính kèm gần nhất* dựa vào trạng thái đã pin của tool “Cập nhật email”.
    - Nếu không có 'attachments' → (tuỳ chọn) fallback sang 'main_files'.
    - Trả về chuỗi "[<file_name.txt>]\\n<full text>" hoặc rỗng nếu không có dữ liệu.
    """
    if es is None:
        return ""

    try:
        pinned = es.load_latest_email_update_state(session, chat_id)
    except Exception:
        pinned = {}

    candidates = (pinned.get("attachments") or []) if isinstance(pinned, dict) else []
    if (not candidates) and prefer_main_when_empty:
        if isinstance(pinned, dict):
            candidates = pinned.get("main_files") or []

    row = _pick_latest_document_from_pinned(session, chat_id, candidates)
    if not row:
        return ""

    rel_txt = (getattr(row, "doc_ocr_text_path", "") or "").strip()
    if not rel_txt:
        return ""
    abs_txt = os.path.join(UPLOAD_ROOT, rel_txt)
    body = _read_text_file(abs_txt)
    if not body:
        return ""
    if not include_header:
        return body
    label = os.path.basename(rel_txt)
    return f"[{label}]\n{body}"


def _fmt_file_list(items: List[Dict[str, Any]]) -> str:
    """
    Hiển thị gọn danh sách file pin: name + relpath (nếu có).
    """
    if not items:
        return "(trống)"
    lines = []
    for it in items:
        nm = (it.get("name") or os.path.basename(it.get("relpath") or "") or "").strip()
        rp = (it.get("relpath") or "").strip()
        if rp and nm and (nm not in rp):
            lines.append(f"- {nm}  ({rp})")
        elif nm:
            lines.append(f"- {nm}")
        elif rp:
            lines.append(f"- {rp}")
    return "\n".join(lines) if lines else "(trống)"


def compose_email_update_user_prompt(
    ctx: Dict[str, Any],
    *,
    attachment_full_text: str = "",
    extra_instructions: Optional[str] = None,
) -> str:
    """
    Build USER prompt cho tool “Cập nhật email” từ context đã gom sẵn (es.collect_email_update_context).
    - attachment_full_text: chuỗi FULL TEXT của văn bản đính kèm gần nhất (không cắt).
    """
    if es is None:
        # fallback: vẫn compose được nhưng không có schema từ es
        schema_block = (
            "Hãy chỉ xuất JSON theo schema tối thiểu:\n"
            "```json\n"
            "{ \"items\": [ { \"title\": \"...\", \"send_time\": \"YYYY-MM-DD HH:MM\", \"recipients\": [\"...\"], \"departments\": [\"...\"], \"body\": \"...\", \"attachments\": [ { \"relpath\": \"...\" } ] } ] }\n"
            "```\n"
        )
    else:
        try:
            schema_block = es.format_email_plan_schema_example()
        except Exception:
            schema_block = (
                "Hãy chỉ xuất JSON theo schema tối thiểu:\n"
                "```json\n"
                "{ \"items\": [ { \"title\": \"...\", \"send_time\": \"YYYY-MM-DD HH:MM\", \"recipients\": [\"...\"], \"departments\": [\"...\"], \"body\": \"...\", \"attachments\": [ { \"relpath\": \"...\" } ] } ] }\n"
                "```\n"
            )

    last_q = (ctx.get("last_user_question") or "").strip()
    last_doc_excerpt = (ctx.get("last_doc_excerpt") or "").strip()
    files = ctx.get("files") or {}
    main_files = files.get("main") or []
    att_files = files.get("attachments") or []
    classify_result = ctx.get("classify_result_latest") or {}
    scheduled = ctx.get("scheduled_emails_all") or []
    glb = (ctx.get("global_memory_text") or "").strip()
    recent = (ctx.get("recent_transcript") or "").strip()

    # Lọc trùng của transcript so với full-text đính kèm (nếu có)
    if attachment_full_text:
        recent = dedup_recent_pairs_against_doc(recent, attachment_full_text)

    # Rút gọn lịch đã lên cho gọn prompt
    sched_slim = []
    for i, it in enumerate(scheduled):
        if i >= 50:
            break
        try:
            sched_slim.append({
                "title": it.get("title"),
                "recipient": it.get("recipient"),
                "send_time": it.get("send_time"),
                "status": it.get("status"),
            })
        except Exception:
            continue

    parts: List[str] = []

    parts.append("NHIỆM VỤ: Dựa trên dữ kiện sau, hãy LÊN KẾ HOẠCH 'Cập nhật email' chuẩn, tránh trùng với các lịch đã có.")
    parts.append(f"[CÂU HỎI GẦN NHẤT]\n{last_q or '(trống)'}")

    # Khối dữ liệu ngữ cảnh
    ctx_blocks: List[str] = []
    # 1) File đã pin (tên + relpath)
    ctx_blocks.append("• TỆP ĐÃ PIN — Văn bản cần chuyển:\n" + _fmt_file_list(main_files))
    ctx_blocks.append("• TỆP ĐÃ PIN — Văn bản đính kèm:\n" + _fmt_file_list(att_files))
    # 2) FULL TEXT văn bản đính kèm gần nhất
    if attachment_full_text:
        ctx_blocks.append("• FULL TEXT — Văn bản đính kèm gần nhất (raw, full):\n" + attachment_full_text)
    # 3) Trích tệp gần nhất (excerpt) — nếu có
    if last_doc_excerpt:
        ctx_blocks.append("• TRÍCH ĐOẠN TỆP GẦN NHẤT (excerpt):\n" + last_doc_excerpt)
    # 4) Kết quả phân loại (JSON)
    try:
        ctx_blocks.append("• KẾT QUẢ PHÂN LOẠI GẦN NHẤT (JSON):\n" + json.dumps(classify_result, ensure_ascii=False, indent=2))
    except Exception:
        ctx_blocks.append("• KẾT QUẢ PHÂN LOẠI GẦN NHẤT (JSON):\n{}")
    # 5) Lịch đã lên của user (gọn)
    try:
        ctx_blocks.append("• LỊCH GỬI MAIL ĐÃ LÊN (gần nhất → xa):\n" + json.dumps(sched_slim, ensure_ascii=False, indent=2))
    except Exception:
        ctx_blocks.append("• LỊCH GỬI MAIL ĐÃ LÊN (gần nhất → xa):\n[]")
    # 6) Ghi nhớ + transcript
    ctx_blocks.append("• GHI NHỚ CÁ NHÂN (global):\n" + (glb or "(trống)"))
    ctx_blocks.append("• MỘT SỐ LƯỢT TRAO ĐỔI GẦN ĐÂY (đã lọc trùng với file):\n" + (recent or "(trống)"))

    parts.append("[DỮ LIỆU NGỮ CẢNH]\n" + "\n\n".join(ctx_blocks))

    # Yêu cầu output
    guidance: List[str] = [
        "[YÊU CẦU OUTPUT]",
        "- CHỈ in ra JSON hợp lệ theo schema dưới đây, KHÔNG giải thích thêm.",
        "- 'send_time' dùng định dạng 'YYYY-MM-DD HH:MM' (naive).",
        "- Nếu có nhiều người nhận, đưa vào 'recipients' (mình sẽ tự tách).",
        "- Nếu có tệp đính kèm, ưu tiên điền 'relpath' trong trường 'attachments'.",
    ]
    if (extra_instructions or "").strip():
        guidance.append("- Hướng dẫn bổ sung:\n" + extra_instructions.strip())

    parts.append("\n".join(guidance))
    parts.append(schema_block)

    return "\n\n".join(parts).strip()


def compose_email_update_user_prompt_from_db(
    session: Any,
    *,
    chat_id: str,
    user_id: str,
    global_memory_text: Optional[str] = None,
    extra_instructions: Optional[str] = None,
) -> str:
    """
    Entrypoint “all-in-one” cho tool “Cập nhật email”:
      - Tự gom context qua es.collect_email_update_context(...)
      - Đọc FULL TEXT của văn bản đính kèm gần nhất (không cắt)
      - Build USER prompt JSON-only theo schema của email_scheduler
    """
    if es is None:
        # vẫn compose được dù thiếu es, nhưng không có context phong phú
        ctx: Dict[str, Any] = {
            "last_user_question": "",
            "last_doc_excerpt": "",
            "files": {"main": [], "attachments": []},
            "classify_result_latest": {},
            "scheduled_emails_all": [],
            "global_memory_text": (global_memory_text or ""),
            "recent_transcript": "",
        }
    else:
        ctx = es.collect_email_update_context(
            session,
            chat_id=chat_id,
            user_id=user_id,
            global_memory_text=global_memory_text or "",
        )

    full_text = latest_pinned_attachment_text(session, chat_id, include_header=True, prefer_main_when_empty=True)
    return compose_email_update_user_prompt(ctx, attachment_full_text=full_text, extra_instructions=extra_instructions)

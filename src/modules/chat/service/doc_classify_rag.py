# file: src/modules/chat/service/doc_classify_rag.py
# updated: 2025-09-03 (v1.2.0)
# changes (v1.2.0):
#   - SIMPLE-MODE compatible: block output giữ nguyên cấu trúc dễ đọc A/B (A = ví dụ học; B do tầng trên union).
#   - CSV sniffer đơn giản, bền vững hơn: trả về (delimiter, stream) và dùng DictReader(..., delimiter=...).
#   - Giữ nguyên quy tắc tách nhãn VERBATIM: chỉ ';' / xuống dòng / bullet '•' (KHÔNG tách ',' hay '/').
#   - Header nêu rõ số mẫu hiển thị (có thể >k do mở rộng), kèm tiêu chí xếp hạng (weights).
#
# changes (v1.1.1):
#   - KHÔNG tách nhãn theo ',' hoặc '/'. Chỉ tách theo ';', xuống dòng và bullet (•).
#   - Sniffer delimiter ưu tiên dựa trên header: thử ',', '\t', '|', ';' và chọn delimiter cho ra đủ cột schema.
#
# changes (v1.1.0):
#   - API khớp nơi gọi: build_tool_block_for_classify() (alias build_training_block()).
#   - Hỗ trợ .csv/.tsv, auto-sniff delimiter, xử lý BOM.
#   - Header block ghi rõ số mẫu hiển thị thực tế (có thể > k do mở rộng).
#   - Tiện ích debug: reload_dataset(), get_dataset_stats().
#
# changes (v1.0.1):
#   - NHÃN MỤC TIÊU: tách đa nhãn VERBATIM (không làm sạch nội dung nhãn). Chỉ strip 2 đầu + khử trùng lặp theo chuỗi gốc.
#
# purpose:
#   - Xây khối "2.1. DỮ LIỆU TOOLS PHÂN LOẠI VĂN BẢN (Top-k ví dụ gần nhất)"
#   - Trích đa nhãn từ cột doc_action (multi-label) và hiển thị TẤT CẢ nhãn mục tiêu
#   - Xếp hạng theo trọng số: doc_content (10) > doc_title (7) > doc_issuer (2)
#   - Tự mở rộng số mẫu nếu các điểm kế tiếp vẫn cao (giữ chất lượng)
#
# env:
#   DOC_CLASSIFY_DATA=/path/a.csv[,/path/b.csv]
#   RAG_TOP_K=6
#   RAG_TOP_K_MAX=12
#   RAG_EXPAND_RATIO=0.92
#   RAG_MIN_SCORE_ABS=0.08
#   RAG_SNIPPET_CHARS=800
#
# dataset schema (CSV/TSV, header expected):
#   doc_type,doc_issuer,doc_title,doc_content,doc_action
#
# public API:
#   build_tool_block_for_classify(doc_raw_text: str, top_k: int = 6) -> str
#   build_training_block(doc_raw_text: str, k: int = 6) -> str
#   reload_dataset() -> None
#   get_dataset_stats() -> dict
#   union_allowed_labels(doc_raw_text: str, k: int = 6) -> List[str]
#   infer_labels_by_vote(doc_raw_text: str, top_k: int = 20, min_score: float = 0.20, allowed: Optional[List[str]] = None) -> List[dict]

from __future__ import annotations

import os
import csv
import io
import re
import unicodedata
from typing import List, Dict, Any, Optional, Tuple

# ───────────────── config ─────────────────
DEF_TOP_K        = int(os.getenv("RAG_TOP_K", "6") or "6")
TOP_K_MAX        = int(os.getenv("RAG_TOP_K_MAX", "12") or "12")
EXPAND_RATIO     = float(os.getenv("RAG_EXPAND_RATIO", "0.92") or "0.92")
MIN_SCORE_ABS    = float(os.getenv("RAG_MIN_SCORE_ABS", "0.08") or "0.08")
SNIPPET_CHARS    = int(os.getenv("RAG_SNIPPET_CHARS", "800") or "800")
DATA_PATHS_ENV   = os.getenv("DOC_CLASSIFY_DATA", "") or ""

WEIGHTS = {
    "doc_content": 10.0,
    "doc_title":   7.0,
    "doc_issuer":  2.0,
}

# ───────────────── utils ─────────────────
def _strip_html(s: str) -> str:
    s = re.sub(r"<br\s*/?>", "\n", s or "", flags=re.I)
    s = re.sub(r"</p\s*>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"[ \t]+", " ", s).strip()

def _norm(s: str) -> str:
    s = (s or "").strip()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
    s = re.sub(r"[_]+", " ", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    return s

def _tokens(s: str) -> List[str]:
    s = _norm(s)
    toks = [t for t in s.split() if len(t) >= 2]
    return toks

def _jaccard(a: List[str], b: List[str]) -> float:
    if not a or not b:
        return 0.0
    sa, sb = set(a), set(b)
    inter = len(sa & sb)
    if inter <= 0:
        return 0.0
    union = len(sa | sb)
    return inter / max(1, union)

def _overlap_ratio(a: List[str], b: List[str]) -> float:
    if not a or not b:
        return 0.0
    sa, sb = set(a), set(b)
    inter = len(sa & sb)
    denom = min(len(sa), len(sb))
    return inter / max(1, denom)

def _score_record(q: Dict[str, Any], r: Dict[str, Any]) -> float:
    s_total = 0.0
    for field, w in WEIGHTS.items():
        qtok = q.get(field + "_tok") or []
        rtok = r.get(field + "_tok") or []
        if not r.get(field):
            continue
        j = _jaccard(qtok, rtok)
        o = _overlap_ratio(qtok, rtok)
        s_total += w * (0.6 * j + 0.4 * o)
    return s_total

def _split_labels_verbatim(x: str) -> List[str]:
    """
    Multi-label, VERBATIM:
    - Chỉ tách theo ';', xuống dòng, bullet (•). KHÔNG tách theo ',' hay '/'.
    - Chỉ strip() 2 đầu; bỏ rỗng; giữ nguyên nội dung/ thứ tự; khử trùng lặp theo chuỗi gốc.
    """
    raw = (x or "").replace("\u2022", "•")
    parts = re.split(r"[;\n\r•]+", raw)  # chỉ những delimiter được phép
    out: List[str] = []
    seen = set()
    for p in parts:
        s = (p or "").strip()
        if not s:
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out

def _safe_snippet(s: str, limit: int) -> str:
    s = (_strip_html(s or "")).strip()
    if limit <= 0 or len(s) <= limit:
        return s
    cut = s[:limit]
    last = max(cut.rfind("\n"), cut.rfind(". "), cut.rfind("; "), cut.rfind(" "))
    if last >= 200:
        cut = cut[:last]
    return cut.strip() + " …"

# ───────────────── dataset ─────────────────
_DATA: List[Dict[str, Any]] = []
_READY: bool = False
_LOAD_ERR: Optional[str] = None
_LAST_SIG: Optional[str] = None

def _signature_of_paths(paths: List[str]) -> str:
    stats = []
    for p in paths:
        try:
            st = os.stat(p)
            stats.append(f"{p}:{int(st.st_mtime)}:{st.st_size}")
        except Exception:
            stats.append(f"{p}:na")
    return "|".join(stats)

def _sniff_reader(fh: io.TextIOBase) -> Tuple[str, io.StringIO]:
    """
    Ưu tiên dựa trên header: thử delimiter ứng viên và chọn cái cho ra đủ cột schema.
    Tránh Sniffer nhầm ';' là delimiter do doc_action chứa nhiều ';'.
    Trả về (delimiter, stream).
    """
    raw = fh.read()
    if raw and raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")

    header_line = ""
    for line in raw.splitlines():
        header_line = (line or "").strip()
        if header_line:
            break

    expected = {"doc_type", "doc_issuer", "doc_title", "doc_content", "doc_action"}
    candidates = [",", "\t", "|", ";"]  # ưu tiên CSV chuẩn trước

    def _try(delim: str) -> List[str]:
        try:
            row = next(csv.reader([header_line], delimiter=delim))
            return [c.strip().lower() for c in row]
        except Exception:
            return []

    chosen = None
    for d in candidates:
        cols = _try(d)
        if cols and expected.issubset(set(cols)):
            chosen = d
            break

    if not chosen:
        chosen = ","  # fallback an toàn

    return chosen, io.StringIO(raw)

def _load_one_path(path: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            delim, stream = _sniff_reader(f)
            reader = csv.DictReader(stream, delimiter=delim)
            for i, row in enumerate(reader):
                rec = {
                    "doc_type":    (row.get("doc_type")    or "").strip(),
                    "doc_issuer":  (row.get("doc_issuer")  or "").strip(),
                    "doc_title":   (row.get("doc_title")   or "").strip(),
                    "doc_content": (row.get("doc_content") or "").strip(),
                    "doc_action":  (row.get("doc_action")  or "").strip(),
                    "__src": f"{os.path.basename(path)}:{i+2}",
                }
                if not rec["doc_content"] or not rec["doc_action"]:
                    continue
                if len(rec["doc_content"]) < 120:
                    # quá ngắn thường là noise / metadata
                    continue
                rec["doc_content_tok"] = _tokens(rec["doc_content"])
                rec["doc_title_tok"]   = _tokens(rec["doc_title"])
                rec["doc_issuer_tok"]  = _tokens(rec["doc_issuer"])
                rec["labels"] = _split_labels_verbatim(rec["doc_action"])
                if not rec["labels"]:
                    continue
                rows.append(rec)
    except Exception as e:
        raise RuntimeError(f"Lỗi đọc {path}: {e}") from e
    return rows

def _load_dataset_if_needed() -> None:
    global _READY, _DATA, _LOAD_ERR, _LAST_SIG
    if _READY and _DATA:
        return
    _DATA = []
    _LOAD_ERR = None
    paths = [p.strip() for p in DATA_PATHS_ENV.split(",") if p.strip()]
    if not paths:
        _LOAD_ERR = "DOC_CLASSIFY_DATA chưa được cấu hình."
        _READY = True
        return
    _LAST_SIG = _signature_of_paths(paths)

    temp_rows: List[Dict[str, Any]] = []
    for path in paths:
        try:
            temp_rows.extend(_load_one_path(path))
        except Exception as e:
            _LOAD_ERR = f"{(_LOAD_ERR + ' | ') if _LOAD_ERR else ''}{e}"

    # khử trùng lặp gần theo nội dung
    deduped: List[Dict[str, Any]] = []
    seen_fp = set()
    for r in temp_rows:
        fp = (hash(tuple(r["doc_content_tok"][:400])), len(r["doc_content_tok"]))
        if fp in seen_fp:
            continue
        seen_fp.add(fp)
        deduped.append(r)

    _DATA = deduped
    _READY = True

def _ensure_latest_dataset() -> None:
    global _LAST_SIG, _READY
    paths = [p.strip() for p in DATA_PATHS_ENV.split(",") if p.strip()]
    sig = _signature_of_paths(paths) if paths else ""
    if sig and _LAST_SIG and sig != _LAST_SIG:
        _READY = False
        _load_dataset_if_needed()

def reload_dataset() -> None:
    """Force reload (dùng cho debug)."""
    global _READY, _DATA, _LOAD_ERR, _LAST_SIG
    _READY = False
    _DATA = []
    _LOAD_ERR = None
    _LAST_SIG = None
    _load_dataset_if_needed()

def get_dataset_stats() -> Dict[str, Any]:
    """Trả thống kê nhanh để debug."""
    _ensure_latest_dataset()
    _load_dataset_if_needed()
    return {
        "ok": bool(_DATA),
        "count": len(_DATA),
        "error": _LOAD_ERR,
        "paths": [p.strip() for p in DATA_PATHS_ENV.split(",") if p.strip()],
        "weights": WEIGHTS,
        "expand_ratio": EXPAND_RATIO,
        "min_score_abs": MIN_SCORE_ABS,
        "top_k_max": TOP_K_MAX,
    }

# ───────────────── rank + format block ─────────────────
def _rank_examples(query_raw: str, top_k: int) -> List[Tuple[Dict[str, Any], float]]:
    _ensure_latest_dataset()
    _load_dataset_if_needed()
    if not _DATA:
        return []

    q = {
        "doc_content": query_raw,
        "doc_title": "",
        "doc_issuer": "",
        "doc_content_tok": _tokens(query_raw),
        "doc_title_tok": [],
        "doc_issuer_tok": [],
    }

    scored: List[Tuple[Dict[str, Any], float]] = []
    for r in _DATA:
        s = _score_record(q, r)
        if s <= 0:
            continue
        scored.append((r, s))

    if not scored:
        return []

    scored.sort(key=lambda x: x[1], reverse=True)

    base = scored[:max(1, top_k)]
    if len(scored) <= top_k:
        selected = base
    else:
        selected = list(base)
        floor = max(MIN_SCORE_ABS, base[-1][1] * EXPAND_RATIO)
        i = top_k

        def _is_near_dup(rec_a: Dict[str, Any], rec_b: Dict[str, Any]) -> bool:
            a, b = rec_a["doc_content_tok"], rec_b["doc_content_tok"]
            jac = _jaccard(a, b)
            return jac >= 0.85

        while i < len(scored) and len(selected) < TOP_K_MAX:
            r, s = scored[i]
            if s < floor or s < MIN_SCORE_ABS:
                break
            if any(_is_near_dup(r, x[0]) for x in selected):
                i += 1
                continue
            selected.append((r, s))
            i += 1

    return selected

def _fmt_labels(labels: List[str]) -> str:
    # Giữ nguyên cách viết, nối bằng "; "
    if not labels:
        return "(không xác định)"
    return "; ".join(labels)

def build_training_block(doc_raw_text: str, k: int = DEF_TOP_K) -> str:
    """
    Trả về block RAG “2.1. …” chứa các ví dụ gần nhất (có thể > k nếu mở rộng).
    """
    query_raw = (doc_raw_text or "").strip()
    if not query_raw:
        return ""

    pairs = _rank_examples(query_raw, max(1, k))
    if not pairs:
        header = (
            "2.1. DỮ LIỆU TOOLS PHÂN LOẠI VĂN BẢN (Top-k ví dụ gần nhất)\n"
            "- Chưa có dataset hoặc truy vấn không khớp. Vui lòng kiểm tra cấu hình DOC_CLASSIFY_DATA."
        )
        return header

    total = len(pairs)
    lines: List[str] = []
    lines.append("2.1. DỮ LIỆU TOOLS PHÂN LOẠI VĂN BẢN (Top-k ví dụ gần nhất)")
    lines.append(f"- Hiển thị: {total} mẫu (yêu cầu k={k}, có thể mở rộng ≤{TOP_K_MAX} nếu điểm kế tiếp đủ cao).")
    lines.append("- Tiêu chí xếp hạng: doc_content (10/10) > doc_title (7/10) > doc_issuer (2/10).")
    lines.append("")

    for idx, (r, s) in enumerate(pairs, start=1):
        title   = r.get("doc_title") or "(không tiêu đề)"
        issuer  = r.get("doc_issuer") or "(không rõ cơ quan)"
        snippet = _safe_snippet(r.get("doc_content") or "", SNIPPET_CHARS)
        labels  = _fmt_labels(r.get("labels") or [])

        lines.append(f"[MẪU {idx}]  (score={s:.6f})")
        lines.append(f"- Tiêu đề: {title}")
        lines.append(f"- Cơ quan ban hành: {issuer}")
        lines.append(f"- Nội dung (trích): {snippet}")
        lines.append(f"- NHÃN MỤC TIÊU: {labels}")
        lines.append("")

    return "\n".join(lines).rstrip()

# API khớp với nơi gọi từ chat_api.py / prompt_compose
def build_tool_block_for_classify(doc_raw_text: str, top_k: int = DEF_TOP_K) -> str:
    return build_training_block(doc_raw_text, k=top_k)

# ───────────────── vote fallback ─────────────────
def union_allowed_labels(doc_raw_text: str, k: int = DEF_TOP_K) -> List[str]:
    """
    Trả union nhãn từ các mẫu gần nhất (RAG), sắp theo trọng số tương đồng.
    Dùng làm [B] và/hoặc filter cho fallback.
    """
    pairs = _rank_examples(doc_raw_text or "", max(1, k))
    if not pairs:
        return []
    base_max = max(s for _, s in pairs) or 1.0

    weight: Dict[str, float] = {}
    order: Dict[str, int] = {}
    for idx, (rec, s) in enumerate(pairs, start=1):
        w = (s / base_max)
        for lab in (rec.get("labels") or []):
            if not lab:
                continue
            weight[lab] = weight.get(lab, 0.0) + w
            if lab not in order:
                order[lab] = idx

    items = sorted(weight.items(), key=lambda kv: (-kv[1], order.get(kv[0], 9999)))
    return [lab for lab, _ in items]

def infer_labels_by_vote(
    doc_raw_text: str,
    top_k: int = 20,
    min_score: float = 0.20,
    allowed: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Fallback đa nhãn dựa trên phiếu bầu từ RAG:
    - Điểm nhãn = tổng(weight của các mẫu chứa nhãn), weight = score_i / max_score_base.
    - Chuẩn hoá về [0..1] theo max của tất cả nhãn.
    - Lọc theo allowed (nếu có).
    - Cắt top_k, bỏ dưới min_score.
    """
    k = DEF_TOP_K if top_k <= 0 else min(top_k, TOP_K_MAX)
    ulabels = union_allowed_labels(doc_raw_text, k=k)
    if allowed:
        allowset = set(allowed)
        ulabels = [x for x in ulabels if x in allowset]
    if not ulabels:
        return []

    pairs = _rank_examples(doc_raw_text or "", k)
    if not pairs:
        return []

    base_max = max(s for _, s in pairs) or 1.0
    wmap: Dict[str, float] = {}
    hitmap: Dict[str, List[int]] = {}

    allowset = set(ulabels)
    for idx, (rec, s) in enumerate(pairs, start=1):
        w = (s / base_max)
        labels = [x for x in (rec.get("labels") or []) if x in allowset]
        for lab in labels:
            wmap[lab] = wmap.get(lab, 0.0) + w
            hitmap.setdefault(lab, []).append(idx)

    if not wmap:
        return []

    maxw = max(wmap.values()) or 1.0
    items: List[Dict[str, Any]] = []
    for lab, sc in wmap.items():
        score = sc / maxw  # 0..1
        if score < (min_score or 0.0):
            continue
        rationale = "Xuất hiện trong các mẫu gần nhất: " + ", ".join(f"#{i}" for i in hitmap.get(lab, [])[:6])
        items.append({"label": lab, "score": round(float(score), 4), "rationale": rationale})

    items.sort(key=lambda x: x["score"], reverse=True)
    if top_k > 0:
        items = items[:top_k]
    return items

__all__ = [
    "build_tool_block_for_classify",
    "build_training_block",
    "reload_dataset",
    "get_dataset_stats",
    "union_allowed_labels",
    "infer_labels_by_vote",
]

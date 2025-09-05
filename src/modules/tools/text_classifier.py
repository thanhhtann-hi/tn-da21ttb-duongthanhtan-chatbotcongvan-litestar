# file: src/modules/tools/text_classifier.py
# updated: 2025-09-03 (v1.1.0)
# changes (v1.1.0):
#   - SIMPLE-MODE: Rõ ràng hoá tool "Phân loại phòng ban" (FE label) dùng id/name 'doc_email_routing'.
#     • Loại bỏ các từ khoá "soạn/gửi email" khỏi bucket doc_email_routing (tránh lẫn với email update).
#     • Mở rộng keyword cho phân loại: "phân loại phòng ban", "chuyển đến phòng/ban", "đơn vị xử lý", "bộ phận một cửa", ...
#     • Ưu tiên intent: email_update > (doc_email_routing | doc_classify) > deep_research > web_search > ...
#   - Aliases: thêm "phân loại phòng ban" & cụm tương đương vào DOC_EMAIL_ROUTING (để resolve theo label FE).
#   - Confidence: boost nhẹ khi match rõ ý định phân loại (doc_email_routing/doc_classify).
#   - Self-test: cập nhật ví dụ cho phân loại phòng ban.
from __future__ import annotations

import re
import json
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any, Iterable, Tuple

# ──────────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class Classification:
    intent: str                          # e.g. 'qa', 'web_search', 'deep_research', ...
    predicted_tool_name: Optional[str]   # e.g. 'WEB_SEARCH', 'DEEP_RESEARCH', ...
    confidence: float                    # 0..1
    reasons: List[str] = field(default_factory=list)

    # Signals / features extracted for downstream logic, logging, guardrails…
    language: str = "auto"
    token_count: int = 0
    urls: List[str] = field(default_factory=list)
    emails: List[str] = field(default_factory=list)
    phones: List[str] = field(default_factory=list)
    contains_code: bool = False
    contains_pii: bool = False
    contains_numbers: bool = False
    urgency: Optional[str] = None        # 'low'|'normal'|'high' if detected
    flags: Dict[str, Any] = field(default_factory=dict)  # free-form extras

    def to_dict(self) -> Dict[str, Any]:
        return {
            "intent": self.intent,
            "predicted_tool_name": self.predicted_tool_name,
            "confidence": round(float(self.confidence), 3),
            "reasons": self.reasons,
            "language": self.language,
            "token_count": self.token_count,
            "urls": self.urls,
            "emails": self.emails,
            "phones": self.phones,
            "contains_code": self.contains_code,
            "contains_pii": self.contains_pii,
            "contains_numbers": self.contains_numbers,
            "urgency": self.urgency,
            "flags": self.flags,
        }


# Canonical, UI-facing tool names (match icon bank / tools API như FE đang dùng)
TOOL_CANON = {
    "qa": "ANSWER_MODE",
    "web_search": "WEB_SEARCH",
    "deep_research": "DEEP_RESEARCH",
    "doc_email_update": "DOC_EMAIL_UPDATE",
    # FE dùng id/name 'doc_email_routing' nhưng label là “Phân loại văn bản”
    "doc_email_routing": "DOC_EMAIL_ROUTING",
    # Back-compat: intent 'doc_classify' vẫn map được qua alias/label
    "doc_classify": "DOC_CLASSIFY",
}

# Aliases để resolve từ danh sách tools BE trả về (name/label linh hoạt)
TOOL_ALIASES = {
    "ANSWER_MODE": {"answer_mode", "qa", "default", "chat"},
    "WEB_SEARCH": {"web_search", "search", "tìm kiếm", "tra cứu", "browse"},
    "DEEP_RESEARCH": {"deep_research", "nghiên cứu", "research", "report"},
    "DOC_EMAIL_UPDATE": {
        "doc_email_update", "email update", "update email", "trả lời email", "reply", "reply all",
        "hồi âm", "phản hồi email", "theo luồng email", "follow up"
    },
    # Quan trọng: alias của DOC_EMAIL_ROUTING phải bao phủ label FE “Phân loại văn bản”
    # và các cụm đồng nghĩa; KHÔNG chứa các từ khoá soạn/gửi email.
    "DOC_EMAIL_ROUTING": {
        "doc_email_routing",
        "phân loại", "phân loại văn bản", "phân loại phòng ban",
        "phân loại công văn", "xếp loại văn bản",
        "chuyển phòng ban", "chuyển đến phòng ban", "chuyển cho phòng", "chuyển cho ban",
        "giao xử lý", "phân công xử lý", "định tuyến văn bản", "route to department",
        "đơn vị xử lý", "bộ phận một cửa"
    },
    # Back-compat: vẫn nhận các cụm “phân loại …”
    "DOC_CLASSIFY": {
        "doc_classify", "phân loại", "phân loại văn bản", "phân loại phòng ban",
        "document classify", "text classify", "document classification", "text classification",
        "phân loại công văn", "xếp loại văn bản", "route to department", "định tuyến văn bản"
    },
}

# ──────────────────────────────────────────────────────────────────────────────
# Core Classifier
# ──────────────────────────────────────────────────────────────────────────────

class TextClassifier:
    """
    Lightweight, rule-based classifier optimized for Vietnamese + English chat.

    - No external deps; explainable via `reasons`.
    - Returns conservative confidence. Multiple rule hits increase confidence.
    - Extracts URLs/emails/phones + basic PII/code signals for guardrails.

    NOTE:
    - Intent phân loại phòng ban: match khi người dùng nói rõ hành động phân loại/định tuyến/chuyển
      văn bản cho phòng/ban/đơn vị xử lý. Không đè lên tác vụ email update.
    """

    RE_URL = re.compile(r"""(?i)\b((?:https?://|www\.)[^\s<>\]]+)""")
    RE_EMAIL = re.compile(r"(?i)\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b")
    # VN-ish phones & generic international (+84 / 0xxxxxxxxx)
    RE_PHONE = re.compile(r"(?:(?<!\d)(?:\+?84|0)\d{8,10}(?!\d))")
    # Numbers & money
    RE_NUMBER = re.compile(r"\b\d+(?:[.,]\d+)?\b")
    RE_CURRENCY = re.compile(r"(?i)\b(vnd|đ|usd|\$|eur|€)\b")
    # Code-ish: fenced blocks, braces+semicolons, imports, function defs, xml tags...
    RE_CODE_FENCE = re.compile(r"```[\s\S]*?```")
    RE_CODE_HINT = re.compile(r"(?i)\b(import|class|def|function|=>|var|let|const|#include|SELECT\s+.+\s+FROM|<\w+[^>]*>)")
    # Urgency
    RE_URGENT = re.compile(r"(?i)\b(urgent|asap|gấp|khẩn|ngay lập tức|ngay|today|trong ngày)\b")
    # VI diacritics (rough detector)
    RE_VI = re.compile(r"[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]", re.I)
    # CJK blocks (very rough)
    RE_ZH = re.compile(r"[\u4e00-\u9fff]")
    RE_JA = re.compile(r"[\u3040-\u30ff]")

    # Vietnamese / English intent keyword banks (lowercased)
    KW = {
        "web_search": [
            # VI
            "tìm", "tìm kiếm", "tra cứu", "google", "tin tức", "giá cổ phiếu", "giá vàng", "hôm nay là",
            # EN
            "search", "look up", "google", "news", "latest", "current", "price of", "who is", "what is",
        ],
        "deep_research": [
            "nghiên cứu", "báo cáo", "phân tích sâu", "so sánh chi tiết", "tổng hợp nguồn", "trích dẫn",
            "whitepaper", "deep dive", "comprehensive", "systematic review", "literature review",
        ],
        # Phân loại phòng ban (đi với tool doc_email_routing theo id FE)
        "doc_email_routing": [
            "phân loại phòng ban", "phân loại văn bản", "phân loại công văn", "xếp loại văn bản",
            "định tuyến văn bản", "route to department", "chọn phòng ban xử lý", "chọn phòng xử lý",
            "chuyển phòng ban", "chuyển đến phòng ban", "chuyển cho phòng", "chuyển cho ban",
            "giao xử lý", "phân công xử lý", "đơn vị xử lý", "bộ phận một cửa",
            "văn bản này chuyển cho phòng", "công văn này gửi cho phòng nào", "file này chuyển cho bộ phận nào",
        ],
        # Back-compat: người dùng nói “phân loại…” / “classification…”
        "doc_classify": [
            "phân loại văn bản", "phân loại công văn", "phân loại phòng ban", "xếp loại văn bản",
            "đặt nhãn", "gán nhãn", "label", "classification", "classify document",
            "text classification", "document classification", "route to department", "định tuyến văn bản",
        ],
        # Email update / reply / follow-up (KHÁC với phân loại)
        "doc_email_update": [
            "trả lời email", "phản hồi email", "cập nhật email", "update email", "reply all", "reply",
            "fwd:", "re:", "theo luồng email", "follow up", "soạn email", "viết email", "gửi email",
            "compose email", "email compose", "subject:", "tiêu đề:", "cc:", "bcc:",
        ],
        "translate": ["dịch", "translate", "dịch sang", "translate to"],
        "summarize": ["tóm tắt", "summary", "summarize"],
        "rewrite": ["viết lại", "paraphrase", "rewrite", "diễn đạt lại"],
        "math": ["tính", "giải phương trình", "equation", "solve for", "integrate", "derivative"],
        "table": ["bảng", "table", "csv", "excel", "tabulate"],
        "ocr": ["ocr", "scan", "quét", "ảnh chụp", "pdf scan"],
        "greeting": ["xin chào", "chào bạn", "hello", "hi", "yo", "hey"],
        "help": ["hướng dẫn", "help", "how to", "cách dùng", "làm sao", "usage"],
    }

    def classify(self, text: str, *, lang_hint: Optional[str] = None) -> Classification:
        t = (text or "").strip()
        t_low = t.lower()

        urls = self.RE_URL.findall(t)
        emails = self.RE_EMAIL.findall(t)
        phones = self.RE_PHONE.findall(t)
        has_numbers = bool(self.RE_NUMBER.search(t))
        has_currency = bool(self.RE_CURRENCY.search(t))
        code_block = bool(self.RE_CODE_FENCE.search(t)) or bool(self.RE_CODE_HINT.search(t))
        urgency = "high" if self.RE_URGENT.search(t) else None

        lang = self._detect_language(t, hint=lang_hint)

        # Rule hits counter for scoring
        hits: List[Tuple[str, str]] = []

        # Greedy but ordered: explicit tasks first
        # 1) Email update / reply (rõ ràng nhất, ưu tiên hơn phân loại)
        if self._kw_hit(t_low, "doc_email_update") or ("email" in t_low and any(k in t_low for k in ["trả lời", "reply", "follow up", "soạn", "gửi"])):
            hits.append(("intent", "doc_email_update"))

        # 2) Phân loại phòng ban (id FE = doc_email_routing) & back-compat doc_classify
        #    Kích hoạt khi có từ khoá phân loại/chuyển đến phòng/ban/đơn vị xử lý.
        if self._kw_hit(t_low, "doc_email_routing"):
            hits.append(("intent", "doc_email_routing"))
        if self._kw_hit(t_low, "doc_classify"):
            hits.append(("intent", "doc_classify"))

        # 3) Deep vs web search
        if self._kw_hit(t_low, "deep_research"):
            hits.append(("intent", "deep_research"))
        if self._kw_hit(t_low, "web_search") or ("?" in t and any(k in t_low for k in ["ai là", "what is", "who is", "ở đâu", "khi nào"])):
            hits.append(("intent", "web_search"))

        # 4) Utilities / transforms
        if self._kw_hit(t_low, "translate"):
            hits.append(("intent", "translate"))
        if self._kw_hit(t_low, "summarize"):
            hits.append(("intent", "summarize"))
        if self._kw_hit(t_low, "rewrite"):
            hits.append(("intent", "rewrite"))
        if code_block:
            hits.append(("signal", "code"))
        if self._kw_hit(t_low, "math"):
            hits.append(("intent", "math"))
        if self._kw_hit(t_low, "table"):
            hits.append(("intent", "table"))
        if self._kw_hit(t_low, "ocr"):
            hits.append(("intent", "ocr"))
        if self._kw_hit(t_low, "help"):
            hits.append(("intent", "help"))
        if self._kw_hit(t_low, "greeting") and len(t_low.split()) <= 6:
            hits.append(("intent", "greeting"))

        intent = self._decide_intent(hits, t_low, urls, emails)
        predicted_tool = self._intent_to_tool(intent)

        reasons: List[str] = []
        if intent != "qa":
            reasons.append(f"rules→intent:{intent}")
        if urls:
            reasons.append("has_url")
        if emails:
            reasons.append("has_email")
        if phones:
            reasons.append("has_phone")
        if code_block:
            reasons.append("contains_code")
        if urgency:
            reasons.append(f"urgency:{urgency}")

        # Confidence: base on number of strong signals
        conf = self._score_confidence(intent, hits, urls, emails, code_block)

        contains_pii = bool(emails or phones)
        flags = {
            "has_currency": has_currency,
            "question_mark": "?" in t,
            "rule_hits": hits,
        }

        return Classification(
            intent=intent,
            predicted_tool_name=predicted_tool,
            confidence=conf,
            reasons=reasons,
            language=lang,
            token_count=self._token_count(t),
            urls=urls,
            emails=emails,
            phones=phones,
            contains_code=code_block,
            contains_pii=contains_pii,
            contains_numbers=has_numbers,
            urgency=urgency,
            flags=flags,
        )

    # ───── helpers ─────

    def _kw_hit(self, t_low: str, bucket: str) -> bool:
        for kw in self.KW.get(bucket, []):
            if kw in t_low:
                return True
        return False

    def _decide_intent(
        self, hits: List[Tuple[str, str]], t_low: str, urls: List[str], emails: List[str]
    ) -> str:
        # Priority ordering among recognized intents
        intents = [h[1] for h in hits if h[0] == "intent"]

        # Email update (reply/follow-up/compose) có ưu tiên cao nhất nếu được yêu cầu rõ
        if "doc_email_update" in intents or ("email" in t_low and any(k in t_low for k in ["trả lời", "reply", "follow up", "soạn", "gửi"])):
            return "doc_email_update"

        # Phân loại phòng ban (doc_email_routing) hoặc doc_classify
        if "doc_email_routing" in intents:
            return "doc_email_routing"
        if "doc_classify" in intents:
            return "doc_classify"

        # Deep research outranks generic web_search
        if "deep_research" in intents:
            return "deep_research"

        # If query contains "latest/news/giá hôm nay" or has explicit url w/ 'wikipedia/news'
        if "web_search" in intents or any("news" in u.lower() or "wikipedia" in u.lower() for u in urls):
            return "web_search"

        # Translate/summarize/rewrite if strongly indicated and text is long enough
        for tri in ("translate", "summarize", "rewrite"):
            if tri in intents:
                return tri

        # Math/table/ocr/help/greeting
        for tri in ("ocr", "math", "table", "help", "greeting"):
            if tri in intents:
                return tri

        # Default
        return "qa"

    def _intent_to_tool(self, intent: str) -> Optional[str]:
        """
        Map intents sang canonical tool names.
        Lưu ý: FE dùng id 'doc_email_routing' cho “Phân loại văn bản”.
        - Trả "DOC_EMAIL_ROUTING" khi intent = doc_email_routing
        - Trả "DOC_CLASSIFY" cho back-compat; resolve_tool_id sẽ match label “Phân loại văn bản”
        """
        if intent == "doc_email_routing":
            return TOOL_CANON["doc_email_routing"]
        if intent == "doc_classify":
            return TOOL_CANON["doc_classify"]
        if intent in ("web_search", "deep_research", "doc_email_update"):
            return TOOL_CANON[intent]
        return TOOL_CANON["qa"]  # stay in ANSWER_MODE for others

    def _score_confidence(
        self, intent: str, hits: List[Tuple[str, str]], urls: List[str], emails: List[str], code_block: bool
    ) -> float:
        base = 0.25
        strong = 0
        weak = 0

        for kind, val in hits:
            if kind == "intent":
                strong += 1
            else:
                weak += 1

        if intent == "doc_email_update" and emails:
            strong += 1
        if intent == "web_search" and urls:
            weak += 1
        if code_block and intent not in ("web_search", "doc_email_*"):
            weak += 1

        # Boost nhẹ cho phân loại phòng ban
        if intent in ("doc_email_routing", "doc_classify"):
            strong += 1

        score = base + strong * 0.2 + weak * 0.05
        if intent == "qa" and strong == 0 and weak == 0:
            score = 0.35
        return max(0.2, min(0.95, score))

    def _detect_language(self, text: str, *, hint: Optional[str] = None) -> str:
        if hint:
            return hint.lower()
        t = text or ""
        if self.RE_VI.search(t):
            return "vi"
        if self.RE_ZH.search(t):
            return "zh"
        if self.RE_JA.search(t):
            return "ja"
        # crude heuristic: ascii → 'en'
        return "en"

    def _token_count(self, text: str) -> int:
        return len((text or "").split())


# ──────────────────────────────────────────────────────────────────────────────
# Tool resolution helper (optional for chat_api)
# ──────────────────────────────────────────────────────────────────────────────

def resolve_tool_id(tools: Iterable[Dict[str, Any]], predicted_tool_name: Optional[str]) -> Optional[Any]:
    """
    Given tools list from /chat/tools (each item has .id/.name/.label),
    resolve classifier's predicted canonical name to a concrete tool id.

    Returns None if not found (caller keeps current tool or ANSWER_MODE).
    """
    if not predicted_tool_name:
        return None

    want = predicted_tool_name.upper()
    aliases = TOOL_ALIASES.get(want, {want.lower()})

    found: Optional[Any] = None
    for t in tools or []:
        name = str(t.get("name", "")).strip()
        label = str(t.get("label", "")).strip()
        hay = {name.lower(), label.lower()}
        if hay & aliases:
            found = t.get("id")
            break

    return found


# ──────────────────────────────────────────────────────────────────────────────
# Quick self-test
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    clf = TextClassifier()
    tests = [
        "Tìm giúp mình tin tức mới nhất về lãi suất FED?",
        "Làm ơn trả lời email này cho tôi, subject: Báo cáo Q3",
        "Hãy nghiên cứu sâu thị trường AI chip và trích dẫn nguồn.",
        "Dịch đoạn sau sang tiếng Anh: Chúng ta sẽ họp vào thứ Sáu.",
        "Tóm tắt nội dung bên dưới.",
        "Xin chào bạn!",
        "SELECT * FROM users WHERE id = 1;",
        "Hỗ trợ PHÂN LOẠI PHÒNG BAN cho công văn đính kèm này, nên chuyển đến bộ phận nào?",
        "Công văn này chuyển đến phòng nào xử lý? Có cần qua bộ phận một cửa trước không?",
        "Nhờ soạn email gửi tới minh.nguyen@example.com, tiêu đề: Báo cáo Q3",
    ]
    for s in tests:
        res = clf.classify(s)
        print("—", s)
        print(json.dumps(res.to_dict(), ensure_ascii=False, indent=2))

# 📁 shared/csrf.py
# 🕒 Last updated: 2025-07-05 15:45
# =============================================================================
# CSRF helper – Double-Submit Cookie pattern
# -----------------------------------------------------------------------------
# • get_client_token(request)  → trích token client gửi (header › body › query)
# • validate_csrf(request)     → so khớp cookie "csrftoken" và client-token.
# • CsrfError                  → raise 403 khi không hợp lệ.
# -----------------------------------------------------------------------------
# Ghi chú:
#   – Dùng cho middleware `core/middleware/csrf_guard.py`.
#   – Không phụ thuộc ORM / DB; chỉ thao tác Request.
# =============================================================================

from __future__ import annotations

from typing import Optional

from litestar import Request
from litestar.exceptions import HTTPException

from shared.secure_cookie import get_csrf_cookie

_HEADER_NAME   = "X-CSRFToken"
_FORM_FIELD    = "csrf_token"
_QUERY_PARAM   = "csrf_token"


class CsrfError(HTTPException):
    """Raise 403 Forbidden khi token CSRF không hợp lệ."""

    def __init__(self, detail: str = "CSRF token missing or incorrect") -> None:
        super().__init__(status_code=403, detail=detail)


async def _get_body_field(request: Request) -> Optional[str]:
    """
    Trích trường csrf_token trong body nếu Content-Type là:
        • application/x-www-form-urlencoded
        • multipart/form-data
        • application/json
    Trả về None nếu không tìm thấy hoặc body rỗng.
    """
    ctype = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()

    if ctype in ("application/x-www-form-urlencoded", "multipart/form-data"):
        form = await request.form()  # type: ignore[func-returns-value]
        return (form.get(_FORM_FIELD) or "").strip() or None

    if ctype == "application/json":
        try:
            data = await request.json()
            val = data.get(_FORM_FIELD)
            if isinstance(val, str) and val.strip():
                return val.strip()
        except Exception:  # malformed JSON → ignore
            pass

    return None


async def get_client_token(request: Request) -> Optional[str]:
    """
    Lấy token do client gửi theo thứ tự ưu tiên:
        1. Header  X-CSRFToken
        2. Body    (field 'csrf_token')
        3. Query   ?csrf_token=...
    """
    hdr = (request.headers.get(_HEADER_NAME) or "").strip()
    if hdr:
        return hdr

    body_val = await _get_body_field(request)
    if body_val:
        return body_val

    q = request.query_params.get(_QUERY_PARAM, "").strip()
    return q or None


async def validate_csrf(request: Request) -> None:
    """
    So khớp cookie "csrftoken" và token client gửi.

    Raises
    ------
    CsrfError
        Khi thiếu cookie hoặc thiếu/bất khớp client-token.
    """
    cookie_token = get_csrf_cookie(request)
    if not cookie_token:
        raise CsrfError("Missing csrftoken cookie")

    client_token = await get_client_token(request)
    if not client_token or client_token != cookie_token:
        raise CsrfError("CSRF token missing or incorrect")

# 📁 src/core/middleware/csrf_guard.py
# 🕒 Last updated: 2025-08-31
# =============================================================================
# CSRF Guard Middleware — Double-Submit Cookie pattern (safe for large uploads)
# -----------------------------------------------------------------------------
# Mục tiêu:
#  • Tránh 413 "Request Entity Too Large" do middleware parse multipart lớn.
#  • Ưu tiên xác thực bằng header (X-CSRFToken) khớp cookie (csrftoken / csrf_token).
#  • Chỉ fallback sang đọc form NẾU body nhỏ (mặc định ≤ 1MB, đổi bằng ENV).
#  • Back-compat alias: CsrfGuardMiddleware = CsrfGuard
# =============================================================================

from __future__ import annotations

import os
import hmac
from typing import Iterable, Optional

from litestar import Request
from litestar.middleware.base import AbstractMiddleware
from litestar.response import Response
from litestar.types import ASGIApp, Receive, Scope, Send


def _ct_eq(a: str, b: str) -> bool:
    """Constant-time string compare."""
    try:
        return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
    except Exception:
        return False


def _json_response(payload: dict, status: int = 403) -> Response:
    """Trả JSON gọn, không lộ nội bộ."""
    return Response(payload, status_code=status, media_type="application/json")


class CsrfGuard(AbstractMiddleware):
    """
    CSRF guard cho các phương thức mutating (POST/PUT/PATCH/DELETE).

    Chiến lược:
      1) Nếu header token khớp cookie token → PASS (không parse body).
      2) Nếu body nhỏ (≤ CSRF_FORM_PARSE_MAX) và là form → fallback đọc form field.
      3) Với multipart lớn mà thiếu header hợp lệ → 403 (không parse).
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        skip_paths: Optional[Iterable[str]] = None,
        header_names: Optional[Iterable[str]] = None,
        form_field: str = "csrf_token",
        max_form_parse_bytes: Optional[int] = None,
    ) -> None:
        super().__init__(app)
        # Bỏ qua những path prefix tĩnh/GET-only… (truyền từ main.py)
        self.skip_paths: tuple[str, ...] = tuple(skip_paths or ())

        # Danh sách header có thể chứa CSRF token (ưu tiên đầu danh sách)
        self.header_names: list[str] = [h.lower() for h in (header_names or [
            "X-CSRFToken",
            "X-XSRF-TOKEN",
            "X-CSRF-Token",
        ])]

        # Tên field trong form (khi bắt buộc phải đọc form nhỏ)
        self.form_field: str = form_field

        # Mặc định: chỉ parse form nếu Content-Length ≤ 1MB
        env_limit = os.getenv("CSRF_FORM_PARSE_MAX", "1048576")  # 1 MiB
        try:
            self.max_form_parse_bytes: int = int(env_limit)
        except Exception:
            self.max_form_parse_bytes = 1_048_576

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # ── Skip websocket / lifespan
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        method = (scope.get("method") or "GET").upper()
        # Safe methods: skip
        if method in {"GET", "HEAD", "OPTIONS", "TRACE"}:
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "") or ""
        # Skip theo prefix (đã cấu hình trong main.py)
        if any(path.startswith(pfx) for pfx in self.skip_paths):
            await self.app(scope, receive, send)
            return

        # ── CSRF check cho mutating methods
        request = Request(scope=scope, receive=receive, send=send)

        # 1) Lấy token từ cookie & header
        cookie_token = (
            request.cookies.get("csrftoken")
            or request.cookies.get("csrf_token")
            or ""
        )

        hdrs = request.headers or {}
        header_token = ""
        for name in self.header_names:
            # Headers trong Litestar là case-insensitive
            v = hdrs.get(name)
            if v:
                header_token = v
                break

        # Nếu có header & cookie và chúng khớp → PASS (không parse body)
        if header_token and cookie_token and _ct_eq(header_token, cookie_token):
            await self.app(scope, receive, send)
            return

        # 2) Đánh giá Content-Length + Content-Type để quyết định có được phép parse
        try:
            content_length = int(hdrs.get("content-length") or "0")
        except Exception:
            content_length = 0

        content_type = (hdrs.get("content-type") or "").lower()
        is_form_like = (
            ("multipart/form-data" in content_type)
            or ("application/x-www-form-urlencoded" in content_type)
        )

        # 2a) Nếu là form và body NHỎ → fallback đọc form field
        if is_form_like and (content_length == 0 or content_length <= self.max_form_parse_bytes):
            try:
                form = await request.form()  # nhỏ → an toàn để parse
                form_token = form.get(self.form_field) or ""
                if form_token and cookie_token and _ct_eq(str(form_token), cookie_token):
                    await self.app(scope, receive, send)
                    return
            except Exception:
                # Không lộ chi tiết parser; trả 403 thống nhất
                resp = _json_response({"ok": False, "error": "CSRF_PARSE_FAILED"})
                await resp(scope, receive, send)
                return

        # 2b) Nếu là multipart lớn nhưng thiếu header hợp lệ → 403 rõ ràng, KHÔNG parse
        if is_form_like and content_length > self.max_form_parse_bytes:
            resp = _json_response(
                {
                    "ok": False,
                    "error": "CSRF_FAILED",
                    "detail": "Missing/invalid CSRF header for large multipart. Provide X-CSRFToken header.",
                },
                status=403,
            )
            await resp(scope, receive, send)
            return

        # 3) Còn lại (JSON / raw / không phải form) → yêu cầu header hợp lệ
        resp = _json_response({"ok": False, "error": "CSRF_FAILED"}, status=403)
        await resp(scope, receive, send)


# ──────────────────────────────────────────────────────────────────────────────
# 🧩 Back-compat alias: module cũ import CsrfGuardMiddleware → vẫn hoạt động
# ──────────────────────────────────────────────────────────────────────────────
CsrfGuardMiddleware = CsrfGuard

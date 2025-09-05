# 📁 src/core/middleware/csrf_setter.py
# 🕒 Last updated: 2025-08-17 14:40
# =============================================================================
# CsrfCookieSetter Middleware – đảm bảo client luôn có cookie “csrftoken”.
#   • Dùng litestar.Response, KHÔNG phụ thuộc starlette
#   • Append đúng các dòng "Set-Cookie" vào ASGI message["headers"]
#   • Proxy-aware: tôn trọng X-Forwarded-Proto để quyết định flag Secure
#   • Đặt middleware này **cuối stack**
# =============================================================================

from __future__ import annotations

import logging
from litestar import Request, Response
from litestar.middleware.base import AbstractMiddleware
from litestar.types import ASGIApp, Receive, Scope, Send

from shared.secure_cookie import generate_csrf_token, set_csrf_cookie

logger = logging.getLogger(__name__)


class CsrfCookieSetter(AbstractMiddleware):
    """
    Double-Submit Cookie: nếu client chưa có `csrftoken`, sinh mới & append
    header Set-Cookie vào mọi response. Đặt middleware này **cuối stack**.
    """

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Bỏ qua WebSocket / lifespan
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        req = Request(scope=scope, receive=receive, send=send)

        # Client đã có csrftoken?
        has_token = "csrftoken" in (req.cookies or {})

        # Nhận biết Secure (trong môi trường có reverse proxy)
        xf_proto = (req.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
        secure_flag = (req.url.scheme == "https") or (xf_proto == "https")

        async def _send(message):
            # Chỉ can thiệp ở bước start response và khi client chưa có cookie
            if message["type"] == "http.response.start" and not has_token:
                try:
                    # Tạo response "dummy" rồi set cookie vào đó
                    dummy = Response(content="", media_type="text/plain")
                    set_csrf_cookie(dummy, generate_csrf_token(), secure=secure_flag)

                    # Append các dòng Set-Cookie từ dummy vào ASGI headers
                    raw = list(message.get("headers", []))  # list[tuple[bytes, bytes]]
                    appended = 0

                    # Ưu tiên: raw_headers (nếu có)
                    raw_headers = getattr(dummy, "raw_headers", None)
                    if raw_headers:
                        for k, v in raw_headers:
                            if isinstance(k, (bytes, bytearray)) and k.lower() == b"set-cookie":
                                raw.append((k, v))
                                appended += 1

                    # Fallback: headers.getlist("set-cookie")
                    if appended == 0:
                        try:
                            values = dummy.headers.getlist("set-cookie")  # type: ignore[attr-defined]
                        except Exception:
                            values = []
                        for val in values:
                            raw.append((b"set-cookie", val.encode("latin-1")))
                            appended += 1

                    # Fallback cuối: headers.get("set-cookie")
                    if appended == 0:
                        one = dummy.headers.get("set-cookie")
                        if one:
                            raw.append((b"set-cookie", one.encode("latin-1")))
                            appended = 1

                    if appended:
                        message["headers"] = raw
                        logger.debug("CsrfCookieSetter: injected csrftoken (secure=%s, count=%d)", secure_flag, appended)
                    else:
                        logger.warning("CsrfCookieSetter: NO Set-Cookie extracted from dummy Response")

                except Exception as e:
                    # Không chặn response nếu có lỗi; chỉ log để điều tra
                    logger.exception("CsrfCookieSetter error while injecting Set-Cookie: %s", e)

            await send(message)

        await self.app(scope, receive, _send)

# 📁 src/core/middleware/maintenance_guard.py
# 🕒 Last updated: 2025-07-08 23:55
# =============================================================================
# Khi system_maintenance = TRUE → trả 503 + no-store, chỉ để JS polling điều khiển reload
# ----------------------------------------------------------------------------- 
# ✨ PATCH 2025-07-08 23:55
#   • Cập nhật timestamp và xác nhận template path “maintenance/503_maintenance.html”
# =============================================================================

from __future__ import annotations

from litestar import Request
from litestar.middleware.base import AbstractMiddleware
from litestar.response import Template
from litestar.types import ASGIApp, Receive, Scope, Send

from core.db.engine import SessionLocal
from core.db.models import SystemSettings

class MaintenanceGuardMiddleware(AbstractMiddleware):
    """Chặn HTTP request khi bật chế độ bảo trì (trừ asset & /ping)."""

    _WHITELIST: tuple[str, ...] = (
        "/static", "/images", "/js", "/css", "/favicon", "/ping"
    )

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Bỏ qua non-HTTP
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        request = Request(scope=scope, receive=receive, send=send)
        path    = request.url.path

        # Whitelist asset & health check
        if any(path.startswith(p) for p in self._WHITELIST):
            return await self.app(scope, receive, send)

        # Lấy cấu hình
        with SessionLocal() as db:
            settings = db.query(SystemSettings).first()

        # Nếu đang bảo trì → trả 503 + header no-store (không ép HTTP reload)
        if settings and settings.system_maintenance:
            template = Template("maintenance/503_maintenance.html")
            response = template.to_asgi_response(app=self.app, request=request)
            response.status_code              = 503
            response.headers["Cache-Control"] = "no-store, max-age=0"
            return await response(scope, receive, send)

        # Không bảo trì → tiếp tục bình thường
        return await self.app(scope, receive, send)

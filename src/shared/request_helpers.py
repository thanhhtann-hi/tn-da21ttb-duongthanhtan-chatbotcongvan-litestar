# 📁 src/shared/request_helpers.py
# 🕒 Last updated: 2025-07-05 14:45
# 📝
#   • NEW: Tiện ích chung để lấy địa chỉ IP thực tế và múi giờ (timezone) của
#     client. Ưu tiên đọc header, fallback cookie.
#   • Dùng trong AuthGuardMiddleware & các route OAuth để cập nhật liên tục
#     user_register_ip + setting_timezone.
# ---------------------------------------------------------------------------

from __future__ import annotations

from litestar import Request


def client_ip(req: Request) -> str | None:
    """
    Trả về IP thật của client dưới dạng chuỗi (v4/v6).
    Ưu tiên header reverse-proxy rồi tới socket client.

    Thứ tự:
        1. X-Forwarded-For   → lấy IP đầu tiên
        2. X-Real-IP
        3. req.client.host   (trong ASGI scope)
    """
    xff = req.headers.get("X-Forwarded-For", "")
    if xff:
        # “X-Forwarded-For: client, proxy1, proxy2”
        return xff.split(",")[0].strip()

    xri = req.headers.get("X-Real-IP", "")
    if xri:
        return xri.strip()

    # `request.client` có thể là None (WSGI adapter), nên dùng getattr
    return getattr(req.client, "host", None)


def client_tz(req: Request) -> str | None:
    """
    Trả về timezone của client (ví dụ: 'Asia/Ho_Chi_Minh').

    Các bước:
        1. Đọc header “X-Timezone” (được JS gắn cho HTMX / fetch request).
        2. Nếu thiếu, thử cookie “tz” (đã set 1 năm).
        3. Không tìm thấy → None.
    """
    # 1️⃣ Header
    tz = (req.headers.get("X-Timezone") or "").strip()
    if tz:
        return tz

    # 2️⃣ Cookie (đừng parse bằng lib nặng; chỉ split đơn giản)
    cookie_str = req.headers.get("cookie", "")
    if "tz=" in cookie_str:
        for part in cookie_str.split(";"):
            part = part.strip()
            if part.startswith("tz="):
                return part.split("=", 1)[1]

    # 3️⃣ Không có
    return None

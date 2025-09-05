# 📁 File: modules/ping/ping.py
# 🕒 Last updated: 2025-07-04 21:30

from litestar import get

@get("/ping")
def ping() -> dict[str, str]:
    """Endpoint kiểm tra trạng thái API."""
    return {"message": "pong"}

@get("/.well-known/appspecific/com.chrome.devtools.json")
def devtools_fallback() -> dict:
    """
    Chrome DevTools yêu cầu endpoint này để tích hợp mở devtools trực tiếp.
    Trả về JSON rỗng để tránh 404.
    """
    return {}

# 📁 modules/home/routes/index.py
# 🕒 Last updated: 2025-07-01 14:05
# 📝 Di chuyển từ src/routes/home.py; đồng bộ import theo cấu trúc core, shared
# =============================================================================
from litestar import get, Request
from litestar.response import Template
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from core.db.engine import SessionLocal
from core.db.models import User
from shared.secure_cookie import get_secure_cookie

# Header cấm cache – ngăn trang chủ bị “lưu tạm” ở mode khách
_NO_CACHE_HDRS = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}

@get("/")
def home(request: Request) -> Template:
    """Trang chủ – nếu đã đăng nhập, tải user.settings để template hiển thị avatar."""
    uid = get_secure_cookie(request)
    user = None

    if uid:
        with SessionLocal() as db:
            user = db.scalars(
                select(User)
                .options(selectinload(User.settings))
                .where(User.user_id == uid)
            ).first()

    return Template("index.html", context={"user": user}, headers=_NO_CACHE_HDRS)

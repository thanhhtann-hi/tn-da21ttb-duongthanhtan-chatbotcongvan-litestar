# file: src/modules/admin/routes/admin.py
# updated: 2025-08-24 (v1.1 – admin-only to match middleware gate)
# Thêm type-hint trả về & export fragment để main.py import

from typing import Tuple, Optional
from litestar import get, Request
from litestar.response import Template, Redirect

# ─────────────────────────────────────────────────────────────
# Helper: trả (user, None) hoặc (None, redirect/404 template)
# ─────────────────────────────────────────────────────────────
def _ensure_admin(request: Request) -> Tuple[Optional[object], Template | Redirect | None]:
    user = request.scope.get("user")
    if not user:
        return None, Redirect("/auth/login", status_code=302)
    # Admin-only (đồng nhất với AuthGuardMiddleware)
    if user.user_role != "admin":
        return None, Template(template_name="error/404_error.html", status_code=404)
    return user, None


@get("/admin")
def admin_home(request: Request) -> Template | Redirect:
    """Full page dashboard (layout + content)."""
    user, err = _ensure_admin(request)
    if err:
        return err
    return Template(template_name="admin/admin_home.html", context={"user": user})


@get("/admin/home-fragment")
def admin_home_fragment(request: Request) -> Template | Redirect:
    """Nội dung fragment để HTMX nạp vào #admin-frame."""
    user, err = _ensure_admin(request)
    if err:
        return err
    return Template(template_name="admin/admin_home_fragment.html", context={"user": user})

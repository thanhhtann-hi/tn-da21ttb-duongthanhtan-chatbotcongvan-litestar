# 📁 File: modules/legal/routes/legal.py
# 🕒 Last updated: 2025-07-01 14:25
# =============================================================================
# Routes cho trang pháp lý – Điều khoản sử dụng & Chính sách riêng tư
# • Đồng bộ đường dẫn template với thư mục modules/legal/templates
# =============================================================================

from litestar import get
from litestar.response import Template

@get("/legal/terms")
def terms_page() -> Template:
    """Hiển thị trang Điều khoản sử dụng."""
    return Template(template_name="terms.html")

@get("/legal/privacy")
def privacy_page() -> Template:
    """Hiển thị trang Chính sách riêng tư."""
    return Template(template_name="privacy.html")

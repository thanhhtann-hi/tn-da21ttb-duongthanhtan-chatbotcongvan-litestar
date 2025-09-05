# 📁 src/modules/auth/routes/__init__.py
# 🕒 Last updated: 2025-07-08 20:45
# 📌 Ensure all routes are mounted

from . import auth_password
from . import auth_verify
from . import auth_google
from . import auth_microsoft
from . import auth  # Nếu có chứa /auth/register

# 📁 File: src/config.py
# 🕒 Last updated: 2025-08-30
# 📌 Đọc cấu hình tập trung: DB, OAuth, System flags, SMTP/Email, Runpod, Upload/OCR.
#     Khớp với thay đổi trong modules/chat/routes/chat_api.py

import os
import secrets
from dotenv import load_dotenv

load_dotenv()  # tải biến môi trường, .env ghi đè biến hệ thống

# ——————————————————————————————————————————————————
# Helpers
# ——————————————————————————————————————————————————
def _b(s: str | None, default: bool = False) -> bool:
    if s is None:
        return default
    return str(s).strip().lower() in ("1", "true", "yes", "y", "on")

def _i(s: str | None, default: int) -> int:
    try:
        return int(str(s).strip())
    except Exception:
        return default

# ——————————————————————————————————————————————————
# Bí mật & cookie
# ——————————————————————————————————————————————————
SECRET_KEY: str = os.getenv("SECRET_KEY") or secrets.token_urlsafe(48)
if len(SECRET_KEY) < 32:
    raise RuntimeError("SECRET_KEY phải có ít nhất 32 ký tự!")

COOKIE_NAME: str = os.getenv("COOKIE_NAME", "session")
COOKIE_SALT: str = os.getenv("COOKIE_SALT", "cookie-signature")
COOKIE_MAX_AGE: int = _i(os.getenv("COOKIE_MAX_AGE"), 7 * 24 * 3600)  # 7 ngày
COOKIE_DOMAIN: str | None = os.getenv("COOKIE_DOMAIN")  # cho phép chia sẻ giữa subdomain

# ——————————————————————————————————————————————————
# Cấu hình Database
# ——————————————————————————————————————————————————
DB_HOST     = os.getenv("DB_HOST")
DB_PORT     = os.getenv("DB_PORT")
DB_NAME     = os.getenv("DB_NAME")
DB_USER     = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

DB_URL = f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

# ——————————————————————————————————————————————————
# SMTP / Email
# ——————————————————————————————————————————————————
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = _i(os.getenv("SMTP_PORT"), 465)
SMTP_FROM = os.getenv("SMTP_FROM", "no-reply@example.com")
SMTP_PASS = os.getenv("SMTP_PASS", "")
EMAIL_FROM = os.getenv("EMAIL_FROM", f"TVU MoE <{SMTP_FROM}>")
SMTP_DEV_MODE = _b(os.getenv("SMTP_DEV_MODE"), False)  # True → chỉ log chứ không gửi

DEFAULT_DEPT_EMAIL = os.getenv("DEFAULT_DEPT_EMAIL", "departments@example.com")

# ——————————————————————————————————————————————————
# App / Domain
# ——————————————————————————————————————————————————
APP_DOMAIN = os.getenv("APP_DOMAIN", "http://127.0.0.1:8000")

# ——————————————————————————————————————————————————
# OAuth Google
# ——————————————————————————————————————————————————
GOOGLE_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
GOOGLE_REDIRECT_URI  = os.getenv("GOOGLE_REDIRECT_URI")

# ——————————————————————————————————————————————————
# OAuth Microsoft
# ——————————————————————————————————————————————————
MICROSOFT_CLIENT_ID     = os.getenv("MICROSOFT_CLIENT_ID")
MICROSOFT_CLIENT_SECRET = os.getenv("MICROSOFT_CLIENT_SECRET")
MICROSOFT_REDIRECT_URI  = os.getenv("MICROSOFT_REDIRECT_URI")
MICROSOFT_AUTHORITY     = os.getenv("MICROSOFT_AUTHORITY", "https://login.microsoftonline.com/common")

# ——————————————————————————————————————————————————
# System Settings defaults (fallback từ ENV)
# ——————————————————————————————————————————————————
SYSTEM_REGISTER_DEFAULT: bool    = _b(os.getenv("SYSTEM_REGISTER"), False)
SYSTEM_LOGIN_DEFAULT: bool       = _b(os.getenv("SYSTEM_LOGIN"), True)
SYSTEM_MAINTENANCE_DEFAULT: bool = _b(os.getenv("SYSTEM_MAINTENANCE"), False)

# ——————————————————————————————————————————————————
# Runpod (OpenAI-compatible endpoint) — khớp chat_api.py
# ——————————————————————————————————————————————————
RUNPOD_BASE_URL: str        = os.getenv("RUNPOD_BASE_URL", "").strip()  # có thể thiếu /v1, code sẽ tự thêm
RUNPOD_API_KEY: str         = os.getenv("RUNPOD_API_KEY", "").strip()
RUNPOD_DEFAULT_MODEL: str   = os.getenv("RUNPOD_DEFAULT_MODEL", "openai/gpt-oss-20b").strip()
RUNPOD_DEFAULT_REASONING: str = os.getenv("RUNPOD_DEFAULT_REASONING", "low").strip().lower()
RUNPOD_TIMEOUT: int         = _i(os.getenv("RUNPOD_TIMEOUT"), 60)
RUNPOD_MAX_TOKENS: int      = _i(os.getenv("RUNPOD_MAX_TOKENS"), 100000)

# ——————————————————————————————————————————————————
# Uploads & OCR — khớp chat_api.py
# ——————————————————————————————————————————————————
UPLOAD_ROOT: str = os.path.abspath(os.getenv("UPLOAD_ROOT", os.path.join("uploads")))
OCR_ENABLED: bool = _b(os.getenv("OCR_ENABLED"), True)
OCR_MAX_APPEND_CHARS: int = _i(os.getenv("OCR_MAX_APPEND_CHARS"), 8000)
OCR_SNIPPET_PER_FILE: int = _i(os.getenv("OCR_SNIPPET_PER_FILE"), 2000)

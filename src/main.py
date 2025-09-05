# file: src/main.py
# updated: 2025-09-02 (v2.1.1)
# notes:
#   - App-level `request_max_body_size` (nếu Litestar hỗ trợ) để fail 413 sớm.
#   - BỎ request_max_size (không tồn tại ở bản Litestar hiện tại).
#   - Cấu hình multipart (max_file_size / max_body_size / max_files / max_fields) theo ENV,
#     có kiểm tra tương thích phiên bản (try-import + introspection).
#   - /chat/api/send vẫn giữ preflight Content-Length ở handler.
#   - ĐÃ thêm /chat/api/upload_limits vào route_handlers và CSRF skip (GET).
#   - Dùng /chat/tools & /chat/tools/select từ chat_api.py để tránh trùng route.

import os
import logging
import inspect
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(override=True)
os.environ.setdefault("LITESTAR_WARN_IMPLICIT_SYNC_TO_THREAD", "0")

logging.basicConfig(
    level=logging.DEBUG,
    format="%(levelname)s - %(asctime)s - %(name)s - %(message)s",
)
log = logging.getLogger("startup")

# ──────────────────────────────────────────────────────────────────────────────
# Litestar & templating
# ──────────────────────────────────────────────────────────────────────────────
from litestar import Litestar, get, Request
from litestar.exceptions import NotFoundException
from litestar.static_files.config import StaticFilesConfig
from litestar.template.config import TemplateConfig
from litestar.response import File, Template
from litestar.contrib.jinja import JinjaTemplateEngine
from jinja2 import Environment, FileSystemLoader, select_autoescape, StrictUndefined

# --- Optional imports cho multipart / decoding config (tương thích nhiều bản) ---
MultipartConfig = None
RequestDecodingConfig = None
try:
    from litestar.config import MultipartConfig as _MC  # type: ignore
    MultipartConfig = _MC
except Exception:
    try:
        from litestar.config.multipart import MultipartConfig as _MC2  # type: ignore
        MultipartConfig = _MC2
    except Exception:
        MultipartConfig = None

try:
    from litestar.config import RequestDecodingConfig as _RDC  # type: ignore
    RequestDecodingConfig = _RDC
except Exception:
    try:
        from litestar.config.request import RequestDecodingConfig as _RDC2  # type: ignore
        RequestDecodingConfig = _RDC2
    except Exception:
        RequestDecodingConfig = None

# ──────────────────────────────────────────────────────────────────────────────
# Routes: core
# ──────────────────────────────────────────────────────────────────────────────
from modules.ping.ping import ping, devtools_fallback
from modules.home.routes.index import home
from modules.legal.routes.legal import terms_page, privacy_page

# Chat – pages & fragments
from modules.chat.routes.chat_index import chat_index, chat_detail
from modules.chat.routes.chat_notify import (
    chat_notify_unread_count,
    chat_notify_list,
    chat_notify_read,
    chat_notify_read_all,
    chat_notify_detail,
)
from modules.chat.routes.chat_notify_all import chat_notify_all
from modules.chat.routes.chat_sidebar import chat_sidebar_list
from modules.chat.routes.chat_header import (
    list_models,
    header_fragment,
    select_model,
)
from modules.chat.routes.chat_api import (
    chat_api_send,
    chat_api_message,
    chat_api_edit,          # ✅ endpoints versioning / thao tác message
    chat_api_regenerate,
    chat_api_upload_limits, # ✅ upload limits (GET)
    chat_tools as chat_tools_list,          # ✅ tools menu (GET /chat/tools)
    chat_tools_select as chat_tools_select, # ✅ tools select (POST /chat/tools/select)
)

# Auth
from modules.auth.routes.auth import (
    login_form,
    register_form,
    login,
    register,
    logout,
    api_validate_username,
    api_validate_email,
)
from modules.auth.routes.auth_google import google_oauth, google_oauth_callback
from modules.auth.routes.auth_microsoft import ms_oauth_start, ms_oauth_callback
from modules.auth.routes.auth_verify import verify_form, verify_submit, resend_code
from modules.auth.routes.auth_password import (
    forgot_password_form,
    forgot_password_submit,
    forgot_password_sent_page,
    reset_password_form,
    reset_password_submit,
)

# Admin – Home & Security
from modules.admin.routes.admin import admin_home, admin_home_fragment
from modules.admin.routes.admin_security import (
    admin_security,
    admin_security_fragment_get,
    admin_security_fragment,
)

# Admin – Notify
from modules.admin.routes.admin_notify import (
    admin_notify_page,
    admin_notify_fragment_get,
    admin_notify_new_modal,
    admin_notify_create,
    admin_notify_detail_modal,
    admin_notify_edit_modal,
    admin_notify_update,
    admin_notify_hide,
    admin_notify_hide_post,
    admin_notify_delete_modal,
    admin_notify_bulk_hide,
    admin_notify_export_csv,
    admin_notify_calendar_modal,
    admin_notify_bulk_delete_modal,
    admin_notify_bulk_export_modal,
)

# Admin – Models
from modules.admin.routes.admin_models import (
    admin_models_page,
    admin_models_fragment_get,
    admin_models_new_modal,
    admin_models_edit_modal,
    admin_models_detail_modal,
    admin_models_delete_modal,
    admin_models_bulk_delete_modal,
    admin_models_bulk_export_modal,
    admin_models_create,
    admin_models_update,
    admin_models_retire,
    admin_models_toggle_enabled,
    admin_models_bulk_enable,
    admin_models_bulk_disable,
    admin_models_bulk_delete,
    admin_models_export_csv,
    admin_models_export_redirect,
)

# Admin – Tools (Tiện ích hệ thống)
from modules.admin.routes.admin_tools import (
    admin_tools_page,
    admin_tools_fragment_get,
    admin_tools_new_modal,
    admin_tools_edit_modal,
    admin_tools_detail_modal,
    admin_tools_delete_modal,
    admin_tools_bulk_delete_modal,
    admin_tools_bulk_export_modal,
    admin_tools_create,
    admin_tools_update,
    admin_tools_hide,
    admin_tools_toggle_enabled,
    admin_tools_bulk_enable,
    admin_tools_bulk_disable,
    admin_tools_bulk_delete,
    admin_tools_export_csv,
    admin_tools_export_redirect,
)

# Admin – Users
from modules.admin.routes.admin_users import (
    admin_users_page,
    admin_users_fragment_get,
    admin_users_new_modal,
    admin_users_detail_modal,
    admin_users_edit_modal,
    admin_users_delete_modal,
    admin_users_bulk_delete_modal,
    admin_users_bulk_export_modal,
    admin_users_bulk_confirm_modal,
    admin_users_toggle_verified,
    admin_users_create,
    admin_users_update,
    admin_users_delete,
    admin_users_bulk_activate,
    admin_users_bulk_suspend,
    admin_users_bulk_ban,
    admin_users_bulk_deactivate,
    admin_users_bulk_verify,
    admin_users_bulk_unverify,
    admin_users_bulk_delete,
    admin_users_bulk,
    admin_users_export_csv,
    admin_users_export_redirect,
    admin_users_check_email_unique,
    admin_users_sort,
)

# Admin – Departments
from modules.admin.routes.admin_departments import (
    admin_departments_page,
    admin_departments_fragment_get,
    admin_departments_new_modal,
    admin_departments_detail_modal,
    admin_departments_edit_modal,
    admin_departments_delete_modal,
    admin_departments_bulk_delete_modal,
    admin_departments_bulk_export_modal,
    admin_departments_create,
    admin_departments_update,
    admin_departments_delete,
    admin_departments_bulk_delete,
    admin_departments_bulk,
    admin_departments_export_csv,
    admin_departments_export_redirect,
    admin_departments_check_name_unique,
    admin_departments_sort,
)

# Admin – Documents
from modules.admin.routes.admin_documents import (
    admin_documents_page,
    admin_documents_fragment_get,
    admin_documents_new_modal,
    admin_documents_detail_modal,
    admin_documents_delete_modal,
    admin_documents_bulk_delete_modal,
    admin_documents_bulk_export_modal,
    admin_documents_create,
    admin_documents_delete,
    admin_documents_bulk_delete,
    admin_documents_bulk,
    admin_documents_export_csv,
    admin_documents_export_redirect,
    admin_documents_sort,
)

# Middleware & DB check
from core.middleware.csrf_guard import CsrfGuard
from core.middleware.maintenance_guard import MaintenanceGuardMiddleware
from core.middleware.auth_guard import AuthGuardMiddleware
from core.middleware.csrf_setter import CsrfCookieSetter
from core.db.engine import engine


# ──────────────────────────────────────────────────────────────────────────────
# ENV → giới hạn multipart & body
# ──────────────────────────────────────────────────────────────────────────────
def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default

# Tổng dung lượng request mong muốn (bytes) – dùng REQ_MAX làm "nguồn sự thật"
REQ_MAX = env_int("REQUEST_MAX_SIZE", env_int("MAX_UPLOAD_BYTES", 50 * 1024 * 1024))  # default 50MB

# Giới hạn cho multipart (nếu framework hỗ trợ)
MP_MAX_FILE   = env_int("MULTIPART_MAX_FILE_SIZE", REQ_MAX)                   # 1 file
MP_MAX_BODY   = env_int("MULTIPART_MAX_BODY_SIZE", REQ_MAX + 5 * 1024 * 1024) # tổng body (+ biên độ boundary)
MP_MAX_FILES  = env_int("MULTIPART_MAX_FILES", 10)
MP_MAX_FIELDS = env_int("MULTIPART_MAX_FIELDS", 200)

# Chuẩn bị kwargs tùy chọn cho Litestar(...) (chỉ truyền nếu framework hỗ trợ)
optional_app_kwargs = {}

# multipart_config: chỉ tạo khi class & tham số tồn tại
if MultipartConfig and ("multipart_config" in inspect.signature(Litestar).parameters):
    mc_kwargs = {}
    sig_mc = inspect.signature(MultipartConfig)
    if "max_file_size" in sig_mc.parameters:
        mc_kwargs["max_file_size"] = MP_MAX_FILE
    if "max_body_size" in sig_mc.parameters:
        mc_kwargs["max_body_size"] = MP_MAX_BODY
    if "max_files" in sig_mc.parameters:
        mc_kwargs["max_files"] = MP_MAX_FILES
    if "max_fields" in sig_mc.parameters:
        mc_kwargs["max_fields"] = MP_MAX_FIELDS
    if "max_field_size" in sig_mc.parameters:
        mc_kwargs["max_field_size"] = MP_MAX_BODY  # cho phép field text lớn (prompt dài)
    try:
        optional_app_kwargs["multipart_config"] = MultipartConfig(**mc_kwargs)
    except Exception as e:
        log.warning("MultipartConfig init failed (%s). Skip multipart_config.", e)

# request decoding config (nếu có)
if RequestDecodingConfig and ("request_decoder_config" in inspect.signature(Litestar).parameters):
    try:
        sig_rdc = inspect.signature(RequestDecodingConfig)
        rdc_kwargs = {}
        if "max_content_length" in sig_rdc.parameters:
            rdc_kwargs["max_content_length"] = MP_MAX_BODY
        if "max_request_body_size" in sig_rdc.parameters:
            rdc_kwargs["max_request_body_size"] = MP_MAX_BODY
        optional_app_kwargs["request_decoder_config"] = RequestDecodingConfig(**rdc_kwargs)
    except Exception as e:
        log.warning("RequestDecodingConfig init failed (%s). Skip request_decoder_config.", e)

# 🔴 App-level cap để tránh 413 sớm trước khi handler đọc form (nếu bản Litestar hỗ trợ tham số này)
if "request_max_body_size" in inspect.signature(Litestar).parameters:
    optional_app_kwargs["request_max_body_size"] = MP_MAX_BODY or REQ_MAX
    log.info("App request_max_body_size set -> %s", optional_app_kwargs["request_max_body_size"])

log.info(
    "Upload limits -> REQ_MAX=%s, MP_MAX_FILE=%s, MP_MAX_BODY=%s, MP_MAX_FILES=%s",
    REQ_MAX, MP_MAX_FILE, MP_MAX_BODY, MP_MAX_FILES
)

# ──────────────────────────────────────────────────────────────────────────────
# Startup & error
# ──────────────────────────────────────────────────────────────────────────────
async def test_db_connect() -> None:
    with engine.connect():
        print("✅ DB OK")

def not_found_handler(request: Request, exc: NotFoundException):
    return Template(template_name="error/404_error.html", status_code=404)

class StrictJinjaTemplateEngine(JinjaTemplateEngine):
    def __init__(self, directory: str, **kwargs) -> None:
        super().__init__(directory=directory, **kwargs)
        self.env = Environment(
            loader=FileSystemLoader(directory),
            autoescape=select_autoescape(["html", "xml"]),
            undefined=StrictUndefined,
        )
        self.env.globals.update(
            {
                "is_home": False,
                "asset_ver": None,
                "moe_default_label": "MoE",
                "moe_default_variant": "",
                "allowed_models_json": "[]",
                "moe_selected_json": "null",
                "moe_models": [],
            }
        )

@get("/favicon.ico")
def favicon() -> File:  # pragma: no cover
    return File(path=Path("static/images/favicon/favicon.ico"))

template_config = TemplateConfig(
    directory=[
        "modules/auth/templates",
        "modules/chat/templates",
        "modules/home/templates",
        "modules/legal/templates",
        "modules/admin/templates",
        "templates",
    ],
    engine=StrictJinjaTemplateEngine,
)

# ──────────────────────────────────────────────────────────────────────────────
# App
# ──────────────────────────────────────────────────────────────────────────────
app = Litestar(
    debug=True,
    exception_handlers={NotFoundException: not_found_handler},
    route_handlers=[
        # static / ping
        favicon,
        ping,
        devtools_fallback,
        # home
        home,
        # chat pages
        chat_index,
        chat_detail,
        # chat notify
        chat_notify_unread_count,
        chat_notify_list,
        chat_notify_read,
        chat_notify_read_all,
        chat_notify_detail,
        chat_notify_all,
        # chat sidebar (fragment)
        chat_sidebar_list,
        # MoE header
        list_models,
        header_fragment,
        select_model,
        # ✅ footer tools (dùng từ chat_api.py)
        chat_tools_list,
        chat_tools_select,
        # chat API
        chat_api_send,
        chat_api_message,
        chat_api_edit,
        chat_api_regenerate,
        chat_api_upload_limits,  # ✅ route upload limits (GET)
        # auth
        login_form,
        register_form,
        login,
        register,
        logout,
        google_oauth,
        google_oauth_callback,
        ms_oauth_start,
        ms_oauth_callback,
        verify_form,
        verify_submit,
        resend_code,
        api_validate_username,
        api_validate_email,
        forgot_password_form,
        forgot_password_submit,
        forgot_password_sent_page,
        reset_password_form,
        reset_password_submit,
        # admin home / security
        admin_home,
        admin_home_fragment,
        admin_security,
        admin_security_fragment_get,
        admin_security_fragment,
        # admin notify
        admin_notify_page,
        admin_notify_fragment_get,
        admin_notify_new_modal,
        admin_notify_create,
        admin_notify_detail_modal,
        admin_notify_edit_modal,
        admin_notify_update,
        admin_notify_hide,
        admin_notify_hide_post,
        admin_notify_delete_modal,
        admin_notify_bulk_hide,
        admin_notify_export_csv,
        admin_notify_calendar_modal,
        admin_notify_bulk_delete_modal,
        admin_notify_bulk_export_modal,
        # admin models
        admin_models_page,
        admin_models_fragment_get,
        admin_models_new_modal,
        admin_models_edit_modal,
        admin_models_detail_modal,
        admin_models_delete_modal,
        admin_models_bulk_delete_modal,
        admin_models_bulk_export_modal,
        admin_models_create,
        admin_models_update,
        admin_models_retire,
        admin_models_toggle_enabled,
        admin_models_bulk_enable,
        admin_models_bulk_disable,
        admin_models_bulk_delete,
        admin_models_export_csv,
        admin_models_export_redirect,
        # admin tools
        admin_tools_page,
        admin_tools_fragment_get,
        admin_tools_new_modal,
        admin_tools_edit_modal,
        admin_tools_detail_modal,
        admin_tools_delete_modal,
        admin_tools_bulk_delete_modal,
        admin_tools_bulk_export_modal,
        admin_tools_create,
        admin_tools_update,
        admin_tools_hide,
        admin_tools_toggle_enabled,
        admin_tools_bulk_enable,
        admin_tools_bulk_disable,
        admin_tools_bulk_delete,
        admin_tools_export_csv,
        admin_tools_export_redirect,
        # admin users
        admin_users_page,
        admin_users_fragment_get,
        admin_users_new_modal,
        admin_users_detail_modal,
        admin_users_edit_modal,
        admin_users_delete_modal,
        admin_users_bulk_delete_modal,
        admin_users_bulk_export_modal,
        admin_users_bulk_confirm_modal,
        admin_users_toggle_verified,
        admin_users_create,
        admin_users_update,
        admin_users_delete,
        admin_users_bulk_activate,
        admin_users_bulk_suspend,
        admin_users_bulk_ban,
        admin_users_bulk_deactivate,
        admin_users_bulk_verify,
        admin_users_bulk_unverify,
        admin_users_bulk_delete,
        admin_users_bulk,
        admin_users_export_csv,
        admin_users_export_redirect,
        admin_users_check_email_unique,
        admin_users_sort,
        # admin departments
        admin_departments_page,
        admin_departments_fragment_get,
        admin_departments_new_modal,
        admin_departments_detail_modal,
        admin_departments_edit_modal,
        admin_departments_delete_modal,
        admin_departments_bulk_delete_modal,
        admin_departments_bulk_export_modal,
        admin_departments_create,
        admin_departments_update,
        admin_departments_delete,
        admin_departments_bulk_delete,
        admin_departments_bulk,
        admin_departments_export_csv,
        admin_departments_export_redirect,
        admin_departments_check_name_unique,
        admin_departments_sort,
        # admin documents
        admin_documents_page,
        admin_documents_fragment_get,
        admin_documents_new_modal,
        admin_documents_detail_modal,
        admin_documents_delete_modal,
        admin_documents_bulk_delete_modal,
        admin_documents_bulk_export_modal,
        admin_documents_create,
        admin_documents_delete,
        admin_documents_bulk_delete,
        admin_documents_bulk,
        admin_documents_export_csv,
        admin_documents_export_redirect,
        admin_documents_sort,
        # legal
        terms_page,
        privacy_page,
    ],
    middleware=[
        (
            CsrfGuard,
            {
                "skip_paths": [
                    "/static",
                    "/images",
                    "/js",
                    "/css",
                    "/favicon.ico",
                    # Auth (forms/pages)
                    "/auth/oauth",
                    "/auth/login",
                    "/auth/register",
                    "/auth/verify",
                    "/auth/resend-code",
                    "/auth/forgot-password",
                    "/auth/reset-password",
                    # Chat notifications (GET only)
                    "/chat/notify/unread_count",
                    "/chat/notify/list",
                    "/chat/notify/read",
                    "/chat/notify/read_all",
                    # Chat sidebar fragment (GET)
                    "/chat/sidebar/list",
                    # MoE header GET endpoints
                    "/chat/models",
                    "/chat/header/fragment",
                    # Footer tools GET
                    "/chat/tools",
                    # ⚙️ Upload limits (GET)
                    "/chat/api/upload_limits",
                    # Admin groups (GET only)
                    "/admin/notify", "/admin/notify/fragment",
                    "/admin/models", "/admin/models/fragment",
                    "/admin/tools", "/admin/tools/fragment",
                    "/admin/users", "/admin/users/fragment",
                    "/admin/departments", "/admin/departments/fragment",
                    "/admin/documents", "/admin/documents/fragment",
                    # ❌ Không skip các POST/PUT/DELETE khác.
                ],
            },
        ),
        MaintenanceGuardMiddleware,
        AuthGuardMiddleware,
        CsrfCookieSetter,
    ],
    on_startup=[test_db_connect],
    template_config=template_config,
    static_files_config=[
        StaticFilesConfig(
            path="/static",
            directories=[
                "static",
                "modules/auth/static",
                "modules/chat/static",
                "modules/home/static",
                "modules/legal/static",
                "modules/admin/static",
            ],
        ),
        StaticFilesConfig(path="/images", directories=["static/images"]),
        StaticFilesConfig(path="/js", directories=["static/js"]),
        StaticFilesConfig(path="/css", directories=["static/css"]),
    ],
    # ✅ chỉ truyền khi framework hỗ trợ (đã build ở optional_app_kwargs)
    **optional_app_kwargs,
)

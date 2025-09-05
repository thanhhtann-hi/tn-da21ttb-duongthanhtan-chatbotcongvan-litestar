# file: src/modules/auth/routes/auth.py
# updated: 2025-08-13
# note: [AUTH-000] Accept scrypt & pbkdf2 hashes; auto-upgrade pbkdf2→scrypt on login; force scrypt on register.

from __future__ import annotations

import datetime as dt
import re
import uuid
from typing import Annotated, Dict, Tuple, Union, Optional

from litestar import get, post, Request
from litestar.response import Template, Response, Redirect
from litestar.params import Body
from litestar.enums import RequestEncodingType
from litestar.exceptions import HTTPException
from litestar.background_tasks import BackgroundTask
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from werkzeug.security import generate_password_hash, check_password_hash

from core.db.engine import SessionLocal
from core.db.models import (
    User,
    UserSettings,
    VerifyCode,
    SystemSettings,
    PasswordResetToken,
)
from shared.mailer import send_mail
from shared.verify_helpers import _gen_code, _email_html
from shared.secure_cookie import (
    set_secure_cookie,
    get_secure_cookie,
    delete_secure_cookie,
    generate_csrf_token,
    set_csrf_cookie,
)

# [AUTH-001] Cache settings
_NO_CACHE = {"Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache"}

# [AUTH-002] Regex helpers
_USERNAME_RE         = re.compile(r"^[a-z0-9]+$")
_ALPHA_RE, _DIGIT_RE = re.compile(r"[a-z]"), re.compile(r"\d")
_EMAIL_RE            = re.compile(r"^[\w\.-]+@([\w\-]+\.)+[a-zA-Z]{2,63}$")
_MIN_LEN, _MAX_LEN   = 3, 30

# [AUTH-003] Hash checker (Werkzeug)
def is_supported_hash(hashval: str) -> bool:
    """
    [AUTH-003-1] Hỗ trợ các hash hợp lệ của Werkzeug hiện nay:
        - scrypt (mặc định mới)
        - pbkdf2:sha256 (tương thích ngược)
    """
    if not hashval:
        return False
    return hashval.startswith(("scrypt:", "pbkdf2:sha256:"))

# [AUTH-004] Flag helpers
def __password_flow_enabled() -> bool:
    """[AUTH-004-1] True khi system_login == TRUE và domain_mode == 'none'."""
    with SessionLocal() as db:
        sys: SystemSettings | None = db.query(SystemSettings).first()
        return bool(sys and sys.system_login and sys.system_domain_mode == "none")

def __register_allowed() -> bool:
    """[AUTH-004-2] True khi system_register == TRUE và domain_mode == 'none'."""
    with SessionLocal() as db:
        sys: SystemSettings | None = db.query(SystemSettings).first()
        return bool(sys and sys.system_register and sys.system_domain_mode == "none")

# [AUTH-005] Misc helpers
def _is_htmx(req: Request) -> bool:
    return req.headers.get("hx-request", "").lower() == "true"

def _err(req: Request, msg: str) -> Response:
    """[AUTH-005-1] Trả lỗi text cho HTMX, else raise HTTPException."""
    if _is_htmx(req):
        return Response(msg, status_code=200, media_type="text/plain")
    raise HTTPException(status_code=400, detail=msg)

def _username_valid(name: str) -> Tuple[bool, str]:
    if not (_MIN_LEN <= len(name) <= _MAX_LEN):
        return False, f"Độ dài {_MIN_LEN}-{_MAX_LEN} ký tự"
    if not _USERNAME_RE.fullmatch(name):
        return False, "Chỉ chữ thường và số, không dấu hay ký tự đặc biệt."
    if not (_ALPHA_RE.search(name) and _DIGIT_RE.search(name)):
        return False, "Phải có cả chữ và số"
    return True, ""

def _client_ip(req: Request) -> str | None:
    xff = req.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    xri = req.headers.get("X-Real-IP", "")
    if xri:
        return xri.strip()
    return getattr(req.client, "host", None)

# [AUTH-006] Gửi / cập nhật mã xác minh
def _send_verify_code(db, user_id: str, email: str) -> Tuple[Optional[BackgroundTask], int]:
    now = dt.datetime.now(dt.timezone.utc)

    def _aware(ts: dt.datetime) -> dt.datetime:
        return ts if ts.tzinfo else ts.replace(tzinfo=dt.timezone.utc)

    vc: VerifyCode | None = db.scalars(
        select(VerifyCode).where(VerifyCode.vc_user_id == user_id)
    ).first()
    if vc:
        wait_current = 60 * vc.vc_send_count
        elapsed = (now - _aware(vc.vc_created_at)).total_seconds()
        if elapsed < wait_current:
            return None, int(wait_current - elapsed)

    code = _gen_code()
    expires = now + dt.timedelta(minutes=10)
    if vc:
        vc.vc_code = code
        vc.vc_attempts = 0
        vc.vc_max_attempt = max(vc.vc_max_attempt - 1, 1)
        vc.vc_send_count += 1
        vc.vc_expires_at = expires
        vc.vc_created_at = now
        wait_next = 60 * vc.vc_send_count
    else:
        db.add(VerifyCode(
            vc_id=str(uuid.uuid4()),
            vc_user_id=user_id,
            vc_email=email,
            vc_code=code,
            vc_attempts=0,
            vc_max_attempt=5,
            vc_send_count=1,
            vc_expires_at=expires,
            vc_created_at=now,
        ))
        wait_next = 60
    db.commit()
    task = BackgroundTask(send_mail, to=email, subject="Mã xác minh TvuMoE", html_body=_email_html(code))
    return task, wait_next

# ─────────────────────────────── GET /auth/login ───────────────────────────
# [AUTH-007] GET login form
@get("/auth/login")
def login_form(request: Request) -> Template | Redirect:
    """[AUTH-007-1] Luôn hiển thị trang login: OAuth + email/password nếu bật."""
    uid = get_secure_cookie(request)
    if uid:
        with SessionLocal() as db:
            if db.get(User, uid):
                return Redirect("/", status_code=302)

    # [AUTH-007-2] Đọc config từ SystemSettings
    with SessionLocal() as db:
        sys = db.query(SystemSettings).first()

    # [AUTH-007-3] Chỉ hiển thị form email/password & cho phép đăng ký khi domain_mode == 'none'
    domain_mode = sys.system_domain_mode if sys else "none"
    show_password_form = domain_mode == "none"
    show_register_link = bool(sys and sys.system_register and domain_mode == "none")

    # [AUTH-007-4] Render login page / fragment
    tpl = "auth/login/login_fragment.html" if _is_htmx(request) else "auth/login/login.html"
    token = request.cookies.get("csrftoken") or generate_csrf_token()
    resp = Template(
        tpl,
        context={
            "csrf_token": token,
            "show_password_form": show_password_form,
            "show_register_link": show_register_link,
            "system_domain_mode": domain_mode,
        },
        headers={**_NO_CACHE, "HX-Trigger": "updateTitle"},
    )
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp

# ───────────────────────────── GET /auth/register ──────────────────────────
# [AUTH-008] GET register form
@get("/auth/register")
def register_form(request: Request) -> Template | Redirect:
    if not __register_allowed():
        return Template("error/404_error.html", status_code=404)

    uid = get_secure_cookie(request)
    if uid:
        with SessionLocal() as db:
            if db.get(User, uid):
                return Redirect("/", status_code=302)

    tpl = "auth/register/register_fragment.html" if _is_htmx(request) else "auth/register/register.html"
    token = request.cookies.get("csrftoken") or generate_csrf_token()
    resp = Template(tpl, context={"csrf_token": token}, headers={**_NO_CACHE, "HX-Trigger": "updateTitle"})
    set_csrf_cookie(resp, token, secure=request.url.scheme == "https")
    return resp

# ─────────────────────────────── POST /auth/login ───────────────────────────
# [AUTH-009] POST login
@post("/auth/login")
def login(
    request: Request,
    data: Annotated[Dict[str, str], Body(media_type="application/x-www-form-urlencoded")],
) -> Union[Response, Redirect]:
    if not __password_flow_enabled():
        return Template("error/404_error.html", status_code=404)

    # [AUTH-009-1] Validate input
    email = data.get("email", "").strip()
    pw    = data.get("password", "")
    if not email:
        return _err(request, "Vui lòng nhập email")
    if not _EMAIL_RE.fullmatch(email):
        return _err(request, "Địa chỉ email không hợp lệ")
    if not pw:
        return _err(request, "Vui lòng nhập mật khẩu")

    with SessionLocal() as db:
        # [AUTH-009-2] Tìm user theo email
        user = db.scalars(select(User).where(User.user_email == email)).first()
        if not user:
            return _err(request, "Tài khoản không tồn tại")

        # [AUTH-009-3] Chỉ chấp nhận hash hợp lệ (scrypt / pbkdf2:sha256)
        if not is_supported_hash(user.user_password_hash or ""):
            return _err(
                request,
                "⚠️ Định dạng mật khẩu không được hệ thống hỗ trợ.\n"
                "Vui lòng dùng werkzeug.security.generate_password_hash (scrypt hoặc pbkdf2:sha256).",
            )

        # [AUTH-009-4] Kiểm tra mật khẩu
        if not check_password_hash(user.user_password_hash, pw):
            return _err(request, "Sai mật khẩu")

        # [AUTH-009-5] Auto-upgrade: pbkdf2 → scrypt sau khi login thành công
        if user.user_password_hash.startswith("pbkdf2:sha256:"):
            user.user_password_hash = generate_password_hash(pw, method="scrypt")
            db.commit()

        # [AUTH-009-6] Nếu email chưa verify → gửi mã & chuyển trang verify
        if not user.user_email_verified:
            task, _ = _send_verify_code(db, user.user_id, user.user_email)
            url      = f"/auth/verify?e={user.user_email}&uid={user.user_id}"
            uid      = user.user_id
            csrf_tok = generate_csrf_token()

            if _is_htmx(request):
                resp = Response("", status_code=200, media_type="text/plain", background=task)
                resp.headers["HX-Redirect"] = url
                set_secure_cookie(resp, uid, secure=request.url.scheme == "https")
                set_csrf_cookie(resp, csrf_tok, secure=request.url.scheme == "https")
                return resp

            resp = Redirect(url, status_code=303, background=task)
            set_secure_cookie(resp, uid, secure=request.url.scheme == "https")
            set_csrf_cookie(resp, csrf_tok, secure=request.url.scheme == "https")
            return resp

        # [AUTH-009-7] Kiểm tra trạng thái user
        if user.user_status != "active":
            return _err(
                request,
                {
                    "suspended":   "Tài khoản đã bị tạm khóa!",
                    "banned":      "Tài khoản đã bị cấm!",
                    "deactivated": "Tài khoản đã bị vô hiệu hóa!",
                }.get(user.user_status, "Tài khoản không hợp lệ!"),
            )

        # [AUTH-009-8] Đồng bộ IP / timezone & commit khi có thay đổi
        ip_addr = _client_ip(request)
        tz      = (request.headers.get("X-Timezone") or "").strip() or None
        updated = False
        if ip_addr and ip_addr != user.user_register_ip:
            user.user_register_ip = ip_addr
            updated = True
        if not user.settings:
            db.add(UserSettings(setting_user_id=user.user_id, setting_timezone=tz))
            updated = True
        elif tz and tz != user.settings.setting_timezone:
            user.settings.setting_timezone = tz
            updated = True
        if updated:
            db.commit()
        uid = user.user_id

    # [AUTH-009-9] Set cookie & redirect về trang chủ
    csrf_tok = generate_csrf_token()
    if _is_htmx(request):
        resp = Response("", status_code=200, media_type="text/plain")
        resp.headers["HX-Redirect"] = "/"
    else:
        resp = Redirect("/", status_code=302)
    set_secure_cookie(resp, uid, secure=request.url.scheme == "https")
    set_csrf_cookie(resp, csrf_tok, secure=request.url.scheme == "https")
    return resp

# ─────────────────────────────── POST /auth/register ───────────────────────────
# [AUTH-010] POST register
@post("/auth/register")
def register(
    request: Request,
    data: Annotated[Dict[str, str], Body(media_type=RequestEncodingType.URL_ENCODED)],
) -> Union[Response, Redirect]:
    if not __register_allowed():
        return Template("error/404_error.html", status_code=404)

    # [AUTH-010-1] Validate input
    username = data.get("username", "").strip()
    email    = data.get("email", "").strip()
    pw       = data.get("password", "")
    ok, msg  = _username_valid(username)
    if not ok:
        return _err(request, msg)
    if not email or len(pw) < 6:
        return _err(request, "Dữ liệu không hợp lệ")

    ip_addr  = _client_ip(request)
    timezone = (request.headers.get("X-Timezone") or "").strip() or None
    now_utc  = dt.datetime.now(dt.timezone.utc)

    with SessionLocal() as db:
        user = db.scalars(select(User).where(User.user_name == username)).first()
        if user:
            # [AUTH-010-2] Trường hợp username đã tồn tại nhưng chưa verify email
            if user.user_email_verified:
                return _err(request, "Tên đã tồn tại!")
            if email != user.user_email:
                dup = db.scalars(
                    select(User).where(
                        User.user_email == email,
                        User.user_email_verified.is_(True),
                    )
                ).first()
                if dup:
                    return _err(request, "Email đã được sử dụng")
                user.user_email = email
            # [AUTH-010-3] Ép scrypt khi cập nhật mật khẩu
            user.user_password_hash = generate_password_hash(pw, method="scrypt")
            user.user_register_ip   = ip_addr
            user.user_updated_at    = now_utc
            if not user.settings:
                db.add(UserSettings(setting_user_id=user.user_id, setting_timezone=timezone))
            else:
                user.settings.setting_timezone = timezone
            uid = user.user_id
        else:
            # [AUTH-010-4] Tạo mới: ép scrypt ngay từ đầu
            dup = db.scalars(
                select(User).where(
                    User.user_email == email,
                    User.user_email_verified.is_(True),
                )
            ).first()
            if dup:
                return _err(request, "Email đã được sử dụng")
            uid = str(uuid.uuid4())
            db.add(User(
                user_id            = uid,
                user_name          = username,
                user_email         = email,
                user_password_hash = generate_password_hash(pw, method="scrypt"),
                user_role          = "user",
                user_status        = "active",
                user_register_ip   = ip_addr,
                user_created_at    = now_utc,
                user_updated_at    = now_utc,
            ))
            db.add(UserSettings(
                setting_user_id    = uid,
                setting_theme      = "system",
                setting_timezone   = timezone,
                setting_created_at = now_utc,
                setting_updated_at = now_utc,
            ))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return _err(request, "Tên hoặc email đã tồn tại!")
        task, _ = _send_verify_code(db, uid, email)

    # [AUTH-010-5] Redirect sang verify
    url = f"/auth/verify?e={email}&uid={uid}"
    if _is_htmx(request):
        resp = Response("", status_code=200, media_type="text/plain", background=task)
        resp.headers["HX-Redirect"] = url
        return resp
    return Redirect(url, status_code=303, background=task)

# ─────────────────────────────── Validate APIs ──────────────────────────────
# [AUTH-011] Validate username
@get("/api/validate-username")
def api_validate_username(u: str | None = None) -> Response:
    username = (u or "").strip()
    ok, msg  = _username_valid(username)
    if not ok:
        return Response({"valid": False, "message": msg})
    with SessionLocal() as db:
        row = db.scalars(select(User.user_email_verified).where(User.user_name == username)).first()
    if row is None:
        return Response({"valid": True, "message": ""})
    if row:
        return Response({"valid": False, "message": "Tên đã tồn tại"})
    return Response({"valid": True, "message": "Tên đang chờ xác minh"})

# [AUTH-012] Validate email
@get("/api/validate-email")
def api_validate_email(e: str | None = None) -> Response:
    email = (e or "").strip()
    if not email:
        return Response({"valid": False, "message": "Không được để trống"})
    with SessionLocal() as db:
        row = db.scalars(select(User.user_email_verified).where(User.user_email == email)).first()
    if row is None:
        return Response({"valid": True, "message": ""})
    if row:
        return Response({"valid": False, "message": "Email đã được sử dụng"})
    return Response({"valid": True, "message": "Email đang chờ xác minh"})

# ─────────────────────────────── /auth/logout ───────────────────────────────
# [AUTH-013] Logout
@get("/auth/logout")
def logout() -> Redirect:
    resp = Redirect("/", status_code=302)
    delete_secure_cookie(resp)
    resp.delete_cookie("csrftoken", path="/")
    return resp

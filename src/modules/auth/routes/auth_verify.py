# 📁 src/modules/auth/routes/auth_verify.py
# 🕒 Last updated: 2025-07-09 00:50
# =============================================================================
# Xác minh email – quota sai dần: 5 → 4 → 3 → ...
# • Hot-fix timezone (naive ↔︎ aware) – tránh TypeError khi trừ datetime
# • Chỉ cho phép xác minh khi system_login == TRUE
# • Cache-Control: no-store – chống back page hiển thị lại form cũ
# • Đổi template từ keyword-arg name= → positional argument
# =============================================================================

from __future__ import annotations

import datetime as dt
import logging
import uuid
from typing import Annotated, Optional

from litestar import get, post, Request
from litestar.response import Template, Response
from litestar.background_tasks import BackgroundTask
from litestar.enums import RequestEncodingType
from litestar.params import Body
from litestar.exceptions import HTTPException
from sqlalchemy import select, update, delete

from core.db.engine import SessionLocal
from core.db.models import User, VerifyCode, SystemSettings
from shared.mailer import send_mail
from shared.verify_helpers import _gen_code, _email_html

log = logging.getLogger(__name__)


def _aware(ts: dt.datetime) -> dt.datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=dt.timezone.utc)

_NO_CACHE = {
    "Cache-Control": "no-store, must-revalidate",
    "Pragma": "no-cache",
}

def _safe_send_mail(**kwargs) -> None:
    try:
        send_mail(**kwargs)
    except Exception as exc:
        log.warning("Gửi mail thất bại: %s", exc, exc_info=True)

def _err(request: Request, msg: str, *, headers: dict[str, str] | None = None) -> Response:
    if request.headers.get("hx-request", "").lower() == "true":
        return Response(msg, status_code=200, media_type="text/plain", headers=headers or {})
    raise HTTPException(status_code=400, detail=msg)

def _is_verify_flow_enabled() -> bool:
    with SessionLocal() as db:
        sys: SystemSettings | None = db.query(SystemSettings).first()
        return bool(sys and sys.system_login)

@get("/auth/verify")
def verify_form(request: Request, e: str, uid: str) -> Template | Response:
    if not _is_verify_flow_enabled():
        return Template("error/404_error.html", status_code=404)

    is_htmx = request.headers.get("hx-request", "").lower() == "true"
    tpl = "auth/verify/verify_fragment.html" if is_htmx else "auth/verify/verify.html"

    with SessionLocal() as db:
        user = db.get(User, uid)
        if not user or user.user_status != "active":
            return Response(None, status_code=204, headers={**_NO_CACHE, "HX-Redirect": "/auth/login"})

        verified = user.user_email_verified
        wait = 0
        if not verified:
            now = dt.datetime.now(dt.timezone.utc)
            vc = db.scalars(select(VerifyCode).where(VerifyCode.vc_user_id == uid)).first()
            if vc:
                elapsed = (now - _aware(vc.vc_created_at)).total_seconds()
                remain = 60 * vc.vc_send_count - elapsed
                wait = int(remain) if remain > 0 else 0

    return Template(
        tpl,
        context={"email": e, "uid": uid, "wait": wait, "verified": verified},
        headers={**_NO_CACHE, "HX-Trigger": "updateTitle"},
    )

@post("/auth/verify")
def verify_submit(
    request: Request,
    data: Annotated[dict[str, str], Body(media_type=RequestEncodingType.URL_ENCODED)],
) -> Response:
    if not _is_verify_flow_enabled():
        return Template("error/404_error.html", status_code=404)

    code = data.get("code", "").strip()
    uid = data.get("uid", "").strip()
    is_htmx = request.headers.get("hx-request", "").lower() == "true"

    now = dt.datetime.now(dt.timezone.utc)
    with SessionLocal() as db:
        user = db.get(User, uid)
        if not user or user.user_status != "active":
            return _err(request, "Tài khoản không hợp lệ hoặc đã bị khóa")

        if user.user_email_verified:
            if is_htmx:
                return _err(request, "Bạn đã xác minh Email rồi! Vui lòng quay lại Đăng nhập")
            return Response(None, status_code=204, headers={"HX-Redirect": "/auth/login"})

        vc = db.scalars(select(VerifyCode).where(VerifyCode.vc_user_id == uid)).first()
        if not vc or vc.vc_expires_at <= now:
            return _err(request, "Mã đã hết hạn! Vui lòng gửi lại mã.", headers={"X-Expired": "true"})

        if vc.vc_attempts >= vc.vc_max_attempt:
            return _err(
                request,
                f"Bạn đã nhập sai quá {vc.vc_max_attempt} lần! Vui lòng gửi lại mã.",
                headers={"X-Locked": "true"},
            )

        if code != vc.vc_code:
            vc.vc_attempts += 1
            db.commit()
            remaining = vc.vc_max_attempt - vc.vc_attempts
            return _err(
                request,
                f"Mã không hợp lệ ({vc.vc_attempts}/{vc.vc_max_attempt})",
                headers={"X-Attempts-Left": str(max(remaining, 0))},
            )

        db.execute(update(User).where(User.user_id == uid).values(user_email_verified=True))
        db.execute(delete(VerifyCode).where(VerifyCode.vc_user_id == uid))
        db.commit()

    return Response(None, status_code=204, headers={"HX-Redirect": "/auth/login"})

@post("/auth/resend-code")
def resend_code(
    data: Annotated[dict[str, str], Body(media_type=RequestEncodingType.URL_ENCODED)],
) -> Response:
    if not _is_verify_flow_enabled():
        return Template("error/404_error.html", status_code=404)

    uid = data.get("uid", "")
    email = data.get("email", "")
    now = dt.datetime.now(dt.timezone.utc)

    with SessionLocal() as db:
        user = db.get(User, uid)
        if not user or user.user_email != email or user.user_status != "active":
            raise HTTPException(status_code=400, detail="Không tìm thấy người dùng hoặc đã bị khóa")

        vc = db.scalars(select(VerifyCode).where(VerifyCode.vc_user_id == uid)).first()

        wait_current = 60 * (vc.vc_send_count if vc else 1)
        elapsed = (now - (_aware(vc.vc_created_at) if vc else now)).total_seconds()
        if vc and (remain := wait_current - elapsed) > 0:
            raise HTTPException(status_code=429, detail=f"Hãy đợi {int(remain)}s rồi thử lại")

        new_code = _gen_code()
        expires = now + dt.timedelta(minutes=10)

        if vc:
            vc.vc_code = new_code
            vc.vc_attempts = 0
            vc.vc_max_attempt = max(vc.vc_max_attempt - 1, 1)
            vc.vc_send_count += 1
            vc.vc_expires_at = expires
            vc.vc_created_at = now
            wait_next = 60 * vc.vc_send_count
        else:
            vc = VerifyCode(
                vc_id=str(uuid.uuid4()),
                vc_user_id=uid,
                vc_email=email,
                vc_code=new_code,
                vc_attempts=0,
                vc_max_attempt=5,
                vc_send_count=1,
                vc_expires_at=expires,
                vc_created_at=now,
            )
            db.add(vc)
            wait_next = 60

        db.commit()

    task = BackgroundTask(
        _safe_send_mail,
        to=email,
        subject="Mã xác minh TvuMoE",
        html_body=_email_html(new_code),
    )
    return Response(
        "",
        status_code=202,
        background=task,
        headers={"X-Wait-Seconds": str(wait_next)},
    )
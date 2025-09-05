# file: src/modules/chat/routes/chat_notify.py
# updated: 2025-08-15
# note: thêm endpoint đếm unread

from __future__ import annotations

# [A] Imports
from litestar import get, post, Request
from litestar.response import Template, Response
from sqlalchemy import select, update, exists, literal, DateTime, func
from sqlalchemy.orm import selectinload
from sqlalchemy.dialects.postgresql import insert as pg_insert

from core.db.engine import SessionLocal
from core.db.models import NotificationRecipient, User, SystemNotification
from shared.secure_cookie import get_secure_cookie
from shared.timezone import now_tz


# [B] Utils
def _is_htmx(req: Request) -> bool:
    return (req.headers.get("HX-Request") or "").lower() == "true"

def _empty_notify_fragment() -> Template:
    return Template(
        template_name="partials/chat_notify_list_fragment.html",
        context={"notifications": []},
        headers={"Cache-Control": "no-store", "HX-Push-Url": "false", "Vary": "HX-Request"},
    )

def _split_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in text.replace("\r\n", "\n").strip().split("\n\n") if p.strip()]


# [0] GET /chat/notify/unread_count – trả về số lượng chưa đọc (JSON)
@get("/chat/notify/unread_count")
def chat_notify_unread_count(request: Request) -> dict[str, int]:
    uid = get_secure_cookie(request)
    if not uid:
        # Không lộ trạng thái auth; UI sẽ hiểu là 0
        return {"unread": 0}

    with SessionLocal() as db:
        user = db.get(User, uid)
        if not user:
            return {"unread": 0}

        # [0.1] Bổ sung recipient còn thiếu (giống /list) để badge hiển thị ngay
        selectable = (
            select(SystemNotification.notify_id, literal(uid), literal(None, type_=DateTime(timezone=True)))
            .where(
                SystemNotification.notify_visible.is_(True),
                SystemNotification.notify_target_roles.any(user.user_role),
                ~exists().where(
                    (NotificationRecipient.notify_id == SystemNotification.notify_id)
                    & (NotificationRecipient.user_id == uid)
                ),
            )
            .order_by(SystemNotification.notify_created_at.desc())
            .limit(200)
        )
        db.execute(
            pg_insert(NotificationRecipient)
            .from_select(["notify_id", "user_id", "read_at"], selectable)
            .on_conflict_do_nothing(index_elements=["notify_id", "user_id"])
        )
        db.commit()

        # [0.2] Đếm số chưa đọc, chỉ những notify còn visible & đúng role
        count_stmt = (
            select(func.count())
            .select_from(NotificationRecipient)
            .join(NotificationRecipient.notification)
            .where(
                NotificationRecipient.user_id == uid,
                NotificationRecipient.read_at.is_(None),
                SystemNotification.notify_visible.is_(True),
                SystemNotification.notify_target_roles.any(user.user_role),
            )
        )
        unread = db.scalar(count_stmt) or 0

    return {"unread": int(unread)}


# [1] GET /chat/notify/list – 5 notify mới nhất (fragment HTMX)
@get("/chat/notify/list")
def chat_notify_list(request: Request) -> Template | Response:
    # [1.0] Chỉ phục vụ HTMX
    if not _is_htmx(request):
        return Response(status_code=404, content=b"")

    uid = get_secure_cookie(request)
    if not uid:
        return _empty_notify_fragment()

    with SessionLocal() as db:
        user = db.get(User, uid)
        if not user:
            return _empty_notify_fragment()

        # [1.1] Bổ sung recipient còn thiếu (idempotent)
        selectable = (
            select(SystemNotification.notify_id, literal(uid), literal(None, type_=DateTime(timezone=True)))
            .where(
                SystemNotification.notify_visible.is_(True),
                SystemNotification.notify_target_roles.any(user.user_role),
                ~exists().where(
                    (NotificationRecipient.notify_id == SystemNotification.notify_id)
                    & (NotificationRecipient.user_id == uid)
                ),
            )
            .order_by(SystemNotification.notify_created_at.desc())
            .limit(200)
        )
        db.execute(
            pg_insert(NotificationRecipient)
            .from_select(["notify_id", "user_id", "read_at"], selectable)
            .on_conflict_do_nothing(index_elements=["notify_id", "user_id"])
        )
        db.commit()

        # [1.2] Lấy danh sách hiển thị
        stmt = (
            select(NotificationRecipient)
            .join(NotificationRecipient.notification)
            .options(selectinload(NotificationRecipient.notification))
            .where(
                NotificationRecipient.user_id == uid,
                SystemNotification.notify_visible.is_(True),
                SystemNotification.notify_target_roles.any(user.user_role),
            )
            .order_by(SystemNotification.notify_created_at.desc())
            .limit(5)
        )
        recipients = db.scalars(stmt).all()

    return Template(
        template_name="partials/chat_notify_list_fragment.html",
        context={"notifications": recipients},
        headers={"Cache-Control": "no-store", "HX-Push-Url": "false", "Vary": "HX-Request"},
    )


# [2] POST /chat/notify/read – đánh dấu 1 notify đã đọc
@post("/chat/notify/read")
async def chat_notify_read(request: Request) -> Response:
    # [2.0] Nhận form và đánh dấu
    form_data = await request.form()
    uid = get_secure_cookie(request)
    nid = form_data.get("notify_id")
    if not (uid and nid):
        return Response(status_code=204, content=b"")

    with SessionLocal() as db:
        user = db.get(User, uid)
        if not user:
            return Response(status_code=204, content=b"")

        stmt = (
            select(NotificationRecipient)
            .join(NotificationRecipient.notification)
            .options(selectinload(NotificationRecipient.notification))
            .where(
                NotificationRecipient.user_id == uid,
                NotificationRecipient.notify_id == nid,
                SystemNotification.notify_visible.is_(True),
                SystemNotification.notify_target_roles.any(user.user_role),
            )
        )
        rec = db.scalars(stmt).first()
        if rec and not rec.read_at:
            rec.read_at = now_tz()
            db.commit()

    return Response(status_code=204, content=b"")


# [3] POST /chat/notify/read_all – đánh dấu tất cả đã đọc
@post("/chat/notify/read_all")
async def chat_notify_read_all(request: Request) -> Response:
    uid = get_secure_cookie(request)
    if not uid:
        return Response(status_code=204, content=b"")

    with SessionLocal() as db:
        user = db.get(User, uid)
        if not user:
            return Response(status_code=204, content=b"")

        visible_exists = (
            exists()
            .where(SystemNotification.notify_id == NotificationRecipient.notify_id)
            .where(SystemNotification.notify_visible.is_(True))
            .where(SystemNotification.notify_target_roles.any(user.user_role))
        )

        db.execute(
            update(NotificationRecipient)
            .where(
                NotificationRecipient.user_id == uid,
                NotificationRecipient.read_at.is_(None),
                visible_exists,
            )
            .values(read_at=now_tz())
        )
        db.commit()

    return Response(status_code=204, content=b"")


# [4] GET /chat/notify/detail/{id} – chỉ trả modal fragment cho HTMX
@get("/chat/notify/detail/{notify_id:str}")
def chat_notify_detail(request: Request, notify_id: str) -> Template | Response:
    # [4.0] Chỉ phục vụ HTMX để tránh “trang thô”
    if not _is_htmx(request):
        return Response(status_code=404, content=b"")

    uid = get_secure_cookie(request)
    if not uid:
        return Response(status_code=401, content=b"")

    with SessionLocal() as db:
        user = db.get(User, uid)
        if not user:
            return Response(status_code=404, content=b"")

        # [4.1] Tìm recipient
        stmt = (
            select(NotificationRecipient)
            .join(NotificationRecipient.notification)
            .options(selectinload(NotificationRecipient.notification).selectinload(SystemNotification.created_by))
            .where(
                NotificationRecipient.user_id == uid,
                NotificationRecipient.notify_id == notify_id,
                SystemNotification.notify_visible.is_(True),
                SystemNotification.notify_target_roles.any(user.user_role),
            )
        )
        rec = db.scalars(stmt).first()

        # [4.2] Nếu chưa có: tạo cho user (nếu notify hợp lệ)
        if not rec:
            sn = db.scalars(
                select(SystemNotification)
                .where(
                    SystemNotification.notify_id == notify_id,
                    SystemNotification.notify_visible.is_(True),
                    SystemNotification.notify_target_roles.any(user.user_role),
                )
                .options(selectinload(SystemNotification.created_by))
            ).first()
            if not sn:
                return Response(status_code=404, content=b"")
            rec = NotificationRecipient(notify_id=notify_id, user_id=uid, read_at=now_tz())
            db.add(rec)
            db.commit()
            rec.notification = sn

        # [4.3] Ghi nhận đã đọc
        if not rec.read_at:
            rec.read_at = now_tz()
            db.commit()

        # [4.4] Chuẩn bị dữ liệu render
        creator = rec.notification.created_by
        sender_name = (
            (creator.user_display_name if creator and creator.user_display_name else None)
            or (creator.user_name if creator and creator.user_name else None)
            or (creator.user_email if creator and creator.user_email else None)
            or "Hệ thống"
        )
        normalized = (rec.notification.notify_content or "").replace("\r\n", "\n").strip()
        paragraphs = _split_paragraphs(normalized)

    # [4.5] Trả fragment modal (no-store, không đẩy URL)
    return Template(
        template_name="partials/chat_notify_detail_modal.html",
        context={
            "rec": rec,
            "notification": rec.notification,
            "sender_name": sender_name,
            "normalized_content": normalized,
            "paragraphs": paragraphs,
        },
        headers={"Cache-Control": "no-store", "Vary": "HX-Request", "HX-Push-Url": "false"},
    )

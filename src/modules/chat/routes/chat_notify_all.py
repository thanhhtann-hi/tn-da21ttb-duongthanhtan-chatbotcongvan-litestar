# file: src/modules/chat/routes/chat_notify_all.py
# updated: 2025-08-16 (v8.4)
# note:
#   [1] Xác thực + lấy tham số phân trang
#   [2] Tải user + settings (an toàn lazy)
#   [3] Thiết lập timezone theo user (fallback HCM)
#   [4] Đếm tổng & tính phân trang (PAGE_SIZE=15)
#   [5] Lấy danh sách thông báo theo trang (role + visible)
#   [6] Chuẩn hóa nội dung -> đoạn văn
#   [7] Nhóm theo ngày (TZ user) + label Hôm nay/Hôm qua/dd/mm/yyyy
#       ★ Thêm g.full_date để dùng cho tooltip (dd/mm/YYYY)
#   [8] Trả context cho template (kèm paging state)
#   [9] Cache-Control: no-store

from __future__ import annotations

from collections import OrderedDict
from datetime import timedelta
from zoneinfo import ZoneInfo

from litestar import get, Request
from litestar.response import Template, Response
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload

from core.db.engine import SessionLocal
from core.db.models import User, SystemNotification
from shared.secure_cookie import get_secure_cookie
from shared.timezone import now_tz

PAGE_SIZE = 15  # số card / trang

def _split_paragraphs(text: str) -> list[str]:
    """[6] Tách nội dung theo đoạn (double newline)."""
    text = (text or "").replace("\r\n", "\n").strip()
    return [p.strip() for p in text.split("\n\n") if p.strip()]

@get("/chat/notify/all")
def chat_notify_all(request: Request) -> Template | Response:
    # [1] Auth + page param
    uid = get_secure_cookie(request)
    if not uid:
        return Response(status_code=404, content=b"")

    try:
        page = int((request.query_params or {}).get("page", 1))
    except Exception:
        page = 1
    if page < 1:
        page = 1

    with SessionLocal() as db:
        # [2] User + settings
        user = db.execute(
            select(User)
            .options(selectinload(User.settings))
            .where(User.user_id == uid)
        ).scalar_one_or_none()
        if not user or user.user_status != "active":
            return Response(status_code=404, content=b"")

        user_avatar_url = (
            user.settings.setting_user_avatar_url
            if getattr(user, "settings", None) and user.settings.setting_user_avatar_url
            else None
        )
        user_ctx = {
            "user_id": user.user_id,
            "user_name": user.user_name,
            "user_display_name": user.user_display_name,
            "user_email": user.user_email,
            "user_role": user.user_role,
            "settings": {"setting_user_avatar_url": user_avatar_url},
        }

        # [3] Timezone theo user (fallback HCM)
        tz_name = (getattr(user, "settings", None) and user.settings.setting_timezone) or "Asia/Ho_Chi_Minh"
        try:
            user_tz = ZoneInfo(tz_name)
        except Exception:
            user_tz = ZoneInfo("Asia/Ho_Chi_Minh")

        # [4] Count tổng để chia trang
        base_filter = (
            (SystemNotification.notify_visible.is_(True)) &
            (SystemNotification.notify_target_roles.any(user.user_role))
        )
        total_count = db.scalar(select(func.count()).where(base_filter)) or 0
        total_pages = max(1, (total_count + PAGE_SIZE - 1) // PAGE_SIZE)
        if page > total_pages:
            page = total_pages
        offset = (page - 1) * PAGE_SIZE

        # [5] Lấy danh sách theo trang (mới nhất trước)
        notifs = db.execute(
            select(SystemNotification)
            .where(base_filter)
            .options(selectinload(SystemNotification.created_by).selectinload(User.settings))
            .order_by(SystemNotification.notify_created_at.desc())
            .limit(PAGE_SIZE)
            .offset(offset)
        ).scalars().all()

        # [7] Gom nhóm theo ngày (TZ user)
        now_local = now_tz().astimezone(user_tz)
        today = now_local.date()
        yesterday = today - timedelta(days=1)
        role_map = {"admin": "Quản trị viên", "internal": "Nội bộ", "user": "Người dùng"}

        groups_od: OrderedDict[str, dict] = OrderedDict()

        for sn in notifs:
            # Người gửi
            creator = sn.created_by
            sender_name = (
                (creator.user_display_name if creator and creator.user_display_name else None)
                or (creator.user_name if creator and creator.user_name else None)
                or (creator.user_email if creator and creator.user_email else None)
                or "Hệ thống"
            )
            sender_title = role_map.get(creator.user_role, "Thành viên") if creator else "Hệ thống"
            sender_avatar_url = (
                creator.settings.setting_user_avatar_url
                if creator and getattr(creator, "settings", None) and creator.settings.setting_user_avatar_url
                else "/static/images/img_user.webp"
            )

            # Thời gian local
            created_at = sn.notify_created_at
            if created_at is None:
                local_dt = now_local
            else:
                try:
                    if created_at.tzinfo:
                        local_dt = created_at.astimezone(user_tz)
                    else:
                        local_dt = created_at.replace(tzinfo=ZoneInfo("UTC")).astimezone(user_tz)
                except Exception:
                    local_dt = now_local

            # Khóa nhóm + label
            date_key = local_dt.date().isoformat()
            day_num = local_dt.day
            full_date = local_dt.strftime("%d/%m/%Y")  # ★ dùng cho tooltip
            if local_dt.date() == today:
                label = "Hôm nay"
            elif local_dt.date() == yesterday:
                label = "Hôm qua"
            else:
                label = full_date

            # Chuẩn hóa giờ 12h
            h, m = local_dt.hour, local_dt.minute
            ampm = "PM" if h >= 12 else "AM"
            h12 = h % 12 or 12
            time_str = f"{h12}:{m:02d} {ampm}"

            paragraphs = _split_paragraphs(sn.notify_content)

            # Tạo nhóm nếu chưa có
            if date_key not in groups_od:
                groups_od[date_key] = {
                    "day": day_num,
                    "label": label,
                    "full_date": full_date,   # ★ để template hiển thị tooltip
                    "items": [],
                }

            # Đưa card vào nhóm (thứ tự đã là mới -> cũ)
            groups_od[date_key]["items"].append({
                "sender_name": sender_name,
                "sender_title": sender_title,
                "sender_avatar_url": sender_avatar_url,
                "time": time_str,           # dùng cho card trong ngày + tooltip
                "paragraphs": paragraphs,
            })

        groups = list(groups_od.values())

    # [8] Render template
    return Template(
        template_name="chat_notify_all.html",
        context={
            "user": user_ctx,
            "csrf_token": request.cookies.get("csrftoken", ""),
            "is_notify_all": True,
            "is_home": False,

            # data render
            "groups": groups,

            # paging
            "page": page,
            "total_pages": total_pages,
            "has_prev": page > 1,
            "has_next": page < total_pages,
            "prev_page": page - 1 if page > 1 else 1,
            "next_page": page + 1 if page < total_pages else total_pages,
            "page_size": PAGE_SIZE,
        },
        headers={"Cache-Control": "no-store"},  # [9]
    )

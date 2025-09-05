# 📄 src/shared/timezone.py
# 🕒 Last updated: 2025-07-10 01:30
# 📝 Cung cấp tiện ích now_tz() trả datetime.now với timezone chuẩn hệ thống

import datetime as dt
import zoneinfo


def now_tz() -> dt.datetime:
    """
    Trả về thời gian hiện tại có timezone.
    Ưu tiên timezone hệ thống nếu có.
    """
    try:
        tz = zoneinfo.ZoneInfo("Asia/Ho_Chi_Minh")
    except Exception:
        tz = dt.timezone.utc
    return dt.datetime.now(tz)

# 📁 File: shared/verify_helpers.py
# 🕒 Last updated: 2025-07-01 15:20
# =============================================================================
# Hỗ trợ sinh mã và tạo nội dung email xác minh
# • _gen_code: tạo chuỗi số ngẫu nhiên (mặc định 6 chữ số)
# • _email_html: đóng gói HTML chứa mã cho email
# =============================================================================

import random

def _gen_code(length: int = 6) -> str:
    """
    Sinh mã xác minh gồm chữ số.
    
    Parameters
    ----------
    length : int
        Độ dài mã (số chữ số); mặc định 6.

    Returns
    -------
    str
        Chuỗi số ngẫu nhiên độ dài `length`.
    """
    return ''.join(random.choices("0123456789", k=length))


def _email_html(code: str) -> str:
    """
    Tạo nội dung HTML gửi kèm mã xác minh.
    
    Parameters
    ----------
    code : str
        Mã xác minh người dùng.

    Returns
    -------
    str
        Đoạn HTML định dạng sẵn kèm mã.
    """
    return f"""
    <div style="font-family:sans-serif;font-size:16px">
        <p>Xin chào,</p>
        <p>Mã xác minh của bạn là:</p>
        <div style="font-size:24px;font-weight:bold;color:#053484;">{code}</div>
        <p>Mã này sẽ hết hạn sau 10 phút.</p>
    </div>
    """

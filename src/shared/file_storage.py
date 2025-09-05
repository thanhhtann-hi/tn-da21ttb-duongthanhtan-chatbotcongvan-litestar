# file: src/shared/file_storage.py
# updated: 2025-08-31
# purpose:
#   - Helpers lưu tệp upload an toàn (sanitize tên file, chống path traversal)
#   - Bảo đảm thư mục, ghi theo stream (async/sync), tránh lỗi tên QUÁ DÀI trên Windows
#   - Tự thêm hậu tố -1, -2... nếu trùng tên

from __future__ import annotations

import os
import re
import shutil
import asyncio
from typing import Any, Callable

# ──────────────────────────────────────────────────────────────────────────────
# Cấu hình (có thể override qua ENV)
# Tổng độ dài đường dẫn tối đa (để tránh lỗi MAX_PATH trên Windows)
FS_MAX_TOTAL_PATH = int(os.getenv("FS_MAX_TOTAL_PATH", "240"))
# Độ dài tối thiểu cho tên file sau khi cắt
FS_MIN_FILENAME = int(os.getenv("FS_MIN_FILENAME", "32"))
# Regex cho ký tự hợp lệ trong tên file: chữ/số + . _ -
_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")
# Tên thiết bị bị cấm trên Windows
_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
# ──────────────────────────────────────────────────────────────────────────────


def ensure_dir(path: str) -> None:
    """Tạo thư mục nếu chưa có (idempotent)."""
    os.makedirs(path, exist_ok=True)


def _collapse_underscores(name: str) -> str:
    return re.sub(r"_+", "_", name)


def _strip_dots_spaces(name: str) -> str:
    # Windows không cho phép tên kết thúc bằng dấu cách hoặc dấu chấm
    return name.strip(" .")


def _sanitize_base(name: str, fallback: str = "file.bin") -> str:
    """
    Chuẩn hoá component tên file (không chứa path):
      - thay ký tự lạ bằng '_'
      - gom nhiều '_' về một
      - loại bỏ khoảng trắng & dấu chấm ở hai đầu
      - cấm tên thiết bị Windows (thêm tiền tố '_')
    """
    base = (name or "").strip()
    base = _SAFE_RE.sub("_", base) or fallback
    base = _collapse_underscores(base)
    base = _strip_dots_spaces(base) or fallback

    root, ext = os.path.splitext(base)
    if root.upper() in _WINDOWS_RESERVED:
        root = f"_{root}"
    # Nếu mất extension hợp lệ, giữ nguyên; nếu ext quá dài thì cắt
    if len(ext) > 16:  # bảo thủ cho các ext lạ
        ext = ext[:16]
    return root + ext


def safe_filename(name: str | None, fallback: str = "file.bin") -> str:
    """
    Chuẩn hoá tên file (không chứa path). KHÔNG đảm bảo độ dài tổng thể.
    Dùng kèm _fit_name_for_dir để đảm bảo không vượt quá FS_MAX_TOTAL_PATH.
    """
    # Lấy chỉ tên cuối cùng, bỏ mọi path user gửi lên
    base = (name or "").replace("\\", "/").split("/")[-1]
    base = _sanitize_base(base, fallback=fallback)

    # Cắt độ dài tối đa "tự thân" để dễ đọc (giả định không biết dest_dir)
    if len(base) > 180:
        stem, ext = os.path.splitext(base)
        keep = max(FS_MIN_FILENAME, 180 - len(ext))
        base = stem[:keep] + ext
    return base


def _fit_name_for_dir(dest_dir: str, filename: str) -> str:
    """
    Đảm bảo tổng đường dẫn (dest_dir/filename) không vượt quá FS_MAX_TOTAL_PATH.
    Nếu quá dài → cắt bớt phần thân tên (giữ extension).
    """
    dest_dir_abs = os.path.abspath(dest_dir)
    ensure_dir(dest_dir_abs)  # để chắc chắn tồn tại

    # +1 cho dấu path separator
    dir_len = len(dest_dir_abs) + 1
    allowed = max(FS_MIN_FILENAME, FS_MAX_TOTAL_PATH - dir_len)
    if allowed <= FS_MIN_FILENAME:
        # Trong trường hợp dest_dir quá sâu, vẫn cố gắng giữ tối thiểu
        allowed = FS_MIN_FILENAME

    if len(filename) <= allowed:
        return filename

    stem, ext = os.path.splitext(filename)
    keep = max(FS_MIN_FILENAME - len(ext), allowed - len(ext))
    if keep < 8:
        keep = 8  # chặn ít nhất vài ký tự để phân biệt
    return (stem[:keep] + ext)


def _unique_path(dest_path: str) -> str:
    """
    Tránh ghi đè nếu file đã tồn tại: thêm hậu tố -1, -2, ...
    Ví dụ: report.pdf -> report-1.pdf
    """
    if not os.path.exists(dest_path):
        return dest_path

    d = os.path.dirname(dest_path)
    base = os.path.basename(dest_path)
    stem, ext = os.path.splitext(base)

    i = 1
    while True:
        cand_name = f"{stem}-{i}{ext}"
        cand_name = _fit_name_for_dir(d, cand_name)
        cand = os.path.join(d, cand_name)
        if not os.path.exists(cand):
            return cand
        i += 1


def _safe_join(root: str, filename: str) -> str:
    """
    Join nhưng chống path traversal. Kết quả luôn nằm trong root.
    """
    root_abs = os.path.abspath(root)
    p = os.path.abspath(os.path.join(root_abs, filename))
    if not p.startswith(root_abs + os.sep) and p != root_abs:
        raise ValueError("Path traversal detected")
    return p


def infer_filename(upload: Any, fallback: str = "file.bin") -> str:
    """
    Lấy tên file hiển thị từ nhiều dạng UploadFile khác nhau.
    """
    for attr in ("filename", "name"):
        v = getattr(upload, attr, None)
        if isinstance(v, str) and v.strip():
            return safe_filename(v, fallback=fallback)
    return fallback


async def save_upload_async(
    upload: Any,
    dest_path: str,
    *,
    chunk_size: int = 1024 * 1024,
    make_unique: bool = False,
) -> str:
    """
    Lưu một đối tượng upload (Litestar/Starlette UploadFile hoặc file-like) xuống đĩa theo stream.

    - Bảo đảm thư mục đích tồn tại
    - Tự rút gọn tên để KHÔNG vượt quá FS_MAX_TOTAL_PATH (khắc phục lỗi Windows MAX_PATH)
    - Tránh ghi đè nếu make_unique=True
    - Hỗ trợ cả async read() (UploadFile) lẫn sync read()/file-like

    Trả về đường dẫn tuyệt đối đã lưu.
    """
    if not dest_path:
        raise ValueError("dest_path is required")

    dest_dir = os.path.dirname(dest_path)
    ensure_dir(dest_dir)

    # Chuẩn hoá & rút gọn tên (nhỡ caller không dùng safe_filename)
    base = os.path.basename(dest_path)
    base = _sanitize_base(base)
    base = _fit_name_for_dir(dest_dir, base)

    # Build lại đường dẫn (chặn traversal)
    dest_path = _safe_join(dest_dir, base)

    if make_unique:
        dest_path = _unique_path(dest_path)

    # Ưu tiên dùng API UploadFile nếu có
    read: Callable[..., Any] | None = getattr(upload, "read", None)
    close = getattr(upload, "close", None)
    is_async_read = asyncio.iscoroutinefunction(read)

    # Ghi theo stream
    with open(dest_path, "wb") as out:
        if is_async_read:
            # UploadFile.read is async
            while True:
                chunk = await upload.read(chunk_size)  # type: ignore[call-arg]
                if not chunk:
                    break
                out.write(chunk)
        else:
            # Thử truy cập file-like gốc
            src = getattr(upload, "file", None)
            if hasattr(src, "read"):
                shutil.copyfileobj(src, out, length=chunk_size)
            elif callable(read):
                # read() sync
                while True:
                    chunk = read(chunk_size)  # type: ignore[misc]
                    if not chunk:
                        break
                    out.write(chunk)
            else:
                # Fallback: thử thuộc tính body (bytes nhỏ)
                data = getattr(upload, "body", b"")
                if isinstance(data, (bytes, bytearray)):
                    out.write(data)
                else:
                    raise TypeError("Unsupported upload object: missing readable interface")

    # Đóng upload nếu có (không bắt buộc)
    try:
        if asyncio.iscoroutinefunction(close):
            await close()  # type: ignore[misc]
        elif callable(close):
            close()  # type: ignore[misc]
    except Exception:
        # an toàn: bỏ qua lỗi khi đóng
        pass

    return os.path.abspath(dest_path)

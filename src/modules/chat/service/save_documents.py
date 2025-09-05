# file: src/modules/chat/service/save_documents.py
# updated: 2025-09-03 (v1.1.0)
# purpose: Save uploaded chat documents safely, enforce limits, and return rich metadata
# compat: Django UploadedFile / Flask-Werkzeug FileStorage / generic file-like
from __future__ import annotations

import os
import io
import re
import json
import uuid
import hashlib
import logging
import mimetypes
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Optional, List, Dict, Any, Tuple, Protocol

log = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Types & Limits
# ──────────────────────────────────────────────────────────────────────────────

class UploadLike(Protocol):
    """Minimal interface we need from an uploaded file object."""
    filename: str  # Werkzeug
    name: str      # Django
    content_type: str  # optional on some frameworks
    def read(self, n: int = -1) -> bytes: ...
    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int: ...
    def tell(self) -> int: ...
    # Optional: size / content_length / stream
    # We'll fall back to stream reading & hashing.


@dataclass
class UploadLimits:
    max_files: int = 10
    per_file_bytes: int = 25 * 1024 * 1024       # 25 MB
    effective_request_cap_bytes: int = 50 * 1024 * 1024  # 50 MB


@dataclass
class SavedFile:
    file_id: str
    original_name: str
    safe_name: str
    ext: str
    size_bytes: int
    sha256: str
    mime_type: str
    process_mode: str = "full"  # "full" | "head_tail"
    head_pages: int = 0
    tail_pages: int = 0
    storage_relpath: str = ""    # relative path from base
    storage_abspath: str = ""    # absolute path on disk
    public_url: Optional[str] = None
    # NEW: mark which pane the file comes from to keep LEFT/RIGHT separated upstream
    pane: str = "main"           # "main" | "attachment"
    notes: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SaveResult:
    ok: bool
    batch_id: str
    saved_main: List[SavedFile] = field(default_factory=list)
    saved_attachments: List[SavedFile] = field(default_factory=list)
    error: Optional[str] = None
    human: Dict[str, Any] = field(default_factory=dict)  # e.g. totals, limits echo


# ──────────────────────────────────────────────────────────────────────────────
# Allowed extensions (mirror FE accept)
# ──────────────────────────────────────────────────────────────────────────────

ALLOWED_EXTS: set = {
    # docs
    "pdf","doc","docx","docm","dot","dotx","rtf","odt","txt","md",
    # images
    "png","jpg","jpeg","gif","bmp","tif","tiff","webp","svg",
    # excel
    "xls","xlsx","xlsm","xlsb","xlt","xltx","csv","ods",
    # ppt
    "ppt","pptx","pptm","pot","potx","odp",
    # web/code/config
    "html","htm","css","scss","sass","less","xml","json","yml","yaml","sql",
    "py","rb","php","java","kt","kts","c","h","cpp","hpp","cs","go","rs",
    "swift","m","mm","ts","tsx","jsx","sh","bat","ps1","ini","toml","gradle",
    "lua","r","pl",
}

# Soft MIME hints
mimetypes.init()


# ──────────────────────────────────────────────────────────────────────────────
# Exceptions
# ──────────────────────────────────────────────────────────────────────────────

class UploadError(Exception): ...
class TooManyFiles(UploadError): ...
class FileTooLarge(UploadError): ...
class TotalTooLarge(UploadError): ...
class DisallowedType(UploadError): ...
class StorageError(UploadError): ...


# ──────────────────────────────────────────────────────────────────────────────
# Utilities
# ──────────────────────────────────────────────────────────────────────────────

SAFE_CHARS_RE = re.compile(r"[^A-Za-z0-9._\-()\[\] ]+", re.UNICODE)
MULTIDOT_RE = re.compile(r"\.+")
WSP_RE = re.compile(r"\s+")

def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def gen_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"

def ext_of(filename: str) -> str:
    name = filename or ""
    i = name.rfind(".")
    if i < 0:
        return ""
    return name[i+1:].lower()

def sanitize_filename(name: str) -> str:
    name = name or "file"
    # strip path traversal
    name = name.replace("\\", "/")
    name = name.split("/")[-1]
    # collapse whitespace
    name = WSP_RE.sub(" ", name).strip()
    # conservative ASCII-ish safe variant:
    safe = SAFE_CHARS_RE.sub("_", name)
    safe = MULTIDOT_RE.sub(".", safe)
    if not safe or safe in {".", ".."}:
        safe = "file"
    return safe[:180]  # avoid extreme names

def guess_mime(filename: str) -> str:
    mime, _ = mimetypes.guess_type(filename, strict=False)
    return mime or "application/octet-stream"

def ensure_dir(path: str) -> None:
    try:
        os.makedirs(path, exist_ok=True)
    except Exception as e:
        raise StorageError(f"Cannot create directory: {path}") from e

def get_display_name(u: UploadLike) -> str:
    # Werkzeug uses .filename, Django uses .name
    name = getattr(u, "filename", None) or getattr(u, "name", None) or "file"
    return name

def get_content_type(u: UploadLike, fallback_name: Optional[str] = None) -> str:
    ct = getattr(u, "content_type", None) or ""
    if not ct and fallback_name:
        ct = guess_mime(fallback_name)
    return ct or "application/octet-stream"

def is_allowed_ext(e: str) -> bool:
    return e in ALLOWED_EXTS

def clamp(n: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, n))


# ──────────────────────────────────────────────────────────────────────────────
# Storage configuration
# (Prefer UPLOAD_ROOT for consistency with other modules; allow fallbacks)
# ──────────────────────────────────────────────────────────────────────────────

def _default_upload_root() -> str:
    # 1) Primary: UPLOAD_ROOT (shared with prompt_compose & OCR readers)
    env_upload_root = os.environ.get("UPLOAD_ROOT")
    if env_upload_root:
        return os.path.abspath(env_upload_root)

    # 2) Legacy/alt: CHAT_UPLOAD_ROOT
    env_chat_root = os.environ.get("CHAT_UPLOAD_ROOT")
    if env_chat_root:
        return os.path.abspath(env_chat_root)

    # 3) Django MEDIA_ROOT/chat_uploads
    try:
        from django.conf import settings  # type: ignore
        if getattr(settings, "MEDIA_ROOT", None):
            return os.path.abspath(os.path.join(settings.MEDIA_ROOT, "chat_uploads"))
    except Exception:
        pass

    # 4) Fallback: ./uploads
    return os.path.abspath(os.path.join(os.getcwd(), "uploads"))

def _public_base_url() -> Optional[str]:
    # e.g. https://cdn.example.com/chat-uploads
    return os.environ.get("CHAT_UPLOAD_PUBLIC_BASE")

UPLOAD_ROOT = _default_upload_root()


# ──────────────────────────────────────────────────────────────────────────────
# Core save API
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class MultiMainPolicy:
    mode: str = "first_full_then_head_tail"   # currently supported
    head_pages: int = 1
    tail_pages: int = 1


def save_documents(
    main_files: Iterable[UploadLike],
    attachments: Iterable[UploadLike],
    *,
    user_role: str = "user",
    limits: Optional[UploadLimits] = None,
    apply_policy_if_multi: bool = True,
    policy: Optional[MultiMainPolicy] = None,
) -> SaveResult:
    """
    Save a batch of uploaded files to disk with validation and limits.

    Parameters
    ----------
    - main_files: files from the LEFT pane (primary content to process)
    - attachments: files from the RIGHT pane (secondary context / email attachments)
    - user_role: affects multi-main policy (internal/admin)
    - limits: UploadLimits; if None uses defaults
    - apply_policy_if_multi: when True, apply 'first_full_then_head_tail' to extra main files for internal/admin
    - policy: override head/tail params

    Returns
    -------
    SaveResult(ok=True/False, ...)
    """
    lim = limits or UploadLimits()
    batch_id = gen_id("batch")

    # Collect lists (we may get single-pass iterables)
    main_list = list(main_files or [])
    atts_list = list(attachments or [])
    total_cnt = len(main_list) + len(atts_list)

    # Enforce counts
    if lim.max_files > 0 and total_cnt > lim.max_files:
        raise TooManyFiles(f"Too many files: {total_cnt} > {lim.max_files}")

    result = SaveResult(ok=False, batch_id=batch_id)
    totalsize = 0

    # Determine storage folder
    today = datetime.now(timezone.utc)
    day_path = os.path.join(
        UPLOAD_ROOT,
        str(today.year),
        f"{today.month:02d}",
        f"{today.day:02d}",
        batch_id,
    )
    ensure_dir(day_path)

    # Prepare multi-main policy
    internal = user_role in ("internal", "admin")
    pol = policy or MultiMainPolicy()
    apply_head_tail = internal and apply_policy_if_multi and len(main_list) > 1 and pol.mode == "first_full_then_head_tail"

    # Save main files
    for idx, upl in enumerate(main_list):
        saved = _save_one(
            upl,
            base_dir=day_path,
            public_base=_public_base_url(),
            per_file_cap=lim.per_file_bytes,
            # process hints:
            process_mode="full" if (idx == 0 or not apply_head_tail) else "head_tail",
            head_pages=pol.head_pages if (idx > 0 and apply_head_tail) else 0,
            tail_pages=pol.tail_pages if (idx > 0 and apply_head_tail) else 0,
            pane="main",
        )
        totalsize += saved.size_bytes
        result.saved_main.append(saved)

    # Save attachments
    for upl in atts_list:
        saved = _save_one(
            upl,
            base_dir=day_path,
            public_base=_public_base_url(),
            per_file_cap=lim.per_file_bytes,
            process_mode="full",
            pane="attachment",
        )
        totalsize += saved.size_bytes
        result.saved_attachments.append(saved)

    # Enforce total payload cap (effective request cap)
    if lim.effective_request_cap_bytes > 0 and totalsize > lim.effective_request_cap_bytes:
        # Best-effort cleanup this batch to avoid orphan files
        _cleanup_batch(day_path)
        raise TotalTooLarge(
            f"Total payload too large: {fmt_bytes(totalsize)} > {fmt_bytes(lim.effective_request_cap_bytes)}"
        )

    result.ok = True
    result.human = {
        "total_files": total_cnt,
        "total_size": totalsize,
        "total_size_h": fmt_bytes(totalsize),
        "limits": {
            "max_files": lim.max_files,
            "per_file_bytes": lim.per_file_bytes,
            "per_file_h": fmt_bytes(lim.per_file_bytes),
            "effective_request_cap_bytes": lim.effective_request_cap_bytes,
            "effective_request_cap_h": fmt_bytes(lim.effective_request_cap_bytes),
        },
        "role": user_role,
        "policy_applied": apply_head_tail,
        "upload_root": UPLOAD_ROOT,
    }
    return result


# ──────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────────────────────────────────────

def _save_one(
    upl: UploadLike,
    *,
    base_dir: str,
    public_base: Optional[str],
    per_file_cap: int,
    process_mode: str,
    head_pages: int = 0,
    tail_pages: int = 0,
    pane: str = "main",
) -> SavedFile:
    """Save a single uploaded file to disk safely and return metadata."""
    display_name = get_display_name(upl)
    safe = sanitize_filename(display_name)
    e = ext_of(safe)

    # Disallow double-extension tricks like .pdf.exe
    if not e or not is_allowed_ext(e):
        raise DisallowedType(f"File type not allowed: {display_name}")

    # Generate unique file id & target path
    file_id = gen_id("f")
    filename = f"{file_id}__{safe}"
    abspath = os.path.join(base_dir, filename)

    # Read stream -> hash and write (enforce per-file cap)
    sha256 = hashlib.sha256()
    total = 0

    # Reset position if possible
    try:
        upl.seek(0)
    except Exception:
        pass

    # Choose a readable stream (Werkzeug provides .stream)
    stream = getattr(upl, "stream", None) or upl  # type: ignore

    try:
        with open(abspath, "wb") as out:
            while True:
                chunk = stream.read(1024 * 1024)  # 1MB
                if not chunk:
                    break
                total += len(chunk)
                if per_file_cap > 0 and total > per_file_cap:
                    try:
                        out.flush()
                        out.close()
                        os.remove(abspath)
                    except Exception:
                        pass
                    raise FileTooLarge(
                        f'File "{display_name}" exceeds per-file limit {fmt_bytes(per_file_cap)}'
                    )
                sha256.update(chunk)
                out.write(chunk)
    except UploadError:
        raise
    except Exception as e2:
        raise StorageError(f"Failed to store file: {display_name}") from e2

    # MIME
    mime = get_content_type(upl, fallback_name=display_name) or guess_mime(display_name)

    relpath = _relpath_from_abspath(abspath)
    public_url = _public_url_for(public_base, relpath)

    saved = SavedFile(
        file_id=file_id,
        original_name=display_name,
        safe_name=safe,
        ext=e,
        size_bytes=total,
        sha256=sha256.hexdigest(),
        mime_type=mime,
        process_mode=process_mode,
        head_pages=head_pages,
        tail_pages=tail_pages,
        storage_relpath=relpath,
        storage_abspath=abspath,
        public_url=public_url,
        pane=pane,
        notes={},
    )

    # annotate slot for quick reads upstream
    try:
        saved.notes.setdefault("slot", pane)
    except Exception:
        pass

    # Optional: materialize head/tail artifacts for PDFs (best-effort)
    if process_mode == "head_tail" and e == "pdf" and (head_pages > 0 or tail_pages > 0):
        _maybe_materialize_pdf_head_tail(saved, head_pages, tail_pages)

    return saved


def _maybe_materialize_pdf_head_tail(saved: SavedFile, head: int, tail: int) -> None:
    """
    If PyPDF2 is available, create sibling files for head/tail pages and record in notes.
    Non-fatal on errors; it's a best-effort UI hint for downstream OCR.
    """
    try:
        import PyPDF2  # type: ignore
    except Exception:
        saved.notes["head_tail"] = {"status": "skipped", "reason": "PyPDF2 not installed"}
        return

    try:
        reader = PyPDF2.PdfReader(saved.storage_abspath)
        n = len(reader.pages)
        head_n = clamp(head, 0, max(0, n))
        tail_n = clamp(tail, 0, max(0, n - head_n))

        artifacts: Dict[str, str] = {}
        if head_n > 0:
            head_path = saved.storage_abspath.replace("__", "__head__")
            writer = PyPDF2.PdfWriter()
            for i in range(0, min(head_n, n)):
                writer.add_page(reader.pages[i])
            with open(head_path, "wb") as fp:
                writer.write(fp)
            artifacts["head"] = _relpath_from_abspath(head_path)

        if tail_n > 0 and n > 0:
            tail_path = saved.storage_abspath.replace("__", "__tail__")
            writer = PyPDF2.PdfWriter()
            for i in range(max(0, n - tail_n), n):
                writer.add_page(reader.pages[i])
            with open(tail_path, "wb") as fp:
                writer.write(fp)
            artifacts["tail"] = _relpath_from_abspath(tail_path)

        saved.notes["head_tail"] = {
            "status": "ok",
            "pages": {"total": n, "head": head_n, "tail": tail_n},
            "artifacts": artifacts,
        }
    except Exception as e:
        log.warning("head/tail pdf failed: %s", e)
        saved.notes["head_tail"] = {"status": "error", "reason": str(e)}


def _public_url_for(public_base: Optional[str], relpath: str) -> Optional[str]:
    if not public_base:
        return None
    rel = relpath.lstrip("/").replace("\\", "/")
    return f"{public_base.rstrip('/')}/{rel}"

def _relpath_from_abspath(abspath: str) -> str:
    try:
        return os.path.relpath(abspath, start=UPLOAD_ROOT).replace("\\", "/")
    except Exception:
        # last resort
        return abspath


def _cleanup_batch(batch_dir: str) -> None:
    try:
        import shutil
        shutil.rmtree(batch_dir, ignore_errors=True)
    except Exception as e:
        log.warning("Failed to cleanup batch dir %s: %s", batch_dir, e)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers for chat_api & email pipeline
# ──────────────────────────────────────────────────────────────────────────────

def summarize_for_payload(res: SaveResult) -> Dict[str, Any]:
    """Compact dict suitable to serialize into chat message / email attachments."""
    def pack(f: SavedFile) -> Dict[str, Any]:
        return {
            "file_id": f.file_id,
            "name": f.original_name,
            "safe_name": f.safe_name,
            "ext": f.ext,
            "size": f.size_bytes,
            "size_h": fmt_bytes(f.size_bytes),
            "sha256": f.sha256,
            "mime": f.mime_type,
            "mode": f.process_mode,
            "head_pages": f.head_pages,
            "tail_pages": f.tail_pages,
            "relpath": f.storage_relpath,
            "url": f.public_url,
            "pane": f.pane,          # NEW: keep slot visible to callers
            "notes": f.notes,
        }
    return {
        "ok": res.ok,
        "batch_id": res.batch_id,
        "main": [pack(x) for x in res.saved_main],
        "attachments": [pack(x) for x in res.saved_attachments],
        "human": res.human,
    }

def build_email_attachments(res: SaveResult, *, include_main: bool = True) -> List[Tuple[str, str, str]]:
    """
    Return list of (filepath, mime_type, filename_for_email) for email sending.
    - include_main=True: include files from LEFT pane (backward compatible).
    - For the "Cập nhật email" tool, call with include_main=False to only attach RIGHT pane files.
    """
    out: List[Tuple[str, str, str]] = []
    files = (res.saved_main if include_main else []) + res.saved_attachments
    for f in files:
        out.append((f.storage_abspath, f.mime_type, f.original_name))
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Formatting helpers
# ──────────────────────────────────────────────────────────────────────────────

def fmt_bytes(n: int) -> str:
    if n is None:
        return "0 B"
    if n < 1024:
        return f"{n} B"
    kb = n / 1024.0
    if kb < 1024:
        return f"{kb:.1f} KB" if kb % 1 else f"{int(kb)} KB"
    mb = kb / 1024.0
    if mb < 1024:
        return f"{mb:.1f} MB" if mb % 1 else f"{int(mb)} MB"
    gb = mb / 1024.0
    return f"{gb:.1f} GB" if gb % 1 else f"{int(gb)} GB"


# ──────────────────────────────────────────────────────────────────────────────
# Quick self-test (optional): run as module
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG, format="%(levelname)s %(message)s")
    from io import BytesIO

    class Fake(UploadLike):  # type: ignore[misc]
        def __init__(self, name: str, data: bytes, content_type: str = ""):
            self.filename = name
            self.content_type = content_type
            self._bio = BytesIO(data)
        def read(self, n: int = -1) -> bytes: return self._bio.read(n)
        def seek(self, off: int, whence: int = io.SEEK_SET) -> int: return self._bio.seek(off, whence)
        def tell(self) -> int: return self._bio.tell()

    # create small fake files
    main = [Fake("demo.pdf", b"%PDF-1.4\nx" * 1000, "application/pdf"),
            Fake("readme.md", b"# Hello\n" * 100)]
    atts = [Fake("data.csv", b"a,b,c\n1,2,3\n", "text/csv")]

    try:
        res = save_documents(main, atts, user_role="internal")
        print(json.dumps(summarize_for_payload(res), indent=2, ensure_ascii=False))
        print("Email parts (attachments only):", build_email_attachments(res, include_main=False))
    except Exception as e:
        print("ERR:", e)

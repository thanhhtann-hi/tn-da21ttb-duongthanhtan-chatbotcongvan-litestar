# file: src/modules/worker/email_dispatcher.py
# updated: 2025-09-03 (v0.9.0)
# purpose:
#   - Worker gửi email cho tool “Cập nhật email”
#   - Lấy batch mail đến hạn từ modules.chat.service.email_scheduler (nếu có)
#   - Gửi qua shared.mailer.send_mail_attachments()
#   - Cập nhật trạng thái: sending → sent / failed (idempotent, best-effort)
#
# ENV:
#   EMAIL_DISPATCH_POLL_SEC=5         # khoảng polling khi chạy loop
#   EMAIL_DISPATCH_BATCH=10           # số item/process mỗi vòng
#   EMAIL_DISPATCH_ONESHOT=0          # 1=chạy một lần rồi thoát; 0=loop
#   UPLOAD_ROOT=./uploads             # để resolve relpath -> absolute
#   SMTP_DEV_MODE=1                   # đã có trong shared/mailer.py (in ra log, không gửi thật)
#   DEFAULT_DEPT_EMAIL=...            # fallback khi thiếu người nhận
#
# Duck-typing API (ưu tiên nếu module email_scheduler có các hàm sau):
#   - es.fetch_due_emails(session, now_utc: int, limit: int) -> List[dict]
#   - es.get_due_email_batch(session, now, limit: int) -> List[dict]
#   - es.mark_sending(session, email_id: str) -> bool
#   - es.mark_sent(session, email_id: str, meta: dict | None = None) -> None
#   - es.mark_failed(session, email_id: str, error: str) -> None
#   - (tùy chọn) es.resolve_attachment_paths(session, item_dict) -> List[str]
#
# Mỗi item dict nên có tối thiểu:
#   {
#     "id": "...",
#     "title"/"subject": "...",
#     "recipient"/"recipients": "a@x" | ["a@x", "b@y"],
#     "body_html"/"html"/"body": "...",
#     "attachments": [ "rel/path.pdf", {"relpath":"..."} , {"path":"/abs"}, ... ]
#   }

from __future__ import annotations

import os
import sys
import time
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# DB session
try:
    from core.db.engine import SessionLocal
except Exception as e:  # pragma: no cover
    raise RuntimeError(f"[email_dispatcher] Missing core.db.engine.SessionLocal: {e}") from e

# Mailer
try:
    from shared.mailer import send_mail_attachments
except Exception as e:  # pragma: no cover
    raise RuntimeError(f"[email_dispatcher] Missing shared.mailer.send_mail_attachments: {e}") from e

# Email scheduler “API”
es = None
try:
    from modules.chat.service import email_scheduler as es  # type: ignore
except Exception:
    es = None  # type: ignore

LOG = logging.getLogger("docaix.email_dispatcher")
logging.basicConfig(
    level=os.getenv("EMAIL_DISPATCH_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

UPLOAD_ROOT = os.path.abspath(os.getenv("UPLOAD_ROOT", os.path.join("uploads")))
POLL_SEC = max(1, int(os.getenv("EMAIL_DISPATCH_POLL_SEC", "5") or "5"))
BATCH = max(1, int(os.getenv("EMAIL_DISPATCH_BATCH", "10") or "10"))
ONESHOT = (os.getenv("EMAIL_DISPATCH_ONESHOT", "0").strip() == "1")
DEFAULT_DEPT_EMAIL = (os.getenv("DEFAULT_DEPT_EMAIL", "") or "").strip()


def _now_utc_ts() -> int:
    return int(time.time())


def _as_list(x: Any) -> List[str]:
    if not x:
        return []
    if isinstance(x, str):
        return [x.strip()] if x.strip() else []
    if isinstance(x, (list, tuple, set)):
        out = []
        for v in x:
            s = str(v or "").strip()
            if s:
                out.append(s)
        return out
    return []


def _resolve_attachment_path(p: str) -> Optional[str]:
    if not p:
        return None
    # Nếu là đường dẫn tương đối (theo UPLOAD_ROOT)
    cand = p
    if not os.path.isabs(cand):
        cand = os.path.join(UPLOAD_ROOT, cand)
    cand = os.path.abspath(cand)
    if os.path.isfile(cand):
        return cand
    return None


def _normalize_attachments(att: Any, *, session) -> List[str]:
    # 1) Nếu email_scheduler có hàm resolve riêng → ưu tiên
    if es and hasattr(es, "resolve_attachment_paths"):
        try:
            paths = es.resolve_attachment_paths(session, att)  # type: ignore[arg-type]
            out: List[str] = []
            for p in _as_list(paths):
                rp = _resolve_attachment_path(p) or (p if os.path.isfile(p) else None)
                if rp and rp not in out:
                    out.append(rp)
            return out
        except Exception as e:
            LOG.debug("resolve_attachment_paths failed: %s", e)

    # 2) Chuẩn chung: nhận list[str] hoặc list[dict]
    out: List[str] = []
    if isinstance(att, list):
        for it in att:
            if isinstance(it, str):
                rp = _resolve_attachment_path(it)
            elif isinstance(it, dict):
                rp = (
                    _resolve_attachment_path(it.get("relpath") or "")
                    or _resolve_attachment_path(it.get("path") or "")
                )
            else:
                rp = None
            if rp and rp not in out:
                out.append(rp)
    elif isinstance(att, dict):
        rp = (
            _resolve_attachment_path(att.get("relpath") or "")
            or _resolve_attachment_path(att.get("path") or "")
        )
        if rp:
            out.append(rp)
    return out


def _to_html(body: str) -> str:
    s = (body or "").strip()
    if not s:
        return "<p>(no content)</p>"
    # Nếu có vẻ đã là HTML thì trả luôn
    if "<" in s and ">" in s and "</" in s:
        return s
    # Bọc tối thiểu
    esc = (
        s.replace("&", "&amp;")
         .replace("<", "&lt;")
         .replace(">", "&gt;")
         .replace("\n", "<br>")
    )
    return f"<div style='font-family: system-ui, Segoe UI, Roboto, sans-serif; font-size: 14px; line-height: 1.5'>{esc}</div>"


def _normalize_item(raw: Dict[str, Any], *, session) -> Optional[Dict[str, Any]]:
    try:
        email_id = str(raw.get("id") or raw.get("email_id") or "").strip()
        if not email_id:
            return None

        subj = str(
            raw.get("subject")
            or raw.get("title")
            or raw.get("topic")
            or "(no subject)"
        ).strip()

        # recipients
        rcpts = (
            _as_list(raw.get("recipients"))
            or _as_list(raw.get("recipient"))
            or _as_list(raw.get("to"))
        )
        if not rcpts and DEFAULT_DEPT_EMAIL:
            rcpts = [DEFAULT_DEPT_EMAIL]
        if not rcpts:
            LOG.warning("Email %s missing recipients; will skip.", email_id)
            return None

        # body/html
        body_html = (
            raw.get("body_html")
            or raw.get("html")
            or raw.get("body")
            or ""
        )
        html = _to_html(str(body_html))

        # attachments
        atts_raw = raw.get("attachments") or []
        attachments = _normalize_attachments(atts_raw, session=session)

        meta = {
            "planned_send_time": raw.get("send_time") or raw.get("time"),
            "departments": raw.get("departments") or [],
            "source": raw.get("source") or "email_scheduler",
        }

        return {
            "id": email_id,
            "subject": subj,
            "recipients": rcpts,
            "html": html,
            "attachments": attachments,
            "meta": meta,
        }
    except Exception as e:
        LOG.error("normalize item failed: %s", e)
        return None


def _fetch_due_batch(session, *, limit: int) -> List[Dict[str, Any]]:
    """
    Lấy batch mail đến hạn bằng duck-typing các hàm trong email_scheduler.
    Ưu tiên: fetch_due_emails(now_utc, limit) -> list[dict]
    Fallback: get_due_email_batch(now=datetime.utcnow(), limit=...)
    """
    if not es:
        LOG.warning("email_scheduler module is not available; nothing to dispatch.")
        return []

    now_utc = _now_utc_ts()

    # Option 1
    if hasattr(es, "fetch_due_emails"):
        try:
            res = es.fetch_due_emails(session, now_utc=now_utc, limit=limit)  # type: ignore
            return list(res or [])
        except TypeError:
            try:
                # maybe positional
                res = es.fetch_due_emails(session, now_utc, limit)  # type: ignore
                return list(res or [])
            except Exception as e:
                LOG.debug("fetch_due_emails failed: %s", e)
        except Exception as e:
            LOG.debug("fetch_due_emails error: %s", e)

    # Option 2
    if hasattr(es, "get_due_email_batch"):
        try:
            res = es.get_due_email_batch(session, now=datetime.now(timezone.utc), limit=limit)  # type: ignore
            return list(res or [])
        except TypeError:
            try:
                res = es.get_due_email_batch(session, datetime.now(timezone.utc), limit)  # type: ignore
                return list(res or [])
            except Exception as e:
                LOG.debug("get_due_email_batch failed: %s", e)
        except Exception as e:
            LOG.debug("get_due_email_batch error: %s", e)

    LOG.warning("No fetch function found in email_scheduler; implement fetch_due_emails/get_due_email_batch.")
    return []


def _mark_sending(session, email_id: str) -> bool:
    if not es:
        return False
    if hasattr(es, "mark_sending"):
        try:
            return bool(es.mark_sending(session, email_id))  # type: ignore
        except Exception as e:
            LOG.debug("mark_sending(%s) failed: %s", email_id, e)
    return True  # best-effort lock


def _mark_sent(session, email_id: str, meta: Optional[Dict[str, Any]] = None) -> None:
    if not es:
        return
    if hasattr(es, "mark_sent"):
        try:
            es.mark_sent(session, email_id, meta or {})  # type: ignore
            return
        except TypeError:
            try:
                es.mark_sent(session, email_id)  # type: ignore
                return
            except Exception as e:
                LOG.debug("mark_sent(%s) failed: %s", email_id, e)
        except Exception as e:
            LOG.debug("mark_sent error: %s", e)


def _mark_failed(session, email_id: str, error: str) -> None:
    if not es:
        return
    if hasattr(es, "mark_failed"):
        try:
            es.mark_failed(session, email_id, error)  # type: ignore
            return
        except TypeError:
            try:
                es.mark_failed(session, email_id)  # type: ignore
                return
            except Exception as e:
                LOG.debug("mark_failed(%s) failed: %s", email_id, e)
        except Exception as e:
            LOG.debug("mark_failed error: %s", e)


def _send_item(session, item: Dict[str, Any]) -> Tuple[bool, str]:
    """
    Gửi 1 item:
      - Gửi theo từng recipient (đơn giản, minh bạch log)
      - Nếu có 1 người gửi thất bại → coi thất bại; còn lại sẽ retry batch kế tiếp (tuỳ email_scheduler)
    """
    email_id = item["id"]
    recipients: List[str] = item["recipients"]
    subject: str = item["subject"]
    html: str = item["html"]
    attachments: List[str] = item["attachments"]

    LOG.info("Dispatch email_id=%s to=%s subj=%s att=%d", email_id, ",".join(recipients), subject, len(attachments))
    for to in recipients:
        try:
            send_mail_attachments(
                to=to,
                subject=subject,
                html_body=html,
                attachments=attachments,
            )
        except Exception as e:
            return False, f"send failure to {to}: {e!r}"
    return True, "sent"


def process_once() -> int:
    """
    Xử lý một lượt: lấy batch đến hạn và gửi.
    Trả về số item đã xử lý (sent + failed).
    """
    session = SessionLocal()
    handled = 0
    try:
        due = _fetch_due_batch(session, limit=BATCH)
        if not due:
            return 0

        for raw in due:
            email_id = str(raw.get("id") or raw.get("email_id") or "")
            if not email_id:
                LOG.warning("skip item without id: %r", raw)
                continue

            if not _mark_sending(session, email_id):
                LOG.info("skip email_id=%s not locked (already processing?)", email_id)
                continue

            item = _normalize_item(raw, session=session)
            if not item:
                _mark_failed(session, email_id, "normalize_failed")
                handled += 1
                continue

            ok, msg = _send_item(session, item)
            if ok:
                meta = {
                    "recipients": item["recipients"],
                    "attachments": item["attachments"],
                    "dispatched_at": datetime.now(timezone.utc).isoformat(),
                }
                _mark_sent(session, email_id, meta)
            else:
                _mark_failed(session, email_id, msg)

            handled += 1

        try:
            session.commit()
        except Exception as e:
            LOG.warning("session.commit() error (ignored, caller should use tx in es.*): %s", e)

        return handled
    finally:
        try:
            session.close()
        except Exception:
            pass


def main() -> None:
    LOG.info("Email dispatcher started (batch=%d, poll=%ds, oneshot=%s, upload_root=%s)",
             BATCH, POLL_SEC, ONESHOT, UPLOAD_ROOT)
    if not es:
        LOG.error("email_scheduler module not found. Exiting.")
        sys.exit(1)

    if ONESHOT:
        n = process_once()
        LOG.info("Oneshot done. processed=%d", n)
        return

    try:
        while True:
            n = process_once()
            if n == 0:
                time.sleep(POLL_SEC)
    except KeyboardInterrupt:
        LOG.info("Email dispatcher stopped by user (SIGINT).")
    except Exception as e:
        LOG.exception("Fatal error in dispatcher loop: %s", e)
        # Phòng trường hợp supervisor (systemd/docker) restart
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()

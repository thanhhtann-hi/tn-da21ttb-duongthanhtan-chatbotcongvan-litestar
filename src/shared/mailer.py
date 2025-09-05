# 📁 File: shared/mailer.py
# 🕒 Last updated: 2025-08-19
# =============================================================================
# Gửi email HTML qua SMTP (có hỗ trợ DEV) + đính kèm file
# ENV:
#   SMTP_DEV_MODE="1"  -> chỉ log, không gửi thật
#   SMTP_HOST, SMTP_PORT, SMTP_FROM (hoặc SMTP_USER), SMTP_PASS, EMAIL_FROM
# =============================================================================

import os
import smtplib
import ssl
import mimetypes
from email.message import EmailMessage
from pathlib import Path
from typing import List

def _smtp_creds():
    host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    port = int(os.getenv("SMTP_PORT", "465"))
    smtp_user = os.getenv("SMTP_FROM") or os.getenv("SMTP_USER")
    smtp_pass = os.getenv("SMTP_PASS")
    display_from = os.getenv("EMAIL_FROM", smtp_user or "")
    if not smtp_user or not smtp_pass:
        raise RuntimeError("Missing SMTP credentials: set SMTP_FROM (or SMTP_USER) and SMTP_PASS")
    return host, port, smtp_user, smtp_pass, display_from

def send_mail(*, to: str, subject: str, html_body: str) -> None:
    if os.getenv("SMTP_DEV_MODE") == "1":
        print(f"[DEV-MAIL] to={to!r} | subject={subject!r} | html_len={len(html_body)}")
        return
    host, port, smtp_user, smtp_pass, display_from = _smtp_creds()
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = display_from
    msg["To"] = to
    msg.set_content("This email requires an HTML-capable client.", subtype="plain")
    msg.add_alternative(html_body, subtype="html")
    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(host, port, context=ctx) as smtp:
        smtp.login(smtp_user, smtp_pass)
        smtp.send_message(msg)

def send_mail_attachments(*, to: str, subject: str, html_body: str, attachments: List[str] | None = None) -> None:
    """Gửi email HTML + đính kèm nhiều file."""
    attachments = attachments or []
    if os.getenv("SMTP_DEV_MODE") == "1":
        print(f"[DEV-MAIL] to={to!r} | subject={subject!r} | html_len={len(html_body)} | atts={len(attachments)}")
        for p in attachments:
            print(f"  - ATTACH: {p}")
        return

    host, port, smtp_user, smtp_pass, display_from = _smtp_creds()

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = display_from
    msg["To"] = to
    msg.set_content("This email requires an HTML-capable client.", subtype="plain")
    msg.add_alternative(html_body, subtype="html")

    # Đính kèm
    for ap in attachments:
        try:
            path = Path(ap)
            if not path.exists() or not path.is_file():
                continue
            ctype, encoding = mimetypes.guess_type(str(path))
            if ctype is None or encoding is not None:
                ctype = "application/octet-stream"
            maintype, subtype = ctype.split("/", 1)
            with path.open("rb") as f:
                data = f.read()
            msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=path.name)
        except Exception:
            continue

    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(host, port, context=ctx) as smtp:
        smtp.login(smtp_user, smtp_pass)
        smtp.send_message(msg)

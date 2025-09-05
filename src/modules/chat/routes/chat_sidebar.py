# file: src/modules/chat/routes/chat_sidebar.py
# updated: 2025-08-19

from __future__ import annotations
from typing import List
from litestar import get, Request
from litestar.response import Template
from sqlalchemy import select, desc
from core.db.engine import SessionLocal
from core.db.models import ChatHistory, User
from shared.secure_cookie import get_secure_cookie

def _load_user(uid: str) -> User | None:
    if not uid:
        return None
    with SessionLocal() as db:
        return db.get(User, uid)

@get("/chat/sidebar/list")
def chat_sidebar_list(request: Request) -> Template:
    uid = get_secure_cookie(request)
    user = _load_user(uid)
    chats: List[ChatHistory] = []
    if uid:
        with SessionLocal() as db:
            q = (
                select(ChatHistory)
                .where(ChatHistory.chat_user_id == uid, ChatHistory.chat_status == "active")
                .order_by(desc(ChatHistory.chat_updated_at))
                .limit(100)
            )
            chats = list(db.scalars(q).all())

    return Template(
        template_name="partials/chat_sidebar_list_fragment.html",
        context={"user": user, "chats": chats},   # 👈 important
    )

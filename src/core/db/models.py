# file: src/core/db/models.py
# updated: 2025-08-22
# note: đồng bộ ORM với CSDL tổng

from __future__ import annotations

import uuid
import datetime as dt
from typing import List, Optional

from sqlalchemy import (
    String,
    Boolean,
    Integer,
    DateTime,
    ForeignKey,
    Text,
    CheckConstraint,
    UniqueConstraint,
    Index,
    func,
)
from sqlalchemy.orm import (
    declarative_base,
    Mapped,
    mapped_column,
    relationship,
)
from sqlalchemy.dialects.postgresql import INET, ARRAY, JSONB

Base = declarative_base()

# =============================================================================
# [1] USERS
# =============================================================================
class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("user_role IN ('admin','user','internal')", name="ck_users_role"),
        CheckConstraint("user_status IN ('active','suspended','banned','deactivated')", name="ck_users_status"),
        UniqueConstraint("user_oauth_provider", "user_oauth_sub", name="uq_users_oauth_provider_sub"),
    )

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_name: Mapped[Optional[str]] = mapped_column(String(100), unique=True)
    user_display_name: Mapped[Optional[str]] = mapped_column(String(255))
    user_email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    user_password_hash: Mapped[Optional[str]] = mapped_column(Text)
    user_role: Mapped[str] = mapped_column(String(20), default="user", nullable=False)
    user_status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    user_oauth_provider: Mapped[Optional[str]] = mapped_column(String(50))
    user_oauth_sub: Mapped[Optional[str]] = mapped_column(String(255))
    user_email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    user_register_ip: Mapped[Optional[str]] = mapped_column(INET)

    user_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    user_updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), server_onupdate=func.now(), nullable=False
    )

    # Quan hệ
    settings: Mapped[Optional["UserSettings"]] = relationship(
        "UserSettings", back_populates="user", uselist=False, cascade="all, delete-orphan", passive_deletes=True
    )
    system_settings: Mapped[Optional["SystemSettings"]] = relationship(
        "SystemSettings", back_populates="updated_by", uselist=False
    )
    chats: Mapped[List["ChatHistory"]] = relationship(
        "ChatHistory", back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )
    projects_owned: Mapped[List["Project"]] = relationship(
        "Project", back_populates="owner"
    )


# =============================================================================
# [2] USER_SETTINGS
# =============================================================================
class UserSettings(Base):
    __tablename__ = "user_settings"
    __table_args__ = (
        CheckConstraint("setting_theme IN ('light','dark','system')", name="ck_user_settings_theme"),
    )

    setting_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.user_id", ondelete="CASCADE"), primary_key=True
    )
    setting_default_prompt: Mapped[Optional[str]] = mapped_column(Text)
    setting_theme: Mapped[str] = mapped_column(String(20), default="light")
    setting_user_avatar_url: Mapped[Optional[str]] = mapped_column(Text)
    setting_allow_memory_lookup: Mapped[bool] = mapped_column(Boolean, default=True)
    setting_allow_memory_storage: Mapped[bool] = mapped_column(Boolean, default=True)
    setting_remembered_summary: Mapped[Optional[str]] = mapped_column(Text)
    setting_timezone: Mapped[Optional[str]] = mapped_column(String(50))
    setting_enable_mapping: Mapped[bool] = mapped_column(Boolean, default=False)

    setting_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    setting_updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), server_onupdate=func.now(), nullable=False
    )

    user: Mapped["User"] = relationship("User", back_populates="settings", uselist=False)


# =============================================================================
# [3] DEPARTMENTS
# =============================================================================
class Department(Base):
    __tablename__ = "departments"

    dept_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    dept_name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    dept_alias: Mapped[Optional[str]] = mapped_column(String(255))
    dept_email: Mapped[Optional[str]] = mapped_column(String(255))
    dept_phone: Mapped[Optional[str]] = mapped_column(String(20))
    dept_website: Mapped[Optional[str]] = mapped_column(String(255))

    dept_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    dept_updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), server_onupdate=func.now(), nullable=False
    )

    # Liên kết many-to-many với ScheduledEmail
    scheduled_emails_links: Mapped[List["NhanMail"]] = relationship(
        "NhanMail", back_populates="department", cascade="all, delete-orphan", passive_deletes=True
    )
    scheduled_emails: Mapped[List["ScheduledEmail"]] = relationship(
        "ScheduledEmail",
        secondary="nhan_mail",
        back_populates="departments",
        viewonly=True,
    )


# =============================================================================
# [4] PROJECTS
# =============================================================================
class Project(Base):
    __tablename__ = "projects"

    project_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    project_description: Mapped[Optional[str]] = mapped_column(Text)
    project_owner_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.user_id"))
    project_prompt: Mapped[Optional[str]] = mapped_column(Text)
    project_color: Mapped[Optional[str]] = mapped_column(String(20))
    project_file_path: Mapped[Optional[str]] = mapped_column(Text)

    project_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    project_updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), server_onupdate=func.now(), nullable=False
    )

    owner: Mapped[Optional["User"]] = relationship("User", back_populates="projects_owned", uselist=False)
    chats: Mapped[List["ChatHistory"]] = relationship("ChatHistory", back_populates="project")


# =============================================================================
# [5] MODEL_VARIANTS
# =============================================================================
class ModelVariant(Base):
    __tablename__ = "model_variants"
    __table_args__ = (
        UniqueConstraint("model_name", name="uq_model_variants_name"),
        CheckConstraint(
            "model_access_scope IN ('all','user','internal','admin')",
            name="ck_model_variants_access_scope",
        ),
        CheckConstraint(
            "model_tier IN ('auto','low','medium','high')",
            name="ck_model_variants_tier",
        ),
        CheckConstraint(
            "model_status IN ('active','preview','deprecated','retired')",
            name="ck_model_variants_status",
        ),
    )

    model_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    model_name: Mapped[str] = mapped_column(String(100), nullable=False)
    model_provider: Mapped[Optional[str]] = mapped_column(String(100))
    model_type: Mapped[Optional[str]] = mapped_column(String(50))
    provider_model_id: Mapped[Optional[str]] = mapped_column(String(100))
    model_description: Mapped[Optional[str]] = mapped_column(Text)

    model_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    model_access_scope: Mapped[str] = mapped_column(String(20), default="all", nullable=False)
    model_tier: Mapped[Optional[str]] = mapped_column(String(20), default="auto")
    model_status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    model_sort_order: Mapped[Optional[int]] = mapped_column(Integer)

    model_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    model_updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), server_onupdate=func.now(), nullable=False
    )

    # ✅ đúng: ChatHistory.initial_model ↔ ModelVariant.initial_for_chats
    initial_for_chats: Mapped[List["ChatHistory"]] = relationship(
        "ChatHistory", back_populates="initial_model", cascade="save-update"
    )
    messages: Mapped[List["ChatMessage"]] = relationship(
        "ChatMessage", back_populates="model", cascade="save-update"
    )


# =============================================================================
# [6] CHAT_HISTORIES
# =============================================================================
class ChatHistory(Base):
    __tablename__ = "chat_histories"
    __table_args__ = (
        CheckConstraint("chat_status IN ('active','deleted','archived')", name="ck_chat_histories_status"),
        CheckConstraint("chat_visibility IN ('private','public')", name="ck_chat_histories_visibility"),
    )

    chat_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    chat_user_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.user_id"))
    chat_project_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("projects.project_id"))
    initial_model_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("model_variants.model_id"))

    chat_title: Mapped[Optional[str]] = mapped_column(String(255))
    chat_tokens_input: Mapped[int] = mapped_column(Integer, default=0)
    chat_tokens_output: Mapped[int] = mapped_column(Integer, default=0)
    chat_status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    chat_visibility: Mapped[str] = mapped_column(String(20), default="public", nullable=False)

    chat_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    chat_updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), server_onupdate=func.now(), nullable=False
    )

    # Quan hệ
    user: Mapped[Optional["User"]] = relationship("User", back_populates="chats", uselist=False)
    project: Mapped[Optional["Project"]] = relationship("Project", back_populates="chats", uselist=False)

    # ✅ đúng: trỏ tới ModelVariant & khớp back_populates ở trên
    initial_model: Mapped[Optional["ModelVariant"]] = relationship(
        "ModelVariant", back_populates="initial_for_chats", uselist=False
    )

    messages: Mapped[List["ChatMessage"]] = relationship(
        "ChatMessage", back_populates="chat", cascade="all, delete-orphan", passive_deletes=True
    )
    documents: Mapped[List["Document"]] = relationship(
        "Document", back_populates="chat", cascade="all, delete-orphan", passive_deletes=True
    )
    versions: Mapped[List["ChatHistoryVersion"]] = relationship(
        "ChatHistoryVersion", back_populates="parent_chat", cascade="all, delete-orphan", passive_deletes=True
    )
    feedbacks: Mapped[List["ChatFeedback"]] = relationship(
        "ChatFeedback", back_populates="chat", cascade="all, delete-orphan", passive_deletes=True
    )
    features: Mapped[List["ChatFeature"]] = relationship(
        "ChatFeature", back_populates="chat", cascade="all, delete-orphan", passive_deletes=True
    )
    scheduled_emails: Mapped[List["ScheduledEmail"]] = relationship(
        "ScheduledEmail", back_populates="chat", cascade="all, delete-orphan", passive_deletes=True
    )


# =============================================================================
# [7] CHAT_MESSAGES
# =============================================================================
class ChatMessage(Base):
    __tablename__ = "chat_messages"

    message_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    message_chat_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("chat_histories.chat_id", ondelete="CASCADE"), nullable=False
    )
    message_model_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("model_variants.model_id"), nullable=False
    )
    message_question: Mapped[str] = mapped_column(Text, nullable=False)
    message_ai_response: Mapped[str] = mapped_column(Text, nullable=False)
    message_tokens_input: Mapped[int] = mapped_column(Integer, default=0)
    message_tokens_output: Mapped[int] = mapped_column(Integer, default=0)

    message_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    message_updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), server_onupdate=func.now(), nullable=False
    )

    chat: Mapped["ChatHistory"] = relationship("ChatHistory", back_populates="messages", uselist=False)
    model: Mapped["ModelVariant"] = relationship("ModelVariant", back_populates="messages", uselist=False)
    # ⬇️ Thêm: các phiên bản snapshot gắn với message này
    versions: Mapped[List["ChatHistoryVersion"]] = relationship(
        "ChatHistoryVersion",
        back_populates="parent_message",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


# =============================================================================
# [8] DOCUMENTS
# =============================================================================
class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (
        CheckConstraint("doc_status IN ('new','routed','reviewed')", name="ck_documents_status"),
    )

    doc_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    doc_chat_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("chat_histories.chat_id", ondelete="CASCADE"), nullable=False
    )
    doc_file_path: Mapped[str] = mapped_column(Text, nullable=False)
    doc_ocr_text_path: Mapped[str] = mapped_column(Text, nullable=False)
    doc_title: Mapped[Optional[str]] = mapped_column(String(255))
    doc_status: Mapped[str] = mapped_column(String(20), default="new", nullable=False)

    doc_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    doc_updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), server_onupdate=func.now(), nullable=False
    )

    chat: Mapped["ChatHistory"] = relationship("ChatHistory", back_populates="documents", uselist=False)
    attachments: Mapped[List["DocumentAttachment"]] = relationship(
        "DocumentAttachment", back_populates="document", cascade="all, delete-orphan", passive_deletes=True
    )


# =============================================================================
# [9] DOCUMENT_ATTACHMENTS
# =============================================================================
class DocumentAttachment(Base):
    __tablename__ = "document_attachments"

    attachment_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    attachment_doc_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.doc_id", ondelete="CASCADE")
    )
    attachment_file_path: Mapped[str] = mapped_column(Text, nullable=False)
    attachment_description: Mapped[Optional[str]] = mapped_column(Text)

    attachment_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    document: Mapped["Document"] = relationship("Document", back_populates="attachments", uselist=False)


# =============================================================================
# [10] CHAT_HISTORY_VERSIONS
# =============================================================================
class ChatHistoryVersion(Base):
    __tablename__ = "chat_history_versions"
    __table_args__ = (
        CheckConstraint("version_kind IN ('edit','regenerate')", name="ck_chv_kind"),
        UniqueConstraint("parent_message_id", "version_index", name="uq_chv_message_index"),
        Index("ix_chv_parent_msg", "parent_message_id"),
        Index("ix_chv_parent_chat", "parent_chat_id"),
    )

    version_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    parent_chat_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("chat_histories.chat_id", ondelete="CASCADE")
    )
    # ⬇️ mới: gắn snapshot với message cụ thể
    parent_message_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("chat_messages.message_id", ondelete="CASCADE")
    )
    # ⬇️ mới: thứ tự phiên bản theo từng message (1,2,3,...)
    version_index: Mapped[Optional[int]] = mapped_column(Integer)
    # ⬇️ mới: phân loại nguồn gốc phiên bản
    version_kind: Mapped[str] = mapped_column(String(20), default="edit", nullable=False)

    version_question: Mapped[str] = mapped_column(Text, nullable=False)
    version_ai_response: Mapped[str] = mapped_column(Text, nullable=False)
    version_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    parent_chat: Mapped[Optional["ChatHistory"]] = relationship(
        "ChatHistory", back_populates="versions", uselist=False
    )
    # ⬇️ mới: quan hệ ngược về ChatMessage
    parent_message: Mapped[Optional["ChatMessage"]] = relationship(
        "ChatMessage", back_populates="versions", uselist=False
    )


# =============================================================================
# [11] CHAT_FEEDBACKS
# =============================================================================
class ChatFeedback(Base):
    __tablename__ = "chat_feedbacks"

    feedback_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    feedback_chat_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("chat_histories.chat_id", ondelete="CASCADE")
    )
    feedback_corrected_response: Mapped[Optional[str]] = mapped_column(Text)
    feedback_text: Mapped[Optional[str]] = mapped_column(Text)
    feedback_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    chat: Mapped[Optional["ChatHistory"]] = relationship("ChatHistory", back_populates="feedbacks", uselist=False)


# =============================================================================
# [12] SCHEDULED_EMAILS
# =============================================================================
class ScheduledEmail(Base):
    __tablename__ = "scheduled_emails"
    __table_args__ = (
        CheckConstraint("email_status IN ('scheduled','sent','failed')", name="ck_scheduled_emails_status"),
    )

    email_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email_chat_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("chat_histories.chat_id", ondelete="CASCADE"), nullable=False
    )
    email_title: Mapped[str] = mapped_column(String(255), nullable=False)
    email_recipient: Mapped[str] = mapped_column(String(255), nullable=False)
    email_body: Mapped[Optional[str]] = mapped_column(Text)
    # Schema dùng TIMESTAMP (không timezone)
    email_send_time: Mapped[dt.datetime] = mapped_column(DateTime(timezone=False), nullable=False)
    email_status: Mapped[str] = mapped_column(String(20), default="scheduled", nullable=False)

    email_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    email_updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), server_onupdate=func.now(), nullable=False
    )

    chat: Mapped["ChatHistory"] = relationship("ChatHistory", back_populates="scheduled_emails", uselist=False)
    attachments: Mapped[List["ScheduledEmailAttachment"]] = relationship(
        "ScheduledEmailAttachment", back_populates="email", cascade="all, delete-orphan", passive_deletes=True
    )
    departments_links: Mapped[List["NhanMail"]] = relationship(
        "NhanMail", back_populates="email", cascade="all, delete-orphan", passive_deletes=True
    )
    # Convenience many-to-many (viewonly)
    departments: Mapped[List["Department"]] = relationship(
        "Department",
        secondary="nhan_mail",
        back_populates="scheduled_emails",
        viewonly=True,
    )


# =============================================================================
# [13] SCHEDULED_EMAIL_ATTACHMENTS
# =============================================================================
class ScheduledEmailAttachment(Base):
    __tablename__ = "scheduled_email_attachments"

    att_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    att_email_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("scheduled_emails.email_id", ondelete="CASCADE")
    )
    att_file_path: Mapped[str] = mapped_column(Text, nullable=False)
    att_description: Mapped[Optional[str]] = mapped_column(Text)

    att_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    email: Mapped[Optional["ScheduledEmail"]] = relationship(
        "ScheduledEmail", back_populates="attachments", uselist=False
    )


# =============================================================================
# [14] NHAN_MAIL (N-N scheduled_emails ↔ departments)
# =============================================================================
class NhanMail(Base):
    __tablename__ = "nhan_mail"

    nm_email_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("scheduled_emails.email_id", ondelete="CASCADE"), primary_key=True
    )
    nm_dept_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("departments.dept_id", ondelete="CASCADE"), primary_key=True
    )
    nm_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    email: Mapped["ScheduledEmail"] = relationship("ScheduledEmail", back_populates="departments_links", uselist=False)
    department: Mapped["Department"] = relationship("Department", back_populates="scheduled_emails_links", uselist=False)


# =============================================================================
# [15] TOOL_DEFINITIONS
# =============================================================================
class ToolDefinition(Base):
    __tablename__ = "tool_definitions"
    __table_args__ = (
        UniqueConstraint("tool_name", name="uq_tool_definitions_name"),
        CheckConstraint(
            "tool_access_scope IN ('all','user','internal','admin')",
            name="ck_tool_definitions_access_scope",
        ),
    )

    tool_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    tool_name: Mapped[str] = mapped_column(String(50), nullable=False)
    tool_description: Mapped[Optional[str]] = mapped_column(Text)
    tool_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    tool_access_scope: Mapped[str] = mapped_column(String(20), default="all", nullable=False)
    tool_sort_order: Mapped[Optional[int]] = mapped_column(Integer)

    tool_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    tool_updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), server_onupdate=func.now(), nullable=False
    )

    chat_features: Mapped[List["ChatFeature"]] = relationship(
        "ChatFeature", back_populates="tool"
    )


# =============================================================================
# [16] CHAT_FEATURES
# =============================================================================
class ChatFeature(Base):
    __tablename__ = "chat_features"

    cf_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    cf_chat_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("chat_histories.chat_id", ondelete="CASCADE"), nullable=False
    )
    cf_tool_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("tool_definitions.tool_id"))
    cf_type_name: Mapped[Optional[str]] = mapped_column(Text)
    cf_metadata: Mapped[Optional[dict]] = mapped_column(JSONB)

    cf_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    chat: Mapped["ChatHistory"] = relationship("ChatHistory", back_populates="features", uselist=False)
    tool: Mapped[Optional["ToolDefinition"]] = relationship("ToolDefinition", back_populates="chat_features", uselist=False)

    # Liên kết tới ModelVariant qua bảng liên kết 'lien_ket'
    model_links: Mapped[List["LienKet"]] = relationship(
        "LienKet", back_populates="chat_feature", cascade="all, delete-orphan", passive_deletes=True
    )
    # Convenience many-to-many (viewonly)
    models: Mapped[List["ModelVariant"]] = relationship(
        "ModelVariant",
        secondary="lien_ket",
        viewonly=True,
    )


# =============================================================================
# [17] LIEN_KET (N-N chat_features ↔ model_variants)
# =============================================================================
class LienKet(Base):
    __tablename__ = "lien_ket"

    cf_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("chat_features.cf_id", ondelete="CASCADE"), primary_key=True
    )
    model_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("model_variants.model_id", ondelete="CASCADE"), primary_key=True
    )
    link_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    chat_feature: Mapped["ChatFeature"] = relationship("ChatFeature", back_populates="model_links", uselist=False)
    model: Mapped["ModelVariant"] = relationship("ModelVariant")


# =============================================================================
# [18] VERIFY_CODES
# =============================================================================
class VerifyCode(Base):
    __tablename__ = "verify_codes"

    vc_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    vc_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)
    vc_email: Mapped[str] = mapped_column(String(255), nullable=False)
    vc_code: Mapped[str] = mapped_column(String(6), nullable=False)
    vc_attempts: Mapped[int] = mapped_column(Integer, default=0)
    vc_max_attempt: Mapped[int] = mapped_column(Integer, default=5)
    vc_send_count: Mapped[int] = mapped_column(Integer, default=1)
    vc_expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    vc_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# =============================================================================
# [19] PASSWORD_RESET_TOKENS
# =============================================================================
class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    prt_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    prt_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)
    prt_token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    prt_expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    prt_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# =============================================================================
# [20] SYSTEM_SETTINGS
# =============================================================================
class SystemSettings(Base):
    __tablename__ = "system_settings"
    __table_args__ = (
        CheckConstraint(
            "system_domain_mode IN ('none','tvu','tvu_and_sttvu')",
            name="ck_system_settings_domain_mode",
        ),
    )

    system_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    system_register: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    system_login: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    system_maintenance: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    setting_updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), server_onupdate=func.now(), nullable=False
    )
    updated_by_user_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("users.user_id", ondelete="SET NULL")
    )

    system_domain_mode: Mapped[str] = mapped_column(String(20), default="none", nullable=False)
    system_allowed_models: Mapped[Optional[List[str]]] = mapped_column(ARRAY(Text))
    system_enabled_tools: Mapped[Optional[List[str]]] = mapped_column(ARRAY(Text))

    updated_by: Mapped[Optional["User"]] = relationship("User", back_populates="system_settings", uselist=False)


# =============================================================================
# [21] SYSTEM_ADMIN_LOGS
# =============================================================================
class SystemAdminLog(Base):
    __tablename__ = "system_admin_logs"

    log_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    log_admin_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_id"), nullable=False)
    log_action: Mapped[str] = mapped_column(String(100), nullable=False)
    log_target_table: Mapped[Optional[str]] = mapped_column(String(100))
    log_target_id: Mapped[Optional[str]] = mapped_column(String(36))
    log_description: Mapped[Optional[str]] = mapped_column(Text)
    log_before: Mapped[Optional[dict]] = mapped_column(JSONB)
    log_after: Mapped[Optional[dict]] = mapped_column(JSONB)
    log_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    admin: Mapped["User"] = relationship("User")


# =============================================================================
# [22] SYSTEM_NOTIFICATIONS
# =============================================================================
class SystemNotification(Base):
    __tablename__ = "system_notifications"

    notify_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    notify_content: Mapped[str] = mapped_column(Text, nullable=False)
    notify_visible: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notify_target_roles: Mapped[Optional[List[str]]] = mapped_column(
        ARRAY(Text), default=lambda: ["user", "internal", "admin"]
    )
    notify_created_by: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.user_id"))
    notify_created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    created_by: Mapped[Optional["User"]] = relationship("User")
    recipients: Mapped[List["NotificationRecipient"]] = relationship(
        "NotificationRecipient", back_populates="notification", cascade="all, delete-orphan", passive_deletes=True
    )


# =============================================================================
# [23] NOTIFICATION_RECIPIENTS
# =============================================================================
class NotificationRecipient(Base):
    __tablename__ = "notification_recipients"

    notify_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("system_notifications.notify_id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.user_id", ondelete="CASCADE"), primary_key=True
    )
    read_at: Mapped[Optional[dt.datetime]] = mapped_column(DateTime(timezone=True))

    notification: Mapped["SystemNotification"] = relationship("SystemNotification", back_populates="recipients")
    user: Mapped["User"] = relationship("User")


# =============================================================================
# [24] UTIL
# =============================================================================
def create_tables(engine):
    """Tạo toàn bộ bảng (dev/test)."""
    Base.metadata.create_all(engine)

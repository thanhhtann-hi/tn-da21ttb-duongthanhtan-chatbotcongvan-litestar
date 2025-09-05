/* ========================================================================
   schema_full.sql  -- DocAIx (2025-08-03)  |  DB: docaix_db
   Đã thêm DROP TABLE … CASCADE & reorder FK cho chạy liền mạch.
   ======================================================================== */

---------------------------------------------------------------------------
-- 1. Phòng ban
---------------------------------------------------------------------------
DROP TABLE IF EXISTS departments CASCADE;
CREATE TABLE departments (
    dept_id         CHAR(36) PRIMARY KEY,
    dept_name       VARCHAR(255) NOT NULL UNIQUE,
    dept_alias      VARCHAR(255),
    dept_email      VARCHAR(255),
    dept_phone      VARCHAR(20),
    dept_website    VARCHAR(255),
    dept_created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    dept_updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 2. Người dùng
---------------------------------------------------------------------------
DROP TABLE IF EXISTS users CASCADE;
CREATE TABLE users (
    user_id             CHAR(36) PRIMARY KEY,
    user_name           VARCHAR(100) UNIQUE,
    user_display_name   VARCHAR(255),
    user_email          VARCHAR(255) NOT NULL UNIQUE,
    user_password_hash  TEXT,
    user_role           VARCHAR(20) NOT NULL
                         CHECK (user_role IN ('admin','user','internal')),
    user_status         VARCHAR(20) DEFAULT 'active'
                         CHECK (user_status IN ('active','suspended','banned','deactivated')),
    user_oauth_provider VARCHAR(50),
    user_oauth_sub      VARCHAR(255),
    user_email_verified BOOLEAN      DEFAULT FALSE,
    user_register_ip    INET,
    user_created_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    user_updated_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_oauth_provider, user_oauth_sub)
);

---------------------------------------------------------------------------
-- 3. Thiết lập người dùng
---------------------------------------------------------------------------
DROP TABLE IF EXISTS user_settings CASCADE;
CREATE TABLE user_settings (
    setting_user_id              CHAR(36) PRIMARY KEY
                                  REFERENCES users(user_id) ON DELETE CASCADE,
    setting_default_prompt       TEXT,
    setting_theme                VARCHAR(20) DEFAULT 'light'
                                  CHECK (setting_theme IN ('light','dark','system')),
    setting_user_avatar_url      TEXT,
    setting_allow_memory_lookup  BOOLEAN DEFAULT TRUE,
    setting_allow_memory_storage BOOLEAN DEFAULT TRUE,
    setting_remembered_summary   TEXT,
    setting_timezone             VARCHAR(50),
    setting_enable_mapping       BOOLEAN DEFAULT FALSE,
    setting_created_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    setting_updated_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 4. Dự án
---------------------------------------------------------------------------
DROP TABLE IF EXISTS projects CASCADE;
CREATE TABLE projects (
    project_id          CHAR(36) PRIMARY KEY,
    project_name        VARCHAR(255) NOT NULL,
    project_description TEXT,
    project_owner_id    CHAR(36) REFERENCES users(user_id),
    project_prompt      TEXT,
    project_color       VARCHAR(20),
    project_file_path   TEXT,
    project_created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    project_updated_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 5. Model AI
---------------------------------------------------------------------------
DROP TABLE IF EXISTS model_variants CASCADE;
CREATE TABLE model_variants (
    model_id           CHAR(36) PRIMARY KEY,
    model_name         VARCHAR(100) NOT NULL UNIQUE,
    model_provider     VARCHAR(100),
    model_type         VARCHAR(50),
    model_description  TEXT,
    model_enabled      BOOLEAN      DEFAULT TRUE,
    model_access_scope VARCHAR(20)  DEFAULT 'all'
                       CHECK (model_access_scope IN ('all','user','internal','admin')),
    model_tier         VARCHAR(20)
                       CHECK (model_tier IN ('auto','low','medium','high')),
    model_status       VARCHAR(20) DEFAULT 'active'
                       CHECK (model_status IN ('active','preview','deprecated','retired')),
    model_sort_order   INT,
    provider_model_id  VARCHAR(100),
    model_created_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    model_updated_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------  
-- 6. Lịch sử chat  
---------------------------------------------------------------------------  
DROP TABLE IF EXISTS chat_histories CASCADE;  
CREATE TABLE chat_histories (  
    chat_id            CHAR(36) PRIMARY KEY,  
    chat_user_id       CHAR(36) REFERENCES users(user_id),  
    chat_project_id    CHAR(36) REFERENCES projects(project_id),  
    initial_model_id   CHAR(36) REFERENCES model_variants(model_id),  
    chat_title         VARCHAR(255),  
    chat_tokens_input  INT DEFAULT 0,  
    chat_tokens_output INT DEFAULT 0,  

    chat_status        VARCHAR(20) NOT NULL DEFAULT 'active'  
                       CHECK (chat_status IN ('active', 'deleted', 'archived')),  

    chat_visibility    VARCHAR(20) NOT NULL DEFAULT 'public'  
                       CHECK (chat_visibility IN ('private','public')),  

    chat_created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,  
    chat_updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP  
);

---------------------------------------------------------------------------
-- 7. Tài liệu & 8. File đính kèm tài liệu
---------------------------------------------------------------------------
DROP TABLE IF EXISTS document_attachments CASCADE;
DROP TABLE IF EXISTS documents CASCADE;

CREATE TABLE documents (
    doc_id            CHAR(36) PRIMARY KEY,
    doc_chat_id       CHAR(36) NOT NULL REFERENCES chat_histories(chat_id) ON DELETE CASCADE,
    doc_file_path     TEXT NOT NULL,
    doc_ocr_text_path TEXT NOT NULL,
    doc_title         VARCHAR(255),
    doc_status        VARCHAR(20) DEFAULT 'new'
                      CHECK (doc_status IN ('new','routed','reviewed')),
    doc_created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    doc_updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE document_attachments (
    attachment_id        CHAR(36) PRIMARY KEY,
    attachment_doc_id    CHAR(36) REFERENCES documents(doc_id) ON DELETE CASCADE,
    attachment_file_path TEXT NOT NULL,
    attachment_description TEXT,
    attachment_created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 9. Tin nhắn chat
---------------------------------------------------------------------------
DROP TABLE IF EXISTS chat_messages CASCADE;
CREATE TABLE chat_messages (
    message_id            CHAR(36) PRIMARY KEY,
    message_chat_id       CHAR(36) NOT NULL REFERENCES chat_histories(chat_id) ON DELETE CASCADE,
    message_model_id      CHAR(36) NOT NULL REFERENCES model_variants(model_id),
    message_question      TEXT NOT NULL,
    message_ai_response   TEXT NOT NULL,
    message_tokens_input  INT  DEFAULT 0,
    message_tokens_output INT  DEFAULT 0,
    message_created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    message_updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 10. Phiên bản chat
---------------------------------------------------------------------------
DROP TABLE IF EXISTS chat_history_versions CASCADE;
CREATE TABLE chat_history_versions (
    version_id          CHAR(36) PRIMARY KEY,
    parent_chat_id      CHAR(36) REFERENCES chat_histories(chat_id) ON DELETE CASCADE,
    version_question    TEXT NOT NULL,
    version_ai_response TEXT NOT NULL,
    version_created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 11. Phản hồi chat
---------------------------------------------------------------------------
DROP TABLE IF EXISTS chat_feedbacks CASCADE;
CREATE TABLE chat_feedbacks (
    feedback_id                 CHAR(36) PRIMARY KEY,
    feedback_chat_id            CHAR(36) REFERENCES chat_histories(chat_id) ON DELETE CASCADE,
    feedback_corrected_response TEXT,
    feedback_text               TEXT,
    feedback_created_at         TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 12. Email hẹn gửi & 14. File đính kèm email
---------------------------------------------------------------------------
DROP TABLE IF EXISTS scheduled_email_attachments CASCADE;
DROP TABLE IF EXISTS scheduled_emails CASCADE;

CREATE TABLE scheduled_emails (
    email_id        CHAR(36) PRIMARY KEY,
    email_chat_id   CHAR(36) NOT NULL REFERENCES chat_histories(chat_id) ON DELETE CASCADE,
    email_title     VARCHAR(255) NOT NULL,
    email_recipient VARCHAR(255) NOT NULL,
    email_body      TEXT,
    email_send_time TIMESTAMP NOT NULL,
    email_status    VARCHAR(20) DEFAULT 'scheduled'
                    CHECK (email_status IN ('scheduled','sent','failed')),
    email_created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    email_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE scheduled_email_attachments (
    att_id          CHAR(36) PRIMARY KEY,
    att_email_id    CHAR(36) REFERENCES scheduled_emails(email_id) ON DELETE CASCADE,
    att_file_path   TEXT NOT NULL,
    att_description TEXT,
    att_created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 13. N-N email ↔ phòng ban
---------------------------------------------------------------------------
DROP TABLE IF EXISTS nhan_mail CASCADE;
CREATE TABLE nhan_mail (
    nm_email_id   CHAR(36) REFERENCES scheduled_emails(email_id) ON DELETE CASCADE,
    nm_dept_id    CHAR(36) REFERENCES departments(dept_id)       ON DELETE CASCADE,
    nm_created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (nm_email_id, nm_dept_id)
);

---------------------------------------------------------------------------
-- 15. Danh sách công cụ (PHẢI trước chat_features)
---------------------------------------------------------------------------
DROP TABLE IF EXISTS tool_definitions CASCADE;
CREATE TABLE tool_definitions (
    tool_id           CHAR(36) PRIMARY KEY,
    tool_name         VARCHAR(50) UNIQUE NOT NULL,
    tool_description  TEXT,
    tool_enabled      BOOLEAN     DEFAULT TRUE,
    tool_access_scope VARCHAR(20) DEFAULT 'all'
                      CHECK (tool_access_scope IN ('all','user','internal','admin')),
    tool_sort_order   INT,
    tool_created_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    tool_updated_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 16. Công cụ đặc biệt trong chat
---------------------------------------------------------------------------
DROP TABLE IF EXISTS chat_features CASCADE;
CREATE TABLE chat_features (
    cf_id         CHAR(36) PRIMARY KEY,
    cf_chat_id    CHAR(36) NOT NULL REFERENCES chat_histories(chat_id) ON DELETE CASCADE,
    cf_tool_id    CHAR(36) REFERENCES tool_definitions(tool_id),
    cf_type_name  TEXT,
    cf_metadata   JSONB,
    cf_created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 17. Verify code
---------------------------------------------------------------------------
DROP TABLE IF EXISTS verify_codes CASCADE;
CREATE TABLE verify_codes (
    vc_id          CHAR(36) PRIMARY KEY,
    vc_user_id     CHAR(36) REFERENCES users(user_id) ON DELETE CASCADE,
    vc_email       VARCHAR(255) NOT NULL,
    vc_code        CHAR(6) NOT NULL,
    vc_attempts    INT DEFAULT 0,
    vc_max_attempt INT DEFAULT 5,
    vc_send_count  INT DEFAULT 1,
    vc_expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
    vc_created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 18. Token khôi phục mật khẩu
---------------------------------------------------------------------------
DROP TABLE IF EXISTS password_reset_tokens CASCADE;
CREATE TABLE password_reset_tokens (
    prt_id         CHAR(36) PRIMARY KEY,
    prt_user_id    CHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    prt_token      VARCHAR(64) UNIQUE NOT NULL,
    prt_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    prt_created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 19. Cấu hình hệ thống
---------------------------------------------------------------------------
DROP TABLE IF EXISTS system_settings CASCADE;
CREATE TABLE system_settings (
    system_id            CHAR(36) PRIMARY KEY,
    system_register      BOOLEAN DEFAULT FALSE,
    system_login         BOOLEAN DEFAULT TRUE,
    system_maintenance   BOOLEAN DEFAULT FALSE,
    setting_updated_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id   CHAR(36) REFERENCES users(user_id),
    system_domain_mode   VARCHAR(20) DEFAULT 'none'
                         CHECK (system_domain_mode IN ('none','tvu','tvu_and_sttvu')),
    system_allowed_models TEXT[],
    system_enabled_tools  TEXT[]
);

---------------------------------------------------------------------------
-- 20. Liên kết N-N model ↔ công cụ chat
---------------------------------------------------------------------------
DROP TABLE IF EXISTS lien_ket CASCADE;
CREATE TABLE lien_ket (
    cf_id           CHAR(36) NOT NULL REFERENCES chat_features(cf_id)      ON DELETE CASCADE,
    model_id        CHAR(36) NOT NULL REFERENCES model_variants(model_id)  ON DELETE CASCADE,
    link_created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (cf_id, model_id)
);

---------------------------------------------------------------------------
-- 21. Log admin
---------------------------------------------------------------------------
DROP TABLE IF EXISTS system_admin_logs CASCADE;
CREATE TABLE system_admin_logs (
    log_id           CHAR(36) PRIMARY KEY,
    log_admin_id     CHAR(36) NOT NULL REFERENCES users(user_id),
    log_action       VARCHAR(100) NOT NULL,
    log_target_table VARCHAR(100),
    log_target_id    CHAR(36),
    log_description  TEXT,
    log_before       JSONB,
    log_after        JSONB,
    log_created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

---------------------------------------------------------------------------
-- 22. Thông báo hệ thống & 23. Người nhận
---------------------------------------------------------------------------
DROP TABLE IF EXISTS notification_recipients CASCADE;
DROP TABLE IF EXISTS system_notifications   CASCADE;

CREATE TABLE system_notifications (
    notify_id           CHAR(36) PRIMARY KEY,
    notify_content      TEXT NOT NULL,
    notify_visible      BOOLEAN DEFAULT TRUE,
    notify_target_roles TEXT[] DEFAULT ARRAY['user','internal','admin'],
    notify_created_by   CHAR(36) REFERENCES users(user_id),
    notify_created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notification_recipients (
    notify_id CHAR(36) REFERENCES system_notifications(notify_id) ON DELETE CASCADE,
    user_id   CHAR(36) REFERENCES users(user_id)                  ON DELETE CASCADE,
    read_at   TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (notify_id, user_id)
);
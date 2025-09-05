-- 1. Phòng ban
SELECT
    dept_id,
    dept_name,
    dept_alias,
    dept_email,
    dept_phone,
    dept_website,
    dept_created_at,
    dept_updated_at
FROM departments;

-- 2. Người dùng
SELECT
    user_id,
    user_name,
    user_display_name,
    user_email,
    user_password_hash,
    user_role,
    user_status,
    user_oauth_provider,
    user_oauth_sub,
    user_email_verified,
    user_register_ip,
    user_created_at,
    user_updated_at
FROM users;

-- 3. Thiết lập người dùng
SELECT
    setting_user_id,
    setting_default_prompt,
    setting_theme,
    setting_user_avatar_url,
    setting_allow_memory_lookup,
    setting_allow_memory_storage,
    setting_remembered_summary,
    setting_timezone,
    setting_enable_mapping,
    setting_created_at,
    setting_updated_at
FROM user_settings;

-- 4. Dự án
SELECT
    project_id,
    project_name,
    project_description,
    project_owner_id,
    project_prompt,
    project_color,
    project_file_path,
    project_created_at,
    project_updated_at
FROM projects;

-- 5. Model AI
SELECT
    model_id,
    model_name,
    model_provider,
    model_type,
    model_description,
    model_enabled,
    model_access_scope,
    model_tier,
    model_status,
    model_sort_order,
    provider_model_id,
    model_created_at,
    model_updated_at
FROM model_variants;

-- 6. Lịch sử chat
SELECT
    chat_id,
    chat_user_id,
    chat_project_id,
    initial_model_id,
    chat_title,
    chat_tokens_input,
    chat_tokens_output,
    chat_status,
    chat_visibility,
    chat_created_at,
    chat_updated_at
FROM chat_histories;

-- 7. Tài liệu
SELECT
    doc_id,
    doc_chat_id,
    doc_file_path,
    doc_ocr_text_path,
    doc_title,
    doc_status,
    doc_created_at,
    doc_updated_at
FROM documents;

-- 8. File đính kèm tài liệu
SELECT
    attachment_id,
    attachment_doc_id,
    attachment_file_path,
    attachment_description,
    attachment_created_at
FROM document_attachments;

-- 9. Tin nhắn chat
SELECT
    message_id,
    message_chat_id,
    message_model_id,
    message_question,
    message_ai_response,
    message_tokens_input,
    message_tokens_output,
    message_created_at,
    message_updated_at
FROM chat_messages;

-- 10. Phiên bản chat
SELECT
    version_id,
    parent_chat_id,
    version_question,
    version_ai_response,
    version_created_at
FROM chat_history_versions;

-- 11. Phản hồi chat
SELECT
    feedback_id,
    feedback_chat_id,
    feedback_corrected_response,
    feedback_text,
    feedback_created_at
FROM chat_feedbacks;

-- 12. Email hẹn gửi
SELECT
    email_id,
    email_chat_id,
    email_title,
    email_recipient,
    email_body,
    email_send_time,
    email_status,
    email_created_at,
    email_updated_at
FROM scheduled_emails;

-- 13. File đính kèm email
SELECT
    att_id,
    att_email_id,
    att_file_path,
    att_description,
    att_created_at
FROM scheduled_email_attachments;

-- 14. N-N email ↔ phòng ban
SELECT
    nm_email_id,
    nm_dept_id,
    nm_created_at
FROM nhan_mail;

-- 15. Danh sách công cụ
SELECT
    tool_id,
    tool_name,
    tool_description,
    tool_enabled,
    tool_access_scope,
    tool_sort_order,
    tool_created_at,
    tool_updated_at
FROM tool_definitions;

-- 16. Công cụ đặc biệt trong chat
SELECT
    cf_id,
    cf_chat_id,
    cf_tool_id,
    cf_type_name,
    cf_metadata,
    cf_created_at
FROM chat_features;

-- 17. Verify code
SELECT
    vc_id,
    vc_user_id,
    vc_email,
    vc_code,
    vc_attempts,
    vc_max_attempt,
    vc_send_count,
    vc_expires_at,
    vc_created_at
FROM verify_codes;

-- 18. Token khôi phục mật khẩu
SELECT
    prt_id,
    prt_user_id,
    prt_token,
    prt_expires_at,
    prt_created_at
FROM password_reset_tokens;

-- 19. Cấu hình hệ thống
SELECT
    system_id,
    system_register,
    system_login,
    system_maintenance,
    setting_updated_at,
    updated_by_user_id,
    system_domain_mode,
    system_allowed_models,
    system_enabled_tools
FROM system_settings;

-- 20. Liên kết N-N model ↔ công cụ chat
SELECT
    cf_id,
    model_id,
    link_created_at
FROM lien_ket;

-- 21. Log admin
SELECT
    log_id,
    log_admin_id,
    log_action,
    log_target_table,
    log_target_id,
    log_description,
    log_before,
    log_after,
    log_created_at
FROM system_admin_logs;

-- 22. Thông báo hệ thống
SELECT
    notify_id,
    notify_content,
    notify_visible,
    notify_target_roles,
    notify_created_by,
    notify_created_at
FROM system_notifications;

-- 23. Người nhận thông báo
SELECT
    notify_id,
    user_id,
    read_at
FROM notification_recipients;

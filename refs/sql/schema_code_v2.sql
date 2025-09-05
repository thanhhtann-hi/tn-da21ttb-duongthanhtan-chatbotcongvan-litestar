-- 1. Tạo bảng user_settings mới
CREATE TABLE user_settings (
    setting_user_id               CHAR(36) PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,

    setting_default_prompt        TEXT,
    setting_theme                 VARCHAR(20) DEFAULT 'light' CHECK (setting_theme IN ('light','dark')),
    setting_token_quota           INT DEFAULT 100000,
    setting_user_avatar_url       TEXT,

    setting_allow_memory_lookup   BOOLEAN DEFAULT TRUE,
    setting_allow_memory_storage  BOOLEAN DEFAULT TRUE,
    setting_remembered_summary    TEXT,

    setting_created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    setting_updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- 2. Chuyển dữ liệu từ bảng users sang user_settings
INSERT INTO user_settings (
    setting_id,
    setting_user_id,
    default_prompt,
    theme,
    token_quota,
    user_avatar_url,
    allow_chat_memory_lookup,
    allow_chat_memory_storage
)
SELECT
    gen_random_uuid(),         -- hoặc dùng uuid_generate_v4() nếu bạn đã enable extension đó
    user_id,
    default_prompt,
    theme,
    token_quota,
    user_avatar_url,
    TRUE,                      -- mặc định cho phép tra cứu ký ức
    TRUE
FROM users;

-- 3. Xoá các cột cũ khỏi bảng users
ALTER TABLE users
    DROP COLUMN default_prompt,
    DROP COLUMN theme,
    DROP COLUMN token_quota,
    DROP COLUMN user_avatar_url;
	
-- 4. Kiểm tra lại dữ liệu
SELECT u.user_id, u.user_name, s.*
FROM users u
JOIN user_settings s ON s.setting_user_id = u.user_id
-- LIMIT 5;

-- 5. Bổ sung cột cho bảng user_settings
ALTER TABLE user_settings
ADD COLUMN setting_remembered_summary TEXT;

-- 6. Đổi tên cột cho bảng user_settings
ALTER TABLE user_settings RENAME COLUMN default_prompt TO setting_default_prompt;
ALTER TABLE user_settings RENAME COLUMN theme TO setting_theme;
ALTER TABLE user_settings RENAME COLUMN token_quota TO setting_token_quota;
ALTER TABLE user_settings RENAME COLUMN user_avatar_url TO setting_user_avatar_url;
ALTER TABLE user_settings RENAME COLUMN allow_chat_memory_lookup TO setting_allow_memory_lookup;
ALTER TABLE user_settings RENAME COLUMN allow_chat_memory_storage TO setting_allow_memory_storage;

-- 7. Kiểm tra cột trong bảng, xem coi có đang gán UNIQUE không
SELECT conname
FROM pg_constraint
WHERE conrelid = 'chat_feedbacks'::regclass
  AND contype = 'u';
  
-- 8. Xóa UNIQUE với giá trị vừa tìm được ở mục 7
ALTER TABLE chat_feedbacks
DROP CONSTRAINT chat_feedbacks_feedback_chat_id_key;

-- 9. Kiểm tra lại các UNIQUE constraints còn lại trong bảng
SELECT conname
FROM pg_constraint
WHERE conrelid = 'chat_feedbacks'::regclass
  AND contype = 'u';



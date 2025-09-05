-- =============================================
-- ✅ Cập nhật cột setting_theme trong bảng user_settings
-- Thêm lựa chọn mới: 'system'
-- =============================================

-- 1. Xoá constraint CHECK cũ nếu tồn tại
ALTER TABLE user_settings 
DROP CONSTRAINT IF EXISTS user_settings_setting_theme_check;

-- 2. Thêm lại constraint với giá trị 'system' mới
ALTER TABLE user_settings
ADD CONSTRAINT user_settings_setting_theme_check
CHECK (setting_theme IN ('light', 'dark', 'system'));

-- 3. (Tùy chọn) Cập nhật giá trị mặc định thành 'system'
-- Nếu bạn vẫn muốn giữ mặc định là 'light' thì bỏ dòng này
ALTER TABLE user_settings
ALTER COLUMN setting_theme SET DEFAULT 'system';


SELECT conname, pg_get_constraintdef(oid) AS constraint_def
FROM pg_constraint
WHERE conrelid = 'user_settings'::regclass
  AND contype = 'c'  -- chỉ lấy constraint kiểu CHECK
  AND conname LIKE '%theme%';


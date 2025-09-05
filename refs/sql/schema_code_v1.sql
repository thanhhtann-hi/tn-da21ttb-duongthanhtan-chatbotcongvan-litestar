-- 1.1 Liệt kê toàn bộ bảng trong schema 'public'
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

-- 1.2 Kiểm tra số lượng bảng đã khởi tạo
SELECT COUNT(*)
FROM information_schema.tables
WHERE table_schema = 'public';

-- 1.3 Thống kê số dòng hiện có trong mỗi bảng (nếu có seed test)
SELECT
    relname AS table_name,
    n_live_tup AS approx_row_count
FROM pg_stat_user_tables
ORDER BY relname;

-- 1.4 Cập nhật vai trò 
UPDATE public.users
SET user_role = 'admin'
WHERE user_id = '35a44da4-ccdf-45b0-9163-42ce62715dc6'; 

-- 1.5 Cập nhật ban tài khoản
UPDATE public.users
SET user_status = 'banned'
WHERE user_id = 'a6172ecc-fee4-4efa-a3ff-d69a4a06de70';

-- 1.6 Tạo tài khoản Admin
INSERT INTO users (
    user_id,
    user_name,
    user_display_name,
    user_email,
    user_password_hash,
    user_role,
    user_status,
    user_email_verified,
    theme
) VALUES (
    gen_random_uuid(),
    'admin1',
    'Administrator',
    'admin@example.com',
    'scrypt:32768:8:1$xL37jF47K7W4zmoY$c817b8538015dd52c89ba5a4e593192d52141def5959a470d093ad772b6747fb139ba56c85b5fd0b29c8142d5da00f8dce9e4664aa8e4ec450a3f2d5f73ce921', 
    'admin',
    'active',
    TRUE,
    'dark'
);

-- 1.7 Xóa Users
DELETE FROM users WHERE user_email = 'admin@example.com';

-- 1.8 Cập nhật cột mới cho Users
ALTER TABLE users
ADD COLUMN user_avatar_url VARCHAR(512);

-- 1.9 Cập nhật thuộc tính trong cột, đổi sang TEXT
ALTER TABLE users
ALTER COLUMN user_avatar_url TYPE TEXT;

-- 1.n Xem danh sách người dùng tạo mới (gần nhất trên cùng)
SELECT * FROM users
ORDER BY user_updated_at DESC;









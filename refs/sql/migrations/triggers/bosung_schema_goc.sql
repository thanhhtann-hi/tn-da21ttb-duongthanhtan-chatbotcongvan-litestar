-- file: migrations/chat_tokens_trigger.sql
-- updated: 2025-09-28 15:39PM
-- note:

-- 1) Thêm các cột mới (nếu chưa có)
ALTER TABLE chat_history_versions
  ADD COLUMN IF NOT EXISTS parent_message_id VARCHAR(36),
  ADD COLUMN IF NOT EXISTS version_index INT,
  ADD COLUMN IF NOT EXISTS version_kind VARCHAR(20) DEFAULT 'edit' NOT NULL;

-- 2) Check constraint cho version_kind
DO $$
BEGIN
  ALTER TABLE chat_history_versions
    ADD CONSTRAINT ck_chv_kind CHECK (version_kind IN ('edit','regenerate'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 3) Unique constraint (parent_message_id, version_index)
DO $$
BEGIN
  ALTER TABLE chat_history_versions
    ADD CONSTRAINT uq_chv_message_index UNIQUE (parent_message_id, version_index);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 4) Index phục vụ truy vấn
CREATE INDEX IF NOT EXISTS ix_chv_parent_msg  ON chat_history_versions(parent_message_id);
CREATE INDEX IF NOT EXISTS ix_chv_parent_chat ON chat_history_versions(parent_chat_id);

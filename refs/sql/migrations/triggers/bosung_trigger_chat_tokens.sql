-- file: migrations/chat_tokens_trigger.sql
-- updated: 2025-08-03
-- note:    Trigger tự động cập nhật cột chat_tokens_input / chat_tokens_output trong chat_histories khi chat_messages được INSERT / UPDATE / DELETE

---------------------------------------------------------------------------
-- 1. Drop trigger & function (idempotent cho môi trường dev)
---------------------------------------------------------------------------
DROP TRIGGER  IF EXISTS trg_sync_chat_tokens ON chat_messages;
DROP FUNCTION IF EXISTS sync_chat_token_totals();

---------------------------------------------------------------------------
-- 2. Hàm cập nhật tổng token
---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_chat_token_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_chat CHAR(36);
BEGIN
    -- Xác định chat_id đang bị ảnh hưởng
    v_chat := COALESCE(NEW.message_chat_id, OLD.message_chat_id);

    -- Ghi lại tổng token mới nhất vào chat_histories
    UPDATE chat_histories h
    SET
        chat_tokens_input  = COALESCE((
            SELECT SUM(message_tokens_input)
            FROM chat_messages
            WHERE message_chat_id = v_chat
        ), 0),
        chat_tokens_output = COALESCE((
            SELECT SUM(message_tokens_output)
            FROM chat_messages
            WHERE message_chat_id = v_chat
        ), 0),
        chat_updated_at    = CURRENT_TIMESTAMP
    WHERE h.chat_id = v_chat;

    RETURN NULL;  -- AFTER trigger không cần trả bản ghi
END;
$$;

---------------------------------------------------------------------------
-- 3. Trigger gọi hàm trên sau khi thay đổi chat_messages
---------------------------------------------------------------------------
CREATE TRIGGER trg_sync_chat_tokens
AFTER INSERT OR UPDATE OR DELETE
ON chat_messages
FOR EACH ROW
EXECUTE FUNCTION sync_chat_token_totals();

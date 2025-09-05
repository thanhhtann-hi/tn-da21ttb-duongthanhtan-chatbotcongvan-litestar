SELECT 
    ch.chat_id,
    ch.chat_title,
    ch.chat_created_at,

    cm.message_id,
    cm.message_question,
    cm.message_ai_response,
    cm.message_created_at,

    d.doc_id,
    d.doc_file_path,
    d.doc_ocr_text_path,
    d.doc_title,
    d.doc_status,
    d.doc_created_at,

    da.attachment_id,
    da.attachment_file_path,
    da.attachment_description,
    da.attachment_created_at

FROM chat_histories ch
JOIN chat_messages cm 
    ON cm.message_chat_id = ch.chat_id
JOIN documents d 
    ON d.doc_chat_id = ch.chat_id
LEFT JOIN document_attachments da 
    ON da.attachment_doc_id = d.doc_id

ORDER BY ch.chat_created_at, cm.message_created_at, d.doc_created_at, da.attachment_created_at;

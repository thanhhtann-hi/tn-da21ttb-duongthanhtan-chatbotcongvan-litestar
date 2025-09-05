// file: src/modules/chat/static/js/chat_paste_guard.js
// updated: 2025-08-28 (v3)
// goal: 1 lần dán duy nhất cho MỖI lần nhấn Ctrl/⌘+V; chặn mọi 'paste' tiếp theo
//       cho đến khi nhả phím. Dán bằng menu/chuột vẫn OK.

(function () {
    'use strict';

    let COMBO_ACTIVE = false;   // đang giữ Ctrl/Meta + V
    let COMBO_ID = 0;           // id phiên dán cho mỗi lần nhấn non-repeat
    let CONSUMED = false;       // đã dùng 1 lần dán trong phiên này
    let AUTO_RESET_T = 0;       // timeout id
    const AUTO_RESET_MS = 2500; // nếu không thấy keyup thì tự reset sau 2.5s

    // helper: bật 1 phiên mới
    function armNewCombo() {
        COMBO_ACTIVE = true;
        COMBO_ID++;
        CONSUMED = false;
        // làm sạch timeout cũ
        if (AUTO_RESET_T) { clearTimeout(AUTO_RESET_T); AUTO_RESET_T = 0; }
        AUTO_RESET_T = setTimeout(resetCombo, AUTO_RESET_MS);
    }

    function resetCombo() {
        COMBO_ACTIVE = false;
        CONSUMED = false;
        if (AUTO_RESET_T) { clearTimeout(AUTO_RESET_T); AUTO_RESET_T = 0; }
    }

    // Nhận lần NHẤN non-repeat của Ctrl/Meta+V để mở combo
    document.addEventListener('keydown', (e) => {
        const k = (e.key || '').toLowerCase();
        const mod = (e.ctrlKey || e.metaKey);
        if (mod && k === 'v' && !e.repeat) {
            armNewCombo();
        }
    }, true);

    // Khi nhả V hoặc nhả Ctrl/Meta → đóng combo
    document.addEventListener('keyup', (e) => {
        const k = (e.key || '').toLowerCase();
        if (k === 'v' || k === 'control' || k === 'meta') {
            resetCombo();
        }
    }, true);

    // Nếu đổi tab/ẩn trang, tránh combo kẹt
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') resetCombo();
    }, true);

    // Chặn dán lặp khi đang giữ phím
    document.addEventListener('paste', (e) => {
        // Nếu là combo đang giữ: chỉ cho 1 lần duy nhất
        if (COMBO_ACTIVE) {
            if (!CONSUMED) {
                CONSUMED = true; // cấp đúng 1 lần
                return;          // cho sự kiện đi qua
            }
            // các lần tiếp theo trong cùng combo → chặn cứng
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }

        // Không phải combo (menu/chuột) → cho qua bình thường
    }, true);
})();

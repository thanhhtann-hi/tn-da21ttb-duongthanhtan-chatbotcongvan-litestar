// ======================================================
// 📄 static/js/auth_left.js
// 🕒 Last updated: 2025-07-04 22:30
// ➤ Tính năng: Text động + chấm tròn động (ẩn sau 1 giây)
// ➤ 🛠 Fix: Lần thứ 2 không bị lặp nội dung block 1
// ======================================================

let idx = parseInt(localStorage.getItem('phrase_idx') || '0');
let showingBlock = 1;
let waitingToFlip = false;

const phrases = [
    ["Tiếp nhận văn bản tự động", "Phân loại, trích xuất và luân chuyển văn bản nhanh chóng, chính xác."],
    ["Trợ lý xử lý văn bản", "AI hỗ trợ đọc hiểu, tóm tắt, đề xuất hướng xử lý tối ưu."],
    ["Tối ưu quy trình tiếp nhận", "Giảm thời gian xử lý nhờ tự động hóa và phân tích nội dung thông minh."],
    ["Hỏi đáp văn bản tức thì", "Tìm đúng thông tin chỉ với một câu hỏi, không cần đọc toàn văn."],
    ["Xử lý hành chính chuẩn xác", "Tối ưu hóa quy trình, giảm thiểu sai sót và nâng cao hiệu suất xử lý văn bản đến."],
    ["AI trong quản lý công vụ", "Từ tiếp nhận đến điều phối nội bộ – tất cả trong một hệ thống thông minh."]
];

function typeWriterEffect(el, dotEl, text, cb) {
    el.textContent = '';
    dotEl.classList.remove('opacity-0', 'dot-blink');
    let i = 0, frame = 0, speed = 0.5;

    setTimeout(() => requestAnimationFrame(step), 300);

    function step() {
        if (document.hidden) {
            requestAnimationFrame(step);
            return;
        }

        frame += speed;

        if (frame >= 1 && i < text.length) {
            el.textContent += text[i++];
            frame = 0;
        }

        if (i < text.length) {
            requestAnimationFrame(step);
        } else {
            dotEl.classList.add('dot-blink');
            setTimeout(() => {
                dotEl.classList.add('opacity-0');
                dotEl.classList.remove('dot-blink');
            }, 1000);
            if (cb) setTimeout(cb, 1000);
        }
    }
}

function fadeBlock() {
    if (document.hidden) {
        waitingToFlip = true;
        return;
    }

    const curID = showingBlock === 1 ? 'block1' : 'block2';
    const nextID = showingBlock === 1 ? 'block2' : 'block1';

    const cur = document.getElementById(curID);
    const nxt = document.getElementById(nextID);
    const nxtL1 = document.getElementById(`${nextID}-line1`);
    const nxtL2 = document.getElementById(`${nextID}-line2`);
    const nxtDot = document.getElementById(`dot${nextID.slice(-1)}`);

    cur.classList.replace('opacity-100', 'opacity-0');

    // ⚠️ Tránh lặp lại → cập nhật nội dung kế tiếp
    nxtL1.textContent = phrases[idx][0];
    nxtL2.textContent = '';
    nxtDot.classList.remove('opacity-0', 'dot-blink');
    nxt.classList.replace('opacity-0', 'opacity-100');

    localStorage.setItem('phrase_idx', idx);

    setTimeout(() =>
        typeWriterEffect(nxtL2, nxtDot, phrases[idx][1], () => {
            showingBlock = showingBlock === 1 ? 2 : 1;
            idx = (idx + 1) % phrases.length;
            localStorage.setItem('phrase_idx', idx);
            setTimeout(fadeBlock, 3000);
        })
        , 700);
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && waitingToFlip) {
        waitingToFlip = false;
        fadeBlock();
    }
});

window.addEventListener('DOMContentLoaded', () => {
    const block1Line1 = document.getElementById('block1-line1');
    const block1Line2 = document.getElementById('block1-line2');
    const dot1 = document.getElementById('dot1');

    block1Line1.textContent = phrases[idx][0];

    typeWriterEffect(block1Line2, dot1, phrases[idx][1], () => {
        // ✅ FIX: tăng idx trước khi gọi fadeBlock để tránh lặp
        idx = (idx + 1) % phrases.length;
        localStorage.setItem('phrase_idx', idx);
        setTimeout(fadeBlock, 3000);
    });
});

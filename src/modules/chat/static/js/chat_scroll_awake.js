// file: src/modules/chat/static/js/chat_scroll_awake.js
// updated: 2025-08-27
// note: Đánh thức/ru ngủ scrollbar theo tương tác (wheel/scroll/touch/hover).

(function () {
    'use strict';
    if (window.__SCROLL_AWAKE__) return; window.__SCROLL_AWAKE__ = true;

    const $ = (s, r) => (r || document).querySelector(s);
    const on = (el, ev, fn, opt) => el && el.addEventListener(ev, fn, opt || { passive: true });

    // Các vùng có thanh cuộn cần theo dõi
    const targets = [
        $('#chat-scroll'),
        $('#sidebar'),
        $('#chat-footer-shell .cf-input')
    ].filter(Boolean);

    function awaken(el, ms) {
        if (!el) return;
        el.classList.add('sb-awake');
        clearTimeout(el.__sbAwakeTimer__);
        el.__sbAwakeTimer__ = setTimeout(() => el.classList.remove('sb-awake'), ms || 900);
    }

    targets.forEach(el => {
        ['scroll', 'wheel', 'touchstart', 'touchmove'].forEach(ev => on(el, ev, () => awaken(el)));
        on(el, 'mouseenter', () => awaken(el));
        el.addEventListener('mouseleave', () => {
            clearTimeout(el.__sbAwakeTimer__);
            el.__sbAwakeTimer__ = setTimeout(() => el.classList.remove('sb-awake'), 250);
        }, { passive: true });
    });

    // Nếu vào trang khi đã có vị trí cuộn
    targets.forEach(el => { if (el && (el.scrollTop > 0 || el.scrollLeft > 0)) awaken(el, 600); });
})();

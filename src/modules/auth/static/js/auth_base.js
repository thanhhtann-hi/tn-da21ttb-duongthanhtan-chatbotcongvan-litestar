// ──────────────────────────────────────────────────────────────────────────────
// 📄 modules/auth/static/js/auth_base.js
// 🕒 Last updated: 2025-07-05 15:55
// 📝
//   • Ghi cookie “tz” + header X-Timezone (giữ nguyên).
//   • NEW: Đọc cookie “csrftoken” ➜ gắn header “X-CSRFToken” cho HTMX & fetch.
//   • One-shot monkey-patch window.fetch (axios/fetch dùng chung) – tránh
//     patch lặp khi file load nhiều lần.
// -----------------------------------------------------------------------------

(() => {
    /* ╔═ 1.  Lấy timezone ↓ ghi cookie 1 năm ──────────────────────────────── */
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    document.cookie = `tz=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;

    /* ╔═ 2.  Helper lấy csrftoken từ cookie ───────────────────────────────── */
    const getCookie = name => {
        const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
        return m ? decodeURIComponent(m[1]) : '';
    };
    const csrf = getCookie('csrftoken');

    /* ╔═ 3.  Gắn header mặc định cho HTMX (XHR) ───────────────────────────── */
    if (window.htmx) {
        htmx.config.defaultHeaders = {
            ...(htmx.config.defaultHeaders || {}),
            'X-Timezone': tz,
            ...(csrf ? { 'X-CSRFToken': csrf } : {}),
        };
    }

    /* ╔═ 4.  Patch window.fetch (ảnh hưởng axios/fetch) ───────────────────── */
    if (!window._globalFetchPatched) {
        window._globalFetchPatched = true;
        const origFetch = window.fetch;
        window.fetch = function (input, init = {}) {
            const headersObj =
                init.headers instanceof Headers
                    ? Object.fromEntries(init.headers.entries())
                    : { ...(init.headers || {}) };

            if (!headersObj['X-Timezone']) headersObj['X-Timezone'] = tz;
            if (csrf && !headersObj['X-CSRFToken']) headersObj['X-CSRFToken'] = csrf;

            return origFetch(input, { ...init, headers: headersObj });
        };
    }

    /* ╔═ 5.  Khởi tạo validation form Đăng ký sau DOM ready ───────────────── */
    document.addEventListener('DOMContentLoaded', () => {
        bindRegisterValidation();
    });

    /* ╔═ 6.  Cập nhật <title> & rebinding sau HTMX swap ===================== */
    document.addEventListener('htmx:afterSwap', e => {
        if (e.detail.target.id === 'form-container') {
            const titleTag = e.detail.xhr.responseXML?.querySelector('title');
            if (titleTag) document.title = titleTag.textContent;
            bindRegisterValidation(e.detail.target);
        }
    });

    /* ╔═ 7.  Hàm realtime-validation cho form Đăng ký ======================= */
    function bindRegisterValidation(root = document) {
        const form = root.querySelector('#reg-form');
        if (!form || form.dataset.bound === '1') return;
        form.dataset.bound = '1';

        const inputs = form.querySelectorAll('input');
        const submit = form.querySelector('#submit-btn');

        const setState = (inp, state, msg = '') => {
            const err = inp.parentElement.querySelector('.error-msg');
            err.textContent = msg;
            inp.classList.remove('border-gray-300', 'border-red-500', 'border-green-500');
            inp.classList.add(
                state === 'error'
                    ? 'border-red-500'
                    : state === 'valid'
                        ? 'border-green-500'
                        : 'border-gray-300',
            );
            submit.disabled = [...form.querySelectorAll('.error-msg')].some(e => e.textContent.trim());
        };

        inputs.forEach(inp => {
            inp.addEventListener('input', () => {
                const err = inp.parentElement.querySelector('.error-msg');
                if (err.textContent) setState(inp, 'normal');
            });

            inp.addEventListener('blur', () => {
                const v = inp.value.trim();
                if (!v) return setState(inp, 'error', 'Không được để trống');

                /* ─── Password ──────────────────────────────────────────── */
                if (inp.id === 'password') {
                    const rePw = /^(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>]).{6,}$/;
                    !rePw.test(v)
                        ? setState(inp, 'error', '≥6 ký tự, gồm số & ký tự đặc biệt')
                        : setState(inp, 'valid');
                }

                /* ─── Username ──────────────────────────────────────────── */
                if (inp.id === 'username') {
                    const reUser = /^(?=.*[a-z])(?=.*\d)[a-z\d]{3,30}$/;
                    if (!reUser.test(v)) {
                        return setState(inp, 'error', 'Chỉ a-z & 0-9, 3-30 ký tự, phải có chữ & số');
                    }
                    fetch(`/api/validate-username?u=${encodeURIComponent(v)}`)
                        .then(r => r.json())
                        .then(d => (d.valid ? setState(inp, 'valid') : setState(inp, 'error', d.message)))
                        .catch(() => setState(inp, 'error', 'Lỗi mạng'));
                }

                /* ─── Email ─────────────────────────────────────────────── */
                if (inp.id === 'email') {
                    const reMail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    if (!reMail.test(v)) return setState(inp, 'error', 'Email không hợp lệ');

                    fetch(`/api/validate-email?e=${encodeURIComponent(v)}`)
                        .then(r => r.json())
                        .then(d => (d.valid ? setState(inp, 'valid') : setState(inp, 'error', d.message)))
                        .catch(() => setState(inp, 'error', 'Lỗi mạng'));
                }
            });
        });
    }
})();

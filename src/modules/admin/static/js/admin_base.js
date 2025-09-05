/********************************************************************
 * file   : src/modules/admin/static/js/admin_base.js
 * updated: 2025-08-25 (v2.3)
 * changes:
 *  - Unify CSRF header: send BOTH 'X-CSRF-Token' & 'X-CSRFToken' for fetch/HTMX
 *  - Add htmx:sendError handler (mất mạng / bị chặn) → Toast cảnh báo
 *  - Ensure #toast-root exists (auto create if missing)
 *  - NEW: Auto scroll-to-top + focus #admin-frame sau khi nạp fragment
 ********************************************************************/
(function () {
    'use strict';

    /* 0) Helpers */
    var qs = function (s) { return document.querySelector(s); };
    var getMeta = function (name) {
        var el = document.querySelector('meta[name="' + name + '"]');
        return el ? el.getAttribute('content') : '';
    };

    /* Ensure toast root exists (defensive) */
    (function ensureToastRoot() {
        if (!document.getElementById('toast-root')) {
            var div = document.createElement('div');
            div.id = 'toast-root';
            div.className = 'fixed inset-0 z-[99999] pointer-events-none';
            document.body.appendChild(div);
        }
    })();

    var csrfToken = getMeta('csrf-token');

    /* ╔══════════════════════════════════════════════════════════════╗
       Toast v2.1 – ổn định auto-hide/click; support multi-line text
       ─────────────────────────────────────────────────────────────── */
    var Toast = (function () {
        var root = document.getElementById('toast-root');
        if (!root) return { show: function () { } };

        var current = null;

        function forceRemove(entry) {
            try { clearTimeout(entry.timer); } catch (e) { }
            try { entry.wrap && entry.wrap.remove(); } catch (e) { }
            if (current === entry) current = null;
        }

        function show(msg, type, ms) {
            type = type || 'info';
            ms = (typeof ms === 'number' && ms > 0) ? ms : 3000;

            if (current) forceRemove(current);

            var wrap = document.createElement('div');
            wrap.className = 'toast-wrapper fixed left-0 right-0 z-[99999]';

            var typeClass = 'toast-info';
            if (type === 'success') typeClass = 'toast-success';
            else if (type === 'error') typeClass = 'toast-error';
            else if (type === 'warn' || type === 'warning') typeClass = 'toast-warn';

            var icons = {
                success: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="10" fill="#22C55E"/><path d="M6 10.5l2.2 2 5-5" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
                error: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="10" fill="#EF4444"/><path d="M7 7l6 6M13 7l-6 6" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
                info: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="10" fill="#2563EB"/><path d="M10 6.5v4.5m0 2.5h.01" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
                warn: '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="10" fill="#FACC15"/><path d="M10 6.5v5m0 2h.01" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>'
            };

            var box = document.createElement('div');
            box.className = 'toast-main ' + typeClass;
            box.setAttribute('role', 'status');
            box.setAttribute('aria-live', 'polite');

            var inner = document.createElement('div');
            inner.className = 'toast-inner';

            var iconWrap = document.createElement('div');
            iconWrap.className = 'toast-icon';
            iconWrap.innerHTML = (icons[type] || icons.info);

            var text = document.createElement('div');
            text.className = 'toast-text';
            text.textContent = String(msg || '');

            inner.appendChild(iconWrap);
            inner.appendChild(text);
            box.appendChild(inner);
            wrap.appendChild(box);
            root.appendChild(wrap);

            var entry = { wrap: wrap, box: box, timer: null, hide: hide };
            current = entry;

            setTimeout(function () { box.classList.add('toast-shown'); }, 10);

            entry.timer = setTimeout(hide, ms);
            box.addEventListener('click', hide, false);

            function hide() {
                try { clearTimeout(entry.timer); } catch (e) { }
                if (!entry || !entry.box || !entry.wrap || !entry.wrap.parentNode) {
                    if (current === entry) current = null; return;
                }
                entry.box.classList.remove('toast-shown');
                entry.box.classList.add('animate-toastOut');
                setTimeout(function () { forceRemove(entry); }, 380);
            }

            return { hide: hide };
        }

        return { show: show };
    })();

    window.Toast = Toast;

    /* A) PATCH fetch() – auto CSRF headers */
    if (!window._adminFetchPatched) {
        window._adminFetchPatched = true;
        var origFetch = window.fetch;
        window.fetch = function (input, init) {
            init = init || {};
            var headers = init.headers instanceof Headers
                ? (function () { var obj = {}; init.headers.forEach(function (v, k) { obj[k] = v; }); return obj; })()
                : (init.headers || {});
            if (csrfToken) {
                if (!headers['X-CSRF-Token']) headers['X-CSRF-Token'] = csrfToken;   // canonical
                if (!headers['X-CSRFToken']) headers['X-CSRFToken'] = csrfToken;     // legacy
            }
            return origFetch(input, Object.assign({}, init, { headers: headers }));
        };
    }

    /* B) HTMX – CSRF + global response handling */
    document.body.addEventListener('htmx:configRequest', function (evt) {
        var token = getMeta('csrf-token');
        if (!token) return;
        evt.detail.headers['X-CSRF-Token'] = token;
        evt.detail.headers['X-CSRFToken'] = token;
    });

    document.body.addEventListener('htmx:afterOnLoad', function (evt) {
        var xhr = evt && evt.detail ? evt.detail.xhr : null;
        if (!xhr) return;

        if (xhr.getResponseHeader && xhr.getResponseHeader('HX-Refresh-All') === 'true') {
            window.location.reload(); return;
        }

        var redirectUrl = xhr.getResponseHeader && xhr.getResponseHeader('HX-Redirect');
        if (redirectUrl) { window.location.href = redirectUrl; return; }

        if ([401, 403, 419].indexOf(xhr.status) > -1) {
            window.location.href = '/auth/login';
        }
    });

    document.body.addEventListener('htmx:responseError', function (evt) {
        try { console.error('HTMX response error:', evt.detail.xhr.status, evt.detail.xhr.responseText); } catch (e) { }
        Toast.show('Có lỗi khi tải dữ liệu.', 'error', 2200);
    });

    // NEW: mạng lỗi / request bị chặn (khác responseError)
    document.body.addEventListener('htmx:sendError', function () {
        Toast.show('Không thể gửi yêu cầu. Vui lòng kiểm tra kết nối mạng.', 'warn', 2600);
    });

    /* C) Focus + scroll vào #admin-frame khi nạp fragment (UX) */
    (function bindFrameFocusScroll() {
        function bumpFocus(target) {
            if (!target) return;
            try {
                if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
                target.focus({ preventScroll: true });
            } catch (e) { /* noop */ }
        }
        function scrollTop(target) {
            try { (target || document.getElementById('admin-frame')).scrollTo({ top: 0, behavior: 'smooth' }); }
            catch (e) { try { (target || document.getElementById('admin-frame')).scrollTop = 0; } catch (_) { } }
        }

        document.body.addEventListener('htmx:afterSwap', function (evt) {
            var t = evt && evt.detail ? evt.detail.target : null;
            if (!t) return;
            // Khi thay nội dung #admin-frame hoặc phần tử nằm trong nó → cuộn lên đầu & focus
            var frame = document.getElementById('admin-frame');
            if (!frame) return;
            if (t === frame || frame.contains(t)) {
                bumpFocus(frame);
                scrollTop(frame);
            }
        });
    })();

    /* D) (giữ) maintenance form… */
    function bindMaintenanceForm() {
        var secForm = qs('#security-form-container form');
        if (!secForm || secForm.dataset.bound === '1') return;
        secForm.dataset.bound = '1';
        secForm.addEventListener('submit', function (e) {
            e.preventDefault();
            try {
                var url = secForm.action;
                var method = (secForm.method || 'POST').toUpperCase();
                var formData = new FormData(secForm);
                window.fetch(url, { method: method, body: formData }).then(function (resp) {
                    if (resp && resp.ok) window.location.reload();
                    else Toast.show('Lưu cấu hình thất bại!', 'error', 2200);
                })["catch"](function () { Toast.show('Có lỗi mạng khi lưu cấu hình!', 'error', 2200); });
            } catch (err) {
                Toast.show('Có lỗi mạng khi lưu cấu hình!', 'error', 2200);
            }
        });
    }
    bindMaintenanceForm();
    document.body.addEventListener('htmx:afterSwap', bindMaintenanceForm);

    /* E) Global error catcher (silent) */
    window.addEventListener('error', function () { });
    window.addEventListener('unhandledrejection', function () { });
})();

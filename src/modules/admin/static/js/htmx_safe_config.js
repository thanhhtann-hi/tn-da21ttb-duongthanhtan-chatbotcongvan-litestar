// file: src/modules/admin/static/js/htmx_safe_config.js
// updated: 2025-08-11
// purpose: 1) Disable HTMX inline eval to avoid syntax errors from "js:" snippets
//          2) Add global CSRF header for all HTMX requests (safe, ES5)

(function () {
    function getMeta(name) {
        try {
            var m = document.querySelector('meta[name="' + name + '"]');
            return m ? m.getAttribute('content') : '';
        } catch (e) { return ''; }
    }

    function applyHTMXConfig() {
        try {
            if (!window.htmx || !window.htmx.config) return;

            // 1) Tắt eval các biểu thức inline: hx-vals="js:...", hx-on="...", ...
            //    (Ta đã có fallback trong JS để kèm filter vào form/query)
            window.htmx.config.allowEval = false;

            // 2) CSRF header toàn cục
            document.body.addEventListener('htmx:configRequest', function (evt) {
                try {
                    var token = getMeta('csrf-token');
                    if (token) { evt.detail.headers['X-CSRFToken'] = token; }
                } catch (e) { /* noop */ }
            }, false);

            // 3) (Tuỳ chọn) Logger nhỏ để phát hiện optional chaining trong response
            //    Bật bằng: window.__HTMX_DEBUG_OPTCHAIN = true
            document.body.addEventListener('htmx:beforeSwap', function (e) {
                try {
                    if (!window.__HTMX_DEBUG_OPTCHAIN) return;
                    var txt = e && e.detail && e.detail.xhr ? (e.detail.xhr.responseText || '') : '';
                    var idx = txt.indexOf('?.');
                    if (idx >= 0) {
                        console.warn('[htmx-safe] Found "?.":',
                            txt.slice(Math.max(0, idx - 160), Math.min(txt.length, idx + 160)));
                    }
                } catch (err) { /* noop */ }
            }, false);

        } catch (e) {
            // im lặng để không spam console ở môi trường prod
        }
    }

    function tryApply() {
        if (window.htmx && window.htmx.config) applyHTMXConfig();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryApply);
    } else {
        tryApply();
    }

    // Dự phòng: nếu HTMX gắn sau file này
    var retries = 0;
    var t = setInterval(function () {
        if (window.htmx && window.htmx.config) {
            applyHTMXConfig();
            clearInterval(t);
        }
        if (++retries > 20) clearInterval(t);
    }, 50);
})();

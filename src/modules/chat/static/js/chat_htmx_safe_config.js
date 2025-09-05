// file: src/modules/chat/static/js/chat_htmx_safe_config.js
// updated: 2025-08-15
// note: sửa nhận diện boosted & bỏ redirect với modal

(function () {
    'use strict';

    // [0] Idempotent guard + version flag
    if (window.__HTMX_CHAT_CFG_APPLIED__) return;
    window.__HTMX_CHAT_CFG_APPLIED__ = true;
    window.__HTMX_CHAT_CFG_VER__ = '1.3';

    // [A] Helpers
    function getMeta(name) {
        try {
            var m = document.querySelector('meta[name="' + name + '"]');
            return m ? m.getAttribute('content') : '';
        } catch (e) { return ''; }
    }
    // [A.1] Lấy URL đích an toàn cho redirect cứng
    function _targetURL(evt, xhr) {
        try {
            return (
                (evt.detail && evt.detail.pathInfo && (evt.detail.pathInfo.finalRequestPath || evt.detail.pathInfo.requestPath)) ||
                (evt.detail && evt.detail.requestConfig && (evt.detail.requestConfig.url || evt.detail.requestConfig.path)) ||
                (xhr && xhr.responseURL) ||
                window.location.href
            );
        } catch (_) { return window.location.href; }
    }
    // [A.2] Có phải request được boost?
    //      ⚠️ Sửa mặc định: nếu không có cờ → coi là KHÔNG boosted.
    function _isBoosted(evt) {
        try {
            if (evt && evt.detail && evt.detail.requestConfig && typeof evt.detail.requestConfig.boosted === 'boolean') {
                return !!evt.detail.requestConfig.boosted;
            }
        } catch (_) { }
        return false; // default: NOT boosted
    }

    // [B] Áp dụng cấu hình khi HTMX sẵn sàng
    function apply() {
        try {
            if (!window.htmx || !window.htmx.config) return;

            // [1] Khoá eval inline trong thuộc tính hx-*
            window.htmx.config.allowEval = false;

            // [2] CSRF header cho mọi HTMX request
            document.body.addEventListener('htmx:configRequest', function (evt) {
                try {
                    var token = getMeta('csrf-token');
                    if (token) evt.detail.headers['X-CSRFToken'] = token;
                } catch (_) { /* noop */ }
            }, false);

            // [3] Fallback trước khi swap: xử lý lỗi/HTML không khớp layout
            document.body.addEventListener('htmx:beforeSwap', function (evt) {
                try {
                    var xhr = evt && evt.detail ? evt.detail.xhr : null;
                    if (!xhr) return;

                    var status = xhr.status || 0;

                    // [3.1] Auth lỗi → hard redirect login
                    if (status === 401 || status === 403 || status === 419) {
                        evt.detail.shouldSwap = false;
                        window.location.href = '/auth/login';
                        return;
                    }

                    // [3.2] 404/500 khi ĐÚNG LÀ boosted → hard redirect đến URL đích
                    if ((status === 404 || status >= 500) && _isBoosted(evt)) {
                        evt.detail.shouldSwap = false;
                        window.location.href = _targetURL(evt, xhr);
                        return;
                    }

                    // [3.3] HTML không chứa #chat-root trong flow boosted → hard redirect
                    //      ✅ Bổ sung ngoại lệ: nếu target là #chat-modal-root (mở modal) thì KHÔNG redirect.
                    var html = evt.detail.serverResponse;
                    var t = evt.detail && evt.detail.target ? evt.detail.target : null;
                    var isModalTarget = !!(t && t.id === 'chat-modal-root');
                    if (_isBoosted(evt) && typeof html === 'string') {
                        if (!isModalTarget && html.indexOf('id="chat-root"') === -1) {
                            evt.detail.shouldSwap = false;
                            window.location.href = _targetURL(evt, xhr);
                            return;
                        }
                    }
                } catch (e) {
                    // có lỗi JS không chặn điều hướng hard redirect
                    try {
                        evt.detail.shouldSwap = false;
                        window.location.href = _targetURL(evt, evt && evt.detail ? evt.detail.xhr : null);
                    } catch (_) { }
                }
            }, false);

            // [4] Xử lý phản hồi sau khi load (redirect header / refresh)
            document.body.addEventListener('htmx:afterOnLoad', function (evt) {
                try {
                    var xhr = evt && evt.detail ? evt.detail.xhr : null;
                    if (!xhr) return;

                    // a) Refresh toàn trang nếu server yêu cầu
                    if (xhr.getResponseHeader && xhr.getResponseHeader('HX-Refresh-All') === 'true') {
                        window.location.reload();
                        return;
                    }

                    // b) Redirect mềm qua header
                    var redirectUrl = xhr.getResponseHeader && xhr.getResponseHeader('HX-Redirect');
                    if (redirectUrl) {
                        window.location.href = redirectUrl;
                        return;
                    }

                    // c) Auth lỗi (phòng hờ)
                    if ([401, 403, 419].indexOf(xhr.status) > -1) {
                        window.location.href = '/auth/login';
                    }
                } catch (_) { /* noop */ }
            }, false);

            // [5] Log lỗi response để debug
            document.body.addEventListener('htmx:responseError', function (evt) {
                try {
                    var x = evt && evt.detail ? evt.detail.xhr : null;
                    console.error('[chat_htmx_safe_config] response error:',
                        x ? (x.status + ' ' + (x.responseURL || '')) : '(unknown)');
                } catch (_) { /* noop */ }
            }, false);
        } catch (_) {
            // silent in prod
        }
    }

    // [C] Chờ HTMX sẵn sàng
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply, { once: true });
    } else {
        apply();
    }
    var retries = 0;
    var t = setInterval(function () {
        if (window.htmx && window.htmx.config) {
            apply();
            clearInterval(t);
        }
        if (++retries > 20) clearInterval(t); // ~1 giây
    }, 50);
})();

/********************************************************************
 * File  : src/modules/admin/static/js/admin_notify_new_modal.js
 * Updated: 2025-08-12 (v2.8 – ES5-safe)
 * Note  : Giữ đủ filter (v/sort/q/start/end/page/per_page) sau submit,
 *         KHÔNG dùng hx-vals. Trước submit (capture) bơm filter vào BODY
 *         và merge __notifyFilterQS() vào hx-post (QS-fallback).
 *         Chỉ swap #notify-list-region; chặn double-submit; toast 1 lần;
 *         phục hồi nút khi lỗi; backup tham số bằng htmx:configRequest.
 ********************************************************************/

/* Focus textarea khi modal mở */
function focusNotifyModalTextarea() {
    setTimeout(function () {
        var modal = document.getElementById('notify-new-modal');
        if (!modal) return;
        var textarea = modal.querySelector('textarea[name="notify_content"]');
        if (textarea) { try { textarea.focus(); } catch (e) { } }
    }, 60);
}

/* Đóng modal tạo mới */
function closeNotifyCreateModal() {
    var ov = document.getElementById('notify-new-modal-overlay');
    if (ov && ov.remove) ov.remove();
    var md = document.getElementById('notify-new-modal');
    if (md && md.remove) md.remove();
}

/* Bind nút đóng, overlay, ESC và click ra ngoài modal */
function bindNotifyModalClose() {
    document.body.addEventListener('click', function (e) {
        if (!e || !e.target) return;
        if (e.target.id === 'notify-new-modal-overlay') { closeNotifyCreateModal(); return; }
        if (e.target.id === 'notify-new-modal-close') { closeNotifyCreateModal(); return; }
        if (e.target.closest) {
            var x = e.target.closest('#notify-new-modal-close');
            if (x) { closeNotifyCreateModal(); return; }
        }
        if (e.target.id === 'notify-new-modal') { closeNotifyCreateModal(); return; }
    });
    document.body.addEventListener('keydown', function (e) {
        if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('notify-new-modal')) {
            closeNotifyCreateModal();
        }
    });
}

/* Helpers */
function _toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }

function _upsertHidden(form, name, value) {
    var el = form.querySelector('input[name="' + name + '"]');
    if (value == null || value === '') {
        if (el && el.remove) el.remove();
        return;
    }
    if (!el) {
        el = document.createElement('input');
        el.type = 'hidden';
        el.name = name;
        form.appendChild(el);
    }
    el.value = String(value);
}

function _mergeQsIntoUrl(base, qs) {
    if (!qs) return base;
    var hasQ = (base || '').indexOf('?') >= 0;
    var payload = (qs.charAt(0) === '?') ? qs.substring(1) : qs;
    return base + (hasQ ? '&' : '?') + payload;
}

/* Lấy filter hiện tại (ưu tiên API mới, fallback DOM) */
function _getCurrentFilters() {
    // API mới từ admin_notify.js
    if (typeof window.__notifyFilterVals === 'function') {
        try {
            var o = window.__notifyFilterVals() || {};
            return {
                start_date: o.start_date || '',
                end_date: o.end_date || '',
                v: o.v || 'all',
                sort: o.sort || 'created_desc',
                q: o.q || '',
                page: _toInt(o.page, 1),
                per_page: _toInt(o.per_page, 10)
            };
        } catch (e) { }
    }
    // Fallback đọc DOM hidden inputs từ toolbar
    var get = function (id) { var el = document.getElementById(id); return el ? (el.value || '') : ''; };
    var inp = document.getElementById('notify-search-input');
    return {
        start_date: get('state-start-date'),
        end_date: get('state-end-date'),
        v: get('state-view') || 'all',
        sort: get('state-sort') || 'created_desc',
        q: inp ? (inp.value || '') : '',
        page: _toInt(get('state-page') || '1', 1),
        per_page: _toInt(get('state-per-page') || '10', 10)
    };
}

/* Helper: luôn kèm đủ filter vào body & URL trước khi submit (KHÔNG dùng hx-vals) */
function ensureFormKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    try { form.removeAttribute('hx-vals'); } catch (e) { }

    // 1) Inject sớm ở capture phase (chạy TRƯỚC htmx) + chặn double-submit
    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__notifyJustCreated = true; // đánh dấu để hiện toast sau khi swap

        var submitBtn = document.querySelector('#notify-submit-btn');
        if (submitBtn) submitBtn.disabled = true;

        var f = _getCurrentFilters();
        var hasRange = !!(f.start_date && f.end_date);

        // Bơm hidden để _extract_filters ưu tiên đọc từ form
        _upsertHidden(form, 'v', f.v);
        _upsertHidden(form, 'sort', f.sort);
        _upsertHidden(form, 'q', f.q);
        _upsertHidden(form, 'start_date', hasRange ? f.start_date : '');
        _upsertHidden(form, 'end_date', hasRange ? f.end_date : '');
        _upsertHidden(form, 'page', f.page > 0 ? f.page : '');
        _upsertHidden(form, 'per_page', f.per_page > 0 ? f.per_page : '');

        // Merge QS vào hx-post cho chắc (server vẫn đọc được nếu ưu tiên query)
        var base = form.getAttribute('hx-post') || form.action || '/admin/notify';
        var qs = (typeof window.__notifyFilterQS === 'function') ? (window.__notifyFilterQS() || '') : '';
        if (!qs) {
            // tự build QS tối giản (có cả page/per_page)
            var parts = [];
            if (f.v && f.v !== 'all') parts.push('v=' + encodeURIComponent(f.v));
            if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
            if (f.q) parts.push('q=' + encodeURIComponent(f.q));
            if (hasRange) {
                parts.push('start_date=' + encodeURIComponent(f.start_date));
                parts.push('end_date=' + encodeURIComponent(f.end_date));
            }
            if (f.page > 0) parts.push('page=' + encodeURIComponent(f.page));
            if (f.per_page > 0) parts.push('per_page=' + encodeURIComponent(f.per_page));
            qs = parts.length ? ('?' + parts.join('&')) : '';
        }

        if (qs) {
            try {
                var u = new URL(base, window.location.origin);
                var p = u.searchParams;
                // clear cũ
                p.delete('v'); p.delete('sort'); p.delete('q'); p.delete('start_date'); p.delete('end_date'); p.delete('page'); p.delete('per_page');
                // set mới
                if (f.v && f.v !== 'all') p.set('v', f.v);
                if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.q) p.set('q', f.q);
                if (hasRange) { p.set('start_date', f.start_date); p.set('end_date', f.end_date); }
                if (f.page > 0) p.set('page', String(f.page));
                if (f.per_page > 0) p.set('per_page', String(f.per_page));
                u.search = p.toString();
                form.setAttribute('hx-post', u.pathname + (u.search ? '?' + u.search : ''));
            } catch (e) {
                form.setAttribute('hx-post', _mergeQsIntoUrl(base, qs));
            }
        } else {
            try {
                var u2 = new URL(base, window.location.origin);
                form.setAttribute('hx-post', u2.pathname + (u2.search ? '?' + u2.search : ''));
            } catch (e) {
                form.setAttribute('hx-post', base);
            }
        }

        // Đảm bảo chỉ swap vùng list
        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#notify-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#notify-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true); // <<< capture

    // 2) Backup tham số vào htmx ngay trước khi gửi
    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentFilters();
            var hasRange = !!(f.start_date && f.end_date);
            // page/per_page luôn đẩy để giữ trang hiện tại
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            // các filter khác: chỉ đẩy khi không phải default
            if (f.v && f.v !== 'all') e.detail.parameters.v = f.v;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            if (f.q) e.detail.parameters.q = f.q;
            if (hasRange) {
                e.detail.parameters.start_date = f.start_date;
                e.detail.parameters.end_date = f.end_date;
            }
            // vá path bằng helper QS để server đọc query (nếu ưu tiên)
            var qs = (typeof window.__notifyFilterQS === 'function') ? (window.__notifyFilterQS() || '') : '';
            if (qs) e.detail.path = _mergeQsIntoUrl(e.detail.path || '', qs);
        } catch (err) { /* noop */ }
    });

    form.dataset.filterBound = '1';
}

/* Validate form: enable submit khi đủ điều kiện */
function attachNotifyCreateFormLogic() {
    var form = document.querySelector('#admin-notify-form');
    var submitBtn = document.querySelector('#notify-submit-btn');
    if (!form || !submitBtn) return;

    var checkboxes = Array.prototype.slice.call(form.querySelectorAll('input[name="notify_target_roles"]'));
    var textarea = form.querySelector('textarea[name="notify_content"]');

    var toggleSubmit = function () {
        var anyChecked = false;
        for (var i = 0; i < checkboxes.length; i++) {
            if (checkboxes[i].checked) { anyChecked = true; break; }
        }
        var hasContent = textarea ? (textarea.value.trim().length > 0) : true;
        submitBtn.disabled = !(anyChecked && hasContent);
    };

    if (!form.dataset.boundRoles) {
        for (var i = 0; i < checkboxes.length; i++) {
            checkboxes[i].addEventListener('change', toggleSubmit);
        }
        if (textarea) textarea.addEventListener('input', toggleSubmit);
        form.dataset.boundRoles = '1';
    }

    ensureFormKeepsFilters(form);
    toggleSubmit();
}

/* Sau khi modal được load động, bind lại các sự kiện */
function rebindAdminNotifyNewModalEvents() {
    focusNotifyModalTextarea();
    attachNotifyCreateFormLogic();
}

/* Gắn các handler này 1 lần duy nhất khi SPA load */
bindNotifyModalClose();

/* HTMX compat: modal vừa nạp -> bind */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {};
    var tgt = d.target ? d.target : null;
    var tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-notify-modal-root' || tid === 'notify-new-modal') {
        rebindAdminNotifyNewModalEvents();
    }
});

/* Sau khi list được swap (tạo mới thành công) -> đóng modal + toast */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var t = evt && evt.detail ? evt.detail.target : null;
    if (!t) return;

    if (t.id === 'notify-list-region' || t.id === 'admin-notify-container') {
        closeNotifyCreateModal();
        if (window.__notifyJustCreated) {
            if (window.Toast && window.Toast.show) window.Toast.show('Tạo thông báo thành công!', 'success', 3000);
            window.__notifyJustCreated = false;
        }
        var form = document.querySelector('#admin-notify-form');
        if (form) form.dataset._submitting = '';
    }
});

/* Phục hồi nút submit nếu lỗi mạng/response để user gửi lại */
function _reEnableCreateOnError() {
    var form = document.querySelector('#admin-notify-form'); if (form) form.dataset._submitting = '';
    var btn = document.querySelector('#notify-submit-btn'); if (btn) btn.disabled = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Tạo thông báo thất bại. Vui lòng thử lại!', 'error', 3000);
}

document.body.addEventListener('htmx:responseError', function () { _reEnableCreateOnError(); });
document.body.addEventListener('htmx:swapError', function () { _reEnableCreateOnError(); });
document.body.addEventListener('htmx:sendError', function () { _reEnableCreateOnError(); });

/* Nếu modal có sẵn (không qua HTMX) -> bind ngay */
if (document.getElementById('notify-new-modal')) {
    rebindAdminNotifyNewModalEvents();
}

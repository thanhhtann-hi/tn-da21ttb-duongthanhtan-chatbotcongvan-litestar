// file: src/modules/admin/static/js/admin_notify_delete_modal.js
// updated: 2025-08-12 (v3.4)
// change log:
// - Bơm cả page/per_page vào BODY + htmx:configRequest + QS fallback để giữ nguyên trang sau khi xoá.
// - Giữ nguyên: chỉ swap #notify-list-region, submit ở capture phase, Toast 1 lần, ES5-safe.
// note:
// - Chỉ swap #notify-list-region.
// - Trước khi gửi: bơm đủ filter (v/sort/q/start/end/page/per_page) vào BODY (hidden inputs) + backup vào htmx:configRequest.
// - Fallback: merge thêm QS vào hx-post/hx-delete/path (xoá các key cũ trước khi set).
// - Dùng submit listener ở capture phase để chạy TRƯỚC htmx.
// - Toast 1 lần. ES5-safe.

function closeNotifyDeleteModal() {
    var ov = document.getElementById('notify-delete-modal-overlay'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var md = document.getElementById('notify-delete-modal'); if (md && md.parentNode) md.parentNode.removeChild(md);
}

/* ES5 int helper */
function _toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }

/* Lấy filter hiện tại từ helper hoặc DOM */
function _currentFilters() {
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
        } catch (e) { /* noop */ }
    }
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

function _upsertHidden(form, name, value) {
    var el = form.querySelector('input[name="' + name + '"]');
    if (value == null || value === '') {
        if (el && el.parentNode) el.parentNode.removeChild(el);
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

/* Bơm filter vào form + vá lại URL hx-attr (fallback) */
function _injectFiltersAndPatchUrl(form) {
    var f = _currentFilters();
    var hasRange = !!(f.start_date && f.end_date);

    // BODY (ưu tiên backend đọc form)
    _upsertHidden(form, 'v', f.v && f.v !== 'all' ? f.v : '');
    _upsertHidden(form, 'sort', f.sort && f.sort !== 'created_desc' ? f.sort : '');
    _upsertHidden(form, 'q', f.q ? f.q : '');
    _upsertHidden(form, 'start_date', hasRange ? f.start_date : '');
    _upsertHidden(form, 'end_date', hasRange ? f.end_date : '');
    _upsertHidden(form, 'page', f.page > 0 ? f.page : '');
    _upsertHidden(form, 'per_page', f.per_page > 0 ? f.per_page : '');

    // Fallback: merge QS vào hx-attr (nếu server lỡ ưu tiên query)
    var attr = form.hasAttribute('hx-delete') ? 'hx-delete' : (form.hasAttribute('hx-post') ? 'hx-post' : null);
    if (!attr) { attr = 'hx-post'; form.setAttribute(attr, form.action || ''); }
    var base = form.getAttribute(attr) || form.action || '';

    // Ưu tiên helper QS
    var qs = '';
    if (typeof window.__notifyFilterQS === 'function') {
        try { qs = window.__notifyFilterQS() || ''; } catch (e) { /* noop */ }
    }
    if (!qs) {
        // tự build QS có cả page/per_page
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
            // dùng URL để tránh double param
            var u = new URL(base, window.location.origin);
            var p = u.searchParams;
            // clear các key trước
            p.delete('v'); p.delete('sort'); p.delete('q'); p.delete('start_date'); p.delete('end_date'); p.delete('page'); p.delete('per_page');
            // set lại theo filter
            if (f.v && f.v !== 'all') p.set('v', f.v);
            if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
            if (f.q) p.set('q', f.q);
            if (hasRange) { p.set('start_date', f.start_date); p.set('end_date', f.end_date); }
            if (f.page > 0) p.set('page', String(f.page));
            if (f.per_page > 0) p.set('per_page', String(f.per_page));
            u.search = p.toString();
            form.setAttribute(attr, u.pathname + (u.search ? '?' + u.search : ''));
        } catch (e) {
            form.setAttribute(attr, _mergeQsIntoUrl(base, qs));
        }
    }

    // Đảm bảo chỉ swap vùng list (nếu template cũ chưa set)
    if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#notify-list-region');
    if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#notify-list-region');
    if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
}

/* Gắn filter vào body + URL trước khi gửi */
function ensureDeleteKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    // tránh template cũ còn hx-vals
    try { form.removeAttribute('hx-vals'); } catch (e) { /* noop */ }

    // 1) Inject sớm ở capture phase (chạy TRƯỚC htmx)
    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__notifyJustDeleted = true;

        var submitBtn = form.querySelector('#notify-delete-submit-btn');
        if (submitBtn) submitBtn.disabled = true;

        _injectFiltersAndPatchUrl(form);
    }, true); // <<< capture

    // 2) Backup lần nữa ngay trước khi HTMX gửi request
    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _currentFilters();
            // bơm trực tiếp vào parameters của HTMX
            // (page/per_page luôn bơm; các filter khác bơm khi KHÔNG phải default)
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.v && f.v !== 'all') e.detail.parameters.v = f.v;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.start_date && f.end_date) {
                e.detail.parameters.start_date = f.start_date;
                e.detail.parameters.end_date = f.end_date;
            }
            // vá đường dẫn (nếu cần)
            var qs = (typeof window.__notifyFilterQS === 'function') ? (window.__notifyFilterQS() || '') : '';
            if (qs) e.detail.path = _mergeQsIntoUrl(e.detail.path || '', qs);
        } catch (err) { /* noop */ }
    });

    form.dataset.filterBound = '1';
}

/* Bind đóng modal: overlay, wrapper, nút X, nút Huỷ, ESC */
function bindNotifyDeleteModalClose() {
    var ov = document.getElementById('notify-delete-modal-overlay');
    if (ov && !ov.dataset.bound) { ov.dataset.bound = '1'; ov.addEventListener('click', closeNotifyDeleteModal); }

    var wrap = document.getElementById('notify-delete-modal');
    if (wrap && !wrap.dataset.boundOutside) {
        wrap.dataset.boundOutside = '1';
        wrap.addEventListener('click', function (e) {
            var t = e && e.target ? e.target : null;
            if (t && t.id === 'notify-delete-modal') { closeNotifyDeleteModal(); }
        });
    }

    var x = document.getElementById('notify-delete-modal-close');
    if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', closeNotifyDeleteModal); }

    var c = document.getElementById('notify-delete-modal-cancel');
    if (c && !c.dataset.bound) { c.dataset.bound = '1'; c.addEventListener('click', closeNotifyDeleteModal); }

    if (!document.body.dataset.boundEscDelete) {
        document.body.dataset.boundEscDelete = '1';
        document.addEventListener('keydown', function (e) {
            if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('notify-delete-modal')) {
                closeNotifyDeleteModal();
            }
        });
    }
}

/* Bind form submit */
function bindNotifyDeleteFormLogic() {
    var form = document.querySelector('#admin-notify-delete-form');
    if (!form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    ensureDeleteKeepsFilters(form);
}

/* Helper khi lỗi */
function _reEnableDeleteOnError(elt) {
    var form = (elt && elt.id === 'admin-notify-delete-form') ? elt : document.querySelector('#admin-notify-delete-form');
    if (!form) return;
    form.dataset._submitting = '';
    var btn = form.querySelector('#notify-delete-submit-btn'); if (btn) btn.disabled = false;
    window.__notifyJustDeleted = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Xoá thất bại. Vui lòng thử lại!', 'error', 3000);
}

/* Swap thành công → đóng modal + toast */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}, tgt = d && d.target ? d.target : null;
    if (tgt && tgt.id === 'notify-list-region') {
        closeNotifyDeleteModal();
        if (window.__notifyJustDeleted) {
            if (window.Toast && window.Toast.show) window.Toast.show('Đã ẩn thông báo!', 'success', 2500);
            window.__notifyJustDeleted = false;
        }
        var form = document.querySelector('#admin-notify-delete-form'); if (form) form.dataset._submitting = '';
    }
});

/* Lỗi XHR/swap/send */
document.body.addEventListener('htmx:responseError', function (e) {
    var d = e && e.detail ? e.detail : {};
    _reEnableDeleteOnError(d.elt ? d.elt : null);
});
document.body.addEventListener('htmx:swapError', function (e) {
    var d = e && e.detail ? e.detail : {};
    _reEnableDeleteOnError(d.elt ? d.elt : null);
});
document.body.addEventListener('htmx:sendError', function (e) {
    var d = e && e.detail ? e.detail : {};
    _reEnableDeleteOnError(d.elt ? d.elt : null);
});

/* Khi modal được nạp */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}, tgt = d && d.target ? d.target : null, tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-notify-modal-root' || tid === 'notify-delete-modal') {
        bindNotifyDeleteModalClose();
        bindNotifyDeleteFormLogic();
    }
});

/* Nếu modal đã có sẵn */
if (document.getElementById('notify-delete-modal')) {
    bindNotifyDeleteModalClose();
    bindNotifyDeleteFormLogic();
}

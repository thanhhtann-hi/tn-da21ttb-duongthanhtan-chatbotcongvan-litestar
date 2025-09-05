/********************************************************************
 * File  : src/modules/admin/static/js/admin_models_delete_modal.js
 * Updated: 2025-08-22 (v1.0 – ES5-safe)
 * Note  : Retire (DELETE) 1 ModelVariant. Chỉ swap #models-list-region.
 *         Trước gửi: bơm đủ filter (status/scope/tier/enabled/provider/type/q/sort/page/per_page)
 *         vào BODY + backup qua htmx:configRequest + QS-fallback vào hx-delete.
 ********************************************************************/

/* Close modal */
function closeModelsDeleteModal() {
    var ov = document.getElementById('models-delete-modal-overlay'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var md = document.getElementById('models-delete-modal'); if (md && md.parentNode) md.parentNode.removeChild(md);
}

/* Helpers */
function _toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
function _upsertHidden(form, name, value) {
    var el = form.querySelector('input[name="' + name + '"]');
    if (value == null || value === '') { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
    if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
    el.value = String(value);
}
function _mergeQsIntoUrl(base, qs) {
    if (!qs) return base;
    var hasQ = (base || '').indexOf('?') >= 0;
    var payload = (qs.charAt(0) === '?') ? qs.substring(1) : qs;
    return base + (hasQ ? '&' : '?') + payload;
}

/* Map sort UI -> canonical (phòng khi chỉ có data-current-sort) */
function _uiSortToCanonical(k) {
    switch (String(k || '').toLowerCase()) {
        case 'new': return 'created_desc';
        case 'old': return 'created_asc';
        case 'az': return 'name_az';
        case 'za': return 'name_za';
        case 'prov_az': return 'provider_az';
        case 'prov_za': return 'provider_za';
        default: return 'created_desc';
    }
}

/* Lấy filter hiện tại – ưu tiên helper, fallback DOM (#admin-models-container) */
function _currentModelsFilters() {
    if (typeof window.__modelsFilterVals === 'function') {
        try {
            var o = window.__modelsFilterVals() || {};
            return {
                status: o.status || 'all',
                scope: o.scope || 'any',
                tier: o.tier || 'all',
                enabled: o.enabled || 'all',
                provider: o.provider || '',
                type: o.type || o.mtype || '',
                q: o.q || '',
                sort: o.sort || 'created_desc',
                page: _toInt(o.page, 1),
                per_page: _toInt(o.per_page, 10)
            };
        } catch (e) { }
    }
    var c = document.getElementById('admin-models-container');
    var qInput = document.getElementById('models-search-input');
    // NEW: ưu tiên form lọc provider/type
    var pInput = document.querySelector('#models-provider-form input[name="provider"]');
    var tInput = document.querySelector('#models-type-form input[name="type"]');
    var f = {
        status: (c && c.dataset.status) || 'all',
        scope: (c && c.dataset.scope) || 'any',
        tier: (c && c.dataset.tier) || 'all',
        enabled: (c && c.dataset.enabled) || 'all',
        provider: pInput ? (pInput.value || '') : ((c && c.dataset.provider) || ''),
        type: tInput ? (tInput.value || '') : ((c && c.dataset.type) || ''),
        q: qInput ? (qInput.value || '') : '',
        sort: _uiSortToCanonical(c && c.dataset.currentSort),
        page: _toInt((c && c.dataset.page) || '1', 1),
        per_page: _toInt((c && c.dataset.perPage) || '10', 10)
    };
    return f;
}

/* Build QS string (tối giản, luôn kèm page/per_page) */
function _buildQS(f) {
    var parts = [];
    if (f.status && f.status !== 'all') parts.push('status=' + encodeURIComponent(f.status));
    if (f.scope && f.scope !== 'any') parts.push('scope=' + encodeURIComponent(f.scope));
    if (f.tier && f.tier !== 'all') parts.push('tier=' + encodeURIComponent(f.tier));
    if (f.enabled && f.enabled !== 'all') parts.push('enabled=' + encodeURIComponent(f.enabled));
    if (f.provider) parts.push('provider=' + encodeURIComponent(f.provider));
    if (f.type) parts.push('type=' + encodeURIComponent(f.type));
    if (f.q) parts.push('q=' + encodeURIComponent(f.q));
    if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
    if (f.page > 0) parts.push('page=' + encodeURIComponent(f.page));
    if (f.per_page > 0) parts.push('per_page=' + encodeURIComponent(f.per_page));
    return parts.length ? ('?' + parts.join('&')) : '';
}

/* Inject filters vào BODY + vá URL (hx-delete) */
function _injectFiltersAndPatchUrl(form) {
    var f = _currentModelsFilters();

    _upsertHidden(form, 'status', f.status !== 'all' ? f.status : '');
    _upsertHidden(form, 'scope', f.scope !== 'any' ? f.scope : '');
    _upsertHidden(form, 'tier', f.tier !== 'all' ? f.tier : '');
    _upsertHidden(form, 'enabled', f.enabled !== 'all' ? f.enabled : '');
    _upsertHidden(form, 'provider', f.provider || '');
    _upsertHidden(form, 'type', f.type || '');
    _upsertHidden(form, 'q', f.q || '');
    _upsertHidden(form, 'sort', f.sort !== 'created_desc' ? f.sort : '');
    _upsertHidden(form, 'page', f.page > 0 ? f.page : '');
    _upsertHidden(form, 'per_page', f.per_page > 0 ? f.per_page : '');

    var attr = form.hasAttribute('hx-delete') ? 'hx-delete' : (form.hasAttribute('hx-post') ? 'hx-post' : null);
    if (!attr) { attr = 'hx-delete'; form.setAttribute(attr, form.action || ''); }
    var base = form.getAttribute(attr) || form.action || '';

    var qs = '';
    if (typeof window.__modelsFilterQS === 'function') { try { qs = window.__modelsFilterQS() || ''; } catch (e) { } }
    if (!qs) { qs = _buildQS(f); }

    if (qs) {
        try {
            var u = new URL(base, window.location.origin);
            var p = u.searchParams;
            // clear keys trước khi set
            ['status', 'scope', 'tier', 'enabled', 'provider', 'type', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
            if (f.status !== 'all') p.set('status', f.status);
            if (f.scope !== 'any') p.set('scope', f.scope);
            if (f.tier !== 'all') p.set('tier', f.tier);
            if (f.enabled !== 'all') p.set('enabled', f.enabled);
            if (f.provider) p.set('provider', f.provider);
            if (f.type) p.set('type', f.type);
            if (f.q) p.set('q', f.q);
            if (f.sort !== 'created_desc') p.set('sort', f.sort);
            if (f.page > 0) p.set('page', String(f.page));
            if (f.per_page > 0) p.set('per_page', String(f.per_page));
            u.search = p.toString();
            form.setAttribute(attr, u.pathname + (u.search ? ('?' + u.search) : ''));
        } catch (e) {
            form.setAttribute(attr, _mergeQsIntoUrl(base, qs));
        }
    }

    if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#models-list-region');
    if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#models-list-region');
    if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
}

/* Đảm bảo giữ filter + chặn double-submit */
function ensureModelsDeleteKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    try { form.removeAttribute('hx-vals'); } catch (e) { }

    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__modelsJustRetired = true;

        var btn = form.querySelector('#models-delete-submit-btn');
        if (btn) btn.disabled = true;

        _injectFiltersAndPatchUrl(form);
    }, true); // capture

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _currentModelsFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.status !== 'all') e.detail.parameters.status = f.status;
            if (f.scope !== 'any') e.detail.parameters.scope = f.scope;
            if (f.tier !== 'all') e.detail.parameters.tier = f.tier;
            if (f.enabled !== 'all') e.detail.parameters.enabled = f.enabled;
            if (f.provider) e.detail.parameters.provider = f.provider;
            if (f.type) e.detail.parameters.type = f.type;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;

            var qs = (typeof window.__modelsFilterQS === 'function') ? (window.__modelsFilterQS() || '') : '';
            if (qs) e.detail.path = _mergeQsIntoUrl(e.detail.path || '', qs);
        } catch (err) { }
    });

    form.dataset.filterBound = '1';
}

/* Bind đóng modal: overlay, wrapper, nút X, nút Huỷ, ESC */
function bindModelsDeleteModalClose() {
    var ov = document.getElementById('models-delete-modal-overlay');
    if (ov && !ov.dataset.bound) { ov.dataset.bound = '1'; ov.addEventListener('click', closeModelsDeleteModal); }

    var wrap = document.getElementById('models-delete-modal');
    if (wrap && !wrap.dataset.boundOutside) {
        wrap.dataset.boundOutside = '1';
        wrap.addEventListener('click', function (e) {
            var t = e && e.target ? e.target : null;
            if (t && t.id === 'models-delete-modal') { closeModelsDeleteModal(); }
        });
    }

    var x = document.getElementById('models-delete-modal-close');
    if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', closeModelsDeleteModal); }

    var c = document.getElementById('models-delete-modal-cancel');
    if (c && !c.dataset.bound) { c.dataset.bound = '1'; c.addEventListener('click', closeModelsDeleteModal); }

    if (!document.body.dataset.boundEscModelsDelete) {
        document.body.dataset.boundEscModelsDelete = '1';
        document.addEventListener('keydown', function (e) {
            if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('models-delete-modal')) {
                closeModelsDeleteModal();
            }
        });
    }
}

/* Bind form submit (nếu có) */
function bindModelsDeleteFormLogic() {
    var form = document.querySelector('#admin-models-delete-form');
    if (!form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    ensureModelsDeleteKeepsFilters(form);
}

/* Lỗi → bật lại nút, reset cờ, báo lỗi */
function _reEnableModelsDeleteOnError(elt) {
    var form = (elt && elt.id === 'admin-models-delete-form') ? elt : document.querySelector('#admin-models-delete-form');
    if (!form) return;
    form.dataset._submitting = '';
    var btn = form.querySelector('#models-delete-submit-btn'); if (btn) btn.disabled = false;
    window.__modelsJustRetired = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Ngừng dùng thất bại. Vui lòng thử lại!', 'error', 3000);
}

/* Swap thành công → đóng modal + toast */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}, tgt = d && d.target ? d.target : null;
    if (tgt && tgt.id === 'models-list-region') {
        closeModelsDeleteModal();
        if (window.__modelsJustRetired) {
            if (window.Toast && window.Toast.show) window.Toast.show('Đã ngừng dùng mô hình!', 'success', 2500);
            window.__modelsJustRetired = false;
        }
        var form = document.querySelector('#admin-models-delete-form'); if (form) form.dataset._submitting = '';
    }
});

/* Lỗi XHR/swap/send */
document.body.addEventListener('htmx:responseError', function (e) {
    var d = e && e.detail ? e.detail : {};
    _reEnableModelsDeleteOnError(d.elt ? d.elt : null);
});
document.body.addEventListener('htmx:swapError', function (e) {
    var d = e && e.detail ? e.detail : {};
    _reEnableModelsDeleteOnError(d.elt ? d.elt : null);
});
document.body.addEventListener('htmx:sendError', function (e) {
    var d = e && e.detail ? e.detail : {};
    _reEnableModelsDeleteOnError(d.elt ? d.elt : null);
});

/* Khi modal được nạp */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}, tgt = d && d.target ? d.target : null, tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-models-modal-root' || tid === 'models-delete-modal') {
        bindModelsDeleteModalClose();
        bindModelsDeleteFormLogic();
    }
});

/* Nếu modal đã có sẵn */
if (document.getElementById('models-delete-modal')) {
    bindModelsDeleteModalClose();
    bindModelsDeleteFormLogic();
}

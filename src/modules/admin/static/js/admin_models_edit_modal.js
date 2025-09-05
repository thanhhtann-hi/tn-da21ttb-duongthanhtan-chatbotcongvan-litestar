/********************************************************************
 * File  : src/modules/admin/static/js/admin_models_edit_modal.js
 * Updated: 2025-08-22 (v1.0 – ES5-safe)
 * Note  : Giữ filter (status/scope/tier/enabled/provider/type/q/sort/page/per_page)
 *         khi cập nhật. Không dùng hx-vals. Sau swap -> đóng modal + toast.
 *         Chặn double-submit; chỉ enable nút khi có thay đổi hợp lệ.
 ********************************************************************/

/* ====== Close helpers ====== */
function closeModelsEditModal() {
    var ov = document.getElementById('models-edit-modal-overlay'); if (ov && ov.remove) ov.remove();
    var md = document.getElementById('models-edit-modal'); if (md && md.remove) md.remove();
}

function bindModelsEditModalClose() {
    document.body.addEventListener('click', function (e) {
        if (!e || !e.target) return;
        if (e.target.id === 'models-edit-modal-overlay') { closeModelsEditModal(); return; }
        if (e.target.id === 'models-edit-modal-close') { closeModelsEditModal(); return; }
        if (e.target.closest) {
            var x = e.target.closest('#models-edit-modal-close'); if (x) { closeModelsEditModal(); return; }
        }
        if (e.target.id === 'models-edit-modal') { closeModelsEditModal(); return; }
        if (e.target.id === 'models-edit-cancel-btn') { closeModelsEditModal(); return; }
    });
    document.body.addEventListener('keydown', function (e) {
        if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('models-edit-modal')) {
            closeModelsEditModal();
        }
    });
}

/* ====== Focus first input ====== */
function focusModelsEditModalFirstInput() {
    setTimeout(function () {
        var md = document.getElementById('models-edit-modal');
        if (!md) return;
        var el = md.querySelector('#model_name');
        if (el) { try { el.focus(); el.select && el.select(); } catch (e) { } }
    }, 60);
}

/* ====== Small helpers ====== */
function _toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
function _upsertHidden(form, name, value) {
    var el = form.querySelector('input[name="' + name + '"]');
    if (value == null || value === '') { if (el && el.remove) el.remove(); return; }
    if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
    el.value = String(value);
}
function _mergeQsIntoUrl(base, qs) {
    if (!qs) return base;
    var hasQ = (base || '').indexOf('?') >= 0;
    var payload = (qs.charAt(0) === '?') ? qs.substring(1) : qs;
    return base + (hasQ ? '&' : '?') + payload;
}

/* ====== Read current filters from page ====== */
function _getCurrentModelFilters() {
    if (typeof window.__modelsFilterVals === 'function') {
        try {
            var o = window.__modelsFilterVals() || {};
            return {
                status: o.status || 'all',
                scope: o.scope || 'any',
                tier: o.tier || 'all',
                enabled: o.enabled || 'all',
                provider: o.provider || '',
                type: o.type || '',
                q: o.q || '',
                sort: o.sort || 'created_desc',
                page: _toInt(o.page, 1),
                per_page: _toInt(o.per_page, 10)
            };
        } catch (e) { }
    }
    var c = document.getElementById('admin-models-container') || {};
    var ds = c.dataset || {};
    var searchForm = document.getElementById('models-search-form') || null;
    var sortInput = searchForm ? searchForm.querySelector('input[name="sort"]') : null;
    // NEW: ưu tiên form lọc provider/type
    var pInput = document.querySelector('#models-provider-form input[name="provider"]');
    var tInput = document.querySelector('#models-type-form input[name="type"]');

    return {
        status: ds.status || 'all',
        scope: ds.scope || 'any',
        tier: ds.tier || 'all',
        enabled: ds.enabled || 'all',
        provider: pInput ? (pInput.value || '') : (ds.provider || ''),
        type: tInput ? (tInput.value || '') : (ds.type || ''),
        q: (document.getElementById('models-search-input') ? (document.getElementById('models-search-input').value || '') : ''),
        sort: (sortInput ? (sortInput.value || 'created_desc') : 'created_desc'),
        page: _toInt(ds.page || '1', 1),
        per_page: _toInt(ds.perPage || ds.perpage || '10', 10)
    };
}

function _modelsFilterQS() {
    if (typeof window.__modelsFilterQS === 'function') {
        try { var s = window.__modelsFilterQS(); if (s) return s; } catch (e) { }
    }
    var f = _getCurrentModelFilters();
    var parts = [];
    if (f.status && f.status !== 'all') parts.push('status=' + encodeURIComponent(f.status));
    if (f.scope && f.scope !== 'any') parts.push('scope=' + encodeURIComponent(f.scope));
    if (f.tier && f.tier !== 'all') parts.push('tier=' + encodeURIComponent(f.tier));
    if (f.enabled && f.enabled !== 'all') parts.push('enabled=' + encodeURIComponent(f.enabled));
    if (f.provider) parts.push('provider=' + encodeURIComponent(f.provider));
    if (f.type) parts.push('type=' + encodeURIComponent(f.type));
    if (f.q) parts.push('q=' + encodeURIComponent(f.q));
    if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
    if (f.page > 1) parts.push('page=' + encodeURIComponent(f.page));
    if (f.per_page && f.per_page !== 10) parts.push('per_page=' + encodeURIComponent(f.per_page));
    return parts.length ? ('?' + parts.join('&')) : '';
}

/* ====== Keep filters & prevent double submit ====== */
function ensureModelsEditFormKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__modelsJustEdited = true;

        var btn = document.getElementById('models-edit-submit-btn');
        if (btn) btn.disabled = true;

        var f = _getCurrentModelFilters();

        // Inject hidden (server ưu tiên đọc từ form)
        _upsertHidden(form, 'status', f.status);
        _upsertHidden(form, 'scope', f.scope);
        _upsertHidden(form, 'tier', f.tier);
        _upsertHidden(form, 'enabled', f.enabled);
        _upsertHidden(form, 'provider', f.provider);
        _upsertHidden(form, 'type', f.type);
        _upsertHidden(form, 'q', f.q);
        _upsertHidden(form, 'sort', f.sort);
        _upsertHidden(form, 'page', (f.page > 0 ? f.page : ''));
        _upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));

        // Merge QS vào hx-put
        var base = form.getAttribute('hx-put') || form.action || '/admin/models';
        var qs = _modelsFilterQS();

        if (qs) {
            try {
                var u = new URL(base, window.location.origin);
                var p = u.searchParams;
                ['status', 'scope', 'tier', 'enabled', 'provider', 'type', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.status && f.status !== 'all') p.set('status', f.status);
                if (f.scope && f.scope !== 'any') p.set('scope', f.scope);
                if (f.tier && f.tier !== 'all') p.set('tier', f.tier);
                if (f.enabled && f.enabled !== 'all') p.set('enabled', f.enabled);
                if (f.provider) p.set('provider', f.provider);
                if (f.type) p.set('type', f.type);
                if (f.q) p.set('q', f.q);
                if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 1) p.set('page', String(f.page));
                if (f.per_page && f.per_page !== 10) p.set('per_page', String(f.per_page));
                u.search = p.toString();
                form.setAttribute('hx-put', u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (e) {
                form.setAttribute('hx-put', _mergeQsIntoUrl(base, qs));
            }
        } else {
            try {
                var u2 = new URL(base, window.location.origin);
                form.setAttribute('hx-put', u2.pathname + (u2.search ? '?' + u2.search : ''));
            } catch (e) {
                form.setAttribute('hx-put', base);
            }
        }

        // Chỉ swap vùng list
        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#models-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#models-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true); // capture

    // Backup tham số vào htmx ngay trước khi gửi
    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentModelFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.status && f.status !== 'all') e.detail.parameters.status = f.status;
            if (f.scope && f.scope !== 'any') e.detail.parameters.scope = f.scope;
            if (f.tier && f.tier !== 'all') e.detail.parameters.tier = f.tier;
            if (f.enabled && f.enabled !== 'all') e.detail.parameters.enabled = f.enabled;
            if (f.provider) e.detail.parameters.provider = f.provider;
            if (f.type) e.detail.parameters.type = f.type;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;

            var qs = _modelsFilterQS();
            if (qs) e.detail.path = _mergeQsIntoUrl(e.detail.path || '', qs);
        } catch (err) { }
    });

    form.dataset.filterBound = '1';
}

/* ====== Form validation & change detection ====== */
function attachModelsEditFormLogic() {
    var form = document.getElementById('admin-models-edit-form');
    if (!form) return;

    ensureModelsEditFormKeepsFilters(form);

    var fields = {
        name: form.querySelector('#model_name'),
        provider: form.querySelector('#model_provider'),
        pid: form.querySelector('#provider_model_id'),
        type: form.querySelector('#model_type'),
        scope: form.querySelector('#model_access_scope'),
        tier: form.querySelector('#model_tier'),
        status: form.querySelector('#model_status'),
        sort: form.querySelector('#model_sort_order'),
        desc: form.querySelector('#model_description'),
        enabled: form.querySelector('#model_enabled')
    };
    var submitBtn = document.getElementById('models-edit-submit-btn');

    // Numeric guard for sort order
    if (fields.sort) {
        fields.sort.addEventListener('input', function () {
            this.value = this.value.replace(/[^0-9\-]/g, '');
            if (this.value.length > 8) this.value = this.value.slice(0, 8);
        });
    }

    function snapshot() {
        return JSON.stringify({
            n: fields.name ? fields.name.value.trim() : '',
            p: fields.provider ? (fields.provider.value || '') : '',
            pid: fields.pid ? (fields.pid.value || '') : '',
            t: fields.type ? (fields.type.value || '') : '',
            sc: fields.scope ? fields.scope.value : 'all',
            tr: fields.tier ? fields.tier.value : 'auto',
            st: fields.status ? fields.status.value : 'active',
            so: fields.sort ? (fields.sort.value || '') : '',
            d: fields.desc ? (fields.desc.value || '') : '',
            e: (fields.enabled && !fields.enabled.disabled) ? !!fields.enabled.checked : false
        });
    }

    var initial = snapshot();

    function syncEnabledWithStatus() {
        var st = fields.status ? fields.status.value : 'active';
        var retired = (st === 'retired');
        if (fields.enabled) {
            if (retired) { fields.enabled.checked = false; fields.enabled.disabled = true; }
            else { fields.enabled.disabled = false; }
        }
        var hint = document.getElementById('status-retired-hint');
        if (hint) hint.classList[(retired ? 'remove' : 'add')]('hidden');
    }

    function toggleSubmit() {
        var validName = fields.name && fields.name.value.trim().length > 0;
        var changed = snapshot() !== initial;
        if (submitBtn) submitBtn.disabled = !(validName && changed);
    }

    // Bind changes
    var bindTargets = [fields.name, fields.provider, fields.pid, fields.type, fields.scope, fields.tier, fields.status, fields.sort, fields.desc, fields.enabled];
    for (var i = 0; i < bindTargets.length; i++) {
        var el = bindTargets[i];
        if (!el) continue;
        el.addEventListener((el.tagName === 'SELECT') ? 'change' : 'input', toggleSubmit);
    }
    if (fields.status) fields.status.addEventListener('change', function () { syncEnabledWithStatus(); toggleSubmit(); });

    // Cancel
    var cancel = document.getElementById('models-edit-cancel-btn');
    if (cancel) cancel.addEventListener('click', closeModelsEditModal);

    syncEnabledWithStatus();
    toggleSubmit();
}

/* ====== Rebind when modal loads via HTMX ====== */
function rebindAdminModelsEditModalEvents() {
    focusModelsEditModalFirstInput();
    attachModelsEditFormLogic();
}

/* ====== Global one-time binds ====== */
bindModelsEditModalClose();

/* HTMX: modal vừa nạp -> bind */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {};
    var tgt = d.target ? d.target : null;
    var tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-models-modal-root' || tid === 'models-edit-modal') {
        rebindAdminModelsEditModalEvents();
    }
});

/* Sau khi list swap thành công -> đóng modal + toast */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var t = evt && evt.detail ? evt.detail.target : null;
    if (!t) return;
    if (t.id === 'models-list-region' || t.id === 'admin-models-container') {
        closeModelsEditModal();
        if (window.__modelsJustEdited) {
            if (window.Toast && window.Toast.show) window.Toast.show('Cập nhật mô hình thành công!', 'success', 3000);
            window.__modelsJustEdited = false;
        }
        var f = document.getElementById('admin-models-edit-form');
        if (f) f.dataset._submitting = '';
        var btn = document.getElementById('models-edit-submit-btn'); if (btn) btn.disabled = false;
    }
});

/* Phục hồi nút nếu lỗi để user thử lại */
function _reEnableModelsEditOnError() {
    var f = document.getElementById('admin-models-edit-form'); if (f) f.dataset._submitting = '';
    var btn = document.getElementById('models-edit-submit-btn'); if (btn) btn.disabled = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Cập nhật mô hình thất bại. Vui lòng thử lại!', 'error', 3000);
}
document.body.addEventListener('htmx:responseError', _reEnableModelsEditOnError);
document.body.addEventListener('htmx:swapError', _reEnableModelsEditOnError);
document.body.addEventListener('htmx:sendError', _reEnableModelsEditOnError);

/* Nếu modal đã có sẵn (không qua HTMX) -> bind ngay */
if (document.getElementById('models-edit-modal')) {
    rebindAdminModelsEditModalEvents();
}

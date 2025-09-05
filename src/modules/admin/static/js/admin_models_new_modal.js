/********************************************************************
 * File  : src/modules/admin/static/js/admin_models_new_modal.js
 * Updated: 2025-08-22 (v1.0 – ES5-safe)
 * Note  : Giữ filter (status/scope/tier/enabled/provider/type/q/sort/page/per_page)
 *         khi submit tạo mới. Không dùng hx-vals. Sau swap -> đóng modal + toast.
 ********************************************************************/

/* ====== Close helpers ====== */
function closeModelsCreateModal() {
    var ov = document.getElementById('models-new-modal-overlay'); if (ov && ov.remove) ov.remove();
    var md = document.getElementById('models-new-modal'); if (md && md.remove) md.remove();
}

function bindModelsModalClose() {
    // Overlay / X button / click rìa / ESC
    document.body.addEventListener('click', function (e) {
        if (!e || !e.target) return;
        if (e.target.id === 'models-new-modal-overlay') { closeModelsCreateModal(); return; }
        if (e.target.id === 'models-new-modal-close') { closeModelsCreateModal(); return; }
        if (e.target.closest) {
            var x = e.target.closest('#models-new-modal-close'); if (x) { closeModelsCreateModal(); return; }
        }
        if (e.target.id === 'models-new-modal') { closeModelsCreateModal(); return; }
        if (e.target.id === 'models-cancel-btn') { closeModelsCreateModal(); return; }
    });
    document.body.addEventListener('keydown', function (e) {
        if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('models-new-modal')) {
            closeModelsCreateModal();
        }
    });
}

/* ====== Focus first input ====== */
function focusModelsModalFirstInput() {
    setTimeout(function () {
        var md = document.getElementById('models-new-modal');
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
    // Nếu file admin_models.js có cung cấp API
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

    // Fallback: đọc từ DOM dataset + form ẩn
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

/* Tạo QS tối giản từ filter hiện tại */
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

/* ====== Ensure form keeps filters + prevent double submit ====== */
function ensureModelsFormKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    // Chặn double-submit và bơm filter vào body + merge QS
    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__modelsJustCreated = true;

        var btn = document.getElementById('models-submit-btn');
        if (btn) btn.disabled = true;

        var f = _getCurrentModelFilters();

        // Bơm hidden để server ưu tiên đọc từ form
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

        // Merge QS vào hx-post (fallback nếu server đọc query)
        var base = form.getAttribute('hx-post') || form.action || '/admin/models';
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
                form.setAttribute('hx-post', u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (e) {
                form.setAttribute('hx-post', _mergeQsIntoUrl(base, qs));
            }
        }

        // Bảo đảm chỉ swap vùng list
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

/* ====== Form validation & dynamic UI ====== */
function attachModelsCreateFormLogic() {
    var form = document.getElementById('admin-models-create-form');
    if (!form) return;

    ensureModelsFormKeepsFilters(form);

    var nameInput = form.querySelector('#model_name');
    var statusSel = form.querySelector('#model_status');
    var enabledCb = form.querySelector('#model_enabled');
    var sortOrder = form.querySelector('#model_sort_order');
    var submitBtn = document.getElementById('models-submit-btn');

    function toggleSubmit() {
        var ok = nameInput && nameInput.value.trim().length > 0;
        if (submitBtn) submitBtn.disabled = !ok;
    }

    function syncEnabledWithStatus() {
        var st = (statusSel && statusSel.value) ? statusSel.value : 'active';
        var retired = (st === 'retired');
        if (enabledCb) {
            if (retired) { enabledCb.checked = false; enabledCb.disabled = true; }
            else { enabledCb.disabled = false; }
        }
        var hint = document.getElementById('status-retired-hint');
        if (hint) hint.classList[(retired ? 'remove' : 'add')]('hidden');
    }

    // Numeric guard for sort order
    if (sortOrder) {
        sortOrder.addEventListener('input', function () {
            this.value = this.value.replace(/[^0-9\-]/g, '');
            if (this.value.length > 8) this.value = this.value.slice(0, 8);
        });
    }

    if (nameInput) nameInput.addEventListener('input', toggleSubmit);
    if (statusSel) statusSel.addEventListener('change', function () { syncEnabledWithStatus(); toggleSubmit(); });

    // Cancel button
    var cancel = document.getElementById('models-cancel-btn');
    if (cancel) cancel.addEventListener('click', closeModelsCreateModal);

    syncEnabledWithStatus();
    toggleSubmit();
}

/* ====== Rebind when modal loads via HTMX ====== */
function rebindAdminModelsNewModalEvents() {
    focusModelsModalFirstInput();
    attachModelsCreateFormLogic();
}

/* ====== Global one-time binds ====== */
bindModelsModalClose();

/* HTMX: modal vừa nạp -> bind */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {};
    var tgt = d.target ? d.target : null;
    var tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-models-modal-root' || tid === 'models-new-modal') {
        rebindAdminModelsNewModalEvents();
    }
});

/* Sau khi list swap thành công -> đóng modal + toast */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var t = evt && evt.detail ? evt.detail.target : null;
    if (!t) return;
    if (t.id === 'models-list-region' || t.id === 'admin-models-container') {
        closeModelsCreateModal();
        if (window.__modelsJustCreated) {
            if (window.Toast && window.Toast.show) window.Toast.show('Tạo mô hình thành công!', 'success', 3000);
            window.__modelsJustCreated = false;
        }
        var f = document.getElementById('admin-models-create-form');
        if (f) f.dataset._submitting = '';
        var btn = document.getElementById('models-submit-btn'); if (btn) btn.disabled = false;
    }
});

/* Phục hồi nút nếu có lỗi mạng/response để user thử lại */
function _reEnableModelsCreateOnError() {
    var f = document.getElementById('admin-models-create-form'); if (f) f.dataset._submitting = '';
    var btn = document.getElementById('models-submit-btn'); if (btn) btn.disabled = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Tạo mô hình thất bại. Vui lòng thử lại!', 'error', 3000);
}
document.body.addEventListener('htmx:responseError', _reEnableModelsCreateOnError);
document.body.addEventListener('htmx:swapError', _reEnableModelsCreateOnError);
document.body.addEventListener('htmx:sendError', _reEnableModelsCreateOnError);

/* Nếu modal đã có sẵn (không qua HTMX) -> bind ngay */
if (document.getElementById('models-new-modal')) {
    rebindAdminModelsNewModalEvents();
}

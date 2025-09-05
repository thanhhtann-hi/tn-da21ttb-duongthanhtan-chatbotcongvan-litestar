/* file: src/modules/admin/static/js/admin_tools_modal.js
 * updated: 2025-08-24 (v1.4 – form-first filters; fix stale state after edit/delete)
 * note:
 *  - NEW modal: giữ filter (enabled/scope/q/sort/page/per_page) khi submit tạo mới.
 *  - EDIT modal: tương tự, có phát hiện thay đổi trước khi enable nút lưu.
 *  - DETAIL modal: chỉ đóng/mở + focus khi mở.
 *  - DELETE modal: giữ filter, chặn double-submit, đóng + toast sau swap.
 */

/* ========= Close helpers (generic) ========= */
function __closeToolsModalById(id) { var el = document.getElementById(id); if (el && el.remove) el.remove(); }
function closeToolsCreateModal() { __closeToolsModalById('tools-new-modal-overlay'); __closeToolsModalById('tools-new-modal'); }
function closeToolsEditModal() { __closeToolsModalById('tools-edit-modal-overlay'); __closeToolsModalById('tools-edit-modal'); }
function closeToolsDetailModal() { __closeToolsModalById('tools-detail-modal-overlay'); __closeToolsModalById('tools-detail-modal'); }
function closeToolsDeleteModal() { __closeToolsModalById('tools-delete-modal-overlay'); __closeToolsModalById('tools-delete-modal'); }

/* ========= Bind close events for all modals ========= */
function bindToolsModalClose() {
    document.body.addEventListener('click', function (e) {
        if (!e || !e.target) return;
        // NEW
        if (e.target.id === 'tools-new-modal-overlay') { closeToolsCreateModal(); return; }
        if (e.target.id === 'tools-new-modal-close') { closeToolsCreateModal(); return; }
        if (e.target.closest) { var x = e.target.closest('#tools-new-modal-close'); if (x) { closeToolsCreateModal(); return; } }
        if (e.target.id === 'tools-new-modal') { closeToolsCreateModal(); return; }
        if (e.target.id === 'tools-cancel-btn') { closeToolsCreateModal(); return; }
        // EDIT
        if (e.target.id === 'tools-edit-modal-overlay') { closeToolsEditModal(); return; }
        if (e.target.id === 'tools-edit-modal-close') { closeToolsEditModal(); return; }
        if (e.target.closest) { var y = e.target.closest('#tools-edit-modal-close'); if (y) { closeToolsEditModal(); return; } }
        if (e.target.id === 'tools-edit-modal') { closeToolsEditModal(); return; }
        if (e.target.id === 'tools-edit-cancel-btn') { closeToolsEditModal(); return; }
        // DETAIL
        if (e.target.id === 'tools-detail-modal-overlay') { closeToolsDetailModal(); return; }
        if (e.target.id === 'tools-detail-modal-close' || e.target.id === 'tools-detail-modal-close-btn') { closeToolsDetailModal(); return; }
        if (e.target.closest) {
            var z = e.target.closest('#tools-detail-modal-close') || e.target.closest('#tools-detail-modal-close-btn');
            if (z) { closeToolsDetailModal(); return; }
        }
        if (e.target.id === 'tools-detail-modal') { closeToolsDetailModal(); return; }
        // DELETE
        if (e.target.id === 'tools-delete-modal-overlay') { closeToolsDeleteModal(); return; }
        if (e.target.id === 'tools-delete-modal-close' || e.target.id === 'tools-delete-modal-cancel') { closeToolsDeleteModal(); return; }
        if (e.target.closest) {
            var d = e.target.closest('#tools-delete-modal-close') || e.target.closest('#tools-delete-modal-cancel');
            if (d) { closeToolsDeleteModal(); return; }
        }
        if (e.target.id === 'tools-delete-modal') { closeToolsDeleteModal(); return; }
    });
    document.body.addEventListener('keydown', function (e) {
        if ((e.key === 'Escape' || e.keyCode === 27) && (document.getElementById('tools-new-modal') || document.getElementById('tools-edit-modal') || document.getElementById('tools-detail-modal') || document.getElementById('tools-delete-modal'))) {
            closeToolsCreateModal(); closeToolsEditModal(); closeToolsDetailModal(); closeToolsDeleteModal();
        }
    });
}

/* ========= Focus when opened ========= */
function focusToolsModalFirstInput() { setTimeout(function () { var md = document.getElementById('tools-new-modal'); if (!md) return; var el = md.querySelector('#tool_name'); if (el) { try { el.focus(); el.select && el.select(); } catch (_) { } } }, 60); }
function focusToolsEditModalFirstInput() { setTimeout(function () { var md = document.getElementById('tools-edit-modal'); if (!md) return; var el = md.querySelector('#tool_name'); if (el) { try { el.focus(); el.select && el.select(); } catch (_) { } } }, 60); }
function focusToolsDetailModal() { setTimeout(function () { var md = document.getElementById('tools-detail-modal'); if (md && md.focus) { try { md.focus(); } catch (_) { } } }, 60); }

/* ========= Helpers ========= */
function _t_toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
function _t_upsertHidden(form, name, value) {
    var el = form.querySelector('input[name="' + name + '"]');
    if (value == null || value === '') { if (el && el.remove) el.remove(); return; }
    if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
    el.value = String(value);
}
function _t_mergeQs(base, qs) {
    if (!qs) return base;
    var hasQ = (base || '').indexOf('?') >= 0;
    var payload = (qs.charAt(0) === '?') ? qs.substring(1) : qs;
    return base + (hasQ ? '&' : '?') + payload;
}

// Đọc từ search form trước, fallback dataset/container
function _t_formVal(name, fallback) {
    var sf = document.getElementById('tools-search-form');
    if (sf) {
        var el = sf.querySelector('input[name="' + name + '"]');
        if (el && el.value != null && String(el.value).trim() !== '') return String(el.value).trim();
    }
    return fallback;
}

/* ========= Read current filters from page ========= */
function _getCurrentToolFilters() {
    var c = document.getElementById('admin-tools-container') || {}; var ds = c.dataset || {};
    var searchForm = document.getElementById('tools-search-form') || null;
    var sortInput = searchForm ? searchForm.querySelector('input[name="sort"]') : null;
    var qInput = document.getElementById('tools-search-input');

    var dsEnabled = ds.enabled || 'all';
    var dsScope = ds.scope || 'any';
    var dsSort = (sortInput ? (sortInput.value || '') : (ds.currentSort || 'created_desc'));
    var dsPage = _t_toInt(ds.page || '1', 1);
    var dsPerPage = _t_toInt(ds.perPage || ds.perpage || '10', 10);
    var dsQ = ds.q || '';

    var enabled = _t_formVal('enabled', dsEnabled);
    var scope = _t_formVal('scope', dsScope);
    var sort = _t_formVal('sort', dsSort);
    var page = _t_toInt(_t_formVal('page', dsPage), dsPage);
    var perPage = _t_toInt(_t_formVal('per_page', dsPerPage), dsPerPage);
    var q = qInput ? (qInput.value || '') : _t_formVal('q', dsQ);

    return {
        enabled: enabled || 'all',
        scope: scope || 'any',
        q: q || '',
        sort: sort || 'created_desc',
        page: page,
        per_page: perPage
    };
}

function _toolsFilterQS() {
    var f = _getCurrentToolFilters(); var parts = [];
    if (f.enabled && f.enabled !== 'all') parts.push('enabled=' + encodeURIComponent(f.enabled));
    if (f.scope && f.scope !== 'any') parts.push('scope=' + encodeURIComponent(f.scope));
    if (f.q) parts.push('q=' + encodeURIComponent(f.q));
    if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
    if (f.page > 1) parts.push('page=' + encodeURIComponent(f.page));
    if (f.per_page && f.per_page !== 10) parts.push('per_page=' + encodeURIComponent(f.per_page));
    return parts.length ? ('?' + parts.join('&')) : '';
}

/* ========= NEW modal: keep filters + guard double submit ========= */
function ensureToolsFormKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;
    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__toolsJustCreated = true;
        var btn = document.getElementById('tools-submit-btn'); if (btn) btn.disabled = true;

        var f = _getCurrentToolFilters();
        _t_upsertHidden(form, 'enabled', f.enabled);
        _t_upsertHidden(form, 'scope', f.scope);
        _t_upsertHidden(form, 'q', f.q);
        _t_upsertHidden(form, 'sort', f.sort);
        _t_upsertHidden(form, 'page', (f.page > 0 ? f.page : ''));
        _t_upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));

        var base = form.getAttribute('hx-post') || form.action || '/admin/tools';
        var qs = _toolsFilterQS();
        if (qs) {
            try {
                var u = new URL(base, window.location.origin), p = u.searchParams;
                ['enabled', 'scope', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.enabled && f.enabled !== 'all') p.set('enabled', f.enabled);
                if (f.scope && f.scope !== 'any') p.set('scope', f.scope);
                if (f.q) p.set('q', f.q);
                if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 1) p.set('page', String(f.page));
                if (f.per_page && f.per_page !== 10) p.set('per_page', String(f.per_page));
                u.search = p.toString();
                form.setAttribute('hx-post', u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (_) { form.setAttribute('hx-post', _t_mergeQs(base, qs)); }
        }
        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#tools-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#tools-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentToolFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.enabled && f.enabled !== 'all') e.detail.parameters.enabled = f.enabled;
            if (f.scope && f.scope !== 'any') e.detail.parameters.scope = f.scope;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            var qs = _toolsFilterQS(); if (qs) e.detail.path = _t_mergeQs(e.detail.path || '', qs);
        } catch (_) { }
    });

    form.dataset.filterBound = '1';
}

/* ========= EDIT modal: keep filters + change detection ========= */
function ensureToolsEditFormKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__toolsJustEdited = true;
        var btn = document.getElementById('tools-edit-submit-btn'); if (btn) btn.disabled = true;

        var f = _getCurrentToolFilters();
        _t_upsertHidden(form, 'enabled', f.enabled);
        _t_upsertHidden(form, 'scope', f.scope);
        _t_upsertHidden(form, 'q', f.q);
        _t_upsertHidden(form, 'sort', f.sort);
        _t_upsertHidden(form, 'page', (f.page > 0 ? f.page : ''));
        _t_upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));

        var base = form.getAttribute('hx-put') || form.action || '/admin/tools';
        var qs = _toolsFilterQS();
        if (qs) {
            try {
                var u = new URL(base, window.location.origin), p = u.searchParams;
                ['enabled', 'scope', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.enabled && f.enabled !== 'all') p.set('enabled', f.enabled);
                if (f.scope && f.scope !== 'any') p.set('scope', f.scope);
                if (f.q) p.set('q', f.q);
                if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 1) p.set('page', String(f.page));
                if (f.per_page && f.per_page !== 10) p.set('per_page', String(f.per_page));
                u.search = p.toString();
                form.setAttribute('hx-put', u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (_) { form.setAttribute('hx-put', _t_mergeQs(base, qs)); }
        } else {
            try { var u2 = new URL(base, window.location.origin); form.setAttribute('hx-put', u2.pathname + (u2.search ? ('?' + u2.search) : '')); }
            catch (_) { form.setAttribute('hx-put', base); }
        }

        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#tools-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#tools-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentToolFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.enabled && f.enabled !== 'all') e.detail.parameters.enabled = f.enabled;
            if (f.scope && f.scope !== 'any') e.detail.parameters.scope = f.scope;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            var qs = _toolsFilterQS(); if (qs) e.detail.path = _t_mergeQs(e.detail.path || '', qs);
        } catch (_) { }
    });

    form.dataset.filterBound = '1';
}

/* ========= DELETE modal: keep filters + guard double submit ========= */
function ensureToolsDeleteKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    try { form.removeAttribute('hx-vals'); } catch (_) { }

    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__toolsJustDeleted = true;
        var btn = document.getElementById('tools-delete-submit-btn'); if (btn) btn.disabled = true;

        var f = _getCurrentToolFilters();
        _t_upsertHidden(form, 'enabled', f.enabled);
        _t_upsertHidden(form, 'scope', f.scope);
        _t_upsertHidden(form, 'q', f.q);
        _t_upsertHidden(form, 'sort', f.sort);
        _t_upsertHidden(form, 'page', (f.page > 0 ? f.page : ''));
        _t_upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));

        var attr = form.hasAttribute('hx-delete') ? 'hx-delete' : (form.hasAttribute('hx-post') ? 'hx-post' : null);
        if (!attr) { attr = 'hx-delete'; form.setAttribute(attr, form.action || ''); }
        var base = form.getAttribute(attr) || form.action || '';
        var qs = _toolsFilterQS();

        if (qs) {
            try {
                var u = new URL(base, window.location.origin), p = u.searchParams;
                ['enabled', 'scope', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.enabled && f.enabled !== 'all') p.set('enabled', f.enabled);
                if (f.scope && f.scope !== 'any') p.set('scope', f.scope);
                if (f.q) p.set('q', f.q);
                if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 1) p.set('page', String(f.page));
                if (f.per_page && f.per_page !== 10) p.set('per_page', String(f.per_page));
                u.search = p.toString();
                form.setAttribute(attr, u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (_) { form.setAttribute(attr, _t_mergeQs(base, qs)); }
        }

        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#tools-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#tools-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentToolFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.enabled && f.enabled !== 'all') e.detail.parameters.enabled = f.enabled;
            if (f.scope && f.scope !== 'any') e.detail.parameters.scope = f.scope;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            var qs = _toolsFilterQS(); if (qs) e.detail.path = _t_mergeQs(e.detail.path || '', qs);
        } catch (_) { }
    });

    form.dataset.filterBound = '1';
}

/* ========= Form logic ========= */
function attachToolsCreateFormLogic() {
    var form = document.getElementById('admin-tools-create-form'); if (!form) return;
    ensureToolsFormKeepsFilters(form);

    var nameInput = form.querySelector('#tool_name');
    var sortOrder = form.querySelector('#tool_sort_order');
    var submitBtn = document.getElementById('tools-submit-btn');

    function toggleSubmit() { var ok = nameInput && nameInput.value.trim().length > 0; if (submitBtn) submitBtn.disabled = !ok; }

    if (sortOrder) {
        sortOrder.addEventListener('input', function () {
            this.value = this.value.replace(/[^0-9\-]/g, ''); if (this.value.length > 8) this.value = this.value.slice(0, 8);
        });
    }
    if (nameInput) nameInput.addEventListener('input', toggleSubmit);

    var cancel = document.getElementById('tools-cancel-btn'); if (cancel) cancel.addEventListener('click', closeToolsCreateModal);

    toggleSubmit();
}

function attachToolsEditFormLogic() {
    var form = document.getElementById('admin-tools-edit-form'); if (!form) return;
    ensureToolsEditFormKeepsFilters(form);

    var fields = {
        name: form.querySelector('#tool_name'),
        scope: form.querySelector('#tool_access_scope'),
        sort: form.querySelector('#tool_sort_order'),
        desc: form.querySelector('#tool_description'),
        enabled: form.querySelector('#tool_enabled')
    };
    var submitBtn = document.getElementById('tools-edit-submit-btn');

    if (fields.sort) {
        fields.sort.addEventListener('input', function () {
            this.value = this.value.replace(/[^0-9\-]/g, ''); if (this.value.length > 8) this.value = this.value.slice(0, 8);
        });
    }

    function snapshot() {
        return JSON.stringify({
            n: fields.name ? fields.name.value.trim() : '',
            sc: fields.scope ? fields.scope.value : 'all',
            so: fields.sort ? (fields.sort.value || '') : '',
            d: fields.desc ? (fields.desc.value || '') : '',
            e: fields.enabled ? !!fields.enabled.checked : false
        });
    }
    var initial = snapshot();

    function toggleSubmit() {
        var validName = fields.name && fields.name.value.trim().length > 0;
        var changed = (snapshot() !== initial);
        if (submitBtn) submitBtn.disabled = !(validName && changed);
    }

    var bindTargets = [fields.name, fields.scope, fields.sort, fields.desc, fields.enabled];
    for (var i = 0; i < bindTargets.length; i++) { var el = bindTargets[i]; if (!el) continue; el.addEventListener((el.tagName === 'SELECT') ? 'change' : 'input', toggleSubmit); }

    var cancel = document.getElementById('tools-edit-cancel-btn'); if (cancel) cancel.addEventListener('click', closeToolsEditModal);

    toggleSubmit();
}

function attachToolsDeleteFormLogic() {
    var form = document.getElementById('admin-tools-delete-form'); if (!form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    ensureToolsDeleteKeepsFilters(form);
}

/* ========= Rebind when modal loads via HTMX ========= */
function rebindAdminToolsNewModalEvents() { focusToolsModalFirstInput(); attachToolsCreateFormLogic(); }
function rebindAdminToolsEditModalEvents() { focusToolsEditModalFirstInput(); attachToolsEditFormLogic(); }
function rebindAdminToolsDetailModalEvents() { focusToolsDetailModal(); }
function rebindAdminToolsDeleteModalEvents() {
    // focus không cần, chỉ bind logic + close
    attachToolsDeleteFormLogic();
}

/* ========= Global binds ========= */
bindToolsModalClose();

/* HTMX: modal vừa nạp -> bind */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}; var tgt = d.target ? d.target : null; var tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-tools-modal-root' || tid === 'tools-new-modal') { rebindAdminToolsNewModalEvents(); }
    if (tid === 'admin-tools-modal-root' || tid === 'tools-edit-modal') { rebindAdminToolsEditModalEvents(); }
    if (tid === 'admin-tools-modal-root' || tid === 'tools-detail-modal') { rebindAdminToolsDetailModalEvents(); }
    if (tid === 'admin-tools-modal-root' || tid === 'tools-delete-modal') { rebindAdminToolsDeleteModalEvents(); }
});

/* Sau khi list swap -> đóng modal + toast (NEW/EDIT/DELETE) */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var t = evt && evt.detail ? evt.detail.target : null; if (!t) return;
    if (t.id === 'tools-list-region' || t.id === 'admin-tools-container') {
        closeToolsCreateModal(); closeToolsEditModal(); closeToolsDeleteModal();
        if (window.__toolsJustCreated) {
            if (window.Toast && window.Toast.show) window.Toast.show('Tạo tiện ích thành công!', 'success', 3000);
            window.__toolsJustCreated = false;
        }
        if (window.__toolsJustEdited) {
            if (window.Toast && window.Toast.show) window.Toast.show('Cập nhật tiện ích thành công!', 'success', 3000);
            window.__toolsJustEdited = false;
        }
        if (window.__toolsJustDeleted) {
            if (window.Toast && window.Toast.show) window.Toast.show('Xoá tiện ích thành công!', 'success', 3000);
            window.__toolsJustDeleted = false;
        }
        var f1 = document.getElementById('admin-tools-create-form'); if (f1) f1.dataset._submitting = '';
        var b1 = document.getElementById('tools-submit-btn'); if (b1) b1.disabled = false;
        var f2 = document.getElementById('admin-tools-edit-form'); if (f2) f2.dataset._submitting = '';
        var b2 = document.getElementById('tools-edit-submit-btn'); if (b2) b2.disabled = false;
        var f3 = document.getElementById('admin-tools-delete-form'); if (f3) f3.dataset._submitting = '';
        var b3 = document.getElementById('tools-delete-submit-btn'); if (b3) b3.disabled = false;
    }
});

/* Phục hồi nút nếu lỗi */
function _reEnableToolsCreateOnError() {
    var f = document.getElementById('admin-tools-create-form'); if (f) f.dataset._submitting = '';
    var btn = document.getElementById('tools-submit-btn'); if (btn) btn.disabled = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Tạo tiện ích thất bại. Vui lòng thử lại!', 'error', 3000);
}
function _reEnableToolsEditOnError() {
    var f = document.getElementById('admin-tools-edit-form'); if (f) f.dataset._submitting = '';
    var btn = document.getElementById('tools-edit-submit-btn'); if (btn) btn.disabled = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Cập nhật tiện ích thất bại. Vui lòng thử lại!', 'error', 3000);
}
function _reEnableToolsDeleteOnError() {
    var f = document.getElementById('admin-tools-delete-form'); if (f) f.dataset._submitting = '';
    var btn = document.getElementById('tools-delete-submit-btn'); if (btn) btn.disabled = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Xoá tiện ích thất bại. Vui lòng thử lại!', 'error', 3000);
}
document.body.addEventListener('htmx:responseError', function () { _reEnableToolsCreateOnError(); _reEnableToolsEditOnError(); _reEnableToolsDeleteOnError(); });
document.body.addEventListener('htmx:swapError', function () { _reEnableToolsCreateOnError(); _reEnableToolsEditOnError(); _reEnableToolsDeleteOnError(); });
document.body.addEventListener('htmx:sendError', function () { _reEnableToolsCreateOnError(); _reEnableToolsEditOnError(); _reEnableToolsDeleteOnError(); });

/* Nếu modal có sẵn (không qua HTMX) -> bind ngay */
if (document.getElementById('tools-new-modal')) { rebindAdminToolsNewModalEvents(); }
if (document.getElementById('tools-edit-modal')) { rebindAdminToolsEditModalEvents(); }
if (document.getElementById('tools-detail-modal')) { rebindAdminToolsDetailModalEvents(); }
if (document.getElementById('tools-delete-modal')) { rebindAdminToolsDeleteModalEvents(); }

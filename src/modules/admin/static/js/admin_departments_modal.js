/* file: src/modules/admin/static/js/admin_departments_modal.js
 * updated: 2025-08-25 (v1.5 – keep filters + highlight id)
 * note:
 *  - Create + Edit + Detail + Delete modal cho Phòng ban.
 *  - Giữ bộ lọc hiện tại (q, sort, page, per_page) khi submit ở Create/Edit/Delete.
 *  - Validation: dept_name bắt buộc; email đúng format nếu có; website nên http/https; phone lọc ký tự.
 *  - Sau create/update: đẩy id ra global để list highlight, không đổi trang.
 */

/* ========= Close helpers ========= */
function __closeDepartmentsModalById(id) { var el = document.getElementById(id); if (el && el.remove) el.remove(); }
function closeDepartmentsCreateModal() { __closeDepartmentsModalById('departments-new-modal-overlay'); __closeDepartmentsModalById('departments-new-modal'); }
function closeDepartmentsEditModal() { __closeDepartmentsModalById('departments-edit-modal-overlay'); __closeDepartmentsModalById('departments-edit-modal'); }
function closeDepartmentsDetailModal() { __closeDepartmentsModalById('departments-detail-modal-overlay'); __closeDepartmentsModalById('departments-detail-modal'); }
function closeDepartmentsDeleteModal() { __closeDepartmentsModalById('departments-delete-modal-overlay'); __closeDepartmentsModalById('departments-delete-modal'); }

/* ========= Focus (DETAIL) ========= */
function focusDepartmentsDetailModal() { setTimeout(function () { var md = document.getElementById('departments-detail-modal'); if (md && md.focus) { try { md.focus(); } catch (_) { } } }, 60); }

/* ========= Bind close events ========= */
function bindDepartmentsModalClose() {
    document.body.addEventListener('click', function (e) {
        if (!e || !e.target) return;
        // NEW
        if (e.target.id === 'departments-new-modal-overlay') { closeDepartmentsCreateModal(); return; }
        if (e.target.id === 'departments-new-modal-close') { closeDepartmentsCreateModal(); return; }
        if (e.target.closest) { var x = e.target.closest('#departments-new-modal-close'); if (x) { closeDepartmentsCreateModal(); return; } }
        if (e.target.id === 'departments-new-modal') { closeDepartmentsCreateModal(); return; }
        if (e.target.id === 'departments-cancel-btn') { closeDepartmentsCreateModal(); return; }
        // EDIT
        if (e.target.id === 'departments-edit-modal-overlay') { closeDepartmentsEditModal(); return; }
        if (e.target.id === 'departments-edit-modal-close' || e.target.id === 'departments-edit-cancel-btn') { closeDepartmentsEditModal(); return; }
        if (e.target.closest) { var y = e.target.closest('#departments-edit-modal-close'); if (y) { closeDepartmentsEditModal(); return; } }
        if (e.target.id === 'departments-edit-modal') { closeDepartmentsEditModal(); return; }
        // DETAIL
        if (e.target.id === 'departments-detail-modal-overlay') { closeDepartmentsDetailModal(); return; }
        if (e.target.id === 'departments-detail-modal-close' || e.target.id === 'departments-detail-modal-close-btn') { closeDepartmentsDetailModal(); return; }
        if (e.target.closest) { var z = e.target.closest('#departments-detail-modal-close') || e.target.closest('#departments-detail-modal-close-btn'); if (z) { closeDepartmentsDetailModal(); return; } }
        if (e.target.id === 'departments-detail-modal') { closeDepartmentsDetailModal(); return; }
        // DELETE
        if (e.target.id === 'departments-delete-modal-overlay') { closeDepartmentsDeleteModal(); return; }
        if (e.target.id === 'departments-delete-modal-close' || e.target.id === 'departments-delete-modal-cancel') { closeDepartmentsDeleteModal(); return; }
        if (e.target.closest) { var d = e.target.closest('#departments-delete-modal-close') || e.target.closest('#departments-delete-modal-cancel'); if (d) { closeDepartmentsDeleteModal(); return; } }
        if (e.target.id === 'departments-delete-modal') { closeDepartmentsDeleteModal(); return; }
    });
    document.body.addEventListener('keydown', function (e) {
        if ((e.key === 'Escape' || e.keyCode === 27) &&
            (document.getElementById('departments-new-modal') ||
                document.getElementById('departments-edit-modal') ||
                document.getElementById('departments-detail-modal') ||
                document.getElementById('departments-delete-modal'))) {
            closeDepartmentsCreateModal(); closeDepartmentsEditModal(); closeDepartmentsDetailModal(); closeDepartmentsDeleteModal();
        }
    });
}
bindDepartmentsModalClose();

/* ========= Small utils ========= */
function _d_toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
function _d_upsertHidden(form, name, value) {
    var el = form.querySelector('input[name="' + name + '"]');
    if (value == null || value === '') { if (el && el.remove) el.remove(); return; }
    if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
    el.value = String(value);
}
function _d_mergeQs(base, qs) {
    if (!qs) return base;
    var hasQ = (base || '').indexOf('?') >= 0;
    var payload = (qs.charAt(0) === '?') ? qs.substring(1) : qs;
    return base + (hasQ ? '&' : '?') + payload;
}
function _d_formVal(formId, name, fallback) {
    var f = document.getElementById(formId); if (!f) return fallback;
    var el = f.querySelector('input[name="' + name + '"]');
    if (el && String(el.value).trim() !== '') return String(el.value).trim();
    return fallback;
}

/* ========= Current filters (q, sort, page, per_page) ========= */
function _getCurrentDeptFilters() {
    var c = document.getElementById('admin-departments-container') || {}; var ds = c.dataset || {};
    var sort = _d_formVal('departments-search-form', 'sort', ds.currentSort || 'created_desc') || 'created_desc';
    var qInputEl = document.getElementById('departments-search-input');
    var q = qInputEl ? (qInputEl.value || '') : (ds.q || '');
    var page = _d_toInt(ds.page || '1', 1);
    var perPage = _d_toInt(ds.perPage || ds.perpage || '10', 10);
    return { q: q || '', sort: sort, page: page, per_page: perPage };
}
function _departmentsFilterQS() {
    var f = _getCurrentDeptFilters(); var parts = [];
    if (f.q) parts.push('q=' + encodeURIComponent(f.q));
    if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
    if (f.page > 1) parts.push('page=' + encodeURIComponent(f.page));
    if (f.per_page && f.per_page !== 10) parts.push('per_page=' + encodeURIComponent(f.per_page));
    return parts.length ? ('?' + parts.join('&')) : '';
}

/* ========= CREATE: keep filters + validation ========= */
function ensureDepartmentsFormKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        var btn = document.getElementById('departments-submit-btn'); if (btn) btn.disabled = true;

        var f = _getCurrentDeptFilters();
        ['q', 'sort'].forEach(function (k) { _d_upsertHidden(form, k, f[k]); });
        _d_upsertHidden(form, 'page', (f.page > 0 ? f.page : ''));
        _d_upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));

        var base = form.getAttribute('hx-post') || form.action || '/admin/departments';
        var qs = _departmentsFilterQS();
        if (qs) {
            try {
                var u = new URL(base, window.location.origin), p = u.searchParams;
                ['q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.q) p.set('q', f.q);
                if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 1) p.set('page', String(f.page));
                if (f.per_page && f.per_page !== 10) p.set('per_page', String(f.per_page));
                u.search = p.toString();
                form.setAttribute('hx-post', u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (_) { form.setAttribute('hx-post', _d_mergeQs(base, qs)); }
        }
        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#departments-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#departments-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentDeptFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            var qs = _departmentsFilterQS(); if (qs) e.detail.path = _d_mergeQs(e.detail.path || '', qs);

            // vòng đai an toàn:
            e.detail.parameters.page = e.detail.parameters.page || (f.page > 0 ? f.page : 1);
            e.detail.parameters.per_page = e.detail.parameters.per_page || (f.per_page > 0 ? f.per_page : 10);
        } catch (_) { }
    });

    form.dataset.filterBound = '1';
}

function attachDepartmentsCreateFormLogic() {
    var form = document.getElementById('admin-departments-create-form'); if (!form) return;
    ensureDepartmentsFormKeepsFilters(form);

    var nameEl = form.querySelector('#dept_name');
    var aliasEl = form.querySelector('#dept_alias');
    var emailEl = form.querySelector('#dept_email');
    var phoneEl = form.querySelector('#dept_phone');
    var webEl = form.querySelector('#dept_website');
    var nameHint = document.getElementById('dept-name-hint');
    var emailHint = document.getElementById('dept-email-hint');
    var webHint = document.getElementById('dept-website-hint');
    var submitBtn = document.getElementById('departments-submit-btn');

    function isEmailValid(v) { return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }
    function isUrlLooksOk(v) { if (!v) return true; var s = String(v || '').trim().toLowerCase(); return s.indexOf('http://') === 0 || s.indexOf('https://') === 0; }
    function isNameOk(v) { return String(v || '').trim().length > 0; }

    function toggleSubmit() {
        var okName = isNameOk(nameEl ? nameEl.value : '');
        var okEmail = isEmailValid(emailEl ? emailEl.value : '');
        var okWeb = isUrlLooksOk(webEl ? webEl.value : '');
        if (nameHint) nameHint.classList.toggle('hidden', okName);
        if (emailHint) emailHint.classList.toggle('hidden', okEmail);
        if (webHint) webHint.classList.toggle('hidden', okWeb || !(webEl && webEl.value));
        submitBtn && (submitBtn.disabled = !(okName && okEmail && okWeb));
    }

    nameEl && nameEl.addEventListener('input', toggleSubmit);
    aliasEl && aliasEl.addEventListener('input', function () { /* server trims */ });
    emailEl && emailEl.addEventListener('input', toggleSubmit);
    phoneEl && phoneEl.addEventListener('input', function () { this.value = this.value.replace(/[^0-9+\-\s]/g, '').slice(0, 20); });
    webEl && webEl.addEventListener('input', toggleSubmit);

    toggleSubmit();
}

/* ========= EDIT: keep filters + change detection + validation ========= */
function ensureDepartmentsEditFormKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        var btn = document.getElementById('departments-edit-submit-btn'); if (btn) btn.disabled = true;

        var f = _getCurrentDeptFilters();
        ['q', 'sort'].forEach(function (k) { _d_upsertHidden(form, k, f[k]); });
        _d_upsertHidden(form, 'page', (f.page > 0 ? f.page : ''));
        _d_upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));

        var base = form.getAttribute('hx-put') || form.action || '/admin/departments';
        var qs = _departmentsFilterQS();
        if (qs) {
            try {
                var u = new URL(base, window.location.origin), p = u.searchParams;
                ['q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.q) p.set('q', f.q);
                if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 1) p.set('page', String(f.page));
                if (f.per_page && f.per_page !== 10) p.set('per_page', String(f.per_page));
                u.search = p.toString();
                form.setAttribute('hx-put', u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (_) { form.setAttribute('hx-put', _d_mergeQs(base, qs)); }
        } else {
            try { var u2 = new URL(base, window.location.origin); form.setAttribute('hx-put', u2.pathname + (u2.search ? ('?' + u2.search) : '')); }
            catch (_) { form.setAttribute('hx-put', base); }
        }

        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#departments-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#departments-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentDeptFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            var qs = _departmentsFilterQS(); if (qs) e.detail.path = _d_mergeQs(e.detail.path || '', qs);

            // vòng đai an toàn:
            e.detail.parameters.page = e.detail.parameters.page || (f.page > 0 ? f.page : 1);
            e.detail.parameters.per_page = e.detail.parameters.per_page || (f.per_page > 0 ? f.per_page : 10);
        } catch (_) { }
    });

    form.dataset.filterBound = '1';
}

function attachDepartmentsEditFormLogic() {
    var form = document.getElementById('admin-departments-edit-form'); if (!form) return;
    ensureDepartmentsEditFormKeepsFilters(form);

    var nameEl = form.querySelector('#dept_name');
    var aliasEl = form.querySelector('#dept_alias');
    var emailEl = form.querySelector('#dept_email');
    var phoneEl = form.querySelector('#dept_phone');
    var webEl = form.querySelector('#dept_website');
    var nameHint = document.getElementById('dept-name-hint');
    var emailHint = document.getElementById('dept-email-hint');
    var webHint = document.getElementById('dept-website-hint');
    var submitBtn = document.getElementById('departments-edit-submit-btn');

    function isEmailValid(v) { return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }
    function isUrlLooksOk(v) { if (!v) return true; var s = String(v || '').trim().toLowerCase(); return s.indexOf('http://') === 0 || s.indexOf('https://') === 0; }
    function isNameOk(v) { return String(v || '').trim().length > 0; }

    function snap() {
        return JSON.stringify({
            n: nameEl ? nameEl.value.trim() : '',
            a: aliasEl ? aliasEl.value.trim() : '',
            e: emailEl ? emailEl.value.trim() : '',
            p: phoneEl ? phoneEl.value.trim() : '',
            w: webEl ? webEl.value.trim() : ''
        });
    }
    var initialSnap = snap();

    function toggleSubmit() {
        var okName = isNameOk(nameEl ? nameEl.value : '');
        var okEmail = isEmailValid(emailEl ? emailEl.value : '');
        var okWeb = isUrlLooksOk(webEl ? webEl.value : '');
        if (nameHint) nameHint.classList.toggle('hidden', okName);
        if (emailHint) emailHint.classList.toggle('hidden', okEmail);
        if (webHint) webHint.classList.toggle('hidden', okWeb || !(webEl && webEl.value));
        var changed = (snap() !== initialSnap);
        submitBtn && (submitBtn.disabled = !(okName && okEmail && okWeb && changed));
    }

    nameEl && nameEl.addEventListener('input', toggleSubmit);
    aliasEl && aliasEl.addEventListener('input', toggleSubmit);
    emailEl && emailEl.addEventListener('input', toggleSubmit);
    phoneEl && phoneEl.addEventListener('input', function () { this.value = this.value.replace(/[^0-9+\-\s]/g, '').slice(0, 20); toggleSubmit(); });
    webEl && webEl.addEventListener('input', toggleSubmit);

    toggleSubmit();
}

/* ========= DELETE: keep filters ========= */
function ensureDepartmentsDeleteKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        var btn = document.getElementById('departments-delete-submit-btn'); if (btn) btn.disabled = true;

        var f = _getCurrentDeptFilters();
        ['q', 'sort'].forEach(function (k) { _d_upsertHidden(form, k, f[k]); });
        _d_upsertHidden(form, 'page', (f.page > 0 ? f.page : ''));
        _d_upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));

        var attr = form.hasAttribute('hx-delete') ? 'hx-delete' : (form.hasAttribute('hx-post') ? 'hx-post' : null);
        if (!attr) { attr = 'hx-post'; form.setAttribute(attr, form.action || ''); }
        var base = form.getAttribute(attr) || form.action || '';
        var qs = _departmentsFilterQS();
        if (qs) {
            try {
                var u = new URL(base, window.location.origin), p = u.searchParams;
                ['q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.q) p.set('q', f.q);
                if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 0) p.set('page', String(f.page));
                if (f.per_page > 0) p.set('per_page', String(f.per_page));
                u.search = p.toString();
                form.setAttribute(attr, u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (_) { form.setAttribute(attr, _d_mergeQs(base, qs)); }
        }

        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#departments-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#departments-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentDeptFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            var qs = _departmentsFilterQS(); if (qs) e.detail.path = _d_mergeQs(e.detail.path || '', qs);

            // vòng đai an toàn:
            e.detail.parameters.page = e.detail.parameters.page || (f.page > 0 ? f.page : 1);
            e.detail.parameters.per_page = e.detail.parameters.per_page || (f.per_page > 0 ? f.per_page : 10);
        } catch (_) { }
    });

    form.dataset.filterBound = '1';
}

function attachDepartmentsDeleteFormLogic() {
    var form = document.getElementById('admin-departments-delete-form'); if (!form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    ensureDepartmentsDeleteKeepsFilters(form);
}

/* ========= DETAIL modal small hook ========= */
function attachDepartmentsDetailModalLogic() {
    setTimeout(function () { try { focusDepartmentsDetailModal(); } catch (_) { } }, 20);
}

/* ========= Rebind when modal loads via HTMX ========= */
function rebindAdminDepartmentsNewModalEvents() { attachDepartmentsCreateFormLogic(); }
function rebindAdminDepartmentsEditModalEvents() { attachDepartmentsEditFormLogic(); }
function rebindAdminDepartmentsDetailModalEvents() { attachDepartmentsDetailModalLogic(); }
function rebindAdminDepartmentsDeleteModalEvents() { attachDepartmentsDeleteFormLogic(); }

/* ========= Global HTMX hooks ========= */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}; var tgt = d.target ? d.target : null; var tid = (tgt && tgt.id) ? tgt.id : '';
    if (tid === 'admin-departments-modal-root' || tid === 'departments-new-modal') { rebindAdminDepartmentsNewModalEvents(); }
    if (tid === 'admin-departments-modal-root' || tid === 'departments-edit-modal') { rebindAdminDepartmentsEditModalEvents(); }
    if (tid === 'admin-departments-modal-root' || tid === 'departments-detail-modal') { rebindAdminDepartmentsDetailModalEvents(); }
    if (tid === 'admin-departments-modal-root' || tid === 'departments-delete-modal') { rebindAdminDepartmentsDeleteModalEvents(); }
});

/* ========= Reset submit on list swap ========= */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var t = evt && evt.detail ? evt.detail.target : null; if (!t) return;
    if (t.id === 'departments-list-region' || t.id === 'admin-departments-container') {
        var f1 = document.getElementById('admin-departments-create-form'); if (f1) f1.dataset._submitting = '';
        var b1 = document.getElementById('departments-submit-btn'); if (b1) b1.disabled = false;
        var f2 = document.getElementById('admin-departments-edit-form'); if (f2) f2.dataset._submitting = '';
        var b2 = document.getElementById('departments-edit-submit-btn'); if (b2) b2.disabled = false;
        var f3 = document.getElementById('admin-departments-delete-form'); if (f3) f3.dataset._submitting = '';
        var b3 = document.getElementById('departments-delete-submit-btn'); if (b3) b3.disabled = false;
    }
});

/* ========= Error recovery ========= */
function _reEnableDepartmentsCreateOnError() {
    var f = document.getElementById('admin-departments-create-form'); if (f) f.dataset._submitting = '';
    var btn = document.getElementById('departments-submit-btn'); if (btn) btn.disabled = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Tạo phòng ban thất bại. Vui lòng thử lại!', 'error', 3000);
}
function _reEnableDepartmentsEditOnError() {
    var f = document.getElementById('admin-departments-edit-form'); if (f) f.dataset._submitting = '';
    var btn = document.getElementById('departments-edit-submit-btn'); if (btn) btn.disabled = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Cập nhật phòng ban thất bại. Vui lòng thử lại!', 'error', 3000);
}
function _reEnableDepartmentsDeleteOnError() {
    var f = document.getElementById('admin-departments-delete-form'); if (f) f.dataset._submitting = '';
    var btn = document.getElementById('departments-delete-submit-btn'); if (btn) btn.disabled = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Xoá phòng ban thất bại. Vui lòng thử lại!', 'error', 3000);
}
document.body.addEventListener('htmx:responseError', function () { _reEnableDepartmentsCreateOnError(); _reEnableDepartmentsEditOnError(); _reEnableDepartmentsDeleteOnError(); });
document.body.addEventListener('htmx:swapError', function () { _reEnableDepartmentsCreateOnError(); _reEnableDepartmentsEditOnError(); _reEnableDepartmentsDeleteOnError(); });
document.body.addEventListener('htmx:sendError', function () { _reEnableDepartmentsCreateOnError(); _reEnableDepartmentsEditOnError(); _reEnableDepartmentsDeleteOnError(); });

/* ========= HX-Trigger handlers =========
   Backend dự kiến: resp.headers["HX-Trigger"] = {"departments-single-result":{"action":"create|update|delete","ok":true|false,"reason":"...","id":"..."}}
*/
document.body.addEventListener('departments-single-result', function (ev) {
    var d = (ev && ev.detail) || {}; var action = d.action || ''; var ok = !!d.ok; var reason = d.reason || '';
    function toast(msg, type, ms) { if (window.Toast && Toast.show) Toast.show(msg, type || 'info', ms || 2600); }

    // chuyển id để list highlight sau khi fragment swap
    if (ok && (action === 'update' || action === 'create')) {
        window.__deptHighlightId = d.id || d.dept_id || null;
    } else if (action === 'delete') {
        window.__deptHighlightId = null;
    }

    if (action === 'create') {
        if (ok) { closeDepartmentsCreateModal(); toast('Tạo phòng ban thành công!', 'success', 3000); }
        else { toast('Tạo phòng ban thất bại.', 'error', 3000); }
    }
    if (action === 'update') {
        if (ok) { closeDepartmentsEditModal(); toast('Cập nhật phòng ban thành công!', 'success', 3000); }
        else {
            if (reason === 'duplicate_name') toast('Tên phòng ban đã tồn tại. Vui lòng dùng tên khác.', 'warning', 3600);
            else toast('Cập nhật phòng ban thất bại.', 'error', 3000);
            var f = document.getElementById('admin-departments-edit-form'); if (f) f.dataset._submitting = '';
            var b = document.getElementById('departments-edit-submit-btn'); if (b) b.disabled = false;
        }
    }
    if (action === 'delete') {
        if (ok) { closeDepartmentsDeleteModal(); toast('Đã xoá phòng ban.', 'success', 2800); }
        else {
            if (reason === 'has_members' || reason === 'has_users') toast('Không thể xoá: phòng ban còn nhân sự.', 'warning', 3600);
            else if (reason === 'has_children' || reason === 'not_empty') toast('Không thể xoá: phòng ban còn dữ liệu liên kết.', 'warning', 3600);
            else if (reason === 'forbidden') toast('Bạn không có quyền xoá phòng ban này.', 'warning', 3600);
            else if (reason === 'not_found') toast('Phòng ban không tồn tại hoặc đã bị xoá.', 'warning', 3600);
            else toast('Thao tác xoá không thành công.', 'error', 3000);
            var f3 = document.getElementById('admin-departments-delete-form'); if (f3) f3.dataset._submitting = '';
            var b3 = document.getElementById('departments-delete-submit-btn'); if (b3) b3.disabled = false;
        }
    }
});

/* ========= If modal already exists (no HTMX) ========= */
if (document.getElementById('departments-new-modal')) { rebindAdminDepartmentsNewModalEvents(); }
if (document.getElementById('departments-edit-modal')) { rebindAdminDepartmentsEditModalEvents(); }
if (document.getElementById('departments-detail-modal')) { rebindAdminDepartmentsDetailModalEvents(); }
if (document.getElementById('departments-delete-modal')) { rebindAdminDepartmentsDeleteModalEvents(); }

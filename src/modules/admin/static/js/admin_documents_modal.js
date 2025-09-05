/* file: src/modules/admin/static/js/admin_documents_modal.js
 * updated: 2025-08-25 (v1.1.0 – thêm detail modal: copy nhanh; focus; giữ filter; ES5-safe)
 * note:
 *  - NEW modal: validate doc_file_path + doc_status, giữ filter/paging khi submit.
 *  - DETAIL modal: copy-to-clipboard cho doc_id / chat_id / file paths; focus/close.
 *  - DELETE modal: hook sẵn (chưa dùng ở bước này).
 */

/* ========= Close helpers ========= */
function __closeDocsModalById(id) { var el = document.getElementById(id); if (el && el.remove) el.remove(); }
function closeDocsCreateModal() { __closeDocsModalById('docs-new-modal-overlay'); __closeDocsModalById('docs-new-modal'); }
function closeDocsDetailModal() { __closeDocsModalById('docs-detail-modal-overlay'); __closeDocsModalById('docs-detail-modal'); }
function closeDocsDeleteModal() { __closeDocsModalById('docs-delete-modal-overlay'); __closeDocsModalById('docs-delete-modal'); }

/* ========= Bind close events ========= */
function bindDocsModalClose() {
    document.body.addEventListener('click', function (e) {
        if (!e || !e.target) return;
        // NEW
        if (e.target.id === 'docs-new-modal-overlay') { closeDocsCreateModal(); return; }
        if (e.target.id === 'docs-new-modal-close') { closeDocsCreateModal(); return; }
        if (e.target.closest) { var x = e.target.closest('#docs-new-modal-close'); if (x) { closeDocsCreateModal(); return; } }
        if (e.target.id === 'docs-new-modal') { closeDocsCreateModal(); return; }
        if (e.target.id === 'docs-cancel-btn') { closeDocsCreateModal(); return; }
        // DETAIL
        if (e.target.id === 'docs-detail-modal-overlay') { closeDocsDetailModal(); return; }
        if (e.target.id === 'docs-detail-modal-close' || e.target.id === 'docs-detail-modal-close-btn') { closeDocsDetailModal(); return; }
        if (e.target.closest) { var y = e.target.closest('#docs-detail-modal-close') || e.target.closest('#docs-detail-modal-close-btn'); if (y) { closeDocsDetailModal(); return; } }
        if (e.target.id === 'docs-detail-modal') { closeDocsDetailModal(); return; }
        // DELETE (chuẩn bị sẵn)
        if (e.target.id === 'docs-delete-modal-overlay') { closeDocsDeleteModal(); return; }
        if (e.target.id === 'docs-delete-modal-close' || e.target.id === 'docs-delete-modal-cancel') { closeDocsDeleteModal(); return; }
        if (e.target.closest) { var d = e.target.closest('#docs-delete-modal-close') || e.target.closest('#docs-delete-modal-cancel'); if (d) { closeDocsDeleteModal(); return; } }
        if (e.target.id === 'docs-delete-modal') { closeDocsDeleteModal(); return; }
    });
    document.body.addEventListener('keydown', function (e) {
        if ((e.key === 'Escape' || e.keyCode === 27) && (document.getElementById('docs-new-modal') || document.getElementById('docs-detail-modal') || document.getElementById('docs-delete-modal'))) {
            closeDocsCreateModal(); closeDocsDetailModal(); closeDocsDeleteModal();
        }
    });
}
bindDocsModalClose();

/* ========= Small utils ========= */
function _d_toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
function _d_upsertHidden(form, name, value) {
    var el = form.querySelector('input[name="' + name + '"]');
    if (value == null || value === '') { if (el && el.remove) el.remove(); return; }
    if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
    el.value = String(value);
}
function _d_mergeQs(base, qs) {
    if (!qs) return base; var hasQ = (base || '').indexOf('?') >= 0;
    var payload = (qs.charAt(0) === '?') ? qs.substring(1) : qs; return base + (hasQ ? '&' : '?') + payload;
}
function _d_formVal(formId, name, fallback) {
    var f = document.getElementById(formId); if (f) { var el = f.querySelector('input[name="' + name + '"]'); if (el && el.value != null && String(el.value).trim() !== '') return String(el.value).trim(); }
    return fallback;
}
function _d_safeToast(msg, type, ms) { try { if (window.Toast && Toast.show) Toast.show(msg, type || 'info', ms || 2600); } catch (_) { } }

/* ========= Current filters ========= */
function _getCurrentDocFilters() {
    var c = document.getElementById('admin-documents-container') || {}; var ds = c.dataset || {};
    var sortInput = null; var sf = document.getElementById('docs-search-form'); if (sf) { sortInput = sf.querySelector('input[name="sort"]'); }
    var qInput = document.getElementById('docs-search-input');
    var dsStatus = ds.status || 'all', dsChat = ds.chatId || ds.chatid || '', dsQ = ds.q || '';
    var dsSort = (sortInput ? (sortInput.value || '') : (ds.currentSort || 'created_desc'));
    var dsPage = _d_toInt(ds.page || '1', 1), dsPerPage = _d_toInt(ds.perPage || ds.perpage || '10', 10);

    var status = _d_formVal('docs-search-form', 'status', dsStatus);
    var chatId = _d_formVal('docs-chat-form', 'chat_id', dsChat);
    var sort = _d_formVal('docs-search-form', 'sort', dsSort);
    var page = _d_toInt(_d_formVal('docs-search-form', 'page', dsPage), dsPage);
    var perPage = _d_toInt(_d_formVal('docs-search-form', 'per_page', dsPerPage), dsPerPage);
    var q = qInput ? (qInput.value || '') : _d_formVal('docs-search-form', 'q', dsQ);

    return { status: status || 'all', chat_id: (chatId == null ? '' : chatId), q: q || '', sort: sort || 'created_desc', page: page, per_page: perPage };
}
function _docsFilterQS() {
    var f = _getCurrentDocFilters(); var parts = [];
    if (f.status && f.status !== 'all') parts.push('status=' + encodeURIComponent(f.status));
    if (f.chat_id) parts.push('chat_id=' + encodeURIComponent(f.chat_id));
    if (f.q) parts.push('q=' + encodeURIComponent(f.q));
    if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
    if (f.page > 1) parts.push('page=' + encodeURIComponent(f.page));
    if (f.per_page && f.per_page !== 10) parts.push('per_page=' + encodeURIComponent(f.per_page));
    return parts.length ? ('?' + parts.join('&')) : '';
}

/* ========= Create: keep filters + simple validation ========= */
function ensureDocsFormKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    form.addEventListener('submit', function (e) {
        if (form.dataset._submitting === '1') return;
        // client-side validate
        var filePath = form.querySelector('#doc_file_path');
        var statusSel = form.querySelector('#doc_status');
        var ok = !!(filePath && (filePath.value || '').trim() !== '') && !!(statusSel && (statusSel.value || '') !== '');
        if (!ok) { if (e && e.preventDefault) e.preventDefault(); _d_safeToast('Vui lòng nhập đường dẫn tệp và trạng thái.', 'warning', 2800); return; }

        form.dataset._submitting = '1'; var btn = document.getElementById('docs-submit-btn'); if (btn) btn.disabled = true;

        var f = _getCurrentDocFilters();
        ['status', 'chat_id', 'q', 'sort'].forEach(function (k) { _d_upsertHidden(form, k, f[k]); });
        _d_upsertHidden(form, 'page', (f.page > 0 ? f.page : '')); _d_upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));

        var base = form.getAttribute('hx-post') || form.action || '/admin/documents';
        var qs = _docsFilterQS();
        if (qs) {
            try {
                var u = new URL(base, window.location.origin), p = u.searchParams;
                ['status', 'chat_id', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.status && f.status !== 'all') p.set('status', f.status);
                if (f.chat_id) p.set('chat_id', f.chat_id);
                if (f.q) p.set('q', f.q);
                if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 1) p.set('page', String(f.page));
                if (f.per_page && f.per_page !== 10) p.set('per_page', String(f.per_page));
                u.search = p.toString(); form.setAttribute('hx-post', u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (_) { form.setAttribute('hx-post', _d_mergeQs(base, qs)); }
        }
        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#documents-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#documents-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true);

    /* Bơm param khi HTMX gửi (kể cả control trống) */
    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentDocFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.status && f.status !== 'all') e.detail.parameters.status = f.status;
            if (f.chat_id) e.detail.parameters.chat_id = f.chat_id;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            var qs = _docsFilterQS(); if (qs) e.detail.path = _d_mergeQs(e.detail.path || '', qs);
        } catch (_) { }
    });

    form.dataset.filterBound = '1';
}

function attachDocsCreateFormLogic() {
    var form = document.getElementById('admin-docs-create-form'); if (!form) return;
    ensureDocsFormKeepsFilters(form);

    var filePath = form.querySelector('#doc_file_path');
    var statusSel = form.querySelector('#doc_status');
    var submitBtn = document.getElementById('docs-submit-btn');

    function toggleSubmit() {
        var ok = (filePath && (filePath.value || '').trim() !== '') && (statusSel && (statusSel.value || '') !== '');
        if (submitBtn) submitBtn.disabled = !ok;
    }
    if (filePath) filePath.addEventListener('input', toggleSubmit);
    if (statusSel) statusSel.addEventListener('change', toggleSubmit);
    toggleSubmit();
}

/* ========= Detail modal logic ========= */
function _copyText(txt) {
    if (!txt) { _d_safeToast('Không có dữ liệu để sao chép.', 'warning', 2200); return; }
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(txt)).then(function () { _d_safeToast('Đã sao chép!', 'success', 1400); },
            function () { _fallbackCopy(txt); });
    } else { _fallbackCopy(txt); }
}
function _fallbackCopy(txt) {
    try {
        var ta = document.createElement('textarea'); ta.value = String(txt);
        ta.style.position = 'fixed'; ta.style.left = '-1000px'; ta.style.top = '-1000px'; document.body.appendChild(ta);
        ta.focus(); ta.select(); var ok = document.execCommand('copy'); document.body.removeChild(ta);
        _d_safeToast(ok ? 'Đã sao chép!' : 'Không thể sao chép.', ok ? 'success' : 'error', ok ? 1400 : 2200);
    } catch (_) { _d_safeToast('Không thể sao chép.', 'error', 2200); }
}
function attachDocsDetailModalLogic() {
    // Focus sau khi mở
    setTimeout(function () { try { var md = document.getElementById('docs-detail-modal'); if (md && md.focus) { md.focus(); } } catch (_) { } }, 40);

    // Bind copy
    var root = document.getElementById('docs-detail-modal'); if (!root) return;
    var btns = root.querySelectorAll('.copy-btn');
    for (var i = 0; i < btns.length; i++) {
        (function (b) {
            b.addEventListener('click', function () {
                var txt = b.getAttribute('data-copy') || ''; _copyText(txt);
            });
        })(btns[i]);
    }
}

/* ========= Delete / Detail (form delete — chuẩn bị sẵn) ========= */
function ensureDocsDeleteKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;
    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        var btn = document.getElementById('docs-delete-submit-btn'); if (btn) btn.disabled = true;
        var f = _getCurrentDocFilters();
        ['status', 'chat_id', 'q', 'sort'].forEach(function (k) { _d_upsertHidden(form, k, f[k]); });
        _d_upsertHidden(form, 'page', (f.page > 0 ? f.page : '')); _d_upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));

        var attr = form.hasAttribute('hx-delete') ? 'hx-delete' : (form.hasAttribute('hx-post') ? 'hx-post' : null);
        if (!attr) { attr = 'hx-post'; form.setAttribute(attr, form.action || ''); }
        var base = form.getAttribute(attr) || form.action || '';
        var qs = _docsFilterQS();
        if (qs) {
            try {
                var u = new URL(base, window.location.origin), p = u.searchParams;
                ['status', 'chat_id', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.status !== 'all') p.set('status', f.status);
                if (f.chat_id) p.set('chat_id', f.chat_id);
                if (f.q) p.set('q', f.q);
                if (f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 0) p.set('page', String(f.page));
                if (f.per_page > 0) p.set('per_page', String(f.per_page));
                u.search = p.toString(); form.setAttribute(attr, u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (_) { form.setAttribute(attr, _d_mergeQs(base, qs)); }
        }
        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#documents-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#documents-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentDocFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.status !== 'all') e.detail.parameters.status = f.status;
            if (f.chat_id) e.detail.parameters.chat_id = f.chat_id;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            var qs = _docsFilterQS(); if (qs) e.detail.path = _d_mergeQs(e.detail.path || '', qs);
        } catch (_) { }
    });

    form.dataset.filterBound = '1';
}
function attachDocsDeleteFormLogic() { var form = document.getElementById('admin-docs-delete-form'); if (!form || form.dataset.bound === '1') return; form.dataset.bound = '1'; ensureDocsDeleteKeepsFilters(form); }

/* ========= Rebind when modal loads via HTMX ========= */
function rebindAdminDocsNewModalEvents() { attachDocsCreateFormLogic(); }
function rebindAdminDocsDetailModalEvents() { attachDocsDetailModalLogic(); }
function rebindAdminDocsDeleteModalEvents() { attachDocsDeleteFormLogic(); }

document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}; var tgt = d.target ? d.target : null; var tid = (tgt && tgt.id) ? tgt.id : '';
    if (tid === 'admin-docs-modal-root' || tid === 'docs-new-modal') { rebindAdminDocsNewModalEvents(); }
    if (tid === 'admin-docs-modal-root' || tid === 'docs-detail-modal') { rebindAdminDocsDetailModalEvents(); }
    if (tid === 'admin-docs-modal-root' || tid === 'docs-delete-modal') { rebindAdminDocsDeleteModalEvents(); }
});

/* ========= Reset submit state sau khi swap list ========= */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var t = evt && evt.detail ? evt.detail.target : null; if (!t) return;
    if (t.id === 'documents-list-region' || t.id === 'admin-documents-container') {
        var f1 = document.getElementById('admin-docs-create-form'); if (f1) f1.dataset._submitting = '';
        var b1 = document.getElementById('docs-submit-btn'); if (b1) b1.disabled = false;
        var f3 = document.getElementById('admin-docs-delete-form'); if (f3) f3.dataset._submitting = '';
        var b3 = document.getElementById('docs-delete-submit-btn'); if (b3) b3.disabled = false;
    }
});

/* ========= Error recovery ========= */
function _reEnableDocsCreateOnError() { var f = document.getElementById('admin-docs-create-form'); if (f) f.dataset._submitting = ''; var b = document.getElementById('docs-submit-btn'); if (b) b.disabled = false; _d_safeToast('Tạo văn bản thất bại. Vui lòng thử lại!', 'error', 3000); }
function _reEnableDocsDeleteOnError() { var f = document.getElementById('admin-docs-delete-form'); if (f) f.dataset._submitting = ''; var b = document.getElementById('docs-delete-submit-btn'); if (b) b.disabled = false; _d_safeToast('Xoá văn bản thất bại. Vui lòng thử lại!', 'error', 3000); }
document.body.addEventListener('htmx:responseError', function () { _reEnableDocsCreateOnError(); _reEnableDocsDeleteOnError(); });
document.body.addEventListener('htmx:swapError', function () { _reEnableDocsCreateOnError(); _reEnableDocsDeleteOnError(); });
document.body.addEventListener('htmx:sendError', function () { _reEnableDocsCreateOnError(); _reEnableDocsDeleteOnError(); });

/* ========= HX-Trigger handlers =========
   resp.headers["HX-Trigger"] = {"documents-single-result":{"action":"create|delete","ok":true|false,"reason":"..."}}
*/
document.body.addEventListener('documents-single-result', function (ev) {
    var d = (ev && ev.detail) || {}; var action = d.action || ''; var ok = !!d.ok; var reason = d.reason || '';
    function toast(msg, type, ms) { _d_safeToast(msg, type, ms); }
    if (action === 'create') {
        if (ok) { closeDocsCreateModal(); toast('Tạo văn bản thành công!', 'success', 3000); }
        else { toast('Tạo văn bản thất bại.', 'error', 3000); var f = document.getElementById('admin-docs-create-form'); if (f) f.dataset._submitting = ''; var b = document.getElementById('docs-submit-btn'); if (b) b.disabled = false; }
    }
    if (action === 'delete') {
        if (ok) { closeDocsDeleteModal(); toast('Đã xoá văn bản.', 'success', 2800); }
        else {
            if (reason === 'in_use') toast('Không thể xoá: văn bản đang được sử dụng.', 'warning', 3200);
            else toast('Thao tác xoá không thành công.', 'error', 3000);
            var f3 = document.getElementById('admin-docs-delete-form'); if (f3) f3.dataset._submitting = '';
            var b3 = document.getElementById('docs-delete-submit-btn'); if (b3) b3.disabled = false;
        }
    }
});

/* ========= If modal already exists (no HTMX) ========= */
if (document.getElementById('docs-new-modal')) { rebindAdminDocsNewModalEvents(); }
if (document.getElementById('docs-detail-modal')) { rebindAdminDocsDetailModalEvents(); }
if (document.getElementById('docs-delete-modal')) { rebindAdminDocsDeleteModalEvents(); }

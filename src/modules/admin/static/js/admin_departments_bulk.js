/* file: src/modules/admin/static/js/admin_departments_bulk.js
 * updated: 2025-08-25 (v1.1 – add bulk export: selected|filter; keep filters; open URL)
 * note:
 *   - Bulk delete nhiều Phòng ban — HTMX swap #departments-list-region.
 *   - Bulk export CSV (selected | filter) — mở URL trực tiếp, không dùng HTMX.
 *   - Giữ filter: q/sort/page/per_page. ES5-safe.
 */

/* ===================== Close helpers ===================== */
function closeDepartmentsBulkDeleteModal() {
    var ov = document.getElementById('departments-bulk-delete-modal-overlay'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var md = document.getElementById('departments-bulk-delete-modal'); if (md && md.parentNode) md.parentNode.removeChild(md);
}
function closeDepartmentsBulkExportModal() {
    var ov = document.getElementById('departments-bulk-export-modal-overlay'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var md = document.getElementById('departments-bulk-export-modal'); if (md && md.parentNode) md.parentNode.removeChild(md);
}

/* ===================== Small utils ===================== */
function _db_toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
function _db_upsertHidden(form, name, value) {
    var el = form.querySelector('input[name="' + name + '"]');
    if (value == null || value === '') { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
    if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
    el.value = String(value);
}
function _db_mergeQsIntoUrl(base, qs) {
    if (!qs) return base;
    var hasQ = (base || '').indexOf('?') >= 0;
    var payload = (qs.charAt(0) === '?') ? qs.substring(1) : qs;
    return base + (hasQ ? '&' : '?') + payload;
}

/* Lightweight fetch -> lấy HTML modal */
function _db_fetchText(url, ok, fail) {
    try {
        var xhr = new XMLHttpRequest(); xhr.open('GET', url, true);
        xhr.setRequestHeader('HX-Request', 'true');
        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) { ok && ok(xhr.responseText || ''); }
                else { fail && fail(new Error('HTTP ' + xhr.status)); }
            }
        };
        xhr.send();
    } catch (e) { fail && fail(e); }
}
function _db_fakeXhr(status, body) { return { status: status || 200, responseText: body || '', response: body || '', getResponseHeader: function () { return null; } }; }
function _db_ce(name, detail) { try { return new CustomEvent(name, { detail: detail }); } catch (e) { var ev = document.createEvent('CustomEvent'); ev.initCustomEvent(name, false, false, detail); return ev; } }
function _db_dispatchHX(type, detail) {
    document.body.dispatchEvent(_db_ce(type, detail));
    if (window.htmx && detail && detail.target) { try { window.htmx.process(detail.target); } catch (_e) { } }
}

/* ===================== Current filters (Departments) ===================== */
function _departmentsCurrentFilters() {
    var c = document.getElementById('admin-departments-container') || { dataset: {} };
    var ds = c.dataset || {};
    var sf = document.getElementById('departments-search-form');
    var sortInput = sf ? sf.querySelector('input[name="sort"]') : null;
    var qInput = document.getElementById('departments-search-input');

    var sort = sortInput ? (sortInput.value || 'created_desc') : (ds.currentSort || 'created_desc');
    var q = qInput ? (qInput.value || '') : (ds.q || '');
    var page = _db_toInt(ds.page || '1', 1);
    var perPage = _db_toInt(ds.perPage || ds.perpage || '10', 10);
    return { q: q || '', sort: sort || 'created_desc', page: page, per_page: perPage };
}
function _departmentsBuildQS(f) {
    var parts = [];
    if (f.q) parts.push('q=' + encodeURIComponent(f.q));
    if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
    if (f.page > 1) parts.push('page=' + encodeURIComponent(f.page));
    if (f.per_page && f.per_page !== 10) parts.push('per_page=' + encodeURIComponent(f.per_page));
    return parts.length ? ('?' + parts.join('&')) : '';
}

/* ===================== BULK DELETE (đã có) ===================== */
window.__openDepartmentsBulkDeleteModal = function (ids) {
    var root = document.getElementById('admin-departments-modal-root'); if (!root) return;
    var url = '/admin/departments/bulk-delete-modal';
    if (ids) url += '?ids=' + encodeURIComponent(ids);
    _db_fetchText(url, function (html) {
        root.innerHTML = html || '';
        var fake = _db_fakeXhr(200, html);
        _db_dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
        _db_dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
        _db_dispatchHX('htmx:load', { elt: root });
        _db_dispatchHX('htmx:afterSettle', { target: root, xhr: fake });
        try { var hid = document.getElementById('departments-bulk-delete-ids'); if (hid && ids) hid.value = ids; } catch (_e) { }
    }, function (err) {
        if (window.Toast && window.Toast.show) window.Toast.show('Không mở được hộp thoại xoá hàng loạt: ' + (err && err.message ? err.message : ''), 'error', 3000);
    });
};
function _departmentsInjectFiltersAndPatchUrl(form) {
    var f = _departmentsCurrentFilters();
    _db_upsertHidden(form, 'q', f.q || '');
    _db_upsertHidden(form, 'sort', (f.sort && f.sort !== 'created_desc') ? f.sort : '');
    _db_upsertHidden(form, 'page', f.page > 0 ? f.page : '');
    _db_upsertHidden(form, 'per_page', f.per_page > 0 ? f.per_page : '');

    var attr = form.hasAttribute('hx-post') ? 'hx-post' : (form.hasAttribute('hx-delete') ? 'hx-delete' : null);
    if (!attr) { attr = 'hx-post'; form.setAttribute(attr, form.action || ''); }
    var base = form.getAttribute(attr) || form.action || '';
    var qs = _departmentsBuildQS(f);
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
        } catch (e) { form.setAttribute(attr, _db_mergeQsIntoUrl(base, qs)); }
    }
    if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#departments-list-region');
    if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#departments-list-region');
    if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
}
function ensureDepartmentsBulkDeleteKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;
    try { form.removeAttribute('hx-vals'); } catch (_) { }
    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__departmentsBulkJustDeleted = true;

        var cached = _db_toInt(form.getAttribute('data-selected-count') || '0', 0);
        if (!cached) {
            var idsEl = form.querySelector('input[name="ids"]');
            var idsVal = idsEl ? String(idsEl.value || '').trim() : '';
            if (idsVal) {
                var arr = idsVal.split(','), i, c = 0; for (i = 0; i < arr.length; i++) { if (String(arr[i]).trim()) c++; }
                cached = c;
            }
        }
        window.__departmentsBulkDeleteCount = cached;

        var btn = form.querySelector('#departments-bulk-delete-submit'); if (btn) btn.disabled = true;
        _departmentsInjectFiltersAndPatchUrl(form);
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _departmentsCurrentFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            var qs = _departmentsBuildQS(f); if (qs) e.detail.path = _db_mergeQsIntoUrl(e.detail.path || '', qs);
        } catch (err) { }
    });

    form.dataset.filterBound = '1';
}
function bindDepartmentsBulkDeleteModalClose() {
    var ov = document.getElementById('departments-bulk-delete-modal-overlay');
    if (ov && !ov.dataset.bound) { ov.dataset.bound = '1'; ov.addEventListener('click', closeDepartmentsBulkDeleteModal); }
    var wrap = document.getElementById('departments-bulk-delete-modal');
    if (wrap && !wrap.dataset.boundOutside) {
        wrap.dataset.boundOutside = '1';
        wrap.addEventListener('click', function (e) { var t = e && e.target ? e.target : null; if (t && t.id === 'departments-bulk-delete-modal') { closeDepartmentsBulkDeleteModal(); } });
    }
    var x = document.getElementById('departments-bulk-delete-modal-close');
    if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', closeDepartmentsBulkDeleteModal); }
    var c = document.getElementById('departments-bulk-delete-cancel');
    if (c && !c.dataset.bound) { c.dataset.bound = '1'; c.addEventListener('click', closeDepartmentsBulkDeleteModal); }
    if (!document.body.dataset.boundEscDepartmentsBulkDelete) {
        document.body.dataset.boundEscDepartmentsBulkDelete = '1';
        document.addEventListener('keydown', function (e) {
            if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('departments-bulk-delete-modal')) { closeDepartmentsBulkDeleteModal(); }
        });
    }
}
function bindDepartmentsBulkDeleteFormLogic() {
    var form = document.querySelector('#admin-departments-bulk-delete-form');
    if (!form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    ensureDepartmentsBulkDeleteKeepsFilters(form);
}

/* After swap: đóng modal + toast – DELETE */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var t = evt && evt.detail ? evt.detail.target : null; if (!t) return;
    if (t.id === 'departments-list-region' || t.id === 'admin-departments-container') {
        closeDepartmentsBulkDeleteModal();
        if (window.__departmentsBulkJustDeleted) {
            if (window.Toast && window.Toast.show) {
                var count = _db_toInt(String(window.__departmentsBulkDeleteCount || '0'), 0);
                window.Toast.show(count > 0 ? ('Đã xoá ' + count + ' phòng ban!') : 'Đã xoá các phòng ban đã chọn!', 'success', 2600);
            }
            window.__departmentsBulkJustDeleted = false;
            window.__departmentsBulkDeleteCount = 0;
        }
        var form = document.querySelector('#admin-departments-bulk-delete-form'); if (form) form.dataset._submitting = '';
        var btn = document.getElementById('departments-bulk-delete-submit'); if (btn) btn.disabled = false;
    }
});

/* Error recovery – DELETE */
function _reEnableDepartmentsBulkDeleteOnError(elt) {
    var form = (elt && elt.id === 'admin-departments-bulk-delete-form') ? elt : document.querySelector('#admin-departments-bulk-delete-form');
    if (!form) return;
    form.dataset._submitting = '';
    var btn = form.querySelector('#departments-bulk-delete-submit'); if (btn) btn.disabled = false;
    window.__departmentsBulkJustDeleted = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Xoá hàng loạt thất bại. Vui lòng thử lại!', 'error', 3000);
}
document.body.addEventListener('htmx:responseError', function (e) { var d = e && e.detail ? e.detail : {}; _reEnableDepartmentsBulkDeleteOnError(d.elt ? d.elt : null); });
document.body.addEventListener('htmx:swapError', function (e) { var d = e && e.detail ? e.detail : {}; _reEnableDepartmentsBulkDeleteOnError(d.elt ? d.elt : null); });
document.body.addEventListener('htmx:sendError', function (e) { var d = e && e.detail ? e.detail : {}; _reEnableDepartmentsBulkDeleteOnError(d.elt ? d.elt : null); });

/* ===================== BULK EXPORT ===================== */
/* Open modal EXPORT (optional opener) */
window.__openDepartmentsBulkExportModal = function (ids) {
    var root = document.getElementById('admin-departments-modal-root'); if (!root) return;
    var url = '/admin/departments/bulk-export-modal';
    if (ids) url += '?ids=' + encodeURIComponent(ids);
    _db_fetchText(url, function (html) {
        root.innerHTML = html || '';
        var fake = _db_fakeXhr(200, html);
        _db_dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
        _db_dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
        _db_dispatchHX('htmx:load', { elt: root });
        _db_dispatchHX('htmx:afterSettle', { target: root, xhr: fake });
        try {
            var hid = document.getElementById('departments-bulk-export-ids'); if (hid && ids) hid.value = ids;
            var btnSel = document.getElementById('departments-bulk-export-selected'); if (btnSel) btnSel.disabled = !ids;
            var cnt = document.getElementById('departments-bulk-export-selected-count');
            if (cnt && typeof ids === 'string') { var c = ids ? ids.split(',').filter(function (s) { return !!String(s).trim(); }).length : 0; cnt.textContent = c; }
        } catch (_e) { }
    }, function (err) {
        if (window.Toast && window.Toast.show) window.Toast.show('Không mở được hộp thoại xuất CSV: ' + (err && err.message ? err.message : ''), 'error', 3000);
    });
};

/* Build + open export URL */
function _openDepartmentsExportUrl(mode) {
    // mode: 'selected' | 'filter'
    var base = '/admin/departments/export-csv';
    var f = _departmentsCurrentFilters();
    var qs = _departmentsBuildQS(f);

    if (mode === 'selected') {
        var idsInput = document.getElementById('departments-bulk-export-ids');
        var ids = (idsInput && idsInput.value) ? String(idsInput.value).trim() : '';
        if (!ids) {
            if (window.Toast && window.Toast.show) window.Toast.show('Chưa chọn phòng ban nào để xuất.', 'warning', 2500);
            return;
        }
        var more = 'ids=' + encodeURIComponent(ids) + '&mode=selected&format=csv';
        qs = _db_mergeQsIntoUrl(qs || '', more);
    } else {
        var more2 = 'mode=filter&format=csv';
        qs = _db_mergeQsIntoUrl(qs || '', more2);
    }

    var url = base + qs;
    try { window.open(url, '_blank'); } catch (e) { window.location.href = url; }
    closeDepartmentsBulkExportModal();
}

/* Bind đóng modal export: overlay, wrapper, nút X, ESC */
function bindDepartmentsBulkExportModalClose() {
    var ov = document.getElementById('departments-bulk-export-modal-overlay');
    if (ov && !ov.dataset.bound) { ov.dataset.bound = '1'; ov.addEventListener('click', closeDepartmentsBulkExportModal); }

    var wrap = document.getElementById('departments-bulk-export-modal');
    if (wrap && !wrap.dataset.boundOutside) {
        wrap.dataset.boundOutside = '1';
        wrap.addEventListener('click', function (e) {
            var t = e && e.target ? e.target : null;
            if (t && t.id === 'departments-bulk-export-modal') { closeDepartmentsBulkExportModal(); }
        });
    }

    var x = document.getElementById('departments-bulk-export-modal-close');
    if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', closeDepartmentsBulkExportModal); }

    if (!document.body.dataset.boundEscDepartmentsBulkExport) {
        document.body.dataset.boundEscDepartmentsBulkExport = '1';
        document.addEventListener('keydown', function (e) {
            if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('departments-bulk-export-modal')) {
                closeDepartmentsBulkExportModal();
            }
        });
    }
}

/* Bind hành vi export */
function bindDepartmentsBulkExportActions() {
    var btnSel = document.getElementById('departments-bulk-export-selected');
    if (btnSel && !btnSel.dataset.bound) {
        btnSel.dataset.bound = '1';
        btnSel.addEventListener('click', function () {
            if (btnSel.disabled) {
                if (window.Toast && window.Toast.show) window.Toast.show('Không có mục nào được chọn.', 'info', 2200);
                return;
            }
            _openDepartmentsExportUrl('selected');
        });
    }

    var btnFilt = document.getElementById('departments-bulk-export-filter');
    if (btnFilt && !btnFilt.dataset.bound) {
        btnFilt.dataset.bound = '1';
        btnFilt.addEventListener('click', function () { _openDepartmentsExportUrl('filter'); });
    }
}

/* ===================== Global binds ===================== */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}; var tgt = d && d.target ? d.target : null; var tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-departments-modal-root' || tid === 'departments-bulk-delete-modal') {
        bindDepartmentsBulkDeleteModalClose();
        bindDepartmentsBulkDeleteFormLogic();
    }
    if (tid === 'admin-departments-modal-root' || tid === 'departments-bulk-export-modal') {
        bindDepartmentsBulkExportModalClose();
        bindDepartmentsBulkExportActions();
    }
});

/* Nếu modal đã tồn tại sẵn (không qua HTMX) */
if (document.getElementById('departments-bulk-delete-modal')) {
    bindDepartmentsBulkDeleteModalClose();
    bindDepartmentsBulkDeleteFormLogic();
}
if (document.getElementById('departments-bulk-export-modal')) {
    bindDepartmentsBulkExportModalClose();
    bindDepartmentsBulkExportActions();
}

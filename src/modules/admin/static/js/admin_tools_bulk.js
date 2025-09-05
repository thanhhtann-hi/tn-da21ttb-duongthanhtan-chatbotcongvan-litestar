/* file: src/modules/admin/static/js/admin_tools_bulk.js
 * updated: 2025-08-24 (v1.3 – form-first filters; consistent QS for bulk ops)
 * note:
 *   - Bulk delete nhiều Tool (hard delete) — HTMX swap #tools-list-region.
 *   - Bulk export CSV (selected | filter) — mở URL trực tiếp, không dùng HTMX.
 *   - Giữ filter: enabled/scope/q/sort/page/per_page. ES5-safe.
 */

/* ===================== COMMON (delete) — giữ nguyên nền tảng ===================== */
/* Close modal */
function closeToolsBulkDeleteModal() {
    var ov = document.getElementById('tools-bulk-delete-modal-overlay'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var md = document.getElementById('tools-bulk-delete-modal'); if (md && md.parentNode) md.parentNode.removeChild(md);
}

/* Lightweight helpers */
function _tb_toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
function _tb_upsertHidden(form, name, value) {
    var el = form.querySelector('input[name="' + name + '"]');
    if (value == null || value === '') { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
    if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
    el.value = String(value);
}
function _tb_mergeQsIntoUrl(base, qs) {
    if (!qs) return base;
    var hasQ = (base || '').indexOf('?') >= 0;
    var payload = (qs.charAt(0) === '?') ? qs.substring(1) : qs;
    return base + (hasQ ? '&' : '?') + payload;
}

/* Fetch & HTMX-like dispatch (ES5) */
function _tb_fetchText(url, ok, fail) {
    try {
        var xhr = new XMLHttpRequest(); xhr.open('GET', url, true);
        xhr.setRequestHeader('HX-Request', 'true');
        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) { if (ok) ok(xhr.responseText || ''); }
                else { if (fail) fail(new Error('HTTP ' + xhr.status)); }
            }
        };
        xhr.send();
    } catch (e) { if (fail) fail(e); }
}
function _tb_fakeXhr(status, body) { return { status: status || 200, responseText: body || '', response: body || '', getResponseHeader: function () { return null; } }; }
function _tb_ce(name, detail) { try { return new CustomEvent(name, { detail: detail }); } catch (e) { var evt = document.createEvent('CustomEvent'); evt.initCustomEvent(name, false, false, detail); return evt; } }
function _tb_dispatchHX(type, detail) {
    document.body.dispatchEvent(_tb_ce(type, detail));
    if (window.htmx && detail && detail.target) { try { window.htmx.process(detail.target); } catch (_e) { } }
}

/* Optional opener (DELETE) */
window.__openToolsBulkDeleteModal = function (ids) {
    var root = document.getElementById('admin-tools-modal-root'); if (!root) return;
    var url = '/admin/tools/bulk-delete-modal';
    if (ids) url += '?ids=' + encodeURIComponent(ids);
    _tb_fetchText(url, function (html) {
        root.innerHTML = html || '';
        var fake = _tb_fakeXhr(200, html);
        _tb_dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
        _tb_dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
        _tb_dispatchHX('htmx:load', { elt: root });
        _tb_dispatchHX('htmx:afterSettle', { target: root, xhr: fake });
        try {
            var hid = document.getElementById('tools-bulk-delete-ids');
            if (hid && ids) hid.value = ids;
        } catch (_e) { }
    }, function (err) {
        if (window.Toast && window.Toast.show) window.Toast.show('Không mở được hộp thoại xoá hàng loạt: ' + (err && err.message ? err.message : ''), 'error', 3000);
    });
};

/* Current filters (Tools) — ƯU TIÊN form hidden, fallback dataset */
function _toolsCurrentFilters() {
    function fval(name, fallback) {
        var sf = document.getElementById('tools-search-form');
        if (sf) {
            var el = sf.querySelector('input[name="' + name + '"]');
            if (el && el.value != null && String(el.value).trim() !== '') return String(el.value).trim();
        }
        return fallback;
    }

    var c = document.getElementById('admin-tools-container'); c = c || { dataset: {} };
    var searchForm = document.getElementById('tools-search-form') || null;
    var sortInput = searchForm ? searchForm.querySelector('input[name="sort"]') : null;
    var qInput = document.getElementById('tools-search-input');

    var ds = c.dataset || {};
    var dsEnabled = ds.enabled || 'all';
    var dsScope = ds.scope || 'any';
    var dsSort = sortInput ? (sortInput.value || 'created_desc') : (ds.currentSort || 'created_desc');
    var dsPage = _tb_toInt(ds.page || '1', 1);
    var dsPerPage = _tb_toInt(ds.perPage || ds.perpage || '10', 10);
    var dsQ = ds.q || '';

    var enabled = fval('enabled', dsEnabled);
    var scope = fval('scope', dsScope);
    var sort = fval('sort', dsSort);
    var page = _tb_toInt(fval('page', dsPage), dsPage);
    var perPage = _tb_toInt(fval('per_page', dsPerPage), dsPerPage);
    var q = qInput ? (qInput.value || '') : fval('q', dsQ);

    return {
        enabled: enabled || 'all',
        scope: scope || 'any',
        q: q || '',
        sort: sort || 'created_desc',
        page: page,
        per_page: perPage
    };
}

/* Build QS (with page/per_page) */
function _toolsBuildQS(f) {
    var parts = [];
    if (f.enabled && f.enabled !== 'all') parts.push('enabled=' + encodeURIComponent(f.enabled));
    if (f.scope && f.scope !== 'any') parts.push('scope=' + encodeURIComponent(f.scope));
    if (f.q) parts.push('q=' + encodeURIComponent(f.q));
    if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
    if (f.page > 0) parts.push('page=' + encodeURIComponent(f.page));
    if (f.per_page > 0) parts.push('per_page=' + encodeURIComponent(f.per_page));
    return parts.length ? ('?' + parts.join('&')) : '';
}

/* Inject filters + patch URL (hx-post) for DELETE */
function _toolsInjectFiltersAndPatchUrl(form) {
    var f = _toolsCurrentFilters();

    _tb_upsertHidden(form, 'enabled', f.enabled !== 'all' ? f.enabled : '');
    _tb_upsertHidden(form, 'scope', f.scope !== 'any' ? f.scope : '');
    _tb_upsertHidden(form, 'q', f.q || '');
    _tb_upsertHidden(form, 'sort', f.sort !== 'created_desc' ? f.sort : '');
    _tb_upsertHidden(form, 'page', f.page > 0 ? f.page : '');
    _tb_upsertHidden(form, 'per_page', f.per_page > 0 ? f.per_page : '');

    var attr = form.hasAttribute('hx-post') ? 'hx-post' : (form.hasAttribute('hx-delete') ? 'hx-delete' : null);
    if (!attr) { attr = 'hx-post'; form.setAttribute(attr, form.action || ''); }
    var base = form.getAttribute(attr) || form.action || '';

    var qs = '';
    if (typeof window.__toolsFilterQS === 'function') { try { qs = window.__toolsFilterQS() || ''; } catch (e) { } }
    if (!qs) { qs = _toolsBuildQS(f); }

    if (qs) {
        try {
            var u = new URL(base, window.location.origin); var p = u.searchParams;
            ['enabled', 'scope', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
            if (f.enabled !== 'all') p.set('enabled', f.enabled);
            if (f.scope !== 'any') p.set('scope', f.scope);
            if (f.q) p.set('q', f.q);
            if (f.sort !== 'created_desc') p.set('sort', f.sort);
            if (f.page > 0) p.set('page', String(f.page));
            if (f.per_page > 0) p.set('per_page', String(f.per_page));
            u.search = p.toString();
            form.setAttribute(attr, u.pathname + (u.search ? ('?' + u.search) : ''));
        } catch (e) {
            form.setAttribute(attr, _tb_mergeQsIntoUrl(base, qs));
        }
    }

    if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#tools-list-region');
    if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#tools-list-region');
    if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
}

/* Guard + toast count (DELETE) */
function ensureToolsBulkDeleteKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    try { form.removeAttribute('hx-vals'); } catch (e) { }

    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__toolsBulkJustDeleted = true;

        var cached = _tb_toInt(form.getAttribute('data-selected-count') || '0', 0);
        if (!cached) {
            var idsEl = form.querySelector('input[name="ids"]');
            var idsVal = idsEl ? String(idsEl.value || '').trim() : '';
            if (idsVal) {
                var arr = idsVal.split(','), i, c = 0;
                for (i = 0; i < arr.length; i++) { if (String(arr[i]).trim()) c++; }
                cached = c;
            }
        }
        window.__toolsBulkDeleteCount = cached;

        var btn = form.querySelector('#tools-bulk-delete-submit'); if (btn) btn.disabled = true;

        _toolsInjectFiltersAndPatchUrl(form);
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _toolsCurrentFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.enabled !== 'all') e.detail.parameters.enabled = f.enabled;
            if (f.scope !== 'any') e.detail.parameters.scope = f.scope;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;

            var qs = (typeof window.__toolsFilterQS === 'function') ? (window.__toolsFilterQS() || '') : '';
            if (qs) e.detail.path = _tb_mergeQsIntoUrl(e.detail.path || '', qs);
        } catch (err) { }
    });

    form.dataset.filterBound = '1';
}

/* Close binders (DELETE) */
function bindToolsBulkDeleteModalClose() {
    var ov = document.getElementById('tools-bulk-delete-modal-overlay');
    if (ov && !ov.dataset.bound) { ov.dataset.bound = '1'; ov.addEventListener('click', closeToolsBulkDeleteModal); }

    var wrap = document.getElementById('tools-bulk-delete-modal');
    if (wrap && !wrap.dataset.boundOutside) {
        wrap.dataset.boundOutside = '1';
        wrap.addEventListener('click', function (e) { var t = e && e.target ? e.target : null; if (t && t.id === 'tools-bulk-delete-modal') { closeToolsBulkDeleteModal(); } });
    }

    var x = document.getElementById('tools-bulk-delete-modal-close');
    if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', closeToolsBulkDeleteModal); }

    var c = document.getElementById('tools-bulk-delete-cancel');
    if (c && !c.dataset.bound) { c.dataset.bound = '1'; c.addEventListener('click', closeToolsBulkDeleteModal); }

    if (!document.body.dataset.boundEscToolsBulkDelete) {
        document.body.dataset.boundEscToolsBulkDelete = '1';
        document.addEventListener('keydown', function (e) {
            if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('tools-bulk-delete-modal')) { closeToolsBulkDeleteModal(); }
        });
    }
}

/* Submit binder (DELETE) */
function bindToolsBulkDeleteFormLogic() {
    var form = document.querySelector('#admin-tools-bulk-delete-form');
    if (!form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    ensureToolsBulkDeleteKeepsFilters(form);
}

/* Error (DELETE) */
function _reEnableToolsBulkDeleteOnError(elt) {
    var form = (elt && elt.id === 'admin-tools-bulk-delete-form') ? elt : document.querySelector('#admin-tools-bulk-delete-form');
    if (!form) return;
    form.dataset._submitting = '';
    var btn = form.querySelector('#tools-bulk-delete-submit'); if (btn) btn.disabled = false;
    window.__toolsBulkJustDeleted = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Xoá hàng loạt thất bại. Vui lòng thử lại!', 'error', 3000);
}

/* After swap (DELETE) */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}, tgt = d && d.target ? d.target : null;
    if (tgt && tgt.id === 'tools-list-region') {
        closeToolsBulkDeleteModal();
        if (window.__toolsBulkJustDeleted) {
            if (window.Toast && window.Toast.show) {
                var count = _tb_toInt(String(window.__toolsBulkDeleteCount || '0'), 0);
                window.Toast.show(count > 0 ? ('Đã xoá ' + count + ' tiện ích!') : 'Đã xoá các tiện ích đã chọn!', 'success', 2600);
            }
            window.__toolsBulkJustDeleted = false;
            window.__toolsBulkDeleteCount = 0;
        }
        var form = document.querySelector('#admin-tools-bulk-delete-form'); if (form) form.dataset._submitting = '';
    }
});

/* Error hooks (DELETE) */
document.body.addEventListener('htmx:responseError', function (e) { var d = e && e.detail ? e.detail : {}; _reEnableToolsBulkDeleteOnError(d.elt ? d.elt : null); });
document.body.addEventListener('htmx:swapError', function (e) { var d = e && e.detail ? e.detail : {}; _reEnableToolsBulkDeleteOnError(d.elt ? d.elt : null); });
document.body.addEventListener('htmx:sendError', function (e) { var d = e && e.detail ? e.detail : {}; _reEnableToolsBulkDeleteOnError(d.elt ? d.elt : null); });

/* Load binds (DELETE) */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}, tgt = d && d.target ? d.target : null, tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-tools-modal-root' || tid === 'tools-bulk-delete-modal') {
        bindToolsBulkDeleteModalClose();
        bindToolsBulkDeleteFormLogic();
    }
});
if (document.getElementById('tools-bulk-delete-modal')) { bindToolsBulkDeleteModalClose(); bindToolsBulkDeleteFormLogic(); }

/* ===================== NEW: BULK EXPORT ===================== */

/* Close export modal */
function closeToolsBulkExportModal() {
    var ov = document.getElementById('tools-bulk-export-modal-overlay'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var md = document.getElementById('tools-bulk-export-modal'); if (md && md.parentNode) md.parentNode.removeChild(md);
}

/* Optional opener (EXPORT) */
window.__openToolsBulkExportModal = function (ids) {
    var root = document.getElementById('admin-tools-modal-root'); if (!root) return;
    var url = '/admin/tools/bulk-export-modal';
    if (ids) url += '?ids=' + encodeURIComponent(ids);
    _tb_fetchText(url, function (html) {
        root.innerHTML = html || '';
        var fake = _tb_fakeXhr(200, html);
        _tb_dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
        _tb_dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
        _tb_dispatchHX('htmx:load', { elt: root });
        _tb_dispatchHX('htmx:afterSettle', { target: root, xhr: fake });
        try {
            var hid = document.getElementById('tools-bulk-export-ids');
            if (hid && ids) hid.value = ids;
            var btnSel = document.getElementById('tools-bulk-export-selected');
            if (btnSel) btnSel.disabled = !ids;
            var cnt = document.getElementById('tools-bulk-export-selected-count');
            if (cnt && typeof ids === 'string') { var c = ids ? ids.split(',').filter(function (s) { return !!String(s).trim(); }).length : 0; cnt.textContent = c; }
        } catch (_e) { }
    }, function (err) {
        if (window.Toast && window.Toast.show) window.Toast.show('Không mở được hộp thoại xuất CSV: ' + (err && err.message ? err.message : ''), 'error', 3000);
    });
};

/* Build QS for export from current filters */
function _toolsBuildQSFromFilters(f) {
    var parts = [];
    if (f.enabled && f.enabled !== 'all') parts.push('enabled=' + encodeURIComponent(f.enabled));
    if (f.scope && f.scope !== 'any') parts.push('scope=' + encodeURIComponent(f.scope));
    if (f.q) parts.push('q=' + encodeURIComponent(f.q));
    if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
    if (f.page > 0) parts.push('page=' + encodeURIComponent(f.page));
    if (f.per_page > 0) parts.push('per_page=' + encodeURIComponent(f.per_page));
    return parts.length ? ('?' + parts.join('&')) : '';
}

/* Mở URL export */
function _openToolsExportUrl(mode) {
    // mode: 'selected' | 'filter'
    var base = '/admin/tools/export-csv';
    var f = _toolsCurrentFilters();
    var qs = _toolsBuildQSFromFilters(f);

    if (mode === 'selected') {
        var idsInput = document.getElementById('tools-bulk-export-ids');
        var ids = (idsInput && idsInput.value) ? String(idsInput.value).trim() : '';
        if (!ids) {
            if (window.Toast && window.Toast.show) window.Toast.show('Chưa chọn tiện ích nào để xuất.', 'warning', 2500);
            return;
        }
        var more = 'ids=' + encodeURIComponent(ids) + '&mode=selected&format=csv';
        qs = _tb_mergeQsIntoUrl(qs || '', more);
    } else {
        var more2 = 'mode=filter&format=csv';
        qs = _tb_mergeQsIntoUrl(qs || '', more2);
    }

    var url = base + qs;
    try { window.open(url, '_blank'); } catch (e) { window.location.href = url; }
    closeToolsBulkExportModal();
}

/* Bind đóng modal: overlay, wrapper, nút X, ESC */
function bindToolsBulkExportModalClose() {
    var ov = document.getElementById('tools-bulk-export-modal-overlay');
    if (ov && !ov.dataset.bound) { ov.dataset.bound = '1'; ov.addEventListener('click', closeToolsBulkExportModal); }

    var wrap = document.getElementById('tools-bulk-export-modal');
    if (wrap && !wrap.dataset.boundOutside) {
        wrap.dataset.boundOutside = '1';
        wrap.addEventListener('click', function (e) {
            var t = e && e.target ? e.target : null;
            if (t && t.id === 'tools-bulk-export-modal') { closeToolsBulkExportModal(); }
        });
    }

    var x = document.getElementById('tools-bulk-export-modal-close');
    if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', closeToolsBulkExportModal); }

    if (!document.body.dataset.boundEscToolsBulkExport) {
        document.body.dataset.boundEscToolsBulkExport = '1';
        document.addEventListener('keydown', function (e) {
            if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('tools-bulk-export-modal')) {
                closeToolsBulkExportModal();
            }
        });
    }
}

/* Bind hành vi export */
function bindToolsBulkExportActions() {
    var btnSel = document.getElementById('tools-bulk-export-selected');
    if (btnSel && !btnSel.dataset.bound) {
        btnSel.dataset.bound = '1';
        btnSel.addEventListener('click', function () {
            if (btnSel.disabled) {
                if (window.Toast && window.Toast.show) window.Toast.show('Không có mục nào được chọn.', 'info', 2200);
                return;
            }
            _openToolsExportUrl('selected');
        });
    }

    var btnFilt = document.getElementById('tools-bulk-export-filter');
    if (btnFilt && !btnFilt.dataset.bound) {
        btnFilt.dataset.bound = '1';
        btnFilt.addEventListener('click', function () { _openToolsExportUrl('filter'); });
    }
}

/* Rebind khi modal được nạp */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}, tgt = d && d.target ? d.target : null, tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-tools-modal-root' || tid === 'tools-bulk-export-modal') {
        bindToolsBulkExportModalClose();
        bindToolsBulkExportActions();
    }
});

/* Nếu modal đã tồn tại từ đầu (không qua HTMX) */
if (document.getElementById('tools-bulk-export-modal')) {
    bindToolsBulkExportModalClose();
    bindToolsBulkExportActions();
}

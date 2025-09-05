/* file: src/modules/admin/static/js/admin_users_bulk.js
 * updated: 2025-08-24 (v1.1 – add bulk export: selected|filter; keep filters; open URL)
 * note:
 *   - Bulk delete nhiều User (hard delete) — HTMX swap #users-list-region.
 *   - Bulk export CSV (selected | filter) — mở URL trực tiếp, không dùng HTMX.
 *   - Giữ filter: status/role/verified/provider/q/sort/page/per_page. ES5-safe.
 */

/* ===================== Helpers ===================== */
function closeUsersBulkDeleteModal() {
    var ov = document.getElementById('users-bulk-delete-modal-overlay'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var md = document.getElementById('users-bulk-delete-modal'); if (md && md.parentNode) md.parentNode.removeChild(md);
}
function closeUsersBulkExportModal() {
    var ov = document.getElementById('users-bulk-export-modal-overlay'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var md = document.getElementById('users-bulk-export-modal'); if (md && md.parentNode) md.parentNode.removeChild(md);
}

function _ub_toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
function _ub_upsertHidden(form, name, value) {
    var el = form.querySelector('input[name="' + name + '"]');
    if (value == null || value === '') { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
    if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
    el.value = String(value);
}
function _ub_mergeQsIntoUrl(base, qs) {
    if (!qs) return base;
    var hasQ = (base || '').indexOf('?') >= 0;
    var payload = (qs.charAt(0) === '?') ? qs.substring(1) : qs;
    return base + (hasQ ? '&' : '?') + payload;
}

/* Lightweight fetch (for optional openers) */
function _ub_fetchText(url, ok, fail) {
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
function _ub_fakeXhr(status, body) { return { status: status || 200, responseText: body || '', response: body || '', getResponseHeader: function () { return null; } }; }
function _ub_ce(name, detail) { try { return new CustomEvent(name, { detail: detail }); } catch (e) { var ev = document.createEvent('CustomEvent'); ev.initCustomEvent(name, false, false, detail); return ev; } }
function _ub_dispatchHX(type, detail) {
    document.body.dispatchEvent(_ub_ce(type, detail));
    if (window.htmx && detail && detail.target) { try { window.htmx.process(detail.target); } catch (_e) { } }
}

/* ===================== Current filters (Users) ===================== */
function _usersCurrentFilters() {
    function fval(name, fallback) {
        var sf = document.getElementById('users-search-form');
        if (sf) {
            var el = sf.querySelector('input[name="' + name + '"]');
            if (el && el.value != null && String(el.value).trim() !== '') return String(el.value).trim();
        }
        return fallback;
    }

    var c = document.getElementById('admin-users-container') || { dataset: {} };
    var searchForm = document.getElementById('users-search-form') || null;
    var sortInput = searchForm ? searchForm.querySelector('input[name="sort"]') : null;
    var qInput = document.getElementById('users-search-input');

    var ds = c.dataset || {};
    var dsStatus = ds.status || 'all';
    var dsRole = ds.role || 'all';
    var dsVerified = ds.verified || 'all';
    var dsProvider = ds.provider || '';
    var dsSort = sortInput ? (sortInput.value || 'created_desc') : (ds.currentSort || 'created_desc');
    var dsPage = _ub_toInt(ds.page || '1', 1);
    var dsPerPage = _ub_toInt(ds.perPage || ds.perpage || '10', 10);
    var dsQ = ds.q || '';

    var status = fval('status', dsStatus);
    var role = fval('role', dsRole);
    var verified = fval('verified', dsVerified);
    var provider = fval('provider', dsProvider);
    var sort = fval('sort', dsSort);
    var page = _ub_toInt(fval('page', dsPage), dsPage);
    var perPage = _ub_toInt(fval('per_page', dsPerPage), dsPerPage);
    var q = qInput ? (qInput.value || '') : fval('q', dsQ);

    return {
        status: status || 'all',
        role: role || 'all',
        verified: verified || 'all',
        provider: (provider == null ? '' : provider),
        q: q || '',
        sort: sort || 'created_desc',
        page: page,
        per_page: perPage
    };
}
function _usersBuildQS(f) {
    var parts = [];
    if (f.status && f.status !== 'all') parts.push('status=' + encodeURIComponent(f.status));
    if (f.role && f.role !== 'all') parts.push('role=' + encodeURIComponent(f.role));
    if (f.verified && f.verified !== 'all') parts.push('verified=' + encodeURIComponent(f.verified));
    if (f.provider) parts.push('provider=' + encodeURIComponent(f.provider));
    if (f.q) parts.push('q=' + encodeURIComponent(f.q));
    if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
    if (f.page > 0) parts.push('page=' + encodeURIComponent(f.page));
    if (f.per_page > 0) parts.push('per_page=' + encodeURIComponent(f.per_page));
    return parts.length ? ('?' + parts.join('&')) : '';
}
function _usersBuildQSFromFilters(f) { return _usersBuildQS(f); }

/* ===================== BULK DELETE ===================== */
window.__openUsersBulkDeleteModal = function (ids) {
    var root = document.getElementById('admin-users-modal-root'); if (!root) return;
    var url = '/admin/users/bulk-delete-modal';
    if (ids) url += '?ids=' + encodeURIComponent(ids);
    _ub_fetchText(url, function (html) {
        root.innerHTML = html || '';
        var fake = _ub_fakeXhr(200, html);
        _ub_dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
        _ub_dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
        _ub_dispatchHX('htmx:load', { elt: root });
        _ub_dispatchHX('htmx:afterSettle', { target: root, xhr: fake });
        try { var hid = document.getElementById('users-bulk-delete-ids'); if (hid && ids) hid.value = ids; } catch (_e) { }
    }, function (err) {
        if (window.Toast && window.Toast.show) window.Toast.show('Không mở được hộp thoại xoá hàng loạt: ' + (err && err.message ? err.message : ''), 'error', 3000);
    });
};

function _usersInjectFiltersAndPatchUrl(form) {
    var f = _usersCurrentFilters();

    _ub_upsertHidden(form, 'status', f.status !== 'all' ? f.status : '');
    _ub_upsertHidden(form, 'role', f.role !== 'all' ? f.role : '');
    _ub_upsertHidden(form, 'verified', f.verified !== 'all' ? f.verified : '');
    _ub_upsertHidden(form, 'provider', f.provider || '');
    _ub_upsertHidden(form, 'q', f.q || '');
    _ub_upsertHidden(form, 'sort', f.sort !== 'created_desc' ? f.sort : '');
    _ub_upsertHidden(form, 'page', f.page > 0 ? f.page : '');
    _ub_upsertHidden(form, 'per_page', f.per_page > 0 ? f.per_page : '');

    var attr = form.hasAttribute('hx-post') ? 'hx-post' : (form.hasAttribute('hx-delete') ? 'hx-delete' : null);
    if (!attr) { attr = 'hx-post'; form.setAttribute(attr, form.action || ''); }
    var base = form.getAttribute(attr) || form.action || '';

    var qs = '';
    if (typeof window.__usersFilterQS === 'function') { try { qs = window.__usersFilterQS() || ''; } catch (e) { } }
    if (!qs) { qs = _usersBuildQS(f); }

    if (qs) {
        try {
            var u = new URL(base, window.location.origin), p = u.searchParams;
            ['status', 'role', 'verified', 'provider', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
            if (f.status !== 'all') p.set('status', f.status);
            if (f.role !== 'all') p.set('role', f.role);
            if (f.verified !== 'all') p.set('verified', f.verified);
            if (f.provider) p.set('provider', f.provider);
            if (f.q) p.set('q', f.q);
            if (f.sort !== 'created_desc') p.set('sort', f.sort);
            if (f.page > 0) p.set('page', String(f.page));
            if (f.per_page > 0) p.set('per_page', String(f.per_page));
            u.search = p.toString();
            form.setAttribute(attr, u.pathname + (u.search ? ('?' + u.search) : ''));
        } catch (e) {
            form.setAttribute(attr, _ub_mergeQsIntoUrl(base, qs));
        }
    }

    if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#users-list-region');
    if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#users-list-region');
    if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
}

function ensureUsersBulkDeleteKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    try { form.removeAttribute('hx-vals'); } catch (_) { }

    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__usersBulkJustDeleted = true;

        var cached = _ub_toInt(form.getAttribute('data-selected-count') || '0', 0);
        if (!cached) {
            var idsEl = form.querySelector('input[name="ids"]');
            var idsVal = idsEl ? String(idsEl.value || '').trim() : '';
            if (idsVal) {
                var arr = idsVal.split(','), i, c = 0;
                for (i = 0; i < arr.length; i++) { if (String(arr[i]).trim()) c++; }
                cached = c;
            }
        }
        window.__usersBulkDeleteCount = cached;

        var btn = form.querySelector('#users-bulk-delete-submit'); if (btn) btn.disabled = true;

        _usersInjectFiltersAndPatchUrl(form);
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _usersCurrentFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.status !== 'all') e.detail.parameters.status = f.status;
            if (f.role !== 'all') e.detail.parameters.role = f.role;
            if (f.verified !== 'all') e.detail.parameters.verified = f.verified;
            if (f.provider) e.detail.parameters.provider = f.provider;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;

            var qs = (typeof window.__usersFilterQS === 'function') ? (window.__usersFilterQS() || '') : '';
            if (qs) e.detail.path = _ub_mergeQsIntoUrl(e.detail.path || '', qs);
        } catch (err) { }
    });

    form.dataset.filterBound = '1';
}

/* Bindings for DELETE modal */
function bindUsersBulkDeleteModalClose() {
    var ov = document.getElementById('users-bulk-delete-modal-overlay');
    if (ov && !ov.dataset.bound) { ov.dataset.bound = '1'; ov.addEventListener('click', closeUsersBulkDeleteModal); }

    var wrap = document.getElementById('users-bulk-delete-modal');
    if (wrap && !wrap.dataset.boundOutside) {
        wrap.dataset.boundOutside = '1';
        wrap.addEventListener('click', function (e) { var t = e && e.target ? e.target : null; if (t && t.id === 'users-bulk-delete-modal') { closeUsersBulkDeleteModal(); } });
    }

    var x = document.getElementById('users-bulk-delete-modal-close');
    if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', closeUsersBulkDeleteModal); }

    var c = document.getElementById('users-bulk-delete-cancel');
    if (c && !c.dataset.bound) { c.dataset.bound = '1'; c.addEventListener('click', closeUsersBulkDeleteModal); }

    if (!document.body.dataset.boundEscUsersBulkDelete) {
        document.body.dataset.boundEscUsersBulkDelete = '1';
        document.addEventListener('keydown', function (e) {
            if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('users-bulk-delete-modal')) { closeUsersBulkDeleteModal(); }
        });
    }
}
function bindUsersBulkDeleteFormLogic() {
    var form = document.querySelector('#admin-users-bulk-delete-form');
    if (!form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    ensureUsersBulkDeleteKeepsFilters(form);
}

/* After swap: đóng modal + toast – DELETE */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var t = evt && evt.detail ? evt.detail.target : null; if (!t) return;
    if (t.id === 'users-list-region' || t.id === 'admin-users-container') {
        closeUsersBulkDeleteModal();
        if (window.__usersBulkJustDeleted) {
            if (window.Toast && window.Toast.show) {
                var count = _ub_toInt(String(window.__usersBulkDeleteCount || '0'), 0);
                window.Toast.show(count > 0 ? ('Đã xoá ' + count + ' người dùng!') : 'Đã xoá các người dùng đã chọn!', 'success', 2600);
            }
            window.__usersBulkJustDeleted = false;
            window.__usersBulkDeleteCount = 0;
        }
        var form = document.querySelector('#admin-users-bulk-delete-form'); if (form) form.dataset._submitting = '';
        var btn = document.getElementById('users-bulk-delete-submit'); if (btn) btn.disabled = false;
    }
});

/* Error recovery – DELETE */
function _reEnableUsersBulkDeleteOnError(elt) {
    var form = (elt && elt.id === 'admin-users-bulk-delete-form') ? elt : document.querySelector('#admin-users-bulk-delete-form');
    if (!form) return;
    form.dataset._submitting = '';
    var btn = form.querySelector('#users-bulk-delete-submit'); if (btn) btn.disabled = false;
    window.__usersBulkJustDeleted = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Xoá hàng loạt thất bại. Vui lòng thử lại!', 'error', 3000);
}
document.body.addEventListener('htmx:responseError', function (e) { var d = e && e.detail ? e.detail : {}; _reEnableUsersBulkDeleteOnError(d.elt ? d.elt : null); });
document.body.addEventListener('htmx:swapError', function (e) { var d = e && e.detail ? e.detail : {}; _reEnableUsersBulkDeleteOnError(d.elt ? d.elt : null); });
document.body.addEventListener('htmx:sendError', function (e) { var d = e && e.detail ? e.detail : {}; _reEnableUsersBulkDeleteOnError(d.elt ? d.elt : null); });

/* ===================== BULK EXPORT ===================== */
/* Optional opener (EXPORT) */
window.__openUsersBulkExportModal = function (ids) {
    var root = document.getElementById('admin-users-modal-root'); if (!root) return;
    var url = '/admin/users/bulk-export-modal';
    if (ids) url += '?ids=' + encodeURIComponent(ids);
    _ub_fetchText(url, function (html) {
        root.innerHTML = html || '';
        var fake = _ub_fakeXhr(200, html);
        _ub_dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
        _ub_dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
        _ub_dispatchHX('htmx:load', { elt: root });
        _ub_dispatchHX('htmx:afterSettle', { target: root, xhr: fake });
        try {
            var hid = document.getElementById('users-bulk-export-ids'); if (hid && ids) hid.value = ids;
            var btnSel = document.getElementById('users-bulk-export-selected'); if (btnSel) btnSel.disabled = !ids;
            var cnt = document.getElementById('users-bulk-export-selected-count');
            if (cnt && typeof ids === 'string') { var c = ids ? ids.split(',').filter(function (s) { return !!String(s).trim(); }).length : 0; cnt.textContent = c; }
        } catch (_e) { }
    }, function (err) {
        if (window.Toast && window.Toast.show) window.Toast.show('Không mở được hộp thoại xuất CSV: ' + (err && err.message ? err.message : ''), 'error', 3000);
    });
};

/* Build + open export URL */
function _openUsersExportUrl(mode) {
    // mode: 'selected' | 'filter'
    var base = '/admin/users/export-csv';
    var f = _usersCurrentFilters();
    var qs = _usersBuildQSFromFilters(f);

    if (mode === 'selected') {
        var idsInput = document.getElementById('users-bulk-export-ids');
        var ids = (idsInput && idsInput.value) ? String(idsInput.value).trim() : '';
        if (!ids) {
            if (window.Toast && window.Toast.show) window.Toast.show('Chưa chọn người dùng nào để xuất.', 'warning', 2500);
            return;
        }
        var more = 'ids=' + encodeURIComponent(ids) + '&mode=selected&format=csv';
        qs = _ub_mergeQsIntoUrl(qs || '', more);
    } else {
        var more2 = 'mode=filter&format=csv';
        qs = _ub_mergeQsIntoUrl(qs || '', more2);
    }

    var url = base + qs;
    try { window.open(url, '_blank'); } catch (e) { window.location.href = url; }
    closeUsersBulkExportModal();
}

/* Bind đóng modal: overlay, wrapper, nút X, ESC */
function bindUsersBulkExportModalClose() {
    var ov = document.getElementById('users-bulk-export-modal-overlay');
    if (ov && !ov.dataset.bound) { ov.dataset.bound = '1'; ov.addEventListener('click', closeUsersBulkExportModal); }

    var wrap = document.getElementById('users-bulk-export-modal');
    if (wrap && !wrap.dataset.boundOutside) {
        wrap.dataset.boundOutside = '1';
        wrap.addEventListener('click', function (e) {
            var t = e && e.target ? e.target : null;
            if (t && t.id === 'users-bulk-export-modal') { closeUsersBulkExportModal(); }
        });
    }

    var x = document.getElementById('users-bulk-export-modal-close');
    if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', closeUsersBulkExportModal); }

    if (!document.body.dataset.boundEscUsersBulkExport) {
        document.body.dataset.boundEscUsersBulkExport = '1';
        document.addEventListener('keydown', function (e) {
            if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('users-bulk-export-modal')) {
                closeUsersBulkExportModal();
            }
        });
    }
}

/* Bind hành vi export */
function bindUsersBulkExportActions() {
    var btnSel = document.getElementById('users-bulk-export-selected');
    if (btnSel && !btnSel.dataset.bound) {
        btnSel.dataset.bound = '1';
        btnSel.addEventListener('click', function () {
            if (btnSel.disabled) {
                if (window.Toast && window.Toast.show) window.Toast.show('Không có mục nào được chọn.', 'info', 2200);
                return;
            }
            _openUsersExportUrl('selected');
        });
    }

    var btnFilt = document.getElementById('users-bulk-export-filter');
    if (btnFilt && !btnFilt.dataset.bound) {
        btnFilt.dataset.bound = '1';
        btnFilt.addEventListener('click', function () { _openUsersExportUrl('filter'); });
    }
}

/* ===================== Global binds ===================== */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}; var tgt = d && d.target ? d.target : null; var tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-users-modal-root' || tid === 'users-bulk-delete-modal') {
        bindUsersBulkDeleteModalClose();
        bindUsersBulkDeleteFormLogic();
    }
    if (tid === 'admin-users-modal-root' || tid === 'users-bulk-export-modal') {
        bindUsersBulkExportModalClose();
        bindUsersBulkExportActions();
    }
});

/* Nếu modal đã tồn tại sẵn (không qua HTMX) */
if (document.getElementById('users-bulk-delete-modal')) {
    bindUsersBulkDeleteModalClose();
    bindUsersBulkDeleteFormLogic();
}
if (document.getElementById('users-bulk-export-modal')) {
    bindUsersBulkExportModalClose();
    bindUsersBulkExportActions();
}

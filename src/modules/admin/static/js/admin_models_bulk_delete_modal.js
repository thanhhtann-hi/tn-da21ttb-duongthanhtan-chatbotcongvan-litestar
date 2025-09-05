/********************************************************************
 * File  : src/modules/admin/static/js/admin_models_bulk_delete_modal.js
 * Updated: 2025-08-23 (v1.2 – + opener helper, cache count, ES5-safe)
 * Note  : Bulk retire nhiều ModelVariant.
 *         - Chỉ swap #models-list-region.
 *         - Trước gửi: bơm filter (status/scope/tier/enabled/provider/type/q/sort/page/per_page)
 *           vào BODY + backup qua htmx:configRequest + QS-fallback vào hx-post.
 *         - Chặn double-submit, Toast 1 lần, ES5-safe.
 ********************************************************************/

/* Close modal */
function closeModelsBulkDeleteModal() {
    var ov = document.getElementById('models-bulk-delete-modal-overlay'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var md = document.getElementById('models-bulk-delete-modal'); if (md && md.parentNode) md.parentNode.removeChild(md);
}

/* Lightweight helpers */
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

/* Fetch & HTMX-like dispatch (ES5) */
function _fetchText(url, cbOk, cbErr) {
    try {
        var xhr = new XMLHttpRequest(); xhr.open('GET', url, true);
        xhr.setRequestHeader('HX-Request', 'true');
        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) { if (cbOk) cbOk(xhr.responseText || ''); }
                else { if (cbErr) cbErr(new Error('HTTP ' + xhr.status)); }
            }
        };
        xhr.send();
    } catch (e) { if (cbErr) cbErr(e); }
}
function _makeFakeXhr(status, body) { return { status: status || 200, responseText: body || '', response: body || '', getResponseHeader: function () { return null; } }; }
function _createCE(name, detail) {
    try { return new CustomEvent(name, { detail: detail }); }
    catch (e) { var evt = document.createEvent('CustomEvent'); evt.initCustomEvent(name, false, false, detail); return evt; }
}
function _dispatchHX(type, detail) {
    document.body.dispatchEvent(_createCE(type, detail));
    if (window.htmx && detail && detail.target) { try { window.htmx.process(detail.target); } catch (_e) { } }
}

/* Optional opener used by admin_models.js (fallback cũng OK) */
window.__openBulkDeleteModal = function (ids) {
    var root = document.getElementById('admin-models-modal-root'); if (!root) return;
    var url = '/admin/models/bulk-delete-modal';
    if (ids) url += '?ids=' + encodeURIComponent(ids);
    _fetchText(url, function (html) {
        root.innerHTML = html || '';
        var fake = _makeFakeXhr(200, html);
        _dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
        _dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
        _dispatchHX('htmx:load', { elt: root });
        _dispatchHX('htmx:afterSettle', { target: root, xhr: fake });
        // nếu modal có input ids, set lại để chắc ăn
        try {
            var hid = document.getElementById('models-bulk-delete-ids');
            if (hid && ids) hid.value = ids;
        } catch (_e) { }
    }, function (err) {
        if (window.Toast && window.Toast.show) window.Toast.show('Không mở được hộp thoại ngừng dùng: ' + (err && err.message ? err.message : ''), 'error', 3000);
    });
};

/* Lấy filter hiện tại – ưu tiên helper, fallback DOM */
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
    return {
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
}

/* Build QS (kèm page/per_page) */
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

/* Inject filters + vá URL (hx-post) */
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

    var attr = form.hasAttribute('hx-post') ? 'hx-post' : (form.hasAttribute('hx-delete') ? 'hx-delete' : null);
    if (!attr) { attr = 'hx-post'; form.setAttribute(attr, form.action || ''); }
    var base = form.getAttribute(attr) || form.action || '';

    var qs = '';
    if (typeof window.__modelsFilterQS === 'function') { try { qs = window.__modelsFilterQS() || ''; } catch (e) { } }
    if (!qs) { qs = _buildQS(f); }

    if (qs) {
        try {
            var u = new URL(base, window.location.origin);
            var p = u.searchParams;
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

/* Đảm bảo giữ filter + chặn double-submit; cache số lượng để toast */
function ensureModelsBulkDeleteKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    try { form.removeAttribute('hx-vals'); } catch (e) { }

    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        window.__modelsBulkJustRetired = true;

        // cache count để toast sau swap
        var cached = _toInt(form.getAttribute('data-selected-count') || '0', 0);
        if (!cached) {
            var idsEl = form.querySelector('input[name="ids"]');
            var idsVal = idsEl ? String(idsEl.value || '').trim() : '';
            if (idsVal) {
                var arr = idsVal.split(','); var i, c = 0;
                for (i = 0; i < arr.length; i++) { if (String(arr[i]).trim()) c++; }
                cached = c;
            }
        }
        window.__modelsBulkRetireCount = cached;

        var btn = form.querySelector('#models-bulk-delete-submit');
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
function bindModelsBulkDeleteModalClose() {
    var ov = document.getElementById('models-bulk-delete-modal-overlay');
    if (ov && !ov.dataset.bound) { ov.dataset.bound = '1'; ov.addEventListener('click', closeModelsBulkDeleteModal); }

    var wrap = document.getElementById('models-bulk-delete-modal');
    if (wrap && !wrap.dataset.boundOutside) {
        wrap.dataset.boundOutside = '1';
        wrap.addEventListener('click', function (e) {
            var t = e && e.target ? e.target : null;
            if (t && t.id === 'models-bulk-delete-modal') { closeModelsBulkDeleteModal(); }
        });
    }

    var x = document.getElementById('models-bulk-delete-modal-close');
    if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', closeModelsBulkDeleteModal); }

    var c = document.getElementById('models-bulk-delete-cancel');
    if (c && !c.dataset.bound) { c.dataset.bound = '1'; c.addEventListener('click', closeModelsBulkDeleteModal); }

    if (!document.body.dataset.boundEscModelsBulkDelete) {
        document.body.dataset.boundEscModelsBulkDelete = '1';
        document.addEventListener('keydown', function (e) {
            if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('models-bulk-delete-modal')) {
                closeModelsBulkDeleteModal();
            }
        });
    }
}

/* Bind form submit */
function bindModelsBulkDeleteFormLogic() {
    var form = document.querySelector('#admin-models-bulk-delete-form');
    if (!form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    ensureModelsBulkDeleteKeepsFilters(form);
}

/* Lỗi → bật lại nút, reset cờ, báo lỗi */
function _reEnableModelsBulkDeleteOnError(elt) {
    var form = (elt && elt.id === 'admin-models-bulk-delete-form') ? elt : document.querySelector('#admin-models-bulk-delete-form');
    if (!form) return;
    form.dataset._submitting = '';
    var btn = form.querySelector('#models-bulk-delete-submit'); if (btn) btn.disabled = false;
    window.__modelsBulkJustRetired = false;
    if (window.Toast && window.Toast.show) window.Toast.show('Ngừng dùng hàng loạt thất bại. Vui lòng thử lại!', 'error', 3000);
}

/* Swap thành công → đóng modal + toast */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}, tgt = d && d.target ? d.target : null;
    if (tgt && tgt.id === 'models-list-region') {
        closeModelsBulkDeleteModal();
        if (window.__modelsBulkJustRetired) {
            if (window.Toast && window.Toast.show) {
                var count = _toInt(String(window.__modelsBulkRetireCount || '0'), 0);
                window.Toast.show(count > 0 ? ('Đã ngừng dùng ' + count + ' mô hình!') : 'Đã ngừng dùng các mô hình đã chọn!', 'success', 2600);
            }
            window.__modelsBulkJustRetired = false;
            window.__modelsBulkRetireCount = 0;
        }
        var form = document.querySelector('#admin-models-bulk-delete-form'); if (form) form.dataset._submitting = '';
    }
});

/* Lỗi XHR/swap/send */
document.body.addEventListener('htmx:responseError', function (e) {
    var d = e && e.detail ? e.detail : {};
    _reEnableModelsBulkDeleteOnError(d.elt ? d.elt : null);
});
document.body.addEventListener('htmx:swapError', function (e) {
    var d = e && e.detail ? e.detail : {};
    _reEnableModelsBulkDeleteOnError(d.elt ? d.elt : null);
});
document.body.addEventListener('htmx:sendError', function (e) {
    var d = e && e.detail ? e.detail : {};
    _reEnableModelsBulkDeleteOnError(d.elt ? d.elt : null);
});

/* Khi modal được nạp */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}, tgt = d && d.target ? d.target : null, tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-models-modal-root' || tid === 'models-bulk-delete-modal') {
        bindModelsBulkDeleteModalClose();
        bindModelsBulkDeleteFormLogic();
    }
});

/* Nếu modal đã có sẵn */
if (document.getElementById('models-bulk-delete-modal')) {
    bindModelsBulkDeleteModalClose();
    bindModelsBulkDeleteFormLogic();
}

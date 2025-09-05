/********************************************************************
 * File  : src/modules/admin/static/js/admin_models_bulk_export_modal.js
 * Updated: 2025-08-23 (v1.1 – + opener helper, align route /export-csv)
 * Note  : Export CSV cho ModelVariant (selected / filter).
 *         - Không dùng HTMX để tải file; mở URL kèm filter hiện tại.
 *         - Giữ đủ filter: status/scope/tier/enabled/provider/type/q/sort/page/per_page.
 *         - Đóng modal khi đã kích hoạt xuất.
 ********************************************************************/

/* Close modal */
function closeModelsBulkExportModal() {
    var ov = document.getElementById('models-bulk-export-modal-overlay'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    var md = document.getElementById('models-bulk-export-modal'); if (md && md.parentNode) md.parentNode.removeChild(md);
}

/* Lightweight helpers */
function _toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
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
/* Build QS string (gồm cả page/per_page) */
function _buildQSFromFilters(f) {
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

/* Optional opener used by admin_models.js (mở modal chọn chế độ export) */
(function () {
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

    window.__openBulkExportModal = function (ids) {
        var root = document.getElementById('admin-models-modal-root'); if (!root) return;
        var url = '/admin/models/bulk-export-modal';
        if (ids) url += '?ids=' + encodeURIComponent(ids);
        _fetchText(url, function (html) {
            root.innerHTML = html || '';
            var fake = _makeFakeXhr(200, html);
            _dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
            _dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
            _dispatchHX('htmx:load', { elt: root });
            _dispatchHX('htmx:afterSettle', { target: root, xhr: fake });
            // set hidden ids nếu có
            try {
                var hid = document.getElementById('models-bulk-export-ids');
                if (hid && ids) hid.value = ids;
                // nếu có nút "Selected", enable/disable theo ids
                var btnSel = document.getElementById('models-bulk-export-selected');
                if (btnSel) btnSel.disabled = !ids;
            } catch (_e) { }
        }, function (err) {
            if (window.Toast && window.Toast.show) window.Toast.show('Không mở được hộp thoại xuất CSV: ' + (err && err.message ? err.message : ''), 'error', 3000);
        });
    };
})();

/* Mở URL export */
function _openModelsExportUrl(mode) {
    // mode: 'selected' | 'filter'
    var base = '/admin/models/export-csv';      // thống nhất với toolbar/bulk bar
    var f = _currentModelsFilters();
    var qs = _buildQSFromFilters(f);

    if (mode === 'selected') {
        var idsInput = document.getElementById('models-bulk-export-ids');
        var ids = (idsInput && idsInput.value) ? String(idsInput.value).trim() : '';
        if (!ids) {
            if (window.Toast && window.Toast.show) window.Toast.show('Chưa chọn mô hình nào để xuất.', 'warning', 2500);
            return;
        }
        var more = 'ids=' + encodeURIComponent(ids) + '&mode=selected&format=csv';
        qs = _mergeQsIntoUrl(qs || '', more);
    } else {
        var more2 = 'mode=filter&format=csv';
        qs = _mergeQsIntoUrl(qs || '', more2);
    }

    var url = base + qs;
    try { window.open(url, '_blank'); } catch (e) { window.location.href = url; }
    closeModelsBulkExportModal();
}

/* Bind đóng modal: overlay, wrapper, nút X, ESC */
function bindModelsBulkExportModalClose() {
    var ov = document.getElementById('models-bulk-export-modal-overlay');
    if (ov && !ov.dataset.bound) { ov.dataset.bound = '1'; ov.addEventListener('click', closeModelsBulkExportModal); }

    var wrap = document.getElementById('models-bulk-export-modal');
    if (wrap && !wrap.dataset.boundOutside) {
        wrap.dataset.boundOutside = '1';
        wrap.addEventListener('click', function (e) {
            var t = e && e.target ? e.target : null;
            if (t && t.id === 'models-bulk-export-modal') { closeModelsBulkExportModal(); }
        });
    }

    var x = document.getElementById('models-bulk-export-modal-close');
    if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', closeModelsBulkExportModal); }

    if (!document.body.dataset.boundEscModelsBulkExport) {
        document.body.dataset.boundEscModelsBulkExport = '1';
        document.addEventListener('keydown', function (e) {
            if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('models-bulk-export-modal')) {
                closeModelsBulkExportModal();
            }
        });
    }
}

/* Bind hành vi export */
function bindModelsBulkExportActions() {
    var btnSel = document.getElementById('models-bulk-export-selected');
    if (btnSel && !btnSel.dataset.bound) {
        btnSel.dataset.bound = '1';
        btnSel.addEventListener('click', function () {
            if (btnSel.disabled) { if (window.Toast && window.Toast.show) window.Toast.show('Không có mục nào được chọn.', 'info', 2200); return; }
            _openModelsExportUrl('selected');
        });
    }
    var btnFilt = document.getElementById('models-bulk-export-filter');
    if (btnFilt && !btnFilt.dataset.bound) {
        btnFilt.dataset.bound = '1';
        btnFilt.addEventListener('click', function () { _openModelsExportUrl('filter'); });
    }
}

/* Rebind khi modal được nạp */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}, tgt = d && d.target ? d.target : null, tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-models-modal-root' || tid === 'models-bulk-export-modal') {
        bindModelsBulkExportModalClose();
        bindModelsBulkExportActions();
    }
});

/* Nếu modal đã tồn tại từ đầu (không qua HTMX) */
if (document.getElementById('models-bulk-export-modal')) {
    bindModelsBulkExportModalClose();
    bindModelsBulkExportActions();
}

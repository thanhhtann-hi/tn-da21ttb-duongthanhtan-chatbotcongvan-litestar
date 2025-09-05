/********************************************************************
 * File   : src/modules/admin/static/js/admin_departments.js
 * Updated: 2025-08-25 (v1.4 – clean URL + stay-on-page + row highlight)
 * Scope  : Trang “Quản lý phòng ban”
 * Changes:
 *  [3]  Auto per-page theo viewport (thead/row + chiều cao pager) + map page.
 *  [3.a] NO-DATA SAFE: nếu rỗng, giữ per_page hiện tại (min=5).
 *  [4]  loadList(opts): pushUrl=false khi auto-per-page (boot/resize).
 *  [6.b] Sort dropdown 2 cột (new|old|az|za|alias_az|alias_za|email_az|email_za).
 *  [9]  Header checkbox: indeterminate, ARIA, đồng bộ bulk bar.
 *  [11] Filler rows: luôn bù đúng per_page ở MỌI trang (tbody #departments-filler).
 *  [11A] Page-jump: clamp + đồng bộ hidden page, không reset sau swap.
 *  [12/13] HTMX enrichment + sanitize hx-get: gỡ per_page khỏi URL.
 *  [HL] NEW: Highlight + scroll vào dòng vừa create/update; giữ nguyên trang.
 ********************************************************************/
(function () {
    /* ───────────────────────── [1] Helpers ───────────────────────── */
    function intv(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
    function $(sel, root) { return (root || document).querySelector(sel); }
    function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    function fetchText(url) {
        return new Promise(function (res, rej) {
            try {
                var x = new XMLHttpRequest();
                x.open('GET', url, true);
                x.setRequestHeader('HX-Request', 'true');
                x.onreadystatechange = function () {
                    if (x.readyState === 4) {
                        if (x.status >= 200 && x.status < 300) res(x.responseText || '');
                        else rej(new Error('HTTP ' + x.status));
                    }
                };
                x.send();
            } catch (e) { rej(e); }
        });
    }
    function makeFakeXhr(status, body) {
        return { status: status || 200, responseText: body || '', response: body || '', getResponseHeader: function () { return null; } };
    }
    function createCE(name, detail) { try { return new CustomEvent(name, { detail: detail }); } catch (e) { var evt = document.createEvent('CustomEvent'); evt.initCustomEvent(name, false, false, detail); return evt; } }
    function dispatchHX(type, detail) {
        document.body.dispatchEvent(createCE(type, detail));
        if (window.htmx && detail && detail.target) { try { window.htmx.process(detail.target); } catch (_) { } }
    }
    function swapOuterHTML(url, targetSel) {
        var targetEl = $(targetSel); if (!targetEl) return Promise.resolve();
        return fetchText(url).then(function (html) {
            var box = document.createElement('div'); box.innerHTML = (html || '').trim();
            var next = box.querySelector(targetSel);
            if (!next) { console.error('swapOuterHTML: Không tìm thấy', targetSel); return; }
            var fake = makeFakeXhr(200, html);
            targetEl.parentNode.replaceChild(next, targetEl);
            dispatchHX('htmx:afterSwap', { target: next, xhr: fake });
            dispatchHX('htmx:afterOnLoad', { target: next, xhr: fake });
            dispatchHX('htmx:load', { elt: next });
            dispatchHX('htmx:afterSettle', { target: next, xhr: fake });
        })["catch"](function (err) { console.error(err); });
    }

    /* ───────────────────────── [2] DOM/Filter state ───────────────────────── */
    function getContainer() { return $('#admin-departments-container'); }
    function upsertHiddenInSearchForm(name, val) {
        var form = $('#departments-search-form'); if (!form) return;
        var el = form.querySelector('input[name="' + name + '"]');
        if (val == null || val === '') { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
        if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
        el.value = String(val);
    }
    function formVal(name, fallback) {
        var sf = $('#departments-search-form'); if (!sf) return fallback;
        var el = sf.querySelector('input[name="' + name + '"]');
        var v = el ? (el.value != null ? String(el.value).trim() : '') : '';
        if (v === '') return fallback; return v;
    }

    // UI sort ↔ canonical
    function uiSortToCanonical(v) {
        switch (String(v || '').toLowerCase()) {
            case 'old': return 'created_asc';
            case 'az': return 'name_az';
            case 'za': return 'name_za';
            case 'alias_az': return 'alias_az';
            case 'alias_za': return 'alias_za';
            case 'email_az': return 'email_az';
            case 'email_za': return 'email_za';
            case 'new':
            default: return 'created_desc';
        }
    }
    function canonicalToUi(canon) {
        switch (String(canon || '').toLowerCase()) {
            case 'created_asc': return 'old';
            case 'name_az': return 'az';
            case 'name_za': return 'za';
            case 'alias_az': return 'alias_az';
            case 'alias_za': return 'alias_za';
            case 'email_az': return 'email_az';
            case 'email_za': return 'email_za';
            case 'created_desc':
            default: return 'new';
        }
    }

    function currentFilters() {
        var c = getContainer() || { dataset: {} };
        var ds = c.dataset || {};
        var qInp = $('#departments-search-input');

        var sf = $('#departments-search-form'); var sortInput = sf ? sf.querySelector('input[name="sort"]') : null;
        var dsSortUI = sortInput ? (sortInput.value || 'created_desc') : (ds.currentSort || 'new');
        var sortRaw = formVal('sort', dsSortUI);
        var sortCanon = (String(sortRaw).indexOf('_') > -1 || String(sortRaw).startsWith('created'))
            ? sortRaw : uiSortToCanonical(sortRaw);

        var q = qInp ? (qInp.value || '') : (formVal('q', ds.q || ''));
        var page = intv(formVal('page', ds.page || '1'), intv(ds.page || '1', 1));
        var perPage = intv(formVal('per_page', ds.perPage || ds.perpage || '10'), intv(ds.perPage || ds.perpage || '10', 10));

        return { q: q || '', sort: sortCanon || 'created_desc', page: page, per_page: perPage };
    }

    function buildQS(f) {
        var parts = [];
        if (f.q) parts.push('q=' + encodeURIComponent(f.q));
        if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
        if (f.page > 1) parts.push('page=' + encodeURIComponent(f.page));
        if (f.per_page && f.per_page !== 10) parts.push('per_page=' + encodeURIComponent(f.per_page));
        return parts.length ? ('?' + parts.join('&')) : '';
    }

    // Expose (CSV/fallback/bulk)
    window.__departmentsFilterVals = function () {
        var f = currentFilters();
        return { q: f.q, sort: f.sort, page: f.page, per_page: f.per_page };
    };
    window.__departmentsFilterQS = function () { return buildQS(currentFilters()); };

    /* ───────────────────────── [3] Auto per-page theo viewport ───────────────────────── */
    var MIN_ROWS = 5, ROW_FALLBACK = 54, THEAD_FALLBACK = 45;
    var _perPageApplied = null;

    function measureBottomReserve() {
        var reserve = 0;
        var bar = $('#departments-pagination');
        if (bar) {
            var cs = window.getComputedStyle(bar);
            reserve += (bar.offsetHeight || 0)
                + (parseInt(cs.marginTop || '0', 10) || 0)
                + (parseInt(cs.marginBottom || '0', 10) || 0);
        }
        var wrap = $('#admin-departments-table');
        if (wrap) {
            var cs2 = window.getComputedStyle(wrap);
            reserve += (parseInt(cs2.paddingBottom || '0', 10) || 0);
        }
        return Math.max(90, reserve + 12);
    }
    function sampleHeights() {
        var table = $('#admin-departments-table table');
        var theadH = THEAD_FALLBACK, rowH = ROW_FALLBACK, top = 140;
        if (table) {
            var th = table.querySelector('thead');
            if (th && th.offsetHeight) theadH = th.offsetHeight;
            var r = table.querySelector('#departments-tbody tr');
            if (r && r.offsetHeight) rowH = r.offsetHeight;
            top = table.getBoundingClientRect().top;
        } else {
            var region = $('#departments-list-region');
            if (region) top = region.getBoundingClientRect().top;
        }
        return { theadH: theadH, rowH: rowH, top: top };
    }
    function computeAutoPerPage() {
        var table = $('#admin-departments-table table');
        var curEl = $('#departments-search-form input[name="per_page"]');
        if (!table) {
            // NO-DATA SAFE
            return Math.max(MIN_ROWS, intv(curEl && curEl.value ? curEl.value : String(MIN_ROWS), MIN_ROWS));
        }
        try {
            var h = sampleHeights();
            var viewportH = window.innerHeight || document.documentElement.clientHeight || 800;
            var avail = viewportH - h.top - measureBottomReserve();
            var rows = Math.floor((avail - h.theadH) / Math.max(1, h.rowH));
            if (!isFinite(rows) || rows < MIN_ROWS) rows = MIN_ROWS;
            if (rows > 500) rows = 500;
            return rows;
        } catch (e) {
            return Math.max(MIN_ROWS, intv(curEl && curEl.value ? curEl.value : String(MIN_ROWS), MIN_ROWS));
        }
    }
    function applyAutoPerPageIfChanged(reason) {
        var ppEl = $('#departments-search-form input[name="per_page"]');
        var pageEl = $('#departments-search-form input[name="page"]');
        var cont = getContainer();
        if (!ppEl || !pageEl || !cont) return;

        var want = computeAutoPerPage();
        if (want < 1) want = 1;

        var curPP = intv(ppEl.value || '0', 0);
        if (curPP === want) return;

        var curPage = intv(pageEl.value || '1', 1);
        var firstIndex = ((curPage - 1) * Math.max(1, curPP)) + 1;

        var total = intv(cont.getAttribute('data-total') || '0', 0);
        var newPage = Math.floor((firstIndex - 1) / want) + 1;
        if (total > 0) {
            var totalPagesNew = Math.max(1, Math.ceil(total / want));
            if (newPage > totalPagesNew) newPage = totalPagesNew;
        }
        if (newPage < 1) newPage = 1;

        ppEl.value = String(want);
        pageEl.value = String(newPage);
        cont.dataset.perPage = String(want);
        cont.dataset.page = String(newPage);
        _perPageApplied = want;

        if (reason !== 'afterSwap') {
            // boot/resize: reload "silent" để KHÔNG đẩy per_page lên URL
            var silent = (reason === 'boot' || reason === 'resize');
            loadList({ pushUrl: silent ? false : undefined });
        }
    }

    var _rsTimer = null;
    function debounceResize() {
        if (_rsTimer) clearTimeout(_rsTimer);
        _rsTimer = setTimeout(function () {
            applyAutoPerPageIfChanged('resize');
            addFillerRowsToPerPage();
            sanitizeHxGetPerPage();
        }, 220);
    }

    /* ───────────────────────── [4] Reload list ───────────────────────── */
    function loadList(opts) {
        opts = opts || {};
        try { if (typeof closeMenuIfAny === 'function') closeMenuIfAny(); } catch (_) { }

        // Nếu cần reload "silent" (không đổi URL)
        if (window.htmx && opts.pushUrl === false) {
            var f = (typeof window.__departmentsFilterVals === 'function')
                ? window.__departmentsFilterVals() : currentFilters();
            window.htmx.ajax('GET', '/admin/departments', {
                target: '#departments-list-region',
                select: '#departments-list-region',
                swap: 'outerHTML',
                pushURL: false,
                values: {
                    q: f.q || '',
                    sort: f.sort || 'created_desc',
                    page: f.page || 1,
                    per_page: f.per_page || 10
                }
            });
            return;
        }

        // Luồng mặc định: submit form (hx-push-url="true") để cập nhật URL đẹp do server ép
        var form = $('#departments-search-form');
        if (form && window.htmx) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
        else { swapOuterHTML('/admin/departments' + window.__departmentsFilterQS(), '#departments-list-region'); }
    }

    /* ───────────────────────── [5] Toolbar ───────────────────────── */
    function updateSortLabel() {
        var span = $('#departments-sort-label .sort-value'); if (!span) return;
        var f = currentFilters();
        var key = canonicalToUi(f.sort || 'created_desc');
        var map = {
            'new': 'Mới nhất', 'old': 'Cũ nhất',
            'az': 'Tên A–Z', 'za': 'Tên Z–A',
            'alias_az': 'Bí danh A–Z', 'alias_za': 'Bí danh Z–A',
            'email_az': 'Email A–Z', 'email_za': 'Email Z–A'
        };
        span.textContent = map[key] || 'Mới nhất';
    }
    function triggerReset() {
        var cont = getContainer();
        var input = $('#departments-search-input');
        if (input) input.value = '';
        upsertHiddenInSearchForm('q', '');
        upsertHiddenInSearchForm('sort', 'created_desc');
        upsertHiddenInSearchForm('page', '1');
        if (cont) { cont.dataset.q = ''; cont.dataset.currentSort = 'new'; cont.dataset.page = '1'; }
        updateSortLabel(); loadList();
    }
    function bindToolbar() {
        var s = $('#departments-search-input');
        if (s && !s.dataset.bound) {
            s.dataset.bound = '1';
            s.addEventListener('input', function () { upsertHiddenInSearchForm('page', '1'); });
            s.addEventListener('keydown', function (e) {
                if ((e.key || '') === 'Enter' || e.keyCode === 13) { e.preventDefault(); upsertHiddenInSearchForm('page', '1'); loadList(); }
            });
        }

        var btnSort = $('#btn-departments-sort'), menuSort = $('#menu-departments-sort');
        if (btnSort && !btnSort.dataset.bound) {
            btnSort.dataset.bound = '1';
            btnSort.addEventListener('click', function () {
                if (!menuSort) return;
                menuSort.classList.toggle('hidden');
                btnSort.setAttribute('aria-expanded', menuSort.classList.contains('hidden') ? 'false' : 'true');
            });
            document.addEventListener('mousedown', function (ev) {
                if (!menuSort || menuSort.classList.contains('hidden')) return;
                if (!menuSort.contains(ev.target) && ev.target !== btnSort) menuSort.classList.add('hidden');
            });
            document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && menuSort && !menuSort.classList.contains('hidden')) menuSort.classList.add('hidden'); });
        }
        if (menuSort && !menuSort.dataset.bound) {
            menuSort.dataset.bound = '1';
            menuSort.addEventListener('click', function (e) {
                var item = e.target && e.target.closest ? e.target.closest('button.menu-item') : null; if (!item) return;
                var key = item.getAttribute('data-sort') || 'new';
                var canon = uiSortToCanonical(key);
                upsertHiddenInSearchForm('sort', canon);
                upsertHiddenInSearchForm('page', '1');
                var c = getContainer(); if (c) { c.dataset.currentSort = key; c.dataset.page = '1'; }
                updateSortLabel(); if (menuSort) menuSort.classList.add('hidden'); loadList();
            });
        }

        var csv = $('#btn-departments-export-csv');
        if (csv && !csv.dataset.bound) {
            csv.dataset.bound = '1';
            csv.addEventListener('click', function (e) {
                e.preventDefault();
                var url = '/admin/departments/export-csv' + window.__departmentsFilterQS();
                try { window.open(url, '_blank'); } catch (_) { window.location.href = url; }
            });
        }

        var btnNew = $('#btn-open-departments-new-modal');
        if (btnNew && !btnNew.dataset.bound) { btnNew.dataset.bound = '1'; btnNew.addEventListener('click', function () { openModalGet('/admin/departments/new-modal'); }); }

        var btnReset = $('#btn-departments-reset');
        if (btnReset && !btnReset.dataset.bound) { btnReset.dataset.bound = '1'; btnReset.addEventListener('click', function (e) { e.preventDefault(); triggerReset(); }); }
    }

    /* ───────────────────────── [6] Modals & row actions ───────────────────────── */
    var MODAL_ROOT_SEL = '#admin-departments-modal-root';
    function openModalGet(path) {
        var root = $(MODAL_ROOT_SEL); if (!root) return;
        fetchText(String(path)).then(function (html) {
            root.innerHTML = html || '';
            var fake = makeFakeXhr(200, html);
            dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
            dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
            dispatchHX('htmx:load', { elt: root });
            dispatchHX('htmx:afterSettle', { target: root, xhr: fake });
            bindEditModal();
        });
    }
    function openDetail(id) { openModalGet('/admin/departments/' + encodeURIComponent(id) + '/detail-modal'); }
    function openEdit(id) { openModalGet('/admin/departments/' + encodeURIComponent(id) + '/edit-modal'); }
    function openDelete(id) { openModalGet('/admin/departments/' + encodeURIComponent(id) + '/delete-modal'); }

    /* ───────────────────────── [7] Selection + Bulk bar ───────────────────────── */
    function selectedRowEls() {
        var A = $all('.dept-row-select:checked'), B = $all('.row-select:checked');
        var out = A.concat(B); return out.filter(function (el, i) { return out.indexOf(el) === i; });
    }
    function rows() {
        var A = $all('.dept-row-select'), B = $all('.row-select');
        var out = A.concat(B); return out.filter(function (el, i) { return out.indexOf(el) === i; });
    }
    function headerCb() { return $('#sel-all-departments') || $('#dept-sel-all') || $('#sel-all'); }
    function headerWrap() { return $('#sel-all-departments-wrap') || $('#dept-sel-all-wrap') || $('#sel-all-wrap'); }
    function bulkBar() { return $('#departments-bulk-bar'); }
    function getSelectedIds() {
        var rs = selectedRowEls(); var ids = [];
        for (var i = 0; i < rs.length; i++) {
            var cb = rs[i];
            var id = cb.getAttribute('data-dept-id') || cb.getAttribute('data-id') || cb.value || '';
            if (String(id).trim()) ids.push(String(id).trim());
        }
        return ids;
    }
    function setBtnState(btn, labelEl, baseText, count) {
        if (labelEl) labelEl.textContent = baseText + ' (' + (count || 0) + ')';
        if (btn) { if (count > 0) { btn.removeAttribute('disabled'); btn.classList.remove('is-disabled'); } else { btn.setAttribute('disabled', ''); btn.classList.add('is-disabled'); } }
    }
    function updateBulkButtons() {
        var ids = getSelectedIds();
        setBtnState($('#btn-departments-bulk-delete'), $('#departments-bulk-delete-label'), 'Xoá', ids.length);
        var exBtn = $('#btn-departments-bulk-export');
        if (exBtn) exBtn.removeAttribute('disabled');
    }
    function updateBulkBar(selCount) {
        var bar = bulkBar(); if (!bar) return; var cont = getContainer();
        if (selCount > 0) {
            if (!bar.classList.contains('is-active')) bar.classList.add('is-active');
            bar.removeAttribute('inert'); bar.setAttribute('aria-hidden', 'false');
            if (cont) cont.classList.add('bulk-open');
        } else {
            try { var a = document.activeElement; if (a && bar.contains(a) && a.blur) a.blur(); } catch (_) { }
            bar.classList.remove('is-active'); bar.setAttribute('inert', ''); bar.setAttribute('aria-hidden', 'true');
            if (cont) cont.classList.remove('bulk-open');
        }
        updateBulkButtons();
    }
    function syncHeaderFromRows() {
        var head = headerCb(); var list = rows(); var total = list.length, sel = 0;
        for (var i = 0; i < total; i++) if (list[i].checked) sel++;
        if (head) {
            var all = (sel === total && total > 0); head.checked = all; head.indeterminate = (sel > 0 && !all);
            head.setAttribute('aria-checked', head.indeterminate ? 'mixed' : (all ? 'true' : 'false'));
            var wrap = headerWrap(); if (wrap) { wrap.classList.toggle('is-indeterminate', head.indeterminate); wrap.classList.toggle('is-checked', all); }
        }
        updateBulkBar(sel);
    }
    function setAllRows(checked) { rows().forEach(function (cb) { cb.checked = !!checked; }); }
    function onHeaderClick(e) {
        e.preventDefault(); e.stopPropagation();
        var head = headerCb(); if (!head) return;
        var chooseAll = !(head.indeterminate || head.checked);
        setAllRows(chooseAll);
        head.indeterminate = false; head.checked = chooseAll; head.setAttribute('aria-checked', chooseAll ? 'true' : 'false');
        var wrap = headerWrap(); if (wrap) { wrap.classList.remove('is-indeterminate'); wrap.classList.toggle('is-checked', !!chooseAll); }
        syncHeaderFromRows();
    }
    function bindSelection() {
        var head = headerCb(), wrap = headerWrap();
        if (head && !head.dataset.bound) { head.dataset.bound = '1'; head.addEventListener('click', onHeaderClick); }
        if (wrap && !wrap.dataset.bound) { wrap.dataset.bound = '1'; wrap.addEventListener('click', onHeaderClick); }
        rows().forEach(function (cb) { if (!cb.dataset.bound) { cb.dataset.bound = '1'; cb.addEventListener('change', syncHeaderFromRows); } });
        syncHeaderFromRows();
        bindBulkButtons();
    }
    function bindBulkButtons() {
        var bdel = $('#btn-departments-bulk-delete');
        if (bdel && !bdel.dataset.bound) {
            bdel.dataset.bound = '1';
            bdel.addEventListener('click', function () {
                var ids = getSelectedIds();
                if (!ids.length) { if (window.Toast && window.Toast.show) window.Toast.show('Chưa chọn phòng ban để xoá.', 'info', 2200); return; }
                if (typeof window.__openDepartmentsBulkDeleteModal === 'function') {
                    window.__openDepartmentsBulkDeleteModal(ids.join(','));
                } else {
                    if (window.Toast && window.Toast.show) window.Toast.show('Thiếu module bulk delete. Vui lòng kiểm tra.', 'warning', 2800);
                }
            });
        }
        var bex = $('#btn-departments-bulk-export');
        if (bex && !bex.dataset.bound) {
            bex.dataset.bound = '1';
            bex.addEventListener('click', function () {
                var ids = getSelectedIds();
                if (typeof window.__openDepartmentsBulkExportModal === 'function') {
                    window.__openDepartmentsBulkExportModal(ids.length ? ids.join(',') : '');
                } else {
                    var url = '/admin/departments/export-csv' + window.__departmentsFilterQS();
                    try { window.open(url, '_blank'); } catch (_) { window.location.href = url; }
                }
            });
        }
    }

    /* ───────────────────────── [8] Edit modal (light) ───────────────────────── */
    function bindEditModal() {
        try { if (typeof attachDepartmentsEditFormLogic === 'function') attachDepartmentsEditFormLogic(); } catch (_) { }
        var overlay = document.getElementById('departments-edit-modal-overlay');
        var modal = document.getElementById('departments-edit-modal');
        var form = document.getElementById('admin-departments-edit-form');
        var btnClose = document.getElementById('departments-edit-modal-close');
        var btnCancel = document.getElementById('departments-edit-cancel-btn');
        var submitBtn = document.getElementById('departments-edit-submit-btn');
        if (!form || form.dataset.bound) return; form.dataset.bound = '1';
        function closeModal() { if (overlay) overlay.remove(); if (modal) modal.remove(); }
        if (btnClose) btnClose.onclick = closeModal; if (btnCancel) btnCancel.onclick = closeModal;

        form.addEventListener('htmx:configRequest', function (e) {
            try {
                var d = e && e.detail ? e.detail : {}; if (!d.parameters) d.parameters = {};
                var f = (window.__departmentsFilterVals ? window.__departmentsFilterVals() : null) || {};
                ['q', 'sort', 'page', 'per_page'].forEach(function (k) { d.parameters[k] = (f[k] != null ? String(f[k]) : ''); });
            } catch (_) { }
        });
        function reevaluate() { if (submitBtn) submitBtn.disabled = false; }
        ['input', 'change', 'keyup'].forEach(function (evt) { form.addEventListener(evt, function () { reevaluate(); }, true); });
        reevaluate();

        document.body.addEventListener('departments-single-result', function (ev) {
            var d = ev && ev.detail ? ev.detail : null;
            if (d && d.action === 'update' && d.ok) {
                closeModal();
                if (window.Toast && Toast.show) Toast.show('Đã cập nhật phòng ban.', 'success', 2200);
            }
        });
    }

    /* ───────────────────────── [9] Row buttons delegation ───────────────────────── */
    function bindRowButtons() {
        var tbl = $('#admin-departments-table'); if (!tbl || tbl.dataset.boundDelegation === '1') return;
        tbl.dataset.boundDelegation = '1';
        tbl.addEventListener('click', function (e) {
            var t = e.target || e.srcElement;
            var nameBtn = t && t.closest ? t.closest('.btn-dept-detail') : null;
            if (nameBtn) { var id0 = nameBtn.getAttribute('data-dept-id') || nameBtn.getAttribute('data-id'); if (id0) { e.preventDefault(); openDetail(id0); return; } }
            var btn = t && t.closest ? t.closest('.row-action-detail, .row-action-edit, .row-action-delete') : null;
            if (!btn) return; e.preventDefault();
            var id = btn.getAttribute('data-dept-id') || btn.getAttribute('data-id'); if (!id) return;
            if (btn.classList.contains('row-action-detail')) return openDetail(id);
            if (btn.classList.contains('row-action-edit')) return openEdit(id);
            if (btn.classList.contains('row-action-delete')) return openDelete(id);
        });
    }

    /* ───────────────────────── [10] Pagination jump (fallback) ───────────────────────── */
    function bindPageJump() {
        var form = $('#departments-page-jump-form'), input = $('#departments-page-input');
        if (form && !form.dataset.boundSubmit) {
            form.dataset.boundSubmit = '1';
            form.addEventListener('submit', function (e) {
                if (window.htmx) return;
                e.preventDefault();
                var fd = new FormData(form);
                var qs = new URLSearchParams(fd).toString();
                swapOuterHTML('/admin/departments?' + qs, '#departments-list-region');
            });
        }
        if (input && !input.dataset.boundClamp) {
            input.dataset.boundClamp = '1';
            function clamp() {
                var container = getContainer();
                var maxAttr = input.getAttribute('max') || (container ? (container.getAttribute('data-total-pages') || '1') : '1');
                var max = intv(maxAttr, 1);
                var v = intv(input.value || '1', 1);
                if (v < 1) v = 1; if (v > max) v = max;
                input.value = String(v);
                upsertHiddenInSearchForm('page', String(v));
                if (container) container.dataset.page = String(v);
                return v;
            }
            input.addEventListener('keydown', function (e) {
                if ((e.key || '') === 'Enter' || e.keyCode === 13) {
                    e.preventDefault();
                    clamp();
                    if (form) {
                        if (window.htmx) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
                        else { var fd = new FormData(form); var qs = new URLSearchParams(fd).toString(); swapOuterHTML('/admin/departments?' + qs, '#departments-list-region'); }
                    }
                }
            });
            input.addEventListener('blur', clamp);
        }
    }

    /* ───────────────────────── [11] Filler rows: bù theo per_page ───────────────────────── */
    function addFillerRowsToPerPage() {
        var table = $('#admin-departments-table table'); if (!table) return;
        var tbody = $('#departments-tbody'), filler = $('#departments-filler'), thead = table.querySelector('thead');
        if (!tbody || !filler || !thead) return;

        // clear old fillers
        filler.innerHTML = '';

        // per_page hiện tại
        var pp = intv(formVal('per_page', (getContainer() && getContainer().dataset.perPage) || '10'), 10);
        var realRows = tbody.querySelectorAll('tr').length;
        var need = pp - realRows; if (need <= 0) return;

        var cols = thead.querySelectorAll('th').length || 6;
        var frag = document.createDocumentFragment();
        for (var i = 0; i < need; i++) {
            var tr = document.createElement('tr'); tr.className = 'departments-filler-row'; tr.setAttribute('aria-hidden', 'true');
            var td = document.createElement('td'); td.colSpan = cols; td.className = 'px-4 py-2 border-b border-gray-200'; td.innerHTML = '<span class="invisible">–</span>';
            tr.appendChild(td); frag.appendChild(tr);
        }
        filler.appendChild(frag);
    }

    /* ───────────────────────── [12] HTMX enrichment ───────────────────────── */
    document.body.addEventListener('htmx:configRequest', function (e) {
        try {
            var d = e && e.detail ? e.detail : {}; if (!d) return; if (!d.parameters) d.parameters = {};
            var tgt = e && e.target ? e.target : null;
            var isListSwap = false;
            if (tgt) {
                var hxTarget = (tgt.getAttribute && tgt.getAttribute('hx-target')) || '';
                if (hxTarget === '#departments-list-region') isListSwap = true;
                if (!isListSwap && tgt.id === 'departments-list-region') isListSwap = true;
            }
            if (!isListSwap) return;

            var f = window.__departmentsFilterVals ? window.__departmentsFilterVals() : currentFilters();
            d.parameters.page = f.page > 0 ? f.page : 1;
            if (f.per_page > 0) d.parameters.per_page = f.per_page;
            if (f.q) d.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') d.parameters.sort = f.sort;

            // remove per_page from URL if any
            var path = String(d.path || d.url || '');
            if (path) {
                try {
                    var u = new URL(path, location.origin);
                    if (u.searchParams.has('per_page')) {
                        u.searchParams.delete('per_page');
                        d.path = u.pathname + (u.searchParams.toString() ? ('?' + u.searchParams.toString()) : '');
                    }
                } catch (_) {
                    d.path = path.replace(/([?&])per_page=\d+&?/g, '$1').replace(/[?&]$/, '');
                }
            }
        } catch (_) { }
    });

    /* ───────────────────────── [HL] Row highlight helpers ───────────────────────── */
    // Nhận id sau create/update để highlight
    document.body.addEventListener('departments-single-result', function (ev) {
        var d = ev && ev.detail ? ev.detail : {};
        if (d && d.ok && (d.action === 'update' || d.action === 'create')) {
            window.__deptHighlightId = d.id || d.dept_id || null;
        } else if (d && d.action === 'delete') {
            window.__deptHighlightId = null;
        }
    });

    function highlightDeptRowIfAny() {
        var id = window.__deptHighlightId; if (!id) return;
        var cb = document.querySelector('.dept-row-select[data-dept-id="' + id + '"], .row-select[data-id="' + id + '"]');
        var tr = cb ? cb.closest('tr') : (document.querySelector('tr[data-dept-id="' + id + '"]') || null);
        if (!tr) { window.__deptHighlightId = null; return; }

        tr.classList.add('ring', 'ring-2', 'ring-amber-400', 'bg-amber-50');
        try { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { }
        setTimeout(function () {
            tr.classList.remove('ring', 'ring-2', 'ring-amber-400', 'bg-amber-50');
            window.__deptHighlightId = null;
        }, 1800);
    }

    /* ───────────────────────── [13] Rebind pipeline ───────────────────────── */
    function sanitizeHxGetPerPage() {
        $all('[hx-get]').forEach(function (el) {
            try {
                var raw = el.getAttribute('hx-get') || ''; if (!raw) return;
                var u = new URL(raw, location.origin);
                if (u.searchParams.has('per_page')) {
                    u.searchParams.delete('per_page');
                    el.setAttribute('hx-get', u.pathname + (u.searchParams.toString() ? ('?' + u.searchParams.toString()) : ''));
                }
            } catch (_) {/* ignore */ }
        });
    }
    function rebindListOnly() {
        bindRowButtons(); bindSelection(); bindPageJump(); updateSortLabel();
        addFillerRowsToPerPage(); sanitizeHxGetPerPage();
        setTimeout(function () { updateBulkButtons(); }, 0);
    }
    function rebindAll() {
        bindToolbar(); rebindListOnly(); bindEditModal();
    }

    /* ───────────────────────── [14] Boot/Hydrate + HTMX hooks ───────────────────────── */
    function hydrateOnce(root) {
        var cont = (root || document).querySelector('#admin-departments-container');
        if (!cont || cont.dataset.hydrated === '1') return;
        cont.dataset.hydrated = '1';

        applyAutoPerPageIfChanged('boot'); // tính & map page nếu cần
        rebindAll();

        window.addEventListener('resize', debounceResize);
        window.addEventListener('orientationchange', debounceResize);
        addFillerRowsToPerPage();
        sanitizeHxGetPerPage();
    }
    document.addEventListener('DOMContentLoaded', function () { hydrateOnce(document); });

    document.body.addEventListener('htmx:afterSwap', function (e) {
        var d = e && e.detail ? e.detail : {}, tgt = d && d.target ? d.target : null;
        if (tgt && tgt.id === 'departments-list-region') {
            // TÍNH per_page TRƯỚC rồi mới bind
            applyAutoPerPageIfChanged('afterSwap');
            rebindListOnly();
            addFillerRowsToPerPage();
            sanitizeHxGetPerPage();
            // highlight (nếu có id)
            highlightDeptRowIfAny();
        }
        bindEditModal();
        try { var dlg = document.getElementById('bulkConfirmModal'); if (dlg && dlg.close) dlg.close(); } catch (_) { }
    });
    document.body.addEventListener('htmx:load', function (e) { hydrateOnce(e && e.target ? e.target : document); bindEditModal(); });
    document.body.addEventListener('htmx:afterOnLoad', function (e) { var d = e ? e.detail : null; hydrateOnce(d && d.target ? d.target : document); addFillerRowsToPerPage(); bindEditModal(); });
    document.body.addEventListener('htmx:afterSettle', function (e) { var d = e ? e.detail : null; hydrateOnce(d && d.target ? d.target : document); bindEditModal(); });

    // Global toast cho bulk
    document.body.addEventListener('departments-bulk-result', function (ev) {
        var d = ev && ev.detail ? ev.detail : {}; if (!window.Toast || !Toast.show) return;
        var act = d.action || ''; var affected = d.affected || 0; var total = d.total || 0; var msg = '';
        switch (act) {
            case 'delete': msg = 'Đã xoá ' + affected + '/' + total + ' phòng ban.'; break;
            case 'export': msg = 'Đã gửi yêu cầu xuất CSV.'; break;
            default: msg = 'Đã thực hiện thao tác hàng loạt.'; break;
        }
        Toast.show(msg, 'success', 2000);
    });

    /* ───────────────────────── [15] Public helpers ───────────────────────── */
    window.openDepartmentNewModal = function () { openModalGet('/admin/departments/new-modal'); };
    window.openDepartmentEditModal = function (id) { openEdit(id); };
    window.openDepartmentDetailModal = function (id) { openDetail(id); };
    window.openDepartmentDeleteModal = function (id) { openDelete(id); };
})();

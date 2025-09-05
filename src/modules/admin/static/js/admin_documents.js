/********************************************************************
 * File   : src/modules/admin/static/js/admin_documents.js
 * Updated: 2025-08-25 (v1.0 – filters + sort + paging + selection;
 *          bulk delete/export hooks; HTMX enrichment; smart filler)
 * Scope  : Trang “Quản lý văn bản” (Documents)
 ********************************************************************/
(function () {
    /* =============== Tiny helpers =============== */
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
    function makeFakeXhr(status, body) { return { status: status || 200, responseText: body || '', response: body || '', getResponseHeader: function () { return null; } }; }
    function createCE(name, detail) { try { return new CustomEvent(name, { detail: detail }); } catch (e) { var ev = document.createEvent('CustomEvent'); ev.initCustomEvent(name, false, false, detail); return ev; } }
    function dispatchHX(type, detail) { document.body.dispatchEvent(createCE(type, detail)); if (window.htmx && detail && detail.target) { try { window.htmx.process(detail.target); } catch (_e) { } } }
    function swapOuterHTML(url, targetSel) {
        var targetEl = $(targetSel); if (!targetEl) return Promise.resolve();
        return fetchText(url).then(function (html) {
            var box = document.createElement('div'); box.innerHTML = (html || '').trim();
            var next = box.querySelector(targetSel);
            if (!next) { console.error('swapOuterHTML: Not found', targetSel); return; }
            var fake = makeFakeXhr(200, html);
            targetEl.parentNode.replaceChild(next, targetEl);
            dispatchHX('htmx:afterSwap', { target: next, xhr: fake });
            dispatchHX('htmx:afterOnLoad', { target: next, xhr: fake });
            dispatchHX('htmx:load', { elt: next });
            dispatchHX('htmx:afterSettle', { target: next, xhr: fake });
        })["catch"](function (err) { console.error(err); });
    }
    function safeToast(msg, type, ms) { try { if (window.Toast && Toast.show) Toast.show(msg, type || 'info', ms || 2400); } catch (_) { } }

    /* =============== Filter state (Documents) =============== */
    function getContainer() { return $('#admin-documents-container'); }

    function _formVal(formId, name, fallback) {
        var f = $('#' + formId); if (!f) return fallback;
        var el = f.querySelector('input[name="' + name + '"]');
        var val = el ? (el.value != null ? String(el.value).trim() : '') : '';
        return val === '' ? fallback : val;
    }

    function currentFilters() {
        var c = getContainer() || { dataset: {} };
        var qInp = $('#docs-search-input');
        var ds = c.dataset || {};
        var dsStatus = ds.status || 'all';
        var dsChatId = ds.chatId || ds.chatid || '';
        var dsQ = ds.q || '';
        var dsSort = ds.currentSort || 'new'; // UI key
        var dsPage = intv(ds.page || '1', 1);
        var dsPerPage = intv(ds.perPage || ds.perpage || '10', 10);

        var status = _formVal('docs-search-form', 'status', dsStatus);
        var chatId = _formVal('docs-chat-form', 'chat_id', dsChatId);
        var sort = _formVal('docs-search-form', 'sort', null); // canonical nếu đã set
        var page = intv(_formVal('docs-search-form', 'page', dsPage), dsPage);
        var perPage = intv(_formVal('docs-search-form', 'per_page', dsPerPage), dsPerPage);
        var q = qInp ? (qInp.value || '') : _formVal('docs-search-form', 'q', dsQ);

        return {
            status: status || 'all',
            chat_id: (chatId == null ? '' : chatId),
            q: q || '',
            sort: sort || dsSort,
            page: page,
            per_page: perPage
        };
    }

    function uiSortToCanonical(v) {
        // Map key UI -> sort canonical trên server
        switch (String(v || '').toLowerCase()) {
            case 'old': return 'created_asc';
            case 'title_az': return 'title_az';
            case 'title_za': return 'title_za';
            case 'updated_new': return 'updated_desc';
            case 'updated_old': return 'updated_asc';
            case 'size_asc': return 'size_asc';
            case 'size_desc': return 'size_desc';
            case 'new':
            default: return 'created_desc';
        }
    }

    function buildQS(f) {
        var parts = [];
        if (f.status && f.status !== 'all') parts.push('status=' + encodeURIComponent(f.status));
        if (f.chat_id) parts.push('chat_id=' + encodeURIComponent(f.chat_id));
        if (f.q) parts.push('q=' + encodeURIComponent(f.q));
        // Nếu sort là UI key thì convert → canonical
        var sortCanon = (f.sort && f.sort.indexOf('_') > -1) ? f.sort : uiSortToCanonical(f.sort || 'new');
        if (sortCanon !== 'created_desc') parts.push('sort=' + encodeURIComponent(sortCanon));
        parts.push('page=' + (f.page > 0 ? f.page : 1));
        if (f.per_page > 0) parts.push('per_page=' + f.per_page);
        return parts.length ? ('?' + parts.join('&')) : '';
    }

    // Expose để chỗ khác (bulk/modal) tái dùng nếu cần
    window.__docsFilterVals = function () {
        var f = currentFilters();
        var sortCanon = (f.sort && f.sort.indexOf('_') > -1) ? f.sort : uiSortToCanonical(f.sort);
        return {
            status: f.status, chat_id: f.chat_id, q: f.q,
            sort: sortCanon, page: f.page, per_page: f.per_page
        };
    };
    window.__docsFilterQS = function () { return buildQS(currentFilters()); };

    function upsertHiddenInSearchForm(name, val) {
        var form = $('#docs-search-form'); if (!form) return;
        var el = form.querySelector('input[name="' + name + '"]');
        if (val == null || val === '') { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
        if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
        el.value = String(val);
    }

    /* =============== Reload list =============== */
    function loadList() {
        var form = $('#docs-search-form');
        if (form && window.htmx) {
            if (form.requestSubmit) form.requestSubmit(); else form.submit();
        } else {
            swapOuterHTML('/admin/documents' + window.__docsFilterQS(), '#documents-list-region');
        }
    }

    /* =============== Toolbar (search, filter, sort, export, new) =============== */
    function updateSortLabel() {
        var span = $('#docs-sort-label .sort-value'); if (!span) return;
        var f = currentFilters();
        var key = (String(f.sort).indexOf('_') > -1)
            ? (function (canon) {
                switch (canon) {
                    case 'created_asc': return 'old';
                    case 'title_az': return 'title_az';
                    case 'title_za': return 'title_za';
                    case 'updated_desc': return 'updated_new';
                    case 'updated_asc': return 'updated_old';
                    case 'size_asc': return 'size_asc';
                    case 'size_desc': return 'size_desc';
                    default: return 'new';
                }
            })(String(f.sort))
            : String(f.sort || 'new');

        var map = {
            'new': 'Mới nhất',
            'old': 'Cũ nhất',
            'title_az': 'Tiêu đề A–Z',
            'title_za': 'Tiêu đề Z–A',
            'updated_new': 'Cập nhật mới',
            'updated_old': 'Cập nhật cũ',
            'size_asc': 'Dung lượng tăng',
            'size_desc': 'Dung lượng giảm'
        };
        span.textContent = map[key] || 'Mới nhất';
    }

    function bindToolbar() {
        // Search input: Enter → submit; input → reset page=1
        var s = $('#docs-search-input');
        if (s && !s.dataset.bound) {
            s.dataset.bound = '1';
            s.addEventListener('keydown', function (e) {
                if ((e.key || '') === 'Enter' || e.keyCode === 13) { e.preventDefault(); upsertHiddenInSearchForm('page', '1'); loadList(); }
            });
            s.addEventListener('input', function () { upsertHiddenInSearchForm('page', '1'); });
        }

        // Filter dropdown (nếu có): status pills + chat select/text
        var btnFilter = $('#btn-docs-filter'), menuFilter = $('#menu-docs-filter');
        function pillsSetActive(groupEl, value) {
            if (!groupEl) return; var pills = $all('.filter-pill[role="radio"]', groupEl);
            pills.forEach(function (p) {
                var on = (String(p.getAttribute('data-v') || '').toLowerCase() === String(value || '').toLowerCase());
                p.setAttribute('aria-checked', on ? 'true' : 'false'); p.tabIndex = on ? 0 : -1;
            });
        }
        function collectInitFilter() {
            if (!menuFilter) return { status: (getContainer() && getContainer().dataset.status) || 'all', chat_id: (getContainer() && (getContainer().dataset.chatId || getContainer().dataset.chatid)) || '' };
            return {
                status: (menuFilter.getAttribute('data-init-status') || (getContainer() && getContainer().dataset.status) || 'all').toLowerCase(),
                chat_id: (menuFilter.getAttribute('data-init-chat') || (getContainer() && (getContainer().dataset.chatId || getContainer().dataset.chatid)) || '')
            };
        }
        var initF = collectInitFilter(); var pendingF = { status: initF.status, chat_id: initF.chat_id };
        function updateApplyDisabled() {
            var equal = (String(pendingF.status || 'all') === String(initF.status || 'all')) && (String(pendingF.chat_id || '') === String(initF.chat_id || ''));
            var apply = $('#btn-docs-apply', menuFilter); if (apply) apply.disabled = !!equal;
        }
        function syncUIFromPending() {
            if (!menuFilter) return;
            pillsSetActive(menuFilter.querySelector('[data-filter-group="status"]'), pendingF.status || 'all');
            var chatInput = $('#docs-filter-chat-input', menuFilter); if (chatInput) chatInput.value = pendingF.chat_id || '';
            updateApplyDisabled();
        }

        if (btnFilter && !btnFilter.dataset.bound) {
            btnFilter.dataset.bound = '1';
            btnFilter.addEventListener('click', function () {
                if (!menuFilter) return;
                var willOpen = menuFilter.classList.contains('hidden');
                if (willOpen) { initF = collectInitFilter(); pendingF = { status: initF.status, chat_id: initF.chat_id }; syncUIFromPending(); }
                menuFilter.classList.toggle('hidden');
                btnFilter.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
            });
            document.addEventListener('mousedown', function (ev) {
                if (!menuFilter || menuFilter.classList.contains('hidden')) return;
                if (!menuFilter.contains(ev.target) && ev.target !== btnFilter) menuFilter.classList.add('hidden');
            });
        }
        if (menuFilter && !menuFilter.dataset.bound) {
            menuFilter.dataset.bound = '1';
            menuFilter.addEventListener('click', function (e) {
                var pill = e.target && e.target.closest ? e.target.closest('.filter-pill[role="radio"]') : null;
                if (!pill) return;
                var k = pill.getAttribute('data-k') || ''; var v = pill.getAttribute('data-v') || '';
                if (k === 'status') { pendingF.status = v; pillsSetActive(menuFilter.querySelector('[data-filter-group="status"]'), v); }
                updateApplyDisabled();
            });
            var chatInput = $('#docs-filter-chat-input', menuFilter);
            if (chatInput && !chatInput.dataset.bound) {
                chatInput.dataset.bound = '1';
                chatInput.addEventListener('input', function () { pendingF.chat_id = (chatInput.value || '').trim(); updateApplyDisabled(); });
            }
            var btnReset = $('#btn-docs-reset', menuFilter);
            if (btnReset && !btnReset.dataset.bound) {
                btnReset.dataset.bound = '1';
                btnReset.addEventListener('click', function () { pendingF = { status: 'all', chat_id: '' }; syncUIFromPending(); });
            }
            var btnApply = $('#btn-docs-apply', menuFilter);
            if (btnApply && !btnApply.dataset.bound) {
                btnApply.dataset.bound = '1';
                btnApply.addEventListener('click', function () {
                    upsertHiddenInSearchForm('status', pendingF.status || 'all');
                    upsertHiddenInSearchForm('page', '1');
                    var chatForm = $('#docs-chat-form');
                    if (chatForm) {
                        var inEl = chatForm.querySelector('input[name="chat_id"]');
                        if (inEl) inEl.value = pendingF.chat_id || '';
                    } else {
                        // fallback: set hidden vào search-form
                        upsertHiddenInSearchForm('chat_id', pendingF.chat_id || '');
                    }
                    var c = getContainer(); if (c) { c.dataset.status = pendingF.status || 'all'; c.dataset.chatId = pendingF.chat_id || ''; c.dataset.page = '1'; }
                    if (menuFilter) {
                        menuFilter.setAttribute('data-init-status', pendingF.status || 'all');
                        menuFilter.setAttribute('data-init-chat', pendingF.chat_id || '');
                        menuFilter.classList.add('hidden');
                    }
                    loadList();
                });
            }
        }

        // Sort dropdown
        var btnSort = $('#btn-docs-sort'), menuSort = $('#menu-docs-sort');
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
        }
        if (menuSort && !menuSort.dataset.bound) {
            menuSort.dataset.bound = '1';
            menuSort.addEventListener('click', function (e) {
                var item = e.target && e.target.closest ? e.target.closest('button.menu-item') : null; if (!item) return;
                var key = item.getAttribute('data-sort') || 'new'; var canon = uiSortToCanonical(key);
                upsertHiddenInSearchForm('sort', canon); upsertHiddenInSearchForm('page', '1');
                var c = getContainer(); if (c) { c.dataset.currentSort = key; c.dataset.page = '1'; }
                updateSortLabel();
                if (menuSort) menuSort.classList.add('hidden');
                loadList();
            });
        }

        // Export CSV nhanh theo filter
        var csv = $('#btn-docs-export-csv');
        if (csv && !csv.dataset.bound) {
            csv.dataset.bound = '1';
            csv.addEventListener('click', function (e) {
                e.preventDefault();
                var url = '/admin/documents/export-csv' + window.__docsFilterQS();
                try { window.open(url, '_blank'); } catch (_) { window.location.href = url; }
            });
        }

        // Open Create modal
        var btnNew = $('#btn-open-docs-new-modal');
        if (btnNew && !btnNew.dataset.bound) {
            btnNew.dataset.bound = '1';
            btnNew.addEventListener('click', function () { openModalGet('/admin/documents/new-modal'); });
        }
    }

    /* =============== Modals & row actions =============== */
    var MODAL_ROOT_SEL = '#admin-docs-modal-root';
    function openModalGet(path) {
        var root = $(MODAL_ROOT_SEL); if (!root) return;
        fetchText(String(path)).then(function (html) {
            root.innerHTML = html || '';
            var fake = makeFakeXhr(200, html);
            dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
            dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
            dispatchHX('htmx:load', { elt: root });
            dispatchHX('htmx:afterSettle', { target: root, xhr: fake });
            // Rebind nhẹ (nếu cần) – admin_documents_modal.js sẽ phụ trách logic form
            try { if (typeof rebindAdminDocumentsNewModalEvents === 'function') rebindAdminDocumentsNewModalEvents(); } catch (_) { }
            try { if (typeof rebindAdminDocumentsEditModalEvents === 'function') rebindAdminDocumentsEditModalEvents(); } catch (_) { }
            try { if (typeof rebindAdminDocumentsDetailModalEvents === 'function') rebindAdminDocumentsDetailModalEvents(); } catch (_) { }
            try { if (typeof rebindAdminDocumentsDeleteModalEvents === 'function') rebindAdminDocumentsDeleteModalEvents(); } catch (_) { }
        });
    }
    function openDetail(id) { openModalGet('/admin/documents/' + encodeURIComponent(id) + '/detail-modal'); }
    function openEdit(id) { openModalGet('/admin/documents/' + encodeURIComponent(id) + '/edit-modal'); }
    function openDelete(id) { openModalGet('/admin/documents/' + encodeURIComponent(id) + '/delete-modal'); }

    function bindRowButtons() {
        var tbl = $('#admin-documents-table'); if (!tbl || tbl.dataset.boundDelegation === '1') return;
        tbl.dataset.boundDelegation = '1';
        tbl.addEventListener('click', function (e) {
            var t = e.target || e.srcElement;
            // Tên/tiêu đề bấm → detail
            var nameBtn = t && t.closest ? t.closest('.btn-doc-detail') : null;
            if (nameBtn) { var id0 = nameBtn.getAttribute('data-doc-id'); if (id0) { e.preventDefault(); openDetail(id0); return; } }

            var btn = t && t.closest ? t.closest('.row-action-detail, .row-action-edit, .row-action-delete') : null;
            if (!btn) return;
            e.preventDefault();
            var id = btn.getAttribute('data-doc-id'); if (!id) return;
            if (btn.classList.contains('row-action-detail')) return openDetail(id);
            if (btn.classList.contains('row-action-edit')) return openEdit(id);
            if (btn.classList.contains('row-action-delete')) return openDelete(id);
        });
    }

    /* =============== Selection + Bulk bar =============== */
    function rows() { return $all('.row-select', $('#admin-documents-table')); } // checkbox trên từng dòng
    function selectedRowEls() { return rows().filter(function (x) { return !!x.checked; }); }
    function headerCb() { return $('#docs-sel-all'); }
    function headerWrap() { return $('#docs-sel-all-wrap'); }
    function bulkBar() { return $('#docs-bulk-bar'); }

    function setAllRows(checked) { rows().forEach(function (cb) { cb.checked = !!checked; }); }
    function updateBulkButtons() {
        var sel = selectedRowEls();
        var count = sel.length;
        var btnDel = $('#btn-docs-bulk-delete');
        var btnExp = $('#btn-docs-bulk-export');
        var lblCount = $('#docs-bulk-count');
        if (lblCount) lblCount.textContent = String(count);
        function setBtn(btn, on) { if (!btn) return; if (on) { btn.removeAttribute('disabled'); btn.classList.remove('is-disabled'); } else { btn.setAttribute('disabled', ''); btn.classList.add('is-disabled'); } }
        setBtn(btnDel, count > 0);
        setBtn(btnExp, true); // export vẫn cho phép (filter-based) dù không chọn
    }
    function updateBulkBar(selCount) {
        var bar = bulkBar(); if (!bar) return; var cont = getContainer();
        if (selCount > 0) {
            if (!bar.classList.contains('is-active')) bar.classList.add('is-active');
            bar.removeAttribute('inert'); bar.setAttribute('aria-hidden', 'false');
            if (cont) cont.classList.add('bulk-open');
        } else {
            bar.classList.remove('is-active'); bar.setAttribute('inert', ''); bar.setAttribute('aria-hidden', 'true');
            if (cont) cont.classList.remove('bulk-open');
        }
        updateBulkButtons();
    }
    function syncHeaderFromRows() {
        var head = headerCb(); var list = rows(); var total = list.length, sel = 0;
        for (var i = 0; i < total; i++) if (list[i].checked) sel++;
        if (head) {
            var all = (sel === total && total > 0);
            head.checked = all; head.indeterminate = (sel > 0 && !all);
            head.setAttribute('aria-checked', head.indeterminate ? 'mixed' : (all ? 'true' : 'false'));
            var wrap = headerWrap();
            if (wrap) {
                if (head.indeterminate) { wrap.classList.add('is-indeterminate'); wrap.classList.remove('is-checked'); }
                else { wrap.classList.remove('is-indeterminate'); wrap.classList.toggle('is-checked', all); }
            }
        }
        updateBulkBar(sel);
    }
    function onHeaderClick(e) {
        e.preventDefault(); e.stopPropagation();
        var head = headerCb(); if (!head) return;
        var chooseAll = !(head.indeterminate || head.checked);
        setAllRows(chooseAll);
        head.indeterminate = false; head.checked = chooseAll; head.setAttribute('aria-checked', chooseAll ? 'true' : 'false');
        var wrap = headerWrap(); if (wrap) { wrap.classList.remove('is-indeterminate'); wrap.classList.toggle('is-checked', !!chooseAll); }
        syncHeaderFromRows(); smartFillerSchedule();
    }

    function bindBulkButtons() {
        var btnDel = $('#btn-docs-bulk-delete');
        if (btnDel && !btnDel.dataset.bound) {
            btnDel.dataset.bound = '1';
            btnDel.addEventListener('click', function (e) {
                if (btnDel.hasAttribute('disabled')) { e.preventDefault(); return; }
                var ids = selectedRowEls().map(function (cb) { return cb.getAttribute('data-doc-id'); }).filter(function (x) { return !!x; });
                if (!ids.length) { safeToast('Chưa chọn văn bản nào.', 'info', 2200); return; }
                if (typeof window.__openDocsBulkDeleteModal === 'function') window.__openDocsBulkDeleteModal(ids.join(','));
                else safeToast('Thiếu module bulk delete.', 'warning', 2200);
            });
        }
        var btnExp = $('#btn-docs-bulk-export');
        if (btnExp && !btnExp.dataset.bound) {
            btnExp.dataset.bound = '1';
            btnExp.addEventListener('click', function () {
                var ids = selectedRowEls().map(function (cb) { return cb.getAttribute('data-doc-id'); }).filter(function (x) { return !!x; }).join(',');
                if (typeof window.__openDocsBulkExportModal === 'function') window.__openDocsBulkExportModal(ids || '');
                else {
                    // Fallback: mở CSV theo filter (không có modal)
                    var url = '/admin/documents/export-csv' + window.__docsFilterQS();
                    if (ids) url += (url.indexOf('?') < 0 ? '?' : '&') + 'ids=' + encodeURIComponent(ids);
                    try { window.open(url, '_blank'); } catch (_) { window.location.href = url; }
                }
            });
        }
    }

    function bindSelection() {
        var head = headerCb(), wrap = headerWrap();
        if (head && !head.dataset.bound) { head.dataset.bound = '1'; head.addEventListener('click', onHeaderClick); }
        if (wrap && !wrap.dataset.bound) { wrap.dataset.bound = '1'; wrap.addEventListener('click', onHeaderClick); }
        rows().forEach(function (cb) { if (!cb.dataset.bound) { cb.dataset.bound = '1'; cb.addEventListener('change', syncHeaderFromRows); } });
        syncHeaderFromRows(); bindBulkButtons();
    }

    /* =============== Pager jump (fallback khi không có HTMX) =============== */
    function bindPageJump() {
        var form = $('#docs-page-jump-form'), input = $('#docs-page-input');
        if (form && !form.dataset.boundSubmit) {
            form.dataset.boundSubmit = '1';
            form.addEventListener('submit', function (e) {
                if (window.htmx) return;
                e.preventDefault();
                var fd = new FormData(form);
                var qs = new URLSearchParams(fd).toString();
                swapOuterHTML('/admin/documents?' + qs, '#documents-list-region');
            });
        }
        if (input && !input.dataset.boundClamp) {
            input.dataset.boundClamp = '1';
            function clamp() {
                var max = intv(input.getAttribute('max') || '1', 1);
                var v = intv(input.value || '1', 1);
                if (v < 1) v = 1; if (v > max) v = max;
                input.value = String(v);
                upsertHiddenInSearchForm('page', String(v));
                var c = getContainer(); if (c) c.dataset.page = String(v);
                return v;
            }
            input.addEventListener('keydown', function (e) {
                if ((e.key || '') === 'Enter' || e.keyCode === 13) {
                    e.preventDefault(); clamp();
                    if (form) {
                        if (window.htmx) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
                        else {
                            var fd = new FormData(form); var qs = new URLSearchParams(fd).toString();
                            swapOuterHTML('/admin/documents?' + qs, '#documents-list-region');
                        }
                    }
                }
            });
            input.addEventListener('blur', clamp);
        }
    }

    /* =============== HTMX enrichment: inject filter params khi swap list =============== */
    document.body.addEventListener('htmx:configRequest', function (e) {
        try {
            var d = e && e.detail ? e.detail : {}; if (!d) return; if (!d.parameters) d.parameters = {};
            var tgt = e && e.target ? e.target : null;
            var isListSwap = false;
            if (tgt) {
                var hxTarget = (tgt.getAttribute && tgt.getAttribute('hx-target')) || '';
                if (hxTarget === '#documents-list-region') isListSwap = true;
                if (!isListSwap && tgt.id === 'documents-list-region') isListSwap = true;
            }
            if (!isListSwap) return;

            var f = window.__docsFilterVals ? window.__docsFilterVals() : currentFilters();
            d.parameters.page = f.page > 0 ? f.page : 1;
            if (f.per_page > 0) d.parameters.per_page = f.per_page;
            if (f.status && f.status !== 'all') d.parameters.status = f.status;
            if (f.chat_id) d.parameters.chat_id = f.chat_id;
            if (f.q) d.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') d.parameters.sort = f.sort;

            // sanitize per_page in path nếu đã có
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

    /* =============== Smart filler rows (đệm cho bảng) =============== */
    var smartFillerRAF = 0, smartFillerTick = 0;
    function smartFillerSchedule() {
        if (smartFillerRAF) cancelAnimationFrame(smartFillerRAF);
        smartFillerRAF = requestAnimationFrame(function () {
            smartFillerRAF = 0;
            var now = Date.now();
            if (now - smartFillerTick < 60) { smartFillerTick = now; return smartFillerSchedule(); }
            smartFillerTick = now; smartFillerRender();
        });
    }
    function smartFillerRender() {
        var tableWrap = $('#admin-documents-table');
        var table = tableWrap ? tableWrap.querySelector('table') : null;
        var body = $('#docs-tbody');
        var filler = $('#docs-filler');
        var pager = $('#docs-pagination');
        if (!table || !body || !filler || !pager) return;
        filler.innerHTML = '';
        if (!body.querySelector('tr')) return;

        var sample = body.querySelector('tr');
        var rowH = sample ? Math.max(44, Math.round(sample.getBoundingClientRect().height)) : 56;
        var space = Math.floor(pager.getBoundingClientRect().top - table.getBoundingClientRect().bottom);
        if (!isFinite(space) || space <= Math.floor(rowH * 0.6)) return;

        var count = Math.floor(space / rowH); if (count <= 0) return; if (count > 80) count = 80;
        var cols = (table.querySelectorAll('colgroup col') || []).length || 7;
        var frag = document.createDocumentFragment();
        for (var i = 0; i < count; i++) {
            var tr = document.createElement('tr'); tr.className = 'docs-filler-row'; tr.setAttribute('aria-hidden', 'true');
            var td = document.createElement('td'); td.setAttribute('colspan', String(cols)); td.className = 'px-4 py-2 border-b border-gray-200'; td.innerHTML = '&nbsp;';
            tr.appendChild(td); frag.appendChild(tr);
        }
        filler.appendChild(frag);
    }
    function observeSidebarForFiller() {
        var sb = document.getElementById('admin-sidebar'); if (!sb || sb._fillerObservedDocs) return; sb._fillerObservedDocs = true;
        try {
            var mo = new MutationObserver(function (list) {
                for (var i = 0; i < list.length; i++) {
                    if (list[i].type === 'attributes' && list[i].attributeName === 'class') { setTimeout(smartFillerSchedule, 420); }
                }
            });
            mo.observe(sb, { attributes: true, attributeFilter: ['class'] });
        } catch (_) { }
    }

    /* =============== Rebind pipeline =============== */
    function sanitizeHxGetPerPage() {
        $all('[hx-get]').forEach(function (el) {
            try {
                var raw = el.getAttribute('hx-get') || ''; if (!raw) return;
                var u = new URL(raw, location.origin);
                if (u.searchParams.has('per_page')) {
                    u.searchParams.delete('per_page');
                    el.setAttribute('hx-get', u.pathname + (u.searchParams.toString() ? ('?' + u.searchParams.toString()) : ''));
                }
            } catch (_) { /* ignore */ }
        });
    }
    function rebindListOnly() {
        bindRowButtons();
        bindSelection();
        bindPageJump();
        sanitizeHxGetPerPage();
        updateSortLabel();
        setTimeout(function () { updateBulkButtons(); smartFillerSchedule(); }, 0);
    }
    function rebindAll() { bindToolbar(); rebindListOnly(); observeSidebarForFiller(); }

    /* =============== Boot / Hydrate + HTMX hooks =============== */
    function hydrateOnce(root) {
        var cont = (root || document).querySelector('#admin-documents-container'); if (!cont || cont.dataset.hydrated === '1') return;
        cont.dataset.hydrated = '1';
        rebindAll();
    }

    document.addEventListener('DOMContentLoaded', function () { hydrateOnce(document); });

    document.body.addEventListener('htmx:afterSwap', function (e) {
        var d = e && e.detail ? e.detail : {}, tgt = d && d.target ? d.target : null;
        if (tgt && tgt.id === 'documents-list-region') { rebindListOnly(); }
        // Nếu modal load qua HTMX, file modal.js sẽ bind chi tiết
        try { var dlg = document.getElementById('bulkConfirmModal'); if (dlg && dlg.close) dlg.close(); } catch (_) { }
    });
    document.body.addEventListener('htmx:load', function (e) { hydrateOnce(e && e.target ? e.target : document); });
    document.body.addEventListener('htmx:afterOnLoad', function (e) { var d = e ? e.detail : null; hydrateOnce(d && d.target ? d.target : document); smartFillerSchedule(); });
    document.body.addEventListener('htmx:afterSettle', function (e) { var d = e ? e.detail : null; hydrateOnce(d && d.target ? d.target : document); });

    // Global toast cho kết quả đơn lẻ (nếu backend gửi HX-Trigger)
    document.body.addEventListener('documents-single-result', function (ev) {
        var d = ev && ev.detail ? ev.detail : {}; if (!window.Toast || !Toast.show) return;
        var action = d.action || ''; var ok = !!d.ok;
        if (action === 'create') { Toast.show(ok ? 'Tạo văn bản thành công!' : 'Tạo văn bản thất bại.', ok ? 'success' : 'error', 2600); }
        if (action === 'update') { Toast.show(ok ? 'Cập nhật văn bản thành công!' : 'Cập nhật văn bản thất bại.', ok ? 'success' : 'error', 2600); }
        if (action === 'delete') { Toast.show(ok ? 'Đã xoá văn bản.' : 'Xoá văn bản thất bại.', ok ? 'success' : 'error', 2600); }
    });

    // Recalc khi resize
    window.addEventListener('resize', smartFillerSchedule);
})();

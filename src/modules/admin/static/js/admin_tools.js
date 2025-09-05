/********************************************************************
 * File   : src/modules/admin/static/js/admin_tools.js
 * Updated: 2025-08-24 (v1.5 – unify filter source-of-truth = search form;
 *                      fix refresh after edit/toggle under active filters;
 *                      keep container dataset in sync for fallback)
 * Scope  : Trang “Quản lý tiện ích hệ thống” (ToolDefinition)
 ********************************************************************/
(function () {
    /* ───────────────────────── Helpers ───────────────────────── */
    function intv(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
    function $(sel, root) { return (root || document).querySelector(sel); }
    function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    function getCsrf() {
        var bar = $('#tools-bulk-bar');
        if (bar && bar.getAttribute('data-csrf')) return bar.getAttribute('data-csrf');
        var meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? (meta.getAttribute('content') || '') : '';
    }

    function encodeForm(obj) {
        var s = []; for (var k in obj) if (obj.hasOwnProperty(k)) {
            var v = obj[k]; if (v == null) v = '';
            s.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
        }
        return s.join('&');
    }

    // NOTE: truyền status code vào cb để phân biệt lỗi
    function postForm(url, data, headers, cb) {
        var xhr = new XMLHttpRequest(); xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
        xhr.setRequestHeader('HX-Request', 'true');
        if (headers) { for (var k in headers) if (headers.hasOwnProperty(k)) xhr.setRequestHeader(k, headers[k]); }
        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) {
                var status = xhr.status, body = xhr.responseText || '';
                if (status >= 200 && status < 300) { if (cb) cb(null, body, status); }
                else { if (cb) cb(new Error('HTTP ' + status), body, status); }
            }
        };
        xhr.send(typeof data === 'string' ? data : encodeForm(data || {}));
    }

    function fetchText(url) {
        return new Promise(function (resolve, reject) {
            try {
                var xhr = new XMLHttpRequest(); xhr.open('GET', url, true);
                xhr.setRequestHeader('HX-Request', 'true');
                xhr.onreadystatechange = function () {
                    if (xhr.readyState === 4) {
                        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText || ''); else reject(new Error('HTTP ' + xhr.status));
                    }
                };
                xhr.send();
            } catch (e) { reject(e); }
        });
    }
    function makeFakeXhr(status, body) { return { status: status || 200, responseText: body || '', response: body || '', getResponseHeader: function () { return null; } }; }
    function createCE(name, detail) {
        try { return new CustomEvent(name, { detail: detail }); }
        catch (e) { var evt = document.createEvent('CustomEvent'); evt.initCustomEvent(name, false, false, detail); return evt; }
    }
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

    /* ───────────────────────── Filter state ───────────────────────── */
    function getContainer() { return $('#admin-tools-container'); }

    // Ưu tiên đọc từ search form (single source-of-truth), fallback dataset
    function formVal(name, fallback) {
        var sf = $('#tools-search-form'); if (!sf) return fallback;
        var el = sf.querySelector('input[name="' + name + '"]');
        var v = el ? (el.value != null ? String(el.value).trim() : '') : '';
        if (v === '') return fallback;
        return v;
    }

    function currentFilters() {
        var c = getContainer() || { dataset: {} };
        var qInp = $('#tools-search-input');

        // dataset fallback
        var dsEnabled = (c.dataset.enabled) || 'all';
        var dsScope = (c.dataset.scope) || 'any';
        var dsSortUI = (c.dataset.currentSort) || 'new';
        var dsPage = intv(c.dataset.page || '1', 1);
        var dsPerPage = intv(c.dataset.perPage || '10', 10);
        var dsQ = (c.dataset.q || '');

        // form-first
        var enabled = formVal('enabled', dsEnabled);
        var scope = formVal('scope', dsScope);
        var sort = formVal('sort', null); // canonical nếu có
        var page = intv(formVal('page', dsPage), dsPage);
        var perPage = intv(formVal('per_page', dsPerPage), dsPerPage);
        var q = qInp ? (qInp.value || '') : (formVal('q', dsQ));

        return {
            enabled: enabled || 'all',
            scope: scope || 'any',
            q: q || '',
            sort: sort || dsSortUI, // có thể là UI-key ('new'|...) hoặc canonical
            page: page,
            per_page: perPage
        };
    }

    function uiSortToCanonical(v) {
        switch (String(v || '').toLowerCase()) {
            case 'old': return 'created_asc';
            case 'az': return 'name_az';
            case 'za': return 'name_za';
            case 'order_up': return 'order_asc';
            case 'order_down': return 'order_desc';
            case 'new':
            default: return 'created_desc';
        }
    }

    function buildQS(f) {
        var parts = [];
        if (f.enabled && f.enabled !== 'all') parts.push('enabled=' + encodeURIComponent(f.enabled));
        if (f.scope && f.scope !== 'any') parts.push('scope=' + encodeURIComponent(f.scope));
        if (f.q) parts.push('q=' + encodeURIComponent(f.q));

        // f.sort có thể là UI key → canonical
        var sortCanon = uiSortToCanonical(f.sort || 'new');
        if (sortCanon !== 'created_desc') parts.push('sort=' + encodeURIComponent(sortCanon));

        parts.push('page=' + (f.page > 0 ? f.page : 1));
        if (f.per_page > 0) parts.push('per_page=' + f.per_page);
        return parts.length ? ('?' + parts.join('&')) : '';
    }

    // Expose cho bulk/modal dùng — luôn dựa vào form-first
    window.__toolsFilterVals = function () {
        var f = currentFilters();
        return {
            enabled: f.enabled,
            scope: f.scope,
            q: f.q,
            sort: uiSortToCanonical(f.sort), // luôn canonical để server dễ xử lý
            page: f.page,
            per_page: f.per_page
        };
    };
    window.__toolsFilterQS = function () { return buildQS(currentFilters()); };

    function upsertHiddenInSearchForm(name, val) {
        var form = $('#tools-search-form'); if (!form) return;
        var el = form.querySelector('input[name="' + name + '"]');
        if (val == null || val === '') {
            if (el && el.parentNode) el.parentNode.removeChild(el);
            return;
        }
        if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
        el.value = String(val);
    }

    /* ───────────────────────── Reload list ───────────────────────── */
    function loadList() {
        var form = $('#tools-search-form');
        if (form && window.htmx) {
            if (form.requestSubmit) form.requestSubmit(); else form.submit();
        } else {
            swapOuterHTML('/admin/tools' + window.__toolsFilterQS(), '#tools-list-region');
        }
    }

    /* ───────────────────────── Toolbar: search / filter / sort / CSV ───────────────────────── */
    function updateSortLabel() {
        var span = $('#tools-sort-label .sort-value');
        if (!span) return;
        var f = currentFilters();
        var key = (String(f.sort).indexOf('_') > -1) ? ( // nếu canonical thì map ngược
            (function (canon) {
                switch (canon) {
                    case 'created_asc': return 'old';
                    case 'name_az': return 'az';
                    case 'name_za': return 'za';
                    case 'order_asc': return 'order_up';
                    case 'order_desc': return 'order_down';
                    default: return 'new';
                }
            })(String(f.sort))
        ) : String(f.sort || 'new');

        var m = {
            'new': 'Mới nhất', 'old': 'Cũ nhất', 'az': 'Tên A–Z', 'za': 'Tên Z–A',
            'order_up': 'Thứ tự ↑', 'order_down': 'Thứ tự ↓'
        };
        span.textContent = m[key] || 'Mới nhất';
    }

    function bindToolbar() {
        var s = $('#tools-search-input');
        if (s && !s.dataset.bound) {
            s.dataset.bound = '1';
            s.addEventListener('keydown', function (e) {
                if ((e.key || '') === 'Enter' || e.keyCode === 13) {
                    e.preventDefault();
                    upsertHiddenInSearchForm('page', '1');
                    loadList();
                }
            });
            s.addEventListener('input', function () { upsertHiddenInSearchForm('page', '1'); });
        }

        var btnFilter = $('#btn-tools-filter');
        var menuFilter = $('#menu-tools-filter');
        if (btnFilter && !btnFilter.dataset.bound) {
            btnFilter.dataset.bound = '1';
            btnFilter.addEventListener('click', function () {
                if (!menuFilter) return;
                menuFilter.classList.toggle('hidden');
                btnFilter.setAttribute('aria-expanded', menuFilter.classList.contains('hidden') ? 'false' : 'true');
            });
            document.addEventListener('mousedown', function (ev) {
                if (!menuFilter || menuFilter.classList.contains('hidden')) return;
                if (!menuFilter.contains(ev.target) && ev.target !== btnFilter) menuFilter.classList.add('hidden');
            });
        }
        if (menuFilter && !menuFilter.dataset.bound) {
            menuFilter.dataset.bound = '1';
            menuFilter.addEventListener('click', function (e) {
                var btn = e.target && e.target.closest ? e.target.closest('button.menu-item') : null;
                if (!btn) return;
                var k = btn.getAttribute('data-k'), v = btn.getAttribute('data-v');
                if (!k) return;

                // visual state
                $all('button.menu-item[data-k="' + k + '"]', menuFilter).forEach(function (x) {
                    var same = x.getAttribute('data-v') === v;
                    x.classList.toggle('bg-blue-50', same);
                    x.classList.toggle('text-blue-800', same);
                    x.classList.toggle('ring-blue-300', same);
                    x.classList.toggle('text-gray-900', !same);
                });

                // update form hidden + dataset fallback ngay khi chọn
                upsertHiddenInSearchForm(k, v);
                var c = getContainer(); if (c) c.dataset[k] = v;
                // reset page khi đổi filter
                upsertHiddenInSearchForm('page', '1');
                if (c) c.dataset.page = '1';
            });

            var btnReset = $('#btn-tools-reset', menuFilter);
            if (btnReset && !btnReset.dataset.bound) {
                btnReset.dataset.bound = '1';
                btnReset.addEventListener('click', function () {
                    ['enabled', 'scope'].forEach(function (k) {
                        var val = (k === 'scope' ? 'any' : 'all');
                        upsertHiddenInSearchForm(k, val);
                        var c = getContainer(); if (c) c.dataset[k] = val;
                    });
                    upsertHiddenInSearchForm('page', '1');
                    var c = getContainer(); if (c) c.dataset.page = '1';

                    $all('button.menu-item', menuFilter).forEach(function (x) {
                        var k = x.getAttribute('data-k'); var v = x.getAttribute('data-v');
                        var want = (k === 'scope' ? 'any' : 'all');
                        var active = (v === want);
                        x.classList.toggle('bg-blue-50', active);
                        x.classList.toggle('text-blue-800', active);
                        x.classList.toggle('ring-blue-300', active);
                        x.classList.toggle('text-gray-900', !active);
                    });
                });
            }
            var btnApply = $('#btn-tools-apply', menuFilter);
            if (btnApply && !btnApply.dataset.bound) {
                btnApply.dataset.bound = '1';
                btnApply.addEventListener('click', function () {
                    menuFilter.classList.add('hidden');
                    loadList();
                });
            }
        }

        var btnSort = $('#btn-tools-sort');
        var menuSort = $('#menu-tools-sort');
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
                var item = e.target && e.target.closest ? e.target.closest('button.menu-item') : null;
                if (!item) return;
                var key = item.getAttribute('data-sort') || 'new';
                var canon = uiSortToCanonical(key);
                upsertHiddenInSearchForm('sort', canon);             // canonical vào form
                upsertHiddenInSearchForm('page', '1');

                var c = getContainer();
                if (c) { c.dataset.currentSort = key; c.dataset.page = '1'; }

                updateSortLabel();
                if (menuSort) menuSort.classList.add('hidden');
                loadList();
            });
        }

        var csv = $('#btn-tools-export-csv');
        if (csv && !csv.dataset.bound) {
            csv.dataset.bound = '1';
            csv.addEventListener('click', function (e) {
                e.preventDefault();
                var url = '/admin/tools/export-csv' + window.__toolsFilterQS();
                try { window.open(url, '_blank'); } catch (_) { window.location.href = url; }
            });
        }

        var btnNew = $('#btn-open-tools-new-modal');
        if (btnNew && !btnNew.dataset.bound) {
            btnNew.dataset.bound = '1';
            btnNew.addEventListener('click', function () { openModalGet('/admin/tools/new-modal'); });
        }
    }

    /* ───────────────────────── Modals & row actions ───────────────────────── */
    var MODAL_ROOT_SEL = '#admin-tools-modal-root';
    function openModalGet(path) {
        var root = $(MODAL_ROOT_SEL); if (!root) return;
        fetchText(String(path)).then(function (html) {
            root.innerHTML = html || '';
            var fake = makeFakeXhr(200, html);
            dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
            dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
            dispatchHX('htmx:load', { elt: root });
            dispatchHX('htmx:afterSettle', { target: root, xhr: fake });
        });
    }
    function openDetail(id) { openModalGet('/admin/tools/' + encodeURIComponent(id) + '/detail-modal'); }
    function openEdit(id) { openModalGet('/admin/tools/' + encodeURIComponent(id) + '/edit-modal'); }
    function openDelete(id) { openModalGet('/admin/tools/' + encodeURIComponent(id) + '/delete-modal'); }

    // Toggle enabled
    function toggleEnabled(id, wasOn) {
        var csrf = getCsrf(); var headers = {}; if (csrf) headers['X-CSRF-Token'] = csrf;
        var url = '/admin/tools/' + encodeURIComponent(id) + '/toggle-enabled';
        var f = window.__toolsFilterVals ? window.__toolsFilterVals() : currentFilters();
        var body = { enabled: f.enabled, scope: f.scope, q: f.q, sort: f.sort, page: f.page, per_page: f.per_page };
        postForm(url, body, headers, function (err, html) {
            if (err) {
                if (window.Toast && Toast.show) Toast.show('Thao tác thất bại!', 'error', 3200);
                return;
            }
            // Swap list
            var box = document.createElement('div'); box.innerHTML = (html || '').trim();
            var next = box.querySelector('#tools-list-region'); var cur = $('#tools-list-region');
            if (next && cur && cur.parentNode) {
                cur.parentNode.replaceChild(next, cur);
                var fake = makeFakeXhr(200, html);
                dispatchHX('htmx:afterSwap', { target: next, xhr: fake });
                dispatchHX('htmx:afterOnLoad', { target: next, xhr: fake });
                dispatchHX('htmx:load', { elt: next });
                dispatchHX('htmx:afterSettle', { target: next, xhr: fake });
            }
            if (window.Toast && Toast.show) {
                Toast.show(wasOn ? 'Đã tắt enabled.' : 'Đã bật enabled.', wasOn ? 'error' : 'success', 2000);
            }
        });
    }

    /* ───────────────────────── Selection + Bulk bar ───────────────────────── */
    function rows() { return $all('.row-select'); }
    function headerCb() { return $('#sel-all'); }
    function headerWrap() { return $('#sel-all-wrap'); }
    function bulkBar() { return $('#tools-bulk-bar'); }
    function bulkEnableBtn() { return $('#btn-tools-bulk-enable'); }
    function bulkDisableBtn() { return $('#btn-tools-bulk-disable'); }
    function bulkDeleteBtn() { return $('#btn-tools-bulk-delete'); }
    function bulkExportBtn() { return $('#btn-tools-bulk-export'); }

    function selectedIds() {
        var out = [], list = rows();
        for (var i = 0; i < list.length; i++) { if (list[i].checked) out.push(list[i].getAttribute('data-tool-id')); }
        return out;
    }
    function countEligibleEnable() {
        var list = rows(), n = 0;
        for (var i = 0; i < list.length; i++) {
            if (!list[i].checked) continue;
            var en = list[i].getAttribute('data-enabled');
            if (en !== '1') n++;
        }
        return n;
    }

    function setAllRows(checked) { rows().forEach(function (cb) { cb.checked = !!checked; }); }
    function syncHeaderFromRows() {
        var head = headerCb(); var list = rows(); var total = list.length, sel = 0;
        for (var i = 0; i < total; i++) if (list[i].checked) sel++;
        if (head) {
            var all = (sel === total && total > 0);
            head.checked = all;
            head.indeterminate = (sel > 0 && !all);
            head.setAttribute('aria-checked', head.indeterminate ? 'mixed' : (all ? 'true' : 'false'));
            var wrap = headerWrap();
            if (wrap) {
                if (head.indeterminate) { wrap.classList.add('is-indeterminate'); wrap.classList.remove('is-checked'); }
                else { wrap.classList.remove('is-indeterminate'); wrap.classList.toggle('is-checked', all); }
            }
        }
        updateBulkBar(sel);
    }
    function updateBulkBar(selCount) {
        var bar = bulkBar(); if (!bar) return;
        var cont = getContainer();
        if (selCount > 0) {
            if (bar.className.indexOf('is-active') < 0) bar.className += ' is-active';
            bar.removeAttribute('inert'); bar.setAttribute('aria-hidden', 'false');
            if (cont) cont.classList.add('bulk-open');
        } else {
            bar.className = bar.className.replace(/\bis-active\b/, '').trim();
            bar.setAttribute('inert', ''); bar.setAttribute('aria-hidden', 'true');
            if (cont) cont.classList.remove('bulk-open');
        }
        var enLbl = $('#tools-bulk-enable-label'); if (enLbl) { enLbl.textContent = 'Bật enabled (' + countEligibleEnable() + ')'; }
    }
    function onHeaderClick(e) {
        e.preventDefault(); e.stopPropagation();
        var head = headerCb(); if (!head) return;
        var chooseAll = !(head.indeterminate || head.checked);
        setAllRows(chooseAll);
        head.indeterminate = false; head.checked = chooseAll; head.setAttribute('aria-checked', chooseAll ? 'true' : 'false');
        var wrap = headerWrap(); if (wrap) { wrap.classList.remove('is-indeterminate'); wrap.classList.toggle('is-checked', !!chooseAll); }
        syncHeaderFromRows();
        smartFillerSchedule();
    }

    function bindSelection() {
        var head = headerCb(), wrap = headerWrap();
        if (head && !head.dataset.bound) { head.dataset.bound = '1'; head.addEventListener('click', onHeaderClick); }
        if (wrap && !wrap.dataset.bound) { wrap.dataset.bound = '1'; wrap.addEventListener('click', onHeaderClick); }
        rows().forEach(function (cb) {
            if (!cb.dataset.bound) { cb.dataset.bound = '1'; cb.addEventListener('change', syncHeaderFromRows); }
        });

        var bEn = bulkEnableBtn();
        if (bEn && !bEn.dataset.bound) {
            bEn.dataset.bound = '1';
            bEn.addEventListener('click', function () {
                var ids = selectedIds(); if (!ids.length) { if (window.Toast && Toast.show) Toast.show('Chưa chọn mục nào.', 'info', 2000); return; }
                var allowed = countEligibleEnable();
                if (allowed <= 0) { if (window.Toast && Toast.show) Toast.show('Không có mục nào đủ điều kiện để bật (đã enabled).', 'info', 2800); return; }
                var csrf = getCsrf(), headers = {}; if (csrf) headers['X-CSRF-Token'] = csrf;
                var url = '/admin/tools/bulk-enable';
                var f = window.__toolsFilterVals ? window.__toolsFilterVals() : currentFilters();
                var body = {
                    ids: ids.join(','),
                    enabled: f.enabled, scope: f.scope, q: f.q, sort: f.sort, page: f.page, per_page: f.per_page
                };
                postForm(url, body, headers, function (err, html, status) {
                    if (err) { if (window.Toast && Toast.show) Toast.show('Bật enabled thất bại!', 'error', 2500); return; }
                    var box = document.createElement('div'); box.innerHTML = (html || '').trim();
                    var next = box.querySelector('#tools-list-region'); var cur = $('#tools-list-region');
                    if (next && cur && cur.parentNode) {
                        cur.parentNode.replaceChild(next, cur);
                        var fake = makeFakeXhr(200, html);
                        dispatchHX('htmx:afterSwap', { target: next, xhr: fake });
                        dispatchHX('htmx:afterOnLoad', { target: next, xhr: fake });
                        dispatchHX('htmx:load', { elt: next });
                        dispatchHX('htmx:afterSettle', { target: next, xhr: fake });
                    }
                    if (window.Toast && Toast.show) Toast.show('Đã bật enabled cho các mục phù hợp!', 'success', 2300);
                });
            });
        }

        var bDis = bulkDisableBtn();
        if (bDis && !bDis.dataset.bound) {
            bDis.dataset.bound = '1';
            bDis.addEventListener('click', function () {
                var ids = selectedIds(); if (!ids.length) { if (window.Toast && Toast.show) Toast.show('Chưa chọn mục nào.', 'info', 2000); return; }
                var csrf = getCsrf(), headers = {}; if (csrf) headers['X-CSRF-Token'] = csrf;
                var url = '/admin/tools/bulk-disable';
                var f = window.__toolsFilterVals ? window.__toolsFilterVals() : currentFilters();
                var body = {
                    ids: ids.join(','),
                    enabled: f.enabled, scope: f.scope, q: f.q, sort: f.sort, page: f.page, per_page: f.per_page
                };
                postForm(url, body, headers, function (err, html) {
                    if (err) { if (window.Toast && Toast.show) Toast.show('Tắt enabled thất bại!', 'error', 2500); return; }
                    var box = document.createElement('div'); box.innerHTML = (html || '').trim();
                    var next = box.querySelector('#tools-list-region'); var cur = $('#tools-list-region');
                    if (next && cur && cur.parentNode) {
                        cur.parentNode.replaceChild(next, cur);
                        var fake = makeFakeXhr(200, html);
                        dispatchHX('htmx:afterSwap', { target: next, xhr: fake });
                        dispatchHX('htmx:afterOnLoad', { target: next, xhr: fake });
                        dispatchHX('htmx:load', { elt: next });
                        dispatchHX('htmx:afterSettle', { target: next, xhr: fake });
                    }
                    if (window.Toast && Toast.show) Toast.show('Đã tắt enabled cho các mục đã chọn!', 'success', 2300);
                });
            });
        }

        var bDel = bulkDeleteBtn();
        if (bDel && !bDel.dataset.bound) {
            bDel.dataset.bound = '1';
            bDel.addEventListener('click', function () {
                var ids = selectedIds();
                if (!ids.length) { if (window.Toast && Toast.show) Toast.show('Chưa chọn mục nào.', 'info', 2000); return; }
                if (typeof window.__openToolsBulkDeleteModal === 'function') {
                    window.__openToolsBulkDeleteModal(ids.join(','));
                } else {
                    openModalGet('/admin/tools/bulk-delete-modal?ids=' + encodeURIComponent(ids.join(',')));
                }
            });
        }

        var bCsv = bulkExportBtn();
        if (bCsv && !bCsv.dataset.bound) {
            bCsv.dataset.bound = '1';
            bCsv.addEventListener('click', function () {
                var ids = selectedIds();
                if (typeof window.__openToolsBulkExportModal === 'function') {
                    window.__openToolsBulkExportModal(ids.join(','));
                } else {
                    var url = '/admin/tools/export-csv' + window.__toolsFilterQS();
                    if (ids.length) url += (url.indexOf('?') < 0 ? '?' : '&') + 'ids=' + encodeURIComponent(ids.join(','));
                    try { window.open(url, '_blank'); } catch (_) { window.location.href = url; }
                }
            });
        }

        syncHeaderFromRows();
    }

    /* ───────────────────────── Row buttons delegation ───────────────────────── */
    function bindRowButtons() {
        var tbl = $('#admin-tools-table'); if (!tbl || tbl.dataset.boundDelegation === '1') return;
        tbl.dataset.boundDelegation = '1';
        tbl.addEventListener('click', function (e) {
            var t = e.target || e.srcElement;

            var nameBtn = t && t.closest ? t.closest('.btn-tool-detail') : null;
            if (nameBtn) {
                var id0 = nameBtn.getAttribute('data-tool-id'); if (id0) { e.preventDefault(); openDetail(id0); return; }
            }

            var btn = t && t.closest ? t.closest('.row-action-detail, .row-action-edit, .row-action-delete, .row-action-toggle') : null;
            if (!btn) return;
            e.preventDefault();
            var id = btn.getAttribute('data-tool-id');
            if (!id) return;

            if (btn.classList.contains('row-action-detail')) return openDetail(id);
            if (btn.classList.contains('row-action-edit')) return openEdit(id);
            if (btn.classList.contains('row-action-delete')) return openDelete(id);

            if (btn.classList.contains('row-action-toggle')) {
                var enAttr = btn.getAttribute('data-enabled');
                var wasOn = (enAttr === '1' || enAttr === 'true');
                return toggleEnabled(id, wasOn);
            }
        });
    }

    /* ───────────────────────── Pager jump (fallback) ───────────────────────── */
    function bindPageJump() {
        var form = $('#tools-page-jump-form'), input = $('#tools-page-input');
        if (form && !form.dataset.boundSubmit) {
            form.dataset.boundSubmit = '1';
            form.addEventListener('submit', function (e) {
                if (window.htmx) return;
                e.preventDefault();
                var fd = new FormData(form); var qs = new URLSearchParams(fd).toString();
                swapOuterHTML('/admin/tools?' + qs, '#tools-list-region');
            });
        }
        if (input && !input.dataset.boundClamp) {
            input.dataset.boundClamp = '1';
            function clamp() {
                var max = intv(input.getAttribute('max') || '1', 1);
                var v = intv(input.value || '1', 1);
                if (v < 1) v = 1; if (v > max) v = max; input.value = String(v);
                upsertHiddenInSearchForm('page', String(v));
                var c = getContainer(); if (c) c.dataset.page = String(v);
                return v;
            }
            input.addEventListener('keydown', function (e) {
                if ((e.key || '') === 'Enter' || e.keyCode === 13) {
                    e.preventDefault(); clamp();
                    if (form) {
                        if (window.htmx) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
                        else { var fd = new FormData(form); var qs = new URLSearchParams(fd).toString(); swapOuterHTML('/admin/tools?' + qs, '#tools-list-region'); }
                    }
                }
            });
            input.addEventListener('blur', clamp);
        }
    }

    /* ───────────────────────── HTMX request enrichment ───────────────────────── */
    document.body.addEventListener('htmx:configRequest', function (e) {
        try {
            var d = e && e.detail ? e.detail : {}; if (!d) return;
            if (!d.parameters) d.parameters = {};
            var tgt = e && e.target ? e.target : null;

            var isListSwap = false;
            if (tgt) {
                var hxTarget = (tgt.getAttribute && tgt.getAttribute('hx-target')) || '';
                if (hxTarget === '#tools-list-region') isListSwap = true;
                if (!isListSwap && tgt.id === 'tools-list-region') isListSwap = true;
            }
            if (!isListSwap) return;

            var f = window.__toolsFilterVals ? window.__toolsFilterVals() : currentFilters();
            d.parameters.page = f.page > 0 ? f.page : 1;
            if (f.per_page > 0) d.parameters.per_page = f.per_page;

            if (f.enabled && f.enabled !== 'all') d.parameters.enabled = f.enabled;
            if (f.scope && f.scope !== 'any') d.parameters.scope = f.scope;
            if (f.q) d.parameters.q = f.q;
            var sortCanon = f.sort && f.sort.indexOf('_') > -1 ? f.sort : uiSortToCanonical(f.sort);
            if (sortCanon !== 'created_desc') d.parameters.sort = sortCanon;

            var path = String(d.path || d.url || '');
            if (path) {
                try {
                    var u = new URL(path, location.origin);
                    if (u.searchParams.has('per_page')) {
                        u.searchParams.delete('per_page');
                        d.path = u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
                    }
                } catch (_) {
                    d.path = path.replace(/([?&])per_page=\d+&?/g, '$1').replace(/[?&]$/, '');
                }
            }
        } catch (_) { }
    });

    /* ───────────────────────── Smart filler rows ───────────────────────── */
    var smartFillerRAF = 0, smartFillerTick = 0;
    function smartFillerSchedule() {
        if (smartFillerRAF) cancelAnimationFrame(smartFillerRAF);
        smartFillerRAF = requestAnimationFrame(function () {
            smartFillerRAF = 0;
            var now = Date.now();
            if (now - smartFillerTick < 60) { smartFillerTick = now; return smartFillerSchedule(); }
            smartFillerTick = now;
            smartFillerRender();
        });
    }
    function smartFillerRender() {
        var tableWrap = $('#admin-tools-table');
        var table = tableWrap ? tableWrap.querySelector('table') : null;
        var body = $('#tools-tbody');
        var filler = $('#tools-filler');
        var pager = $('#tools-pagination');
        if (!table || !body || !filler || !pager) return;

        filler.innerHTML = '';
        if (!body.querySelector('tr')) return;

        var sample = body.querySelector('tr');
        var rowH = sample ? Math.max(44, Math.round(sample.getBoundingClientRect().height)) : 56;

        var space = Math.floor(pager.getBoundingClientRect().top - table.getBoundingClientRect().bottom);
        if (!isFinite(space) || space <= Math.floor(rowH * 0.6)) return;

        var count = Math.floor(space / rowH);
        if (count <= 0) return;
        if (count > 80) count = 80;

        var cols = (table.querySelectorAll('colgroup col') || []).length || 7;
        var frag = document.createDocumentFragment();
        for (var i = 0; i < count; i++) {
            var tr = document.createElement('tr');
            tr.className = 'tools-filler-row';
            tr.setAttribute('aria-hidden', 'true');
            var td = document.createElement('td');
            td.setAttribute('colspan', String(cols));
            td.className = 'px-4 py-2 border-b border-gray-200';
            td.innerHTML = '&nbsp;';
            tr.appendChild(td);
            frag.appendChild(tr);
        }
        filler.appendChild(frag);
    }
    function observeSidebarForFiller() {
        var sb = document.getElementById('admin-sidebar');
        if (!sb || sb._fillerObserved) return;
        sb._fillerObserved = true;
        try {
            var mo = new MutationObserver(function (list) {
                for (var i = 0; i < list.length; i++) {
                    if (list[i].type === 'attributes' && list[i].attributeName === 'class') {
                        setTimeout(smartFillerSchedule, 420);
                    }
                }
            });
            mo.observe(sb, { attributes: true, attributeFilter: ['class'] });
        } catch (_) { /* ignore */ }
    }

    /* ───────────────────────── Rebind pipeline ───────────────────────── */
    function sanitizeHxGetPerPage() {
        $all('[hx-get]').forEach(function (el) {
            try {
                var raw = el.getAttribute('hx-get') || '';
                if (!raw) return;
                var u = new URL(raw, location.origin);
                if (u.searchParams.has('per_page')) {
                    u.searchParams.delete('per_page');
                    el.setAttribute('hx-get', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : ''));
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
        setTimeout(smartFillerSchedule, 0);
    }
    function rebindAll() {
        bindToolbar();
        rebindListOnly();
        observeSidebarForFiller();
    }

    /* ───────────────────────── Boot / Hydrate + hooks ───────────────────────── */
    function hydrateOnce(root) {
        var cont = (root || document).querySelector('#admin-tools-container');
        if (!cont || cont.dataset.hydrated === '1') return;
        cont.dataset.hydrated = '1';
        rebindAll();
    }
    document.addEventListener('DOMContentLoaded', function () { hydrateOnce(document); });
    document.body.addEventListener('htmx:afterSwap', function (e) {
        var d = e && e.detail ? e.detail : {}, tgt = d && d.target ? d.target : null;
        if (tgt && tgt.id === 'tools-list-region') {
            rebindListOnly();
        }
    });
    document.body.addEventListener('htmx:load', function (e) { hydrateOnce(e && e.target ? e.target : document); });
    document.body.addEventListener('htmx:afterOnLoad', function (e) {
        var d = e ? e.detail : null; hydrateOnce(d && d.target ? d.target : document);
        smartFillerSchedule();
    });
    document.body.addEventListener('htmx:afterSettle', function (e) { var d = e ? e.detail : null; hydrateOnce(d && d.target ? d.target : document); });

    // Recalc khi resize
    window.addEventListener('resize', smartFillerSchedule);
})();

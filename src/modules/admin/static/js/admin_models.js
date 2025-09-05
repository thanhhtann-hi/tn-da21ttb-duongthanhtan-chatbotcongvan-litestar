/********************************************************************
 * File   : src/modules/admin/static/js/admin_models.js
 * Updated: 2025-08-24 (v1.6 – Gộp fragment, fix filter/sort/reset,
 *                      canonical sort, sync dataset + hidden, no dup binds)
 * Scope  : Trang “Quản lý mô hình AI” (ModelVariant)
 ********************************************************************/
(function () {
    /* ───────────────────────── Helpers ───────────────────────── */
    function intv(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
    function $(sel, root) { return (root || document).querySelector(sel); }
    function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    function getCsrf() {
        var bar = $('#models-bulk-bar');
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

    function getSearchForm() { return document.querySelector('#models-search-form'); }
    function _hid(name) {
        var f = getSearchForm(); if (!f) return null;
        var el = f.querySelector('input[name="' + name + '"]'); return el ? (el.value || '') : null;
    }

    /* ───────────────────────── Filter state ───────────────────────── */
    function getContainer() { return $('#admin-models-container'); }
    function uiSortToCanonical(v) {
        switch (String(v || '').toLowerCase()) {
            case 'old': return 'created_asc';
            case 'az': return 'name_az';
            case 'za': return 'name_za';
            case 'prov_az': return 'provider_az';
            case 'prov_za': return 'provider_za';
            case 'new':
            default: return 'created_desc';
        }
    }
    function currentFilters() {
        var c = getContainer() || { dataset: {} };
        var qInp = $('#models-search-input');
        var pInp = $('#models-provider-form input[name="provider"]');
        var tInp = $('#models-type-form input[name="type"]');
        return {
            // Ưu tiên hidden trong form, fallback dataset
            status: _hid('status') || c.dataset.status || 'all',
            scope: _hid('scope') || c.dataset.scope || 'any',
            tier: _hid('tier') || c.dataset.tier || 'all',
            enabled: _hid('enabled') || c.dataset.enabled || 'all',
            provider: (pInp ? (pInp.value || '') : '') || c.dataset.provider || '',
            type: (tInp ? (tInp.value || '') : '') || c.dataset.type || '',
            q: (qInp ? (qInp.value || '') : ''),
            // dataset.currentSort là UI key; hidden sort là canonical
            sort: (c.dataset.currentSort) || 'new',
            page: intv(c.dataset.page || (_hid('page') || '1'), 1),
            per_page: intv(c.dataset.perPage || (_hid('per_page') || '10'), 10)
        };
    }
    function buildQS(f) {
        var parts = [];
        if (f.status && f.status !== 'all') parts.push('status=' + encodeURIComponent(f.status));
        if (f.scope && f.scope !== 'any') parts.push('scope=' + encodeURIComponent(f.scope));
        if (f.tier && f.tier !== 'all') parts.push('tier=' + encodeURIComponent(f.tier));
        if (f.enabled && f.enabled !== 'all') parts.push('enabled=' + encodeURIComponent(f.enabled));
        if (f.provider) parts.push('provider=' + encodeURIComponent(f.provider));
        if (f.type) parts.push('type=' + encodeURIComponent(f.type));
        if (f.q) parts.push('q=' + encodeURIComponent(f.q));
        var sortCanon = uiSortToCanonical(f.sort || 'new');
        if (sortCanon !== 'created_desc') parts.push('sort=' + encodeURIComponent(sortCanon));
        parts.push('page=' + (f.page > 0 ? f.page : 1));
        if (f.per_page > 0) parts.push('per_page=' + f.per_page);
        return parts.length ? ('?' + parts.join('&')) : '';
    }
    window.__modelsFilterVals = function () {
        var f = currentFilters();
        return {
            status: f.status, scope: f.scope, tier: f.tier, enabled: f.enabled,
            provider: f.provider, type: f.type, q: f.q, sort: uiSortToCanonical(f.sort),
            page: f.page, per_page: f.per_page
        };
    };
    window.__modelsFilterQS = function () { return buildQS(currentFilters()); };

    function upsertHiddenInForms(name, val) {
        ['#models-search-form', '#models-provider-form', '#models-type-form'].forEach(function (sel) {
            var form = $(sel); if (!form) return;
            var el = form.querySelector('input[name="' + name + '"]');
            if (val == null || val === '') {
                if (el && el.parentNode) el.parentNode.removeChild(el);
                return;
            }
            if (!el) {
                el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el);
            }
            el.value = String(val);
        });
    }

    /* ───────────────────────── Reload list ───────────────────────── */
    function loadList() {
        var form = $('#models-search-form');
        if (form && window.htmx) {
            if (form.requestSubmit) form.requestSubmit(); else form.submit();
        } else {
            swapOuterHTML('/admin/models' + window.__modelsFilterQS(), '#models-list-region');
        }
    }

    /* ───────────────────────── Toolbar: search / filter / sort / CSV ───────────────────────── */
    function updateSortLabel() {
        var span = $('#models-sort-label .sort-value');
        if (!span) return;
        var f = currentFilters();
        var m = {
            'new': 'Mới nhất', 'old': 'Cũ nhất', 'az': 'Tên A–Z', 'za': 'Tên Z–A',
            'prov_az': 'Nhà cung cấp A–Z', 'prov_za': 'Nhà cung cấp Z–A'
        };
        span.textContent = m[f.sort] || 'Mới nhất';
    }

    function bindToolbar() {
        var s = $('#models-search-input');
        if (s && !s.dataset.bound) {
            s.dataset.bound = '1';
            s.addEventListener('keydown', function (e) {
                if ((e.key || '') === 'Enter' || e.keyCode === 13) {
                    e.preventDefault();
                    upsertHiddenInForms('page', '1');
                    var c = getContainer(); if (c) c.dataset.page = '1';
                    loadList();
                }
            });
            s.addEventListener('input', function () {
                upsertHiddenInForms('page', '1');
                var c = getContainer(); if (c) c.dataset.page = '1';
            });
        }

        var p = $('#models-provider-form input[name="provider"]');
        if (p && !p.dataset.bound) {
            p.dataset.bound = '1';
            p.addEventListener('change', function () {
                upsertHiddenInForms('page', '1');
                var c = getContainer(); if (c) { c.dataset.provider = p.value || ''; c.dataset.page = '1'; }
            });
            p.addEventListener('keyup', function () {
                upsertHiddenInForms('page', '1');
                var c = getContainer(); if (c) { c.dataset.provider = p.value || ''; }
            });
        }

        var t = $('#models-type-form input[name="type"]');
        if (t && !t.dataset.bound) {
            t.dataset.bound = '1';
            t.addEventListener('change', function () {
                upsertHiddenInForms('page', '1');
                var c = getContainer(); if (c) { c.dataset.type = t.value || ''; c.dataset.page = '1'; }
            });
            t.addEventListener('keyup', function () {
                upsertHiddenInForms('page', '1');
                var c = getContainer(); if (c) { c.dataset.type = t.value || ''; }
            });
        }

        var btnFilter = $('#btn-models-filter');
        var menuFilter = $('#menu-models-filter');
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

                // Active styles
                $all('button.menu-item[data-k="' + k + '"]', menuFilter).forEach(function (x) {
                    var same = x.getAttribute('data-v') === v;
                    x.classList.toggle('bg-blue-50', same);
                    x.classList.toggle('text-blue-800', same);
                    x.classList.toggle('ring-blue-300', same);
                    x.classList.toggle('text-gray-900', !same);
                });

                // Cập nhật hidden + dataset + page
                upsertHiddenInForms(k, v);
                var c = getContainer(); if (c) c.dataset[k] = v;
                upsertHiddenInForms('page', '1'); if (c) c.dataset.page = '1';
            });

            var btnReset = $('#btn-models-reset', menuFilter);
            if (btnReset && !btnReset.dataset.bound) {
                btnReset.dataset.bound = '1';
                btnReset.addEventListener('click', function () {
                    ['status', 'tier', 'enabled'].forEach(function (k) { upsertHiddenInForms(k, 'all'); });
                    upsertHiddenInForms('scope', 'any');
                    upsertHiddenInForms('page', '1');
                    var c = getContainer(); if (c) { c.dataset.status = 'all'; c.dataset.tier = 'all'; c.dataset.enabled = 'all'; c.dataset.scope = 'any'; c.dataset.page = '1'; }

                    // refresh chip styles
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
            var btnApply = $('#btn-models-apply', menuFilter);
            if (btnApply && !btnApply.dataset.bound) {
                btnApply.dataset.bound = '1';
                btnApply.addEventListener('click', function () {
                    upsertHiddenInForms('page', '1');
                    var c = getContainer(); if (c) c.dataset.page = '1';
                    menuFilter.classList.add('hidden');
                    loadList();
                });
            }
        }

        var btnSort = $('#btn-models-sort');
        var menuSort = $('#menu-models-sort');
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

                // hidden sort = canonical; dataset giữ UI key
                upsertHiddenInForms('sort', uiSortToCanonical(key));
                upsertHiddenInForms('page', '1');
                var c = getContainer(); if (c) { c.dataset.currentSort = key; c.dataset.page = '1'; }
                updateSortLabel();

                if (menuSort) menuSort.classList.add('hidden');
                loadList();
            });
        }

        var csv = $('#btn-models-export-csv');
        if (csv && !csv.dataset.bound) {
            csv.dataset.bound = '1';
            csv.addEventListener('click', function (e) {
                e.preventDefault();
                var url = '/admin/models/export-csv' + window.__modelsFilterQS();
                try { window.open(url, '_blank'); } catch (_) { window.location.href = url; }
            });
        }

        var btnNew = $('#btn-open-models-new-modal');
        if (btnNew && !btnNew.dataset.bound) {
            btnNew.dataset.bound = '1';
            btnNew.addEventListener('click', function () { openModalGet('/admin/models/new-modal'); });
        }

        // Cờ để tránh bind trùng từ các script khác (đã gộp)
        window.__MODELS_TOOLBAR_BOUND__ = '1';
    }

    /* ───────────────────────── Modals & row actions ───────────────────────── */
    var MODAL_ROOT_SEL = '#admin-models-modal-root';
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
    function openDetail(id) { openModalGet('/admin/models/' + encodeURIComponent(id) + '/detail-modal'); }
    function openEdit(id) { openModalGet('/admin/models/' + encodeURIComponent(id) + '/edit-modal'); }
    function openDelete(id) { openModalGet('/admin/models/' + encodeURIComponent(id) + '/delete-modal'); }

    // Toggle enabled — hiển thị toast đúng + chặn bật khi retired
    function toggleEnabled(id, wasOn) {
        var csrf = getCsrf(); var headers = {}; if (csrf) headers['X-CSRF-Token'] = csrf;
        var url = '/admin/models/' + encodeURIComponent(id) + '/toggle-enabled';
        var f = window.__modelsFilterVals ? window.__modelsFilterVals() : currentFilters();
        var body = {
            status: f.status, scope: f.scope, tier: f.tier, enabled: f.enabled, provider: f.provider, type: f.type,
            q: f.q, sort: uiSortToCanonical(f.sort), page: f.page, per_page: f.per_page
        };
        postForm(url, body, headers, function (err, html, status) {
            if (err) {
                var msg = 'Thao tác thất bại!';
                if (status === 400 && (html || '').toLowerCase().indexOf('retired') >= 0) {
                    msg = "Không thể bật vì mô hình đang ở trạng thái 'retired'. Hãy chuyển trạng thái về 'active' trước.";
                }
                if (window.Toast && Toast.show) Toast.show(msg, 'error', 3200);
                return;
            }
            // Swap list
            var box = document.createElement('div'); box.innerHTML = (html || '').trim();
            var next = box.querySelector('#models-list-region'); var cur = $('#models-list-region');
            if (next && cur && cur.parentNode) {
                cur.parentNode.replaceChild(next, cur);
                var fake = makeFakeXhr(200, html);
                dispatchHX('htmx:afterSwap', { target: next, xhr: fake });
                dispatchHX('htmx:afterOnLoad', { target: next, xhr: fake });
                dispatchHX('htmx:load', { elt: next });
                dispatchHX('htmx:afterSettle', { target: next, xhr: fake });
            }
            if (window.Toast && Toast.show) {
                // Bật: success; Tắt: error (chuẩn hệ thống)
                Toast.show(wasOn ? 'Đã tắt enabled.' : 'Đã bật enabled.', wasOn ? 'error' : 'success', 2000);
            }
        });
    }

    /* ───────────────────────── Selection + Bulk bar ───────────────────────── */
    function rows() { return $all('.row-select'); }
    function headerCb() { return $('#sel-all'); }
    function headerWrap() { return $('#sel-all-wrap'); }
    function bulkBar() { return $('#models-bulk-bar'); }
    function bulkEnableBtn() { return $('#btn-bulk-enable'); }
    function bulkDisableBtn() { return $('#btn-bulk-disable'); }
    function bulkExportBtn() { return $('#btn-bulk-export'); }
    function bulkRetireBtn() { return $('#btn-bulk-retire'); } // NEW

    function selectedIds() {
        var out = [], list = rows();
        for (var i = 0; i < list.length; i++) { if (list[i].checked) out.push(list[i].getAttribute('data-model-id')); }
        return out;
    }
    function countEligibleEnable() {
        var list = rows(), n = 0;
        for (var i = 0; i < list.length; i++) {
            if (!list[i].checked) continue;
            var en = list[i].getAttribute('data-enabled');
            var st = (list[i].getAttribute('data-status') || '').toLowerCase();
            if ((en !== '1') && st !== 'retired') n++;
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
        var enLbl = $('#bulk-enable-label'); if (enLbl) { enLbl.textContent = 'Bật enabled (' + countEligibleEnable() + ')'; }
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
                if (allowed <= 0) { if (window.Toast && Toast.show) Toast.show('Không có mục nào đủ điều kiện để bật (đã enabled hoặc retired).', 'info', 2800); return; }
                var csrf = getCsrf(), headers = {}; if (csrf) headers['X-CSRF-Token'] = csrf;
                var url = '/admin/models/bulk-enable';
                var f = window.__modelsFilterVals ? window.__modelsFilterVals() : currentFilters();
                var body = {
                    ids: ids.join(','),
                    status: f.status, scope: f.scope, tier: f.tier, enabled: f.enabled, provider: f.provider, type: f.type,
                    q: f.q, sort: uiSortToCanonical(f.sort), page: f.page, per_page: f.per_page
                };
                postForm(url, body, headers, function (err, html) {
                    if (err) { if (window.Toast && Toast.show) Toast.show('Bật enabled thất bại!', 'error', 2500); return; }
                    var box = document.createElement('div'); box.innerHTML = (html || '').trim();
                    var next = box.querySelector('#models-list-region'); var cur = $('#models-list-region');
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
                var url = '/admin/models/bulk-disable';
                var f = window.__modelsFilterVals ? window.__modelsFilterVals() : currentFilters();
                var body = {
                    ids: ids.join(','),
                    status: f.status, scope: f.scope, tier: f.tier, enabled: f.enabled, provider: f.provider, type: f.type,
                    q: f.q, sort: uiSortToCanonical(f.sort), page: f.page, per_page: f.per_page
                };
                postForm(url, body, headers, function (err, html) {
                    if (err) { if (window.Toast && Toast.show) Toast.show('Tắt enabled thất bại!', 'error', 2500); return; }
                    var box = document.createElement('div'); box.innerHTML = (html || '').trim();
                    var next = box.querySelector('#models-list-region'); var cur = $('#models-list-region');
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

        // NEW: Bulk retire
        var bRet = bulkRetireBtn();
        if (bRet && !bRet.dataset.bound) {
            bRet.dataset.bound = '1';
            bRet.addEventListener('click', function () {
                var ids = selectedIds();
                if (!ids.length) { if (window.Toast && Toast.show) Toast.show('Chưa chọn mục nào.', 'info', 2000); return; }
                if (typeof window.__openBulkDeleteModal === 'function') {
                    window.__openBulkDeleteModal(ids.join(','));
                } else {
                    openModalGet('/admin/models/bulk-delete-modal?ids=' + encodeURIComponent(ids.join(',')));
                }
            });
        }

        var bCsv = bulkExportBtn();
        if (bCsv && !bCsv.dataset.bound) {
            bCsv.dataset.bound = '1';
            bCsv.addEventListener('click', function () {
                var ids = selectedIds();
                if (typeof window.__openBulkExportModal === 'function') {
                    window.__openBulkExportModal(ids.join(','));
                } else {
                    var url = '/admin/models/export-csv' + window.__modelsFilterQS();
                    if (ids.length) url += (url.indexOf('?') < 0 ? '?' : '&') + 'ids=' + encodeURIComponent(ids.join(','));
                    try { window.open(url, '_blank'); } catch (_) { window.location.href = url; }
                }
            });
        }

        syncHeaderFromRows();
    }

    /* ───────────────────────── Row buttons delegation ───────────────────────── */
    function bindRowButtons() {
        var tbl = $('#admin-models-table'); if (!tbl || tbl.dataset.boundDelegation === '1') return;
        tbl.dataset.boundDelegation = '1';
        tbl.addEventListener('click', function (e) {
            var t = e.target || e.srcElement;
            var nameBtn = t && t.closest ? t.closest('.btn-model-detail') : null;
            if (nameBtn) {
                var id = nameBtn.getAttribute('data-model-id'); if (id) { e.preventDefault(); openDetail(id); return; }
            }
            var btn = t && t.closest ? t.closest('.row-action-detail, .row-action-edit, .row-action-delete, .row-action-toggle') : null;
            if (!btn) return;
            e.preventDefault();
            var id = btn.getAttribute('data-model-id');
            if (!id) return;

            if (btn.classList.contains('row-action-detail')) return openDetail(id);
            if (btn.classList.contains('row-action-edit')) return openEdit(id);
            if (btn.classList.contains('row-action-delete')) return openDelete(id);

            if (btn.classList.contains('row-action-toggle')) {
                var enAttr = btn.getAttribute('data-enabled');
                var wasOn = (enAttr === '1' || enAttr === 'true');

                // PRECHECK: nếu đang retired và người dùng muốn BẬT thì báo ngay
                if (!wasOn) {
                    var tr = btn.closest('tr');
                    var cb = tr ? tr.querySelector('.row-select') : null;
                    var st = cb ? (cb.getAttribute('data-status') || '').toLowerCase() : '';
                    if (st === 'retired') {
                        if (window.Toast && Toast.show)
                            Toast.show("Không thể bật vì mô hình đang ở trạng thái 'retired'. Hãy chuyển trạng thái về 'active' trước.", 'error', 3200);
                        return;
                    }
                }
                return toggleEnabled(id, wasOn);
            }
        });
    }

    /* ───────────────────────── Pager jump (fallback) ───────────────────────── */
    function bindPageJump() {
        var form = $('#models-page-jump-form'), input = $('#models-page-input');
        if (form && !form.dataset.boundSubmit) {
            form.dataset.boundSubmit = '1';
            form.addEventListener('submit', function (e) {
                if (window.htmx) return;
                e.preventDefault();
                var fd = new FormData(form); var qs = new URLSearchParams(fd).toString();
                swapOuterHTML('/admin/models?' + qs, '#models-list-region');
            });
        }
        if (input && !input.dataset.boundClamp) {
            input.dataset.boundClamp = '1';
            function clamp() {
                var max = intv(input.getAttribute('max') || '1', 1);
                var v = intv(input.value || '1', 1);
                if (v < 1) v = 1; if (v > max) v = max; input.value = String(v);
                upsertHiddenInForms('page', String(v));
                var c = getContainer(); if (c) c.dataset.page = String(v);
                return v;
            }
            input.addEventListener('keydown', function (e) {
                if ((e.key || '') === 'Enter' || e.keyCode === 13) {
                    e.preventDefault(); clamp();
                    if (form) {
                        if (window.htmx) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
                        else { var fd = new FormData(form); var qs = new URLSearchParams(fd).toString(); swapOuterHTML('/admin/models?' + qs, '#models-list-region'); }
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
                if (hxTarget === '#models-list-region') isListSwap = true;
                if (!isListSwap && tgt.id === 'models-list-region') isListSwap = true;
            }
            if (!isListSwap) return;

            var f = window.__modelsFilterVals ? window.__modelsFilterVals() : currentFilters();
            d.parameters.page = f.page > 0 ? f.page : 1;
            if (f.per_page > 0) d.parameters.per_page = f.per_page;

            if (f.status && f.status !== 'all') d.parameters.status = f.status;
            if (f.scope && f.scope !== 'any') d.parameters.scope = f.scope;
            if (f.tier && f.tier !== 'all') d.parameters.tier = f.tier;
            if (f.enabled && f.enabled !== 'all') d.parameters.enabled = f.enabled;
            if (f.provider) d.parameters.provider = f.provider;
            if (f.type) d.parameters.type = f.type;
            if (f.q) d.parameters.q = f.q;
            var sortCanon = uiSortToCanonical(f.sort);
            if (sortCanon !== 'created_desc') d.parameters.sort = sortCanon;

            // loại bỏ per_page trong URL hx-get để tránh nhân đôi
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
        var tableWrap = $('#admin-models-table');
        var table = tableWrap ? tableWrap.querySelector('table') : null;
        var body = $('#models-tbody');
        var filler = $('#models-filler');
        var pager = $('#models-pagination');
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

        var cols = (table.querySelectorAll('colgroup col') || []).length || 8;
        var frag = document.createDocumentFragment();
        for (var i = 0; i < count; i++) {
            var tr = document.createElement('tr');
            tr.className = 'models-filler-row';
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
        var cont = (root || document).querySelector('#admin-models-container');
        if (!cont || cont.dataset.hydrated === '1') return;
        cont.dataset.hydrated = '1';
        rebindAll();
    }
    document.addEventListener('DOMContentLoaded', function () { hydrateOnce(document); });
    document.body.addEventListener('htmx:afterSwap', function (e) {
        var d = e && e.detail ? e.detail : {}, tgt = d && d.target ? d.target : null;
        if (tgt && tgt.id === 'models-list-region') {
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

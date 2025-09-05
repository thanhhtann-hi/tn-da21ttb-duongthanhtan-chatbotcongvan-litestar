/********************************************************************
 * File   : src/modules/admin/static/js/admin_users.js
 * Updated: 2025-08-24 (v1.9 – Local accounts: force re-verify on any change;
 *          set force_reverify=1, uncheck verified; keep v1.7+ features)
 * Scope  : Trang “Quản lý người dùng hệ thống”
 ********************************************************************/
(function () {
    /* ───────────────────────── Helpers ───────────────────────── */
    function intv(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
    function $(sel, root) { return (root || document).querySelector(sel); }
    function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    function getCsrf() {
        var bar = $('#users-bulk-bar');
        if (bar && bar.getAttribute('data-csrf')) return bar.getAttribute('data-csrf');
        var meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? (meta.getAttribute('content') || '') : '';
    }

    function fetchText(url) { return new Promise(function (res, rej) { try { var x = new XMLHttpRequest(); x.open('GET', url, true); x.setRequestHeader('HX-Request', 'true'); x.onreadystatechange = function () { if (x.readyState === 4) { if (x.status >= 200 && x.status < 300) res(x.responseText || ''); else rej(new Error('HTTP ' + x.status)); } }; x.send(); } catch (e) { rej(e); } }); }
    function makeFakeXhr(status, body) { return { status: status || 200, responseText: body || '', response: body || '', getResponseHeader: function () { return null; } }; }
    function createCE(name, detail) { try { return new CustomEvent(name, { detail: detail }); } catch (e) { var evt = document.createEvent('CustomEvent'); evt.initCustomEvent(name, false, false, detail); return evt; } }
    function dispatchHX(type, detail) { document.body.dispatchEvent(createCE(type, detail)); if (window.htmx && detail && detail.target) { try { window.htmx.process(detail.target); } catch (_) { } } }
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
    function getContainer() { return $('#admin-users-container'); }
    function formVal(name, fallback) { var sf = $('#users-search-form'); if (!sf) return fallback; var el = sf.querySelector('input[name="' + name + '"]'); var v = el ? (el.value != null ? String(el.value).trim() : '') : ''; if (v === '') return fallback; return v; }

    function currentFilters() {
        var c = getContainer() || { dataset: {} }; var qInp = $('#users-search-input');
        var dsStatus = (c.dataset.status) || 'all';
        var dsRole = (c.dataset.role) || 'all';
        var dsVerified = (c.dataset.verified) || 'all';
        var dsProvider = (c.dataset.provider) || '';
        var dsSortUI = (c.dataset.currentSort) || 'new';
        var dsPage = intv(c.dataset.page || '1', 1);
        var dsPerPage = intv(c.dataset.perPage || '10', 10);
        var dsQ = (c.dataset.q || '');
        var status = formVal('status', dsStatus);
        var role = formVal('role', dsRole);
        var verified = formVal('verified', dsVerified);
        var provider = formVal('provider', dsProvider);
        var sort = formVal('sort', null);
        var page = intv(formVal('page', dsPage), dsPage);
        var perPage = intv(formVal('per_page', dsPerPage), dsPerPage);
        var q = qInp ? (qInp.value || '') : (formVal('q', dsQ));
        return { status: status || 'all', role: role || 'all', verified: verified || 'all', provider: (provider == null ? '' : provider), q: q || '', sort: sort || dsSortUI, page: page, per_page: perPage };
    }

    function uiSortToCanonical(v) {
        switch (String(v || '').toLowerCase()) {
            case 'old': return 'created_asc';
            case 'az': return 'name_az';
            case 'za': return 'name_za';
            case 'email_az': return 'email_az';
            case 'email_za': return 'email_za';
            case 'role_az': return 'role_az';
            case 'role_za': return 'role_za';
            case 'status_az': return 'status_az';
            case 'status_za': return 'status_za';
            case 'login_new': return 'last_login_desc';
            case 'login_old': return 'last_login_asc';
            case 'new':
            default: return 'created_desc';
        }
    }

    function buildQS(f) {
        var parts = [];
        if (f.status && f.status !== 'all') parts.push('status=' + encodeURIComponent(f.status));
        if (f.role && f.role !== 'all') parts.push('role=' + encodeURIComponent(f.role));
        if (f.verified && f.verified !== 'all') parts.push('verified=' + encodeURIComponent(f.verified));
        if (f.provider) parts.push('provider=' + encodeURIComponent(f.provider));
        if (f.q) parts.push('q=' + encodeURIComponent(f.q));
        var sortCanon = (f.sort && f.sort.indexOf('_') > -1) ? f.sort : uiSortToCanonical(f.sort || 'new');
        if (sortCanon !== 'created_desc') parts.push('sort=' + encodeURIComponent(sortCanon));
        parts.push('page=' + (f.page > 0 ? f.page : 1));
        if (f.per_page > 0) parts.push('per_page=' + f.per_page);
        return parts.length ? ('?' + parts.join('&')) : '';
    }

    window.__usersFilterVals = function () {
        var f = currentFilters();
        return { status: f.status, role: f.role, verified: f.verified, provider: f.provider, q: f.q, sort: (f.sort && f.sort.indexOf('_') > -1) ? f.sort : uiSortToCanonical(f.sort), page: f.page, per_page: f.per_page };
    };
    window.__usersFilterQS = function () { return buildQS(currentFilters()); };

    function upsertHiddenInSearchForm(name, val) {
        var form = $('#users-search-form'); if (!form) return;
        var el = form.querySelector('input[name="' + name + '"]');
        if (val == null || val === '') { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
        if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
        el.value = String(val);
    }

    /* ───────────────────────── Reload list ───────────────────────── */
    function loadList() {
        var form = $('#users-search-form');
        if (form && window.htmx) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
        else { swapOuterHTML('/admin/users' + window.__usersFilterQS(), '#users-list-region'); }
    }

    /* ───────────────────────── Toolbar ───────────────────────── */
    function updateSortLabel() {
        var span = $('#users-sort-label .sort-value'); if (!span) return;
        var f = currentFilters();
        var key = (String(f.sort).indexOf('_') > -1) ? (function (canon) {
            switch (canon) {
                case 'created_asc': return 'old';
                case 'name_az': return 'az';
                case 'name_za': return 'za';
                case 'email_az': return 'email_az';
                case 'email_za': return 'email_za';
                case 'role_az': return 'role_az';
                case 'role_za': return 'role_za';
                case 'status_az': return 'status_az';
                case 'status_za': return 'status_za';
                case 'last_login_desc': return 'login_new';
                case 'last_login_asc': return 'login_old';
                default: return 'new';
            }
        })(String(f.sort)) : String(f.sort || 'new');
        var map = { 'new': 'Mới nhất', 'old': 'Cũ nhất', 'az': 'Tên A–Z', 'za': 'Tên Z–A', 'email_az': 'Email A–Z', 'email_za': 'Email Z–A', 'role_az': 'Vai trò A–Z', 'role_za': 'Vai trò Z–A', 'status_az': 'Trạng thái A–Z', 'status_za': 'Trạng thái Z–A', 'login_new': 'Đăng nhập mới', 'login_old': 'Đăng nhập cũ' };
        span.textContent = map[key] || 'Mới nhất';
    }

    function bindToolbar() {
        var s = $('#users-search-input');
        if (s && !s.dataset.bound) {
            s.dataset.bound = '1';
            s.addEventListener('keydown', function (e) { if ((e.key || '') === 'Enter' || e.keyCode === 13) { e.preventDefault(); upsertHiddenInSearchForm('page', '1'); loadList(); } });
            s.addEventListener('input', function () { upsertHiddenInSearchForm('page', '1'); });
        }

        var btnFilter = $('#btn-users-filter'); var menuFilter = $('#menu-users-filter');
        function pillsSetActive(groupEl, value) {
            if (!groupEl) return; var pills = $all('.filter-pill[role="radio"]', groupEl);
            pills.forEach(function (p) { var on = (String(p.getAttribute('data-v') || '').toLowerCase() === String(value || '').toLowerCase()); p.setAttribute('aria-checked', on ? 'true' : 'false'); p.tabIndex = on ? 0 : -1; });
        }
        function collectInitFilter() {
            if (!menuFilter) return { status: 'all', role: 'all', verified: 'all', provider: '' };
            return { status: (menuFilter.getAttribute('data-init-status') || 'all').toLowerCase(), role: (menuFilter.getAttribute('data-init-role') || 'all').toLowerCase(), verified: (menuFilter.getAttribute('data-init-verified') || 'all').toLowerCase(), provider: (menuFilter.getAttribute('data-init-provider') || '').toLowerCase() };
        }
        var initF = collectInitFilter(); var pendingF = { status: initF.status, role: initF.role, verified: initF.verified, provider: initF.provider };
        function updateApplyDisabled() { var equal = (pendingF.status === initF.status) && (pendingF.role === initF.role) && (pendingF.verified === initF.verified) && ((pendingF.provider || '') === (initF.provider || '')); var apply = $('#btn-users-apply', menuFilter); if (apply) apply.disabled = !!equal; }
        function syncUIFromPending() {
            if (!menuFilter) return;
            pillsSetActive(menuFilter.querySelector('[data-filter-group="status"]'), pendingF.status || 'all');
            pillsSetActive(menuFilter.querySelector('[data-filter-group="role"]'), pendingF.role || 'all');
            pillsSetActive(menuFilter.querySelector('[data-filter-group="verified"]'), pendingF.verified || 'all');
            var pGroup = menuFilter.querySelector('[data-filter-group="provider"]'); var input = $('#users-filter-provider-input', menuFilter); var p = (pendingF.provider || '');
            if (!p) { pillsSetActive(pGroup, ''); if (input) input.value = ''; }
            else if (p === 'local') { pillsSetActive(pGroup, 'local'); if (input) input.value = ''; }
            else { pillsSetActive(pGroup, '__custom__'); if (input) input.value = p; }
            updateApplyDisabled();
        }

        if (btnFilter && !btnFilter.dataset.bound) {
            btnFilter.dataset.bound = '1';
            btnFilter.addEventListener('click', function () { if (!menuFilter) return; var willOpen = menuFilter.classList.contains('hidden'); if (willOpen) { initF = collectInitFilter(); pendingF = {}; for (var k in initF) pendingF[k] = initF[k]; syncUIFromPending(); } menuFilter.classList.toggle('hidden'); btnFilter.setAttribute('aria-expanded', willOpen ? 'true' : 'false'); });
            document.addEventListener('mousedown', function (ev) { if (!menuFilter || menuFilter.classList.contains('hidden')) return; if (!menuFilter.contains(ev.target) && ev.target !== btnFilter) menuFilter.classList.add('hidden'); });
        }
        if (menuFilter && !menuFilter.dataset.bound) {
            menuFilter.dataset.bound = '1';
            menuFilter.addEventListener('click', function (e) {
                var pill = e.target && e.target.closest ? e.target.closest('.filter-pill[role="radio"]') : null; if (!pill) return;
                var k = pill.getAttribute('data-k') || ''; var v = pill.getAttribute('data-v'); var group = pill.parentElement; pillsSetActive(group, v);
                if (k === 'provider') { pendingF.provider = (v || ''); var inp = $('#users-filter-provider-input', menuFilter); if (inp) inp.value = ''; } else { pendingF[k] = v; }
                updateApplyDisabled();
            });
            $all('[role="radiogroup"]', menuFilter).forEach(function (groupEl) {
                if (groupEl.dataset.kbBound) return; groupEl.dataset.kbBound = '1';
                groupEl.addEventListener('keydown', function (e) { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(e.key) === -1) return; e.preventDefault(); var pills = $all('.filter-pill[role="radio"]', groupEl); var idx = -1; for (var i = 0; i < pills.length; i++) { if (pills[i].getAttribute('aria-checked') === 'true') { idx = i; break; } } if (idx < 0) idx = 0; var next = idx; if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % pills.length; else next = (idx - 1 + pills.length) % pills.length; pills[next].click(); pills[next].focus(); });
            });
            var providerInput = $('#users-filter-provider-input', menuFilter);
            if (providerInput && !providerInput.dataset.bound) {
                providerInput.dataset.bound = '1';
                providerInput.addEventListener('input', function () { var val = (providerInput.value || '').trim().toLowerCase(); pendingF.provider = val; var pGroup = menuFilter.querySelector('[data-filter-group="provider"]'); pillsSetActive(pGroup, val === '' ? '' : '__custom__'); updateApplyDisabled(); });
            }
            var btnReset = $('#btn-users-reset', menuFilter);
            if (btnReset && !btnReset.dataset.bound) { btnReset.dataset.bound = '1'; btnReset.addEventListener('click', function () { pendingF = { status: 'all', role: 'all', verified: 'all', provider: '' }; syncUIFromPending(); }); }
            var btnApply = $('#btn-users-apply', menuFilter);
            if (btnApply && !btnApply.dataset.bound) {
                btnApply.dataset.bound = '1';
                btnApply.addEventListener('click', function () {
                    upsertHiddenInSearchForm('status', pendingF.status || 'all');
                    upsertHiddenInSearchForm('role', pendingF.role || 'all');
                    upsertHiddenInSearchForm('verified', pendingF.verified || 'all');
                    upsertHiddenInSearchForm('provider', pendingF.provider || '');
                    upsertHiddenInSearchForm('page', '1');
                    var c = getContainer(); if (c) { c.dataset.status = pendingF.status || 'all'; c.dataset.role = pendingF.role || 'all'; c.dataset.verified = pendingF.verified || 'all'; c.dataset.provider = pendingF.provider || ''; c.dataset.page = '1'; }
                    initF = {}; for (var k in pendingF) initF[k] = pendingF[k];
                    menuFilter.setAttribute('data-init-status', initF.status); menuFilter.setAttribute('data-init-role', initF.role); menuFilter.setAttribute('data-init-verified', initF.verified); menuFilter.setAttribute('data-init-provider', initF.provider || '');
                    menuFilter.classList.add('hidden'); loadList();
                });
            }
        }

        var btnSort = $('#btn-users-sort'); var menuSort = $('#menu-users-sort');
        if (btnSort && !btnSort.dataset.bound) {
            btnSort.dataset.bound = '1';
            btnSort.addEventListener('click', function () { if (!menuSort) return; menuSort.classList.toggle('hidden'); btnSort.setAttribute('aria-expanded', menuSort.classList.contains('hidden') ? 'false' : 'true'); });
            document.addEventListener('mousedown', function (ev) { if (!menuSort || menuSort.classList.contains('hidden')) return; if (!menuSort.contains(ev.target) && ev.target !== btnSort) menuSort.classList.add('hidden'); });
        }
        if (menuSort && !menuSort.dataset.bound) {
            menuSort.dataset.bound = '1';
            menuSort.addEventListener('click', function (e) {
                var item = e.target && e.target.closest ? e.target.closest('button.menu-item') : null; if (!item) return;
                var key = item.getAttribute('data-sort') || 'new'; var canon = uiSortToCanonical(key);
                upsertHiddenInSearchForm('sort', canon); upsertHiddenInSearchForm('page', '1');
                var c = getContainer(); if (c) c.dataset.currentSort = key, c.dataset.page = '1';
                updateSortLabel(); if (menuSort) menuSort.classList.add('hidden'); loadList();
            });
        }

        var csv = $('#btn-users-export-csv');
        if (csv && !csv.dataset.bound) {
            csv.dataset.bound = '1';
            csv.addEventListener('click', function (e) { e.preventDefault(); var url = '/admin/users/export-csv' + window.__usersFilterQS(); try { window.open(url, '_blank'); } catch (_) { window.location.href = url; } });
        }

        var btnNew = $('#btn-open-users-new-modal');
        if (btnNew && !btnNew.dataset.bound) { btnNew.dataset.bound = '1'; btnNew.addEventListener('click', function () { openModalGet('/admin/users/new-modal'); }); }
    }

    /* ───────────────────────── Modals & row actions ───────────────────────── */
    var MODAL_ROOT_SEL = '#admin-users-modal-root';
    function openModalGet(path) {
        var root = $(MODAL_ROOT_SEL); if (!root) return;
        fetchText(String(path)).then(function (html) {
            root.innerHTML = html || '';
            var fake = makeFakeXhr(200, html);
            dispatchHX('htmx:afterSwap', { target: root, xhr: fake });
            dispatchHX('htmx:afterOnLoad', { target: root, xhr: fake });
            dispatchHX('htmx:load', { elt: root });
            dispatchHX('htmx:afterSettle', { target: root, xhr: fake });

            // Auto-open Bulk Confirm <dialog> (nếu có)
            setTimeout(function () {
                var dlg = document.getElementById('bulkConfirmModal');
                if (!dlg) return;
                try { if (dlg.showModal && !dlg.open) dlg.showModal(); else dlg.setAttribute('open', ''); }
                catch (_) { dlg.setAttribute('open', ''); }
            }, 0);

            // luôn có "light" bind cho edit modal
            bindEditModal();
        });
    }
    function openDetail(id) { openModalGet('/admin/users/' + encodeURIComponent(id) + '/detail-modal'); }
    function openEdit(id) { openModalGet('/admin/users/' + encodeURIComponent(id) + '/edit-modal'); }
    function openDelete(id) { openModalGet('/admin/users/' + encodeURIComponent(id) + '/delete-modal'); }

    function toggleVerified(id, wasVerified) {
        var csrf = getCsrf(); var headers = {}; if (csrf) headers['X-CSRF-Token'] = csrf;
        var url = '/admin/users/' + encodeURIComponent(id) + '/toggle-verified';
        var f = window.__usersFilterVals ? window.__usersFilterVals() : currentFilters();
        var body = { status: f.status, role: f.role, verified: f.verified, provider: f.provider, q: f.q, sort: f.sort, page: f.page, per_page: f.per_page };
        var x = new XMLHttpRequest(); x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
        x.setRequestHeader('HX-Request', 'true');
        for (var k in headers) if (headers.hasOwnProperty(k)) x.setRequestHeader(k, headers[k]);
        x.onreadystatechange = function () {
            if (x.readyState === 4) {
                if (x.status >= 200 && x.status < 300) {
                    var html = x.responseText || ''; var box = document.createElement('div'); box.innerHTML = (html || '').trim();
                    var next = box.querySelector('#users-list-region'); var cur = $('#users-list-region');
                    if (next && cur && cur.parentNode) {
                        cur.parentNode.replaceChild(next, cur);
                        var fake = makeFakeXhr(200, html);
                        dispatchHX('htmx:afterSwap', { target: next, xhr: fake });
                        dispatchHX('htmx:afterOnLoad', { target: next, xhr: fake });
                        dispatchHX('htmx:load', { elt: next });
                        dispatchHX('htmx:afterSettle', { target: next, xhr: fake });
                    }
                    if (window.Toast && Toast.show) { Toast.show(wasVerified ? 'Đã bỏ xác minh.' : 'Đã xác minh người dùng.', wasVerified ? 'warning' : 'success', 2000); }
                } else { if (window.Toast && Toast.show) Toast.show('Thao tác thất bại!', 'error', 3200); }
            }
        };
        var payload = []; for (var kk in body) if (body.hasOwnProperty(kk)) payload.push(encodeURIComponent(kk) + '=' + encodeURIComponent(String(body[kk] == null ? '' : body[kk]))); x.send(payload.join('&'));
    }

    /* ───────────────────────── Bulk logic ───────────────────────── */
    function selectedRowEls() { return Array.prototype.slice.call(document.querySelectorAll('.row-select:checked')); }
    function rows() { return $all('.row-select'); }
    function headerCb() { return $('#sel-all'); }
    function headerWrap() { return $('#sel-all-wrap'); }
    function bulkBar() { return $('#users-bulk-bar'); }

    function bulkStats() {
        var rs = selectedRowEls(); var out = { total: rs.length, sso: 0, local: 0, local_verified: 0, local_unverified: 0, active: 0, suspended: 0, banned: 0, deactivated: 0, items: [] };
        rs.forEach(function (cb) {
            var id = cb.getAttribute('data-user-id');
            var status = String(cb.getAttribute('data-status') || '').toLowerCase();
            var provider = (cb.getAttribute('data-provider') || '').toLowerCase();
            var isSSO = (cb.getAttribute('data-sso') === '1') || (provider && provider !== 'local');
            var isLocal = !isSSO;
            var verified = (cb.getAttribute('data-verified') === '1');
            if (isSSO) out.sso++; else out.local++;
            if (isLocal) { if (verified) out.local_verified++; else out.local_unverified++; }
            if (status === 'active') out.active++; else if (status === 'suspended') out.suspended++; else if (status === 'banned') out.banned++; else if (status === 'deactivated') out.deactivated++;
            out.items.push({ id: id, status: status, isSSO: isSSO, isLocal: isLocal, isVerified: verified });
        });
        out.elig = {
            verify: out.items.filter(function (x) { return x.isLocal && !x.isVerified; }).map(function (x) { return x.id; }),
            unverify: out.items.filter(function (x) { return x.isLocal && x.isVerified; }).map(function (x) { return x.id; }),
            activate: out.items.filter(function (x) { return x.status === 'suspended' || x.status === 'deactivated' || x.status === 'banned'; }).map(function (x) { return x.id; }),
            suspend: out.items.filter(function (x) { return x.status === 'active'; }).map(function (x) { return x.id; }),
            deactivate: out.items.filter(function (x) { return x.status !== 'deactivated'; }).map(function (x) { return x.id; })
        };
        return out;
    }

    function setBtnState(btn, labelEl, baseText, count) {
        if (labelEl) labelEl.textContent = baseText + ' (' + (count || 0) + ')';
        if (btn) { if (count > 0) { btn.removeAttribute('disabled'); btn.classList.remove('is-disabled'); } else { btn.setAttribute('disabled', ''); btn.classList.add('is-disabled'); } }
    }
    function updateBulkButtons() {
        var st = bulkStats();
        setBtnState($('#btn-users-bulk-activate'), $('#users-bulk-activate-label'), 'Kích hoạt', st.elig.activate.length);
        setBtnState($('#btn-users-bulk-suspend'), $('#users-bulk-suspend-label'), 'Tạm ngưng', st.elig.suspend.length);
        setBtnState($('#btn-users-bulk-deactivate'), $('#users-bulk-deactivate-label'), 'Vô hiệu hoá', st.elig.deactivate.length);
        setBtnState($('#btn-users-bulk-verify'), $('#users-bulk-verify-label'), 'Xác thực', st.elig.verify.length);
        setBtnState($('#btn-users-bulk-unverify'), $('#users-bulk-unverify-label'), 'Bỏ xác thực', st.elig.unverify.length);
    }

    function openBulkConfirm(action) {
        var st = bulkStats(); var ids = (st.elig[action] || []);
        if (!ids.length) { if (window.Toast && Toast.show) Toast.show('Không có mục phù hợp để "' + action + '".', 'info', 2200); return; }
        var url = '/admin/users/bulk-confirm-modal?ids=' + encodeURIComponent(ids.join(',')) + '&action=' + encodeURIComponent(action);
        openModalGet(url);
    }
    function bulkDo(action) { openBulkConfirm(action); }

    function bulkExport() {
        var rs = selectedRowEls(); var ids = rs.map(function (cb) { return cb.getAttribute('data-user-id'); });
        var url = '/admin/users/export-csv' + (window.__usersFilterQS ? window.__usersFilterQS() : '');
        if (ids.length) url += (url.indexOf('?') < 0 ? '?' : '&') + 'ids=' + encodeURIComponent(ids.join(','));
        try { window.open(url, '_blank'); } catch (_) { window.location.href = url; }
    }

    /* ───────────────────────── Selection + Bulk bar ───────────────────────── */
    function setAllRows(checked) { rows().forEach(function (cb) { cb.checked = !!checked; }); }
    function updateBulkBar(selCount) {
        var bar = bulkBar(); if (!bar) return; var cont = getContainer();
        if (selCount > 0) { if (!bar.classList.contains('is-active')) bar.classList.add('is-active'); bar.removeAttribute('inert'); bar.setAttribute('aria-hidden', 'false'); if (cont) cont.classList.add('bulk-open'); }
        else { bar.classList.remove('is-active'); bar.setAttribute('inert', ''); bar.setAttribute('aria-hidden', 'true'); if (cont) cont.classList.remove('bulk-open'); }
        updateBulkButtons();
    }
    function syncHeaderFromRows() {
        var head = headerCb(); var list = rows(); var total = list.length, sel = 0; for (var i = 0; i < total; i++)if (list[i].checked) sel++;
        if (head) {
            var all = (sel === total && total > 0); head.checked = all; head.indeterminate = (sel > 0 && !all);
            head.setAttribute('aria-checked', head.indeterminate ? 'mixed' : (all ? 'true' : 'false'));
            var wrap = headerWrap(); if (wrap) { if (head.indeterminate) { wrap.classList.add('is-indeterminate'); wrap.classList.remove('is-checked'); } else { wrap.classList.remove('is-indeterminate'); wrap.classList.toggle('is-checked', all); } }
        }
        updateBulkBar(sel);
    }
    function onHeaderClick(e) {
        e.preventDefault(); e.stopPropagation(); var head = headerCb(); if (!head) return;
        var chooseAll = !(head.indeterminate || head.checked); setAllRows(chooseAll);
        head.indeterminate = false; head.checked = chooseAll; head.setAttribute('aria-checked', chooseAll ? 'true' : 'false');
        var wrap = headerWrap(); if (wrap) { wrap.classList.remove('is-indeterminate'); wrap.classList.toggle('is-checked', !!chooseAll); }
        syncHeaderFromRows(); smartFillerSchedule();
    }
    function bindBulkButtons() {
        [['btn-users-bulk-activate', function () { bulkDo('activate'); }],
        ['btn-users-bulk-suspend', function () { bulkDo('suspend'); }],
        ['btn-users-bulk-deactivate', function () { bulkDo('deactivate'); }],
        ['btn-users-bulk-verify', function () { bulkDo('verify'); }],
        ['btn-users-bulk-unverify', function () { bulkDo('unverify'); }],
        ['btn-users-bulk-export', function () { bulkExport(); }]].forEach(function (pair) {
            var el = document.getElementById(pair[0]); if (el && !el.dataset.bound) { el.dataset.bound = '1'; el.addEventListener('click', function (e) { if (el.hasAttribute('disabled')) { e.preventDefault(); return; } pair[1](); }); }
        });
    }
    function bindSelection() {
        var head = headerCb(), wrap = headerWrap();
        if (head && !head.dataset.bound) { head.dataset.bound = '1'; head.addEventListener('click', onHeaderClick); }
        if (wrap && !wrap.dataset.bound) { wrap.dataset.bound = '1'; wrap.addEventListener('click', onHeaderClick); }
        rows().forEach(function (cb) { if (!cb.dataset.bound) { cb.dataset.bound = '1'; cb.addEventListener('change', syncHeaderFromRows); } });
        syncHeaderFromRows(); bindBulkButtons();
    }

    /* ───────────────────────── Edit modal (light) ───────────────────────── */
    function bindEditModal() {
        try { if (typeof attachUsersEditFormLogic === 'function') attachUsersEditFormLogic(); } catch (_) { }

        var overlay = document.getElementById('users-edit-modal-overlay');
        var modal = document.getElementById('users-edit-modal');
        var form = document.getElementById('admin-users-edit-form');
        var btnClose = document.getElementById('users-edit-modal-close');
        var btnCancel = document.getElementById('users-edit-cancel-btn');
        var submitBtn = document.getElementById('users-edit-submit-btn');
        if (!form || form.dataset.bound) return;
        form.dataset.bound = '1';

        function closeModal() { if (overlay) overlay.remove(); if (modal) modal.remove(); }
        if (btnClose) btnClose.onclick = closeModal;
        if (btnCancel) btnCancel.onclick = closeModal;

        // Giữ filter trước submit + (nếu cần) ép re-verify khi local có thay đổi
        form.addEventListener('htmx:configRequest', function (e) {
            try {
                var d = e && e.detail ? e.detail : {};
                if (!d.parameters) d.parameters = {};
                var f = (window.__usersFilterVals ? window.__usersFilterVals() : null) || {};
                ['status', 'role', 'verified', 'provider', 'q', 'sort', 'page', 'per_page'].forEach(function (k) {
                    d.parameters[k] = (f[k] != null ? String(f[k]) : '');
                });

                // bổ sung force_reverify nếu đã được set (JS bên dưới)
                var fr = (document.getElementById('force_reverify') || {}).value || '';
                if (fr) d.parameters.force_reverify = fr;

            } catch (_) { }
        });

        var pw1 = document.getElementById('user_password');
        var pw2 = document.getElementById('user_password_confirm');
        var hint = document.getElementById('users-pass-hint');
        var provider = String(form.getAttribute('data-current-provider') || 'local').toLowerCase();
        var verifiedCb = document.getElementById('user_email_verified');
        var forceInp = document.getElementById('force_reverify');

        // Snapshot ban đầu
        var init = {
            email: (document.getElementById('user_email') || {}).value || '',
            display: (document.getElementById('user_display_name') || {}).value || '',
            name: (document.getElementById('user_name') || {}).value || '',
            role: (document.getElementById('user_role') || {}).value || '',
            status: (document.getElementById('user_status') || {}).value || '',
            verified: ((document.getElementById('user_email_verified') || {}).checked) ? '1' : '0'
        };

        function validatePw() {
            var v1 = pw1 ? (pw1.value || '') : '';
            var v2 = pw2 ? (pw2.value || '') : '';
            var mismatch = (v1 || v2) && (v1 !== v2);
            if (hint) hint.classList.toggle('hidden', !mismatch);
            return !mismatch;
        }

        // Đặt cờ re-verify cho local khi có thay đổi
        function markForceReverify() {
            if (provider !== 'local') return false;
            if (!forceInp) return false;
            forceInp.value = '1';                  // gửi kèm lên server
            if (verifiedCb && !verifiedCb.disabled) verifiedCb.checked = false; // bỏ tick để form reflect
            return true;
        }

        function somethingChanged() {
            var cur = {
                email: (document.getElementById('user_email') || {}).value || '',
                display: (document.getElementById('user_display_name') || {}).value || '',
                name: (document.getElementById('user_name') || {}).value || '',
                role: (document.getElementById('user_role') || {}).value || '',
                status: (document.getElementById('user_status') || {}).value || '',
                verified: ((document.getElementById('user_email_verified') || {}).checked) ? '1' : '0'
            };
            var changed = false;
            for (var k in init) { if (cur[k] !== init[k]) { changed = true; break; } }
            var hasPw = !!((pw1 && pw1.value) || (pw2 && pw2.value));

            if (changed || hasPw) markForceReverify();
            return changed || hasPw;
        }

        function reevaluate() {
            var ok = validatePw() && somethingChanged();
            if (submitBtn) submitBtn.disabled = !ok;
        }

        ['input', 'change', 'keyup'].forEach(function (evt) {
            form.addEventListener(evt, function () { reevaluate(); }, true);
        });
        reevaluate();

        // Lắng nghe HX-Trigger từ server
        document.body.addEventListener('users-single-result', function (ev) {
            var d = ev && ev.detail ? ev.detail : null;
            if (!d) return;
            if (d.action === 'update' && d.ok) {
                closeModal();
                if (window.Toast && Toast.show) {
                    var reverifyMsg = (d.reverify || (forceInp && forceInp.value === '1'))
                        ? 'Đã cập nhật. Email xác minh đã được gửi, vui lòng xác thực lại.'
                        : (d.password_changed ? 'Đã cập nhật & đổi mật khẩu.' : 'Đã cập nhật người dùng.');
                    Toast.show(reverifyMsg, 'success', 2200);
                }
            }
        });
    }

    /* ───────────────────────── Row buttons ───────────────────────── */
    function bindRowButtons() {
        var tbl = $('#admin-users-table'); if (!tbl || tbl.dataset.boundDelegation === '1') return;
        tbl.dataset.boundDelegation = '1';
        tbl.addEventListener('click', function (e) {
            var t = e.target || e.srcElement;
            var nameBtn = t && t.closest ? t.closest('.btn-user-detail') : null;
            if (nameBtn) { var id0 = nameBtn.getAttribute('data-user-id'); if (id0) { e.preventDefault(); openDetail(id0); return; } }
            var btn = t && t.closest ? t.closest('.row-action-detail, .row-action-edit, .row-action-delete, .row-action-toggle-verified') : null;
            if (!btn) return; e.preventDefault(); var id = btn.getAttribute('data-user-id'); if (!id) return;
            if (btn.classList.contains('row-action-detail')) return openDetail(id);
            if (btn.classList.contains('row-action-edit')) return openEdit(id);
            if (btn.classList.contains('row-action-delete')) return openDelete(id);
            if (btn.classList.contains('row-action-toggle-verified')) { var vAttr = btn.getAttribute('data-verified'); var wasVerified = (vAttr === '1' || vAttr === 'true'); return toggleVerified(id, wasVerified); }
        });
    }

    /* ───────────────────────── Pager jump (fallback) ───────────────────────── */
    function bindPageJump() {
        var form = $('#users-page-jump-form'), input = $('#users-page-input');
        if (form && !form.dataset.boundSubmit) {
            form.dataset.boundSubmit = '1';
            form.addEventListener('submit', function (e) { if (window.htmx) return; e.preventDefault(); var fd = new FormData(form); var qs = new URLSearchParams(fd).toString(); swapOuterHTML('/admin/users?' + qs, '#users-list-region'); });
        }
        if (input && !input.dataset.boundClamp) {
            input.dataset.boundClamp = '1';
            function clamp() { var max = intv(input.getAttribute('max') || '1', 1); var v = intv(input.value || '1', 1); if (v < 1) v = 1; if (v > max) v = max; input.value = String(v); upsertHiddenInSearchForm('page', String(v)); var c = getContainer(); if (c) c.dataset.page = String(v); return v; }
            input.addEventListener('keydown', function (e) { if ((e.key || '') === 'Enter' || e.keyCode === 13) { e.preventDefault(); clamp(); if (form) { if (window.htmx) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); } else { var fd = new FormData(form); var qs = new URLSearchParams(fd).toString(); swapOuterHTML('/admin/users?' + qs, '#users-list-region'); } } } });
            input.addEventListener('blur', clamp);
        }
    }

    /* ───────────────────────── HTMX enrichment ───────────────────────── */
    document.body.addEventListener('htmx:configRequest', function (e) {
        try {
            var d = e && e.detail ? e.detail : {}; if (!d) return; if (!d.parameters) d.parameters = {};
            var tgt = e && e.target ? e.target : null;
            var isListSwap = false;
            if (tgt) { var hxTarget = (tgt.getAttribute && tgt.getAttribute('hx-target')) || ''; if (hxTarget === '#users-list-region') isListSwap = true; if (!isListSwap && tgt.id === 'users-list-region') isListSwap = true; }
            if (!isListSwap) return;
            var f = window.__usersFilterVals ? window.__usersFilterVals() : currentFilters();
            d.parameters.page = f.page > 0 ? f.page : 1; if (f.per_page > 0) d.parameters.per_page = f.per_page;
            if (f.status && f.status !== 'all') d.parameters.status = f.status;
            if (f.role && f.role !== 'all') d.parameters.role = f.role;
            if (f.verified && f.verified !== 'all') d.parameters.verified = f.verified;
            if (f.provider) d.parameters.provider = f.provider;
            if (f.q) d.parameters.q = f.q;
            var sortCanon = f.sort && f.sort.indexOf('_') > -1 ? f.sort : uiSortToCanonical(f.sort);
            if (sortCanon !== 'created_desc') d.parameters.sort = sortCanon;

            var path = String(d.path || d.url || '');
            if (path) {
                try { var u = new URL(path, location.origin); if (u.searchParams.has('per_page')) { u.searchParams.delete('per_page'); d.path = u.pathname + (u.searchParams.toString() ? ('?' + u.searchParams.toString()) : ''); } }
                catch (_) { d.path = path.replace(/([?&])per_page=\d+&?/g, '$1').replace(/[?&]$/, ''); }
            }
        } catch (_) { }
    });

    /* ───────────────────────── Smart filler rows ───────────────────────── */
    var smartFillerRAF = 0, smartFillerTick = 0;
    function smartFillerSchedule() { if (smartFillerRAF) cancelAnimationFrame(smartFillerRAF); smartFillerRAF = requestAnimationFrame(function () { smartFillerRAF = 0; var now = Date.now(); if (now - smartFillerTick < 60) { smartFillerTick = now; return smartFillerSchedule(); } smartFillerTick = now; smartFillerRender(); }); }
    function smartFillerRender() {
        var tableWrap = $('#admin-users-table'); var table = tableWrap ? tableWrap.querySelector('table') : null; var body = $('#users-tbody'); var filler = $('#users-filler'); var pager = $('#users-pagination');
        if (!table || !body || !filler || !pager) return;
        filler.innerHTML = ''; if (!body.querySelector('tr')) return;
        var sample = body.querySelector('tr'); var rowH = sample ? Math.max(44, Math.round(sample.getBoundingClientRect().height)) : 56;
        var space = Math.floor(pager.getBoundingClientRect().top - table.getBoundingClientRect().bottom);
        if (!isFinite(space) || space <= Math.floor(rowH * 0.6)) return;
        var count = Math.floor(space / rowH); if (count <= 0) return; if (count > 80) count = 80;
        var cols = (table.querySelectorAll('colgroup col') || []).length || 7; var frag = document.createDocumentFragment();
        for (var i = 0; i < count; i++) { var tr = document.createElement('tr'); tr.className = 'users-filler-row'; tr.setAttribute('aria-hidden', 'true'); var td = document.createElement('td'); td.setAttribute('colspan', String(cols)); td.className = 'px-4 py-2 border-b border-gray-200'; td.innerHTML = '&nbsp;'; tr.appendChild(td); frag.appendChild(tr); }
        filler.appendChild(frag);
    }
    function observeSidebarForFiller() {
        var sb = document.getElementById('admin-sidebar'); if (!sb || sb._fillerObservedUsers) return; sb._fillerObservedUsers = true;
        try { var mo = new MutationObserver(function (list) { for (var i = 0; i < list.length; i++) { if (list[i].type === 'attributes' && list[i].attributeName === 'class') { setTimeout(smartFillerSchedule, 420); } } }); mo.observe(sb, { attributes: true, attributeFilter: ['class'] }); } catch (_) { }
    }

    /* ───────────────────────── Rebind pipeline ───────────────────────── */
    function sanitizeHxGetPerPage() {
        $all('[hx-get]').forEach(function (el) { try { var raw = el.getAttribute('hx-get') || ''; if (!raw) return; var u = new URL(raw, location.origin); if (u.searchParams.has('per_page')) { u.searchParams.delete('per_page'); el.setAttribute('hx-get', u.pathname + (u.searchParams.toString() ? ('?' + u.searchParams.toString()) : '')); } } catch (_) {/* ignore */ } });
    }
    function rebindListOnly() {
        bindRowButtons(); bindSelection(); bindPageJump(); sanitizeHxGetPerPage(); updateSortLabel();
        setTimeout(function () { updateBulkButtons(); smartFillerSchedule(); }, 0);
    }
    function rebindAll() {
        bindToolbar(); rebindListOnly(); observeSidebarForFiller(); bindEditModal();
    }

    /* ───────────────────────── Boot / Hydrate + hooks ───────────────────────── */
    function hydrateOnce(root) {
        var cont = (root || document).querySelector('#admin-users-container'); if (!cont || cont.dataset.hydrated === '1') return; cont.dataset.hydrated = '1'; rebindAll();
    }
    document.addEventListener('DOMContentLoaded', function () { hydrateOnce(document); });
    document.body.addEventListener('htmx:afterSwap', function (e) {
        var d = e && e.detail ? e.detail : {}, tgt = d && d.target ? d.target : null;
        if (tgt && tgt.id === 'users-list-region') { rebindListOnly(); }
        bindEditModal(); // nếu modal load qua HTMX ở nơi khác, vẫn bind
        try { var dlg = document.getElementById('bulkConfirmModal'); if (dlg && dlg.close) dlg.close(); } catch (_) { }
    });
    document.body.addEventListener('htmx:load', function (e) { hydrateOnce(e && e.target ? e.target : document); bindEditModal(); });
    document.body.addEventListener('htmx:afterOnLoad', function (e) { var d = e ? e.detail : null; hydrateOnce(d && d.target ? d.target : document); smartFillerSchedule(); bindEditModal(); });
    document.body.addEventListener('htmx:afterSettle', function (e) { var d = e ? e.detail : null; hydrateOnce(d && d.target ? d.target : document); bindEditModal(); });

    // Global toast for bulk result (server HX-Trigger)
    document.body.addEventListener('users-bulk-result', function (ev) {
        var d = ev && ev.detail ? ev.detail : {}; if (!window.Toast || !Toast.show) return;
        var act = d.action || ''; var affected = d.affected || 0; var total = d.total || 0; var msg = '';
        switch (act) {
            case 'status_active': msg = 'Đã kích hoạt ' + affected + '/' + total + ' tài khoản.'; break;
            case 'status_suspended': msg = 'Đã tạm ngưng ' + affected + '/' + total + ' tài khoản.'; break;
            case 'status_banned': msg = 'Đã cấm ' + affected + '/' + total + ' tài khoản.'; break;
            case 'deactivate':
            case 'status_deactivated': msg = 'Đã vô hiệu hoá ' + affected + '/' + total + ' tài khoản.'; break;
            case 'verify': msg = 'Đã xác minh ' + affected + ' tài khoản local.'; break;
            case 'unverify': msg = 'Đã bỏ xác minh ' + affected + ' tài khoản local.'; break;
            default: msg = 'Đã thực hiện thao tác hàng loạt.'; break;
        }
        Toast.show(msg, 'success', 2000);
    });

    // Recalc khi resize
    window.addEventListener('resize', smartFillerSchedule);
})();

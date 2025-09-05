// file: src/modules/admin/static/js/admin_notify_bulk_modals.js
// updated: 2025-09-03 (v3.7)
// note:
// - Bulk Delete/Export modals.
// - Giữ đủ state (v/sort/q/start_date/end_date):
//   + Inject vào BODY (hidden inputs) ở submit capture phase (trước HTMX serialize).
//   + Backup tại htmx:configRequest (e.detail.parameters + e.detail.path).
// - LUÔN chỉ swap #notify-list-region (ép lại hx-target/hx-select/hx-swap ở runtime).
// - Fallback khi không có HTMX: POST AJAX kèm state, rồi swap #notify-list-region.
// - Tự disable nút khi tất cả mục chọn đã "Đã ẩn". ES5-safe.
// - NEW (v3.7):
//   + Export: fallback khi popup bị chặn (location.href).
//   + helperQS ưu tiên __notifyFilterQSNoPaging() để bỏ page/per_page.
//   + No-HTMX POST: ưu tiên CSRF từ input hidden; gắn cả X-CSRF-Token & X-CSRFToken.
//   + Esc close cleanup.

(function () {
    'use strict';

    /* ── helpers ───────────────────────────────────────────── */
    function qs(sel, root) { return (root || document).querySelector(sel); }
    function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    function encodeForm(obj) { var s = []; for (var k in obj) if (obj.hasOwnProperty(k)) s.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k]))); return s.join('&'); }

    function closeByIds(overlayId, modalId) {
        var ov = document.getElementById(overlayId); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
        var md = document.getElementById(modalId); if (md && md.parentNode) md.parentNode.removeChild(md);
    }

    function mergeQsIntoPath(base, qs) {
        if (!qs) return base || '';
        var payload = (qs.charAt(0) === '?') ? qs.substring(1) : qs;
        return (base || '') + ((base || '').indexOf('?') >= 0 ? '&' : '?') + payload;
    }

    function getSelectionMeta() {
        var ids = [], total = 0, visible = 0, hidden = 0;
        var rows = qsa('.row-select');
        for (var i = 0; i < rows.length; i++) {
            var el = rows[i];
            if (el && el.checked) {
                total++; ids.push(el.getAttribute('data-notify-id'));
                var vis = el.getAttribute('data-visible');
                if (vis === '1' || vis === 'true') visible++; else hidden++;
            }
        }
        return { ids: ids, total: total, visible: visible, hidden: hidden };
    }

    function fetchGET(url, cb) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.setRequestHeader('HX-Request', 'true');
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    if (xhr.status >= 200 && xhr.status < 300) cb(null, xhr.responseText || '', xhr);
                    else cb(new Error('HTTP ' + xhr.status));
                }
            };
            xhr.send();
        } catch (e) { cb(e); }
    }

    function postForm(url, data, headers, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
        xhr.setRequestHeader('HX-Request', 'true');
        if (headers) for (var k in headers) if (headers.hasOwnProperty(k)) xhr.setRequestHeader(k, headers[k]);
        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) cb(null, xhr.responseText || '', xhr);
                else cb(new Error('HTTP ' + xhr.status));
            }
        };
        xhr.send(typeof data === 'string' ? data : encodeForm(data || {}));
    }

    function swapListFromHTML(html) {
        var targetSel = '#notify-list-region';
        var cur = qs(targetSel); if (!cur) return;
        var tmp = document.createElement('div'); tmp.innerHTML = (html || '').trim();
        var next = tmp.querySelector(targetSel); if (!next) return;
        cur.parentNode.replaceChild(next, cur);
        // fire htmx-like hooks
        var fake = { status: 200, responseText: html, getResponseHeader: function () { return null; } };
        try { document.body.dispatchEvent(new CustomEvent('htmx:afterSwap', { detail: { target: next, xhr: fake } })); } catch (_) { }
        try { document.body.dispatchEvent(new CustomEvent('htmx:afterOnLoad', { detail: { target: next, xhr: fake } })); } catch (_) { }
        try { document.body.dispatchEvent(new CustomEvent('htmx:load', { detail: { elt: next } })); } catch (_) { }
        try { document.body.dispatchEvent(new CustomEvent('htmx:afterSettle', { detail: { target: next, xhr: fake } })); } catch (_) { }
        if (window.htmx && window.htmx.process) { try { window.htmx.process(next); } catch (_) { } }
    }

    function toast(msg, type, ms) { if (window.Toast && window.Toast.show) window.Toast.show(msg, type || 'info', ms || 2500); else try { alert(String(msg || '')); } catch (_) { } }

    /* ── filters ──────────────────────────────────────────── */
    function currentFilters() {
        if (typeof window.__notifyFilterVals === 'function') { try { return window.__notifyFilterVals(); } catch (_) { } }
        var get = function (id) { var el = document.getElementById(id); return el ? (el.value || '') : ''; };
        var inp = document.getElementById('notify-search-input');
        return {
            v: get('state-view') || 'all',
            sort: get('state-sort') || 'created_desc',
            q: inp ? (inp.value || '') : '',
            start_date: get('state-start-date'),
            end_date: get('state-end-date')
        };
    }
    function buildQSFromFilters(f) {
        var parts = [];
        if (f.v && f.v !== 'all') parts.push('v=' + encodeURIComponent(f.v));
        if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
        if (f.q) parts.push('q=' + encodeURIComponent(f.q));
        if (f.start_date && f.end_date) { parts.push('start_date=' + encodeURIComponent(f.start_date)); parts.push('end_date=' + encodeURIComponent(f.end_date)); }
        return parts.length ? ('?' + parts.join('&')) : '';
    }
    // v3.7: LUÔN ưu tiên QS KHÔNG kèm page/per_page
    function helperQS() {
        try {
            if (typeof window.__notifyFilterQSNoPaging === 'function') {
                var s = window.__notifyFilterQSNoPaging() || '';
                return s;
            }
        } catch (_) { }
        return buildQSFromFilters(currentFilters());
    }

    function upsertHidden(form, name, value) {
        var el = form.querySelector('input[name="' + name + '"]');
        if (!value) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
        if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); }
        el.value = value;
    }

    function injectFiltersAndPatchUrl(form) {
        var f = currentFilters(), hasRange = !!(f.start_date && f.end_date);

        // body
        upsertHidden(form, 'v', (f.v && f.v !== 'all') ? f.v : '');
        upsertHidden(form, 'sort', (f.sort && f.sort !== 'created_desc') ? f.sort : '');
        upsertHidden(form, 'q', f.q || '');
        upsertHidden(form, 'start_date', hasRange ? f.start_date : '');
        upsertHidden(form, 'end_date', hasRange ? f.end_date : '');

        // url backup
        var attr = 'hx-post';
        if (!form.hasAttribute(attr)) form.setAttribute(attr, form.action || '/admin/notify/bulk-hide');
        var base = form.getAttribute(attr) || form.action || '/admin/notify/bulk-hide';

        var qs = ''; try { qs = helperQS(); } catch (_) { }
        if (qs) {
            try {
                var u = new URL(base, window.location.origin);
                ['v', 'sort', 'q', 'start_date', 'end_date'].forEach(function (k) { u.searchParams.delete(k); });
                if (f.v && f.v !== 'all') u.searchParams.set('v', f.v);
                if (f.sort && f.sort !== 'created_desc') u.searchParams.set('sort', f.sort);
                if (f.q) u.searchParams.set('q', f.q);
                if (hasRange) { u.searchParams.set('start_date', f.start_date); u.searchParams.set('end_date', f.end_date); }
                form.setAttribute(attr, u.pathname + (u.search ? u.search : ''));
            } catch (_) {
                form.setAttribute(attr, mergeQsIntoPath(base, qs));
            }
        }

        // LUÔN ép target/select/swap đúng vùng list
        form.setAttribute('hx-target', '#notify-list-region');
        form.setAttribute('hx-select', '#notify-list-region');
        form.setAttribute('hx-swap', 'outerHTML');
    }

    /* ── open modal (AJAX + htmx.process) ─────────────────── */
    function openModal(path) {
        var rootSel = document.querySelector('#admin-notify-modal-root') ? '#admin-notify-modal-root' : '#modal-root';
        var target = qs(rootSel); if (!target) return;
        fetchGET(path, function (err, html) {
            if (err) return;
            target.innerHTML = html || '';
            if (window.htmx && window.htmx.process) { try { window.htmx.process(target); } catch (_) { } }
            bindBulkDeleteModal();
            bindBulkExportModal();
        });
    }

    /* ── Bulk DELETE modal ─────────────────────────────────── */
    function updateBulkDeleteDescByVisibility() {
        var desc = qs('#bulk-delete-desc'), submit = qs('#bulk-delete-submit');
        if (!desc) return;
        var meta = getSelectionMeta(), total = meta.total, visible = meta.visible, hidden = meta.hidden;

        var noteId = 'bulk-soft-delete-note';
        var noteEl = document.getElementById(noteId);

        if (total === 0) {
            desc.innerHTML = 'Không có mục nào được chọn.';
            if (submit) submit.disabled = true;
            return;
        }
        if (visible === 0) {
            desc.innerHTML = 'Tất cả <span class="font-bold">' + total + '</span> thông báo đã chọn hiện đang <span class="font-bold">ĐÃ ẨN</span>. Không có mục nào để ẩn thêm.';
            if (!noteEl) { noteEl = document.createElement('div'); noteEl.id = noteId; noteEl.className = 'mt-2 text-[12px] text-gray-600'; desc.parentNode.appendChild(noteEl); }
            noteEl.textContent = 'Lưu ý: Ẩn = xoá mềm. Muốn xoá vĩnh viễn, thao tác trên SQL UI (PostgreSQL).';
            if (submit) submit.disabled = true;
        } else {
            var s = 'Bạn sắp ẩn <span class="font-bold">' + visible + '</span> thông báo đang hiển thị';
            if (hidden > 0) s += ' (bỏ qua ' + hidden + ' mục đã ẩn)';
            s += '.';
            desc.innerHTML = s;
            if (noteEl) { try { noteEl.remove(); } catch (_) { noteEl.parentNode && noteEl.parentNode.removeChild(noteEl); } }
            if (submit) submit.disabled = false;
        }
    }

    function ensureBulkDeleteKeepsFilters(form) {
        if (!form || form.dataset.filterBound === '1') return;

        // submit (capture) → inject trước HTMX
        form.addEventListener('submit', function () {
            if (form.dataset._submitting === '1') return;
            form.dataset._submitting = '1';
            window.__notifyJustBulkDeleted = true;
            var btn = qs('#bulk-delete-submit', form); if (btn) btn.disabled = true;
            injectFiltersAndPatchUrl(form);
        }, true);

        // htmx backup
        form.addEventListener('htmx:configRequest', function (e) {
            try {
                var f = currentFilters();
                if (f.v && f.v !== 'all') e.detail.parameters.v = f.v;
                if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
                if (f.q) e.detail.parameters.q = f.q;
                if (f.start_date && f.end_date) { e.detail.parameters.start_date = f.start_date; e.detail.parameters.end_date = f.end_date; }
                var qsfx = helperQS(); if (qsfx) e.detail.path = mergeQsIntoPath(e.detail.path || '', qsfx);
            } catch (_) { }
        });

        form.dataset.filterBound = '1';
    }

    function ensureNoHTMXFallback(form) {
        if (!form || form.dataset.ajaxGuard === '1') return;
        form.dataset.ajaxGuard = '1';
        form.addEventListener('submit', function (e) {
            if (window.htmx) return; // HTMX sẽ lo
            e.preventDefault();

            // đảm bảo đã inject state
            injectFiltersAndPatchUrl(form);

            var url = form.getAttribute('hx-post') || form.action || '/admin/notify/bulk-hide';
            var ids = (qs('#bulk-delete-ids', form) || { value: '' }).value || '';

            // v3.7 CSRF: ưu tiên input hidden, rồi mới meta
            var csrf = (qs('input[name="csrf_token"]', form) || { value: '' }).value || '';
            if (!csrf) {
                var meta = document.querySelector('meta[name="csrf-token"]');
                if (meta) csrf = meta.getAttribute('content') || '';
            }
            var headers = {};
            if (csrf) { headers['X-CSRF-Token'] = csrf; headers['X-CSRFToken'] = csrf; }

            // body gồm ids + filters (không kèm page/per_page)
            var f = currentFilters(), hasRange = !!(f.start_date && f.end_date);
            var body = { ids: ids, csrf_token: csrf };
            if (f.v && f.v !== 'all') body.v = f.v;
            if (f.sort && f.sort !== 'created_desc') body.sort = f.sort;
            if (f.q) body.q = f.q;
            if (hasRange) { body.start_date = f.start_date; body.end_date = f.end_date; }

            postForm(url, body, headers, function (err, html) {
                if (err) { toast('Ẩn thông báo thất bại!', 'error', 2200); form.dataset._submitting = ''; var btn = qs('#bulk-delete-submit', form); if (btn) btn.disabled = false; window.__notifyJustBulkDeleted = false; return; }
                swapListFromHTML(html || '');
                closeByIds('bulk-delete-modal-overlay', 'bulk-delete-modal');
                toast('Đã ẩn các thông báo đã chọn!', 'success', 2500);
                window.__notifyJustBulkDeleted = false;
                form.dataset._submitting = '';
            });
        });
    }

    function bindBulkDeleteModal() {
        var overlay = qs('#bulk-delete-modal-overlay');
        var modal = qs('#bulk-delete-modal');
        if (!overlay && !modal) return;

        // fill ids nếu còn rỗng (từ selection hiện tại)
        var idsInput = qs('#bulk-delete-ids');
        if (idsInput && !idsInput.value) { var meta = getSelectionMeta(); idsInput.value = meta.ids.join(','); }

        updateBulkDeleteDescByVisibility();

        var onKey = function (e) { if ((e.key === 'Escape' || e.keyCode === 27) && qs('#bulk-delete-modal')) close(); };
        var close = function () {
            document.removeEventListener('keydown', onKey);
            closeByIds('bulk-delete-modal-overlay', 'bulk-delete-modal');
        };

        if (overlay && !overlay.dataset.bound) { overlay.dataset.bound = '1'; overlay.addEventListener('click', close); }

        // click-outside
        if (modal && !modal.dataset.outsideBound) {
            modal.dataset.outsideBound = '1';
            modal.addEventListener('click', function (e) {
                var box = qs('.notify-modal-content', modal);
                if (box && !box.contains(e.target)) close();
            });
        }

        var x = qs('#bulk-delete-modal-close'); if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', close); }
        var cancel = qs('#bulk-delete-cancel'); if (cancel && !cancel.dataset.bound) { cancel.dataset.bound = '1'; cancel.addEventListener('click', close); }
        document.addEventListener('keydown', onKey);

        var form = qs('#bulk-delete-form');
        if (form) {
            // Patch sớm để đảm bảo hx-* & URL đúng trước khi HTMX serialize
            injectFiltersAndPatchUrl(form);
            ensureBulkDeleteKeepsFilters(form);
            ensureNoHTMXFallback(form);
        }
    }

    // on HTMX swap thành công → đóng + toast
    document.body.addEventListener('htmx:afterSwap', function (evt) {
        var d = evt && evt.detail ? evt.detail : {};
        var tgt = d.target ? d.target : null;
        if (tgt && tgt.id === 'notify-list-region') {
            closeByIds('bulk-delete-modal-overlay', 'bulk-delete-modal');
            if (window.__notifyJustBulkDeleted) {
                toast('Đã ẩn các thông báo đã chọn!', 'success', 2500);
                window.__notifyJustBulkDeleted = false;
            }
        }
    });

    /* ── Bulk EXPORT modal ─────────────────────────────────── */
    function bindBulkExportModal() {
        var overlay = qs('#bulk-export-modal-overlay');
        var modal = qs('#bulk-export-modal');
        if (!overlay && !modal) return;

        var idsEl = qs('#bulk-export-ids');
        if (idsEl && !idsEl.value) { idsEl.value = getSelectionMeta().ids.join(','); }
        var selectedCount = (idsEl && idsEl.value) ? idsEl.value.split(',').filter(function (x) { return x; }).length : 0;
        var cntNode = qs('#bulk-export-selected-count'); if (cntNode) cntNode.textContent = selectedCount;
        var btnSel = qs('#bulk-export-selected'); if (btnSel) btnSel.disabled = (selectedCount === 0);

        var onKey = function (e) { if ((e.key === 'Escape' || e.keyCode === 27) && qs('#bulk-export-modal')) close(); };
        var close = function () {
            document.removeEventListener('keydown', onKey);
            closeByIds('bulk-export-modal-overlay', 'bulk-export-modal');
        };

        if (overlay && !overlay.dataset.bound) { overlay.dataset.bound = '1'; overlay.addEventListener('click', close); }
        if (modal && !modal.dataset.outsideBound) {
            modal.dataset.outsideBound = '1';
            modal.addEventListener('click', function (e) {
                var box = qs('.notify-modal-content', modal);
                if (box && !box.contains(e.target)) close();
            });
        }
        var x = qs('#bulk-export-modal-close'); if (x && !x.dataset.bound) { x.dataset.bound = '1'; x.addEventListener('click', close); }
        document.addEventListener('keydown', onKey);

        function openExport(idsCsv) {
            var url = '/admin/notify/export-csv' + helperQS();
            if (idsCsv) { url += (url.indexOf('?') < 0 ? '?' : '&') + 'ids=' + encodeURIComponent(idsCsv); }
            var w = window.open(url, '_blank');
            if (!w) { location.href = url; } // v3.7 fallback khi popup bị chặn
            toast('Đang xuất CSV...', 'info', 1800);
            close();
        }

        if (btnSel && !btnSel.dataset.bound) {
            btnSel.dataset.bound = '1';
            btnSel.addEventListener('click', function () {
                var ids = (qs('#bulk-export-ids') || { value: '' }).value;
                if (ids) openExport(ids);
            });
        }
        var btnFilter = qs('#bulk-export-filter');
        if (btnFilter && !btnFilter.dataset.bound) {
            btnFilter.dataset.bound = '1';
            btnFilter.addEventListener('click', function () { openExport(''); });
        }
    }

    /* ── Public open helpers ── */
    window.__openBulkDeleteModal = function (idsCsv) {
        var meta = getSelectionMeta();
        if (meta.total > 0 && meta.visible === 0) {
            toast('Tất cả mục chọn hiện đang ĐÃ ẨN. Muốn xoá vĩnh viễn, vui lòng thao tác trên SQL UI (PostgreSQL).', 'warn', 4200);
            return;
        }
        var path = '/admin/notify/bulk-delete-modal';
        if (idsCsv) { path += '?ids=' + encodeURIComponent(idsCsv); }
        openModal(path);
    };
    window.__openBulkExportModal = function (idsCsv) {
        var path = '/admin/notify/bulk-export-modal';
        if (idsCsv) { path += '?ids=' + encodeURIComponent(idsCsv); }
        openModal(path);
    };

    // nếu modal đã có sẵn trong DOM:
    if (document.getElementById('bulk-delete-modal')) bindBulkDeleteModal();
    if (document.getElementById('bulk-export-modal')) bindBulkExportModal();

})();

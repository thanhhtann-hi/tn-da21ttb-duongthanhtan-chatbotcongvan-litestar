// file: src/modules/chat/static/js/chat_header.js
// updated: 2025-09-03
// note:
//   - Hỗ trợ tier 4 mức: auto | low | medium | high (KHÔNG ép auto -> low; BE router sẽ quyết định khi gọi model)
//   - Tinh chỉnh hint dropdown, fix typo, đồng bộ tick ở fallback
//   - NEW: "Đọc tất cả" dùng Optimistic UI + tắt badge ngay, retry CSRF 403 + dọn class đậm ở node con

(function () {
    'use strict';
    if (window.__CHAT_HEADER_APPLIED__) return;
    window.__CHAT_HEADER_APPLIED__ = true;
    window.__CHAT_HEADER_VER = '7.8';

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    // ---------------- CSRF helpers ----------------
    function getCookie(name) {
        try {
            var a = (document.cookie || '').split('; ');
            for (var i = 0; i < a.length; i++) {
                var s = a[i], k = decodeURIComponent(s.split('=')[0]);
                if (k === name) return decodeURIComponent(s.split('=')[1] || '');
            }
            return '';
        } catch (_) { return ''; }
    }
    function getCsrfToken() {
        var m = document.querySelector('meta[name="csrf-token"]');
        return getCookie('csrftoken') || (m ? m.content : '') || '';
    }
    function syncMetaFromCookie() {
        try {
            var v = getCookie('csrftoken'); if (!v) return;
            var m = document.querySelector('meta[name="csrf-token"]');
            if (!m) { m = document.createElement('meta'); m.setAttribute('name', 'csrf-token'); document.head.appendChild(m); }
            m.setAttribute('content', v);
        } catch (_) { }
    }
    async function warmUpCSRF() {
        try {
            await fetch('/chat/notify/unread_count', {
                credentials: 'include',
                headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
            });
        } catch (_) { }
        syncMetaFromCookie();
    }
    async function jsonFetch(url, opts) {
        opts = opts || {};
        var method = (opts.method || 'GET').toUpperCase();
        var h = new Headers(opts.headers || {});
        h.set('Accept', 'application/json');
        h.set('X-Requested-With', 'XMLHttpRequest');
        if (method !== 'GET') {
            var t = getCsrfToken();
            if (t) h.set('X-CSRFToken', t);
        }
        if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
            var t2 = getCsrfToken();
            if (t2 && !('csrf_token' in opts.body)) opts.body.csrf_token = t2;
            h.set('Content-Type', 'application/json');
            opts.body = JSON.stringify(opts.body);
        }
        return fetch(url, Object.assign({ credentials: 'include' }, opts, { headers: h }));
    }

    // ---------------- Tier helpers (hint dropdown) ----------------
    function normalizeTier(x) {
        var s = String(x || '').trim().toLowerCase();
        if (s === 'low' || s === 'medium' || s === 'high' || s === 'auto') return s; // giữ nguyên 'auto'
        if (s === 'fast' || s === 'instant') return 'low';
        if (s === 'pro' || s === 'thinking' || s === 'research' || s === 'deep') return 'high';
        if (!s) return '';
        return 'medium';
    }
    function tierLabel(t) {
        var m = { low: 'Low', medium: 'Medium', high: 'High', auto: 'Auto' };
        return m[t] || '';
    }

    // ---------------- UI helpers ----------------
    function readSelectedFromCookie() {
        var id = getCookie('moe_model_id'), name = getCookie('moe_model_name');
        if (!id && !name) return null;
        return { id: id, name: name };
    }

    // Tách tên cho header: primary = mọi từ trừ từ cuối; secondary = từ cuối
    function splitForHeader(name) {
        var s = String(name || '').trim().replace(/\s+/g, ' ');
        if (!s) return { primary: 'MoE', secondary: '' };
        var parts = s.split(' ');
        if (parts.length === 1) return { primary: parts[0], secondary: '' };
        var secondary = parts.pop();
        var primary = parts.join(' ');
        return { primary: primary, secondary: secondary };
    }

    function setHeaderLabel(model) {
        // KHÔNG hiển thị tier/variant trên header
        var root = $('#moe-selected');
        if (!root) return;

        var labelWrap = root.querySelector('.moe-label');
        var pri = root.querySelector('.moe-primary');
        var sec = root.querySelector('.moe-secondary');
        var varn = root.querySelector('.moe-variant');

        var name = (model && model.name) ? String(model.name).trim() : 'MoE';
        if (varn) varn.textContent = ''; // tắt tier

        if (pri && sec) {
            var ps = splitForHeader(name);
            pri.textContent = ps.primary || 'MoE';
            sec.textContent = ps.secondary || '';
            sec.classList.toggle('hidden', !ps.secondary);
        } else if (labelWrap) {
            labelWrap.textContent = name || 'MoE';
        }
    }

    // ---------------- Dropdown tick ----------------
    function ensureTickNodeIn(li) {
        var t = li.querySelector('.tick-icon'); if (t) return t;
        t = document.createElement('span');
        t.className = 'tick-icon hidden flex items-center justify-center w-[20px] h-[20px] pointer-events-none';
        t.setAttribute('aria-hidden', 'true');
        var tpl = document.getElementById('moe-tick-icon');
        try {
            if (tpl && tpl.content && tpl.content.firstElementChild) {
                var node = tpl.content.firstElementChild.cloneNode(true);
                if (node.tagName && node.tagName.toLowerCase() === 'svg') {
                    node.setAttribute('width', '16'); node.setAttribute('height', '16'); node.style.display = 'block';
                }
                t.appendChild(node);
            } else {
                t.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 4.5L6.5 10.5L3.5 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            }
        } catch (_) {
            t.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 4.5L6.5 10.5L3.5 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        }
        li.appendChild(t); return t;
    }

    // ---------------- State ----------------
    var MOE_MODELS = [];
    var MOE_SELECTED = null;

    function buildDropdown(models) {
        var dd = $('#moe-dropdown'); if (!dd) return;
        var ul = $('#moe-list', dd) || dd.querySelector('ul');
        if (!ul) {
            ul = document.createElement('ul');
            ul.id = 'moe-list';
            ul.className = 'space-y-1 px-2';
            dd.appendChild(ul);
        }
        ul.innerHTML = '';

        if (!models || !models.length) {
            ul.innerHTML = '<li class="moe-empty px-4 py-2 text-[13px] text-[#9CA3AF]">Không có mô hình khả dụng.</li>';
            return;
        }

        for (var i = 0; i < models.length; i++) {
            var m = models[i], li = document.createElement('li');
            li.role = 'menuitem'; li.tabIndex = 0;
            li.dataset.modelId = m.id; li.dataset.modelName = m.name;
            li.setAttribute('aria-selected', 'false');
            li.className = 'moe-item flex items-center justify-between gap-4 cursor-pointer rounded-md px-4 py-2 hover:bg-[#374151] transition-colors';

            var left = document.createElement('div'); left.className = 'moe-main flex flex-col min-w-0';
            var title = document.createElement('span'); title.className = 'moe-name truncate';
            var short = (m.short_label || '').trim(); if (!short) short = (m.name || '').trim(); if (!short) short = 'Model';
            title.textContent = short;

            var sub = document.createElement('span'); sub.className = 'moe-hint text-[12px] text-[#B1B1B1] truncate';
            var tier = normalizeTier(m.tier || m.variant || m.type);
            var pieces = [];
            var hintLeft = (m.description || m.provider || '').trim();
            if (hintLeft) pieces.push(hintLeft);
            if (tier) pieces.push('· ' + tierLabel(tier));
            sub.textContent = pieces.join(' ');
            left.appendChild(title); left.appendChild(sub); li.appendChild(left);

            ensureTickNodeIn(li);

            (function (mm) {
                li.addEventListener('click', function () {
                    selectModel({
                        id: mm.id,
                        name: mm.name,
                        type: mm.type,
                        tier: normalizeTier(mm.tier || mm.variant || mm.type),
                        provider: mm.provider
                    }, false);
                });
            })(m);
            li.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); }
            });

            ul.appendChild(li);
        }

        var selectedId = (MOE_SELECTED && MOE_SELECTED.id) || ((readSelectedFromCookie() || {}).id);
        if (selectedId) markTick(selectedId);
    }

    function markTick(modelId) {
        var lis = $$('#moe-dropdown li[role="menuitem"]');
        for (var i = 0; i < lis.length; i++) {
            lis[i].classList.remove('is-active');
            lis[i].setAttribute('aria-selected', 'false');
            ensureTickNodeIn(lis[i]).classList.add('hidden');
        }
        var target = null;
        for (var j = 0; j < lis.length; j++) {
            if (lis[j].dataset && String(lis[j].dataset.modelId) === String(modelId)) { target = lis[j]; break; }
        }
        if (!target) return;
        target.classList.add('is-active');
        target.setAttribute('aria-selected', 'true');
        ensureTickNodeIn(target).classList.remove('hidden');
    }

    window.__docaix_moe = {
        version: function () { return window.__CHAT_HEADER_VER; },
        markTick: markTick,
        getItems: function () { return document.querySelectorAll('#moe-dropdown li[role="menuitem"]').length; },
        selected: function () { return MOE_SELECTED; }
    };

    // ---------------- Models loading ----------------
    async function loadModels() {
        try {
            var r = await jsonFetch('/chat/models');
            var ct = (r.headers.get('content-type') || '').toLowerCase();
            if (!ct.includes('application/json')) throw new Error('NON_JSON');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            var data = await r.json();
            MOE_MODELS = (data && data.models ? data.models : []).map(function (m) {
                return Object.assign({}, m, { tier: normalizeTier(m.tier || m.variant || m.type) });
            });
            buildDropdown(MOE_MODELS);
            return MOE_MODELS;
        } catch (err) {
            console.error('Không tải được danh sách mô hình:', err);
            var ul = $('#moe-list');
            if (ul) ul.innerHTML = '<li class="px-4 py-2 text-[13px] text-red-300">Không tải được mô hình.</li>';
            return [];
        }
    }

    async function ensureCsrfReady() {
        if (!getCookie('csrftoken')) await warmUpCSRF();
        else syncMetaFromCookie();
    }

    async function selectModel(model, silent) {
        MOE_SELECTED = model;
        setHeaderLabel(model);
        markTick(model.id);

        await ensureCsrfReady();
        var attempt = function () { return jsonFetch('/chat/model/select', { method: 'POST', body: { model_id: model.id } }); };
        try {
            var res = await attempt();
            if (res.status === 403) { await warmUpCSRF(); res = await attempt(); }
            if (!res.ok) { console.warn('Chọn model thất bại:', res.status); return; }
            document.dispatchEvent(new CustomEvent('moe-model-selected', { detail: model }));
            if (!silent) {
                var dd = $('#moe-dropdown'); if (dd) dd.classList.add('hidden');
                var btn = $('#btn-moe-toggle'); if (btn) btn.setAttribute('aria-expanded', 'false');
            }
        } catch (e) {
            console.error('Chọn model lỗi mạng:', e);
        }
    }

    // ---------------- Modal helpers ----------------
    function ensureModalRoot() {
        var root = $('#chat-modal-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'chat-modal-root';
            document.body.appendChild(root);
        }
        return root;
    }
    function closeModal() {
        var root = $('#chat-modal-root');
        if (root) root.innerHTML = '';
    }

    // ---------------- Notifications dropdown ----------------

    // === Optimistic "Mark all read" (đè cả node con & đặt style inline) ===
    function markAllReadUI() {
        var root = document.getElementById('notification-list');
        if (!root) return;

        // selector ứng cử viên cho title/text bên trong item (cover nhiều markup)
        var TITLE_SEL = '.notify-title,[data-role="notify-title"],.title,.line-1,header strong,header b';
        var TEXT_SEL = '.notify-text,[data-role="notify-text"],.desc,.line-2,section p';

        // class cần gỡ để tránh “đậm/trắng”
        var KILL_CLASSES = [
            'font-bold', 'font-semibold', 'font-extrabold', 'text-white',
            'text-gray-50', 'text-gray-100', 'text-zinc-100', 'text-neutral-100', 'text-slate-100',
            'text-foreground'
        ];
        var KILL_COLOR_RE = /\btext-(?:slate|gray|zinc|neutral|stone)-(?:50|100|200)\b/g;

        root.querySelectorAll('li').forEach(function (li) {
            // trạng thái
            li.classList.remove('is-unread', 'unread', 'new');
            li.classList.add('is-read');
            li.setAttribute('data-unread', '0');

            // bỏ dot/badge nếu còn
            li.querySelectorAll('.notify-dot,.badge-dot,[data-unread-dot]').forEach(function (n) { n.remove(); });

            // làm mềm TEXT
            li.querySelectorAll(TITLE_SEL + ',' + TEXT_SEL).forEach(function (el) {
                if (!el || !el.classList) return;

                // gỡ class đậm/màu “cứng”
                KILL_CLASSES.forEach(function (c) { el.classList.remove(c); });
                if (el.className) el.className = el.className.replace(KILL_COLOR_RE, '').trim();

                // đặt style inline để thắng mọi rule khác
                var isTitle = el.matches(TITLE_SEL);
                el.style.setProperty('color', isTitle ? '#D1D5DB' : '#B1B1B1', 'important');
                el.style.fontWeight = '400';
            });
        });

        // tắt badge tổng ngay
        var badge = document.getElementById('notification-badge');
        if (badge) badge.classList.add('hidden');
    }


    async function postMarkAllRead() {
        await ensureCsrfReady();
        try {
            var r = await jsonFetch('/chat/notify/read_all', { method: 'POST', body: {} });
            if (r.status === 403) { await warmUpCSRF(); r = await jsonFetch('/chat/notify/read_all', { method: 'POST', body: {} }); }
            if (!r.ok) throw new Error('HTTP ' + r.status);
        } catch (err) {
            console.warn('read_all failed → reload list', err);
            try { loadNotifications(); } catch (_) { }
        }
    }

    async function loadNotifications() {
        var list = $('#notification-list'); if (!list) return;
        list.innerHTML = '<li class="px-2 py-1 text-[13px] text-[#9CA3AF]">Đang tải…</li>';
        try {
            var r = await fetch('/chat/notify/list', {
                credentials: 'include',
                headers: { 'Accept': 'text/html', 'HX-Request': 'true' }
            });
            if (!r.ok) { list.innerHTML = '<li class="px-2 py-1 text-[13px] text-red-300">Không tải được thông báo.</li>'; return; }
            var html = await r.text();
            list.innerHTML = (html && html.trim()) ? html
                : '<li class="px-2 py-1 text-[13px] text-[#9CA3AF]">Không có thông báo.</li>';

            if (window.htmx) window.htmx.process(list);
        } catch (e) {
            console.error('Không tải được thông báo:', e);
            list.innerHTML = '<li class="px-2 py-1 text-[13px] text-red-300">Không tải được thông báo.</li>';
        }
    }

    function hideNotificationDropdown() {
        var dd = $('#notification-dropdown'), btn = $('#btn-notification'), tip = $('#notification-tooltip');
        if (dd) dd.classList.add('hidden');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        if (tip) tip.classList.remove('hidden');
    }
    function toggleNotificationDropdown() {
        var btn = $('#btn-notification');
        var dd = $('#notification-dropdown');
        var tip = $('#notification-tooltip');
        if (!btn || !dd) return;

        var willOpen = dd.classList.contains('hidden');

        // đóng MoE nếu đang mở
        var moe = $('#moe-dropdown'); if (moe) moe.classList.add('hidden');
        var moeBtn = $('#btn-moe-toggle'); if (moeBtn) moeBtn.setAttribute('aria-expanded', 'false');

        if (willOpen) {
            dd.classList.remove('hidden');
            btn.setAttribute('aria-expanded', 'true');
            if (tip) tip.classList.add('hidden');
            loadNotifications();
        } else {
            hideNotificationDropdown();
        }
    }
    function closeNotificationIfOutside(evTarget) {
        var dd = $('#notification-dropdown'); if (!dd || dd.classList.contains('hidden')) return;
        var btn = $('#btn-notification');
        var inside = dd.contains(evTarget) || (btn && btn.contains(evTarget));
        if (!inside) hideNotificationDropdown();
    }

    // ---------------- Home lobby options guard ----------------
    function isChatLobby() {
        var header = $('#chat-header');
        var flag = header && header.getAttribute('data-is-home');
        if (flag === '1') return true;
        var p = (location.pathname || '').replace(/\/+$/, '');
        return (p === '' || p === '/' || p === '/chat');
    }
    function hideOptionsIfLobby() {
        if (!isChatLobby()) return;
        var btn = $('#btn-options');
        var dd = $('#options-dropdown');
        if (btn) btn.style.display = 'none';
        if (dd) dd.classList.add('hidden');
    }

    // ---------------- Header height lock (read var -> set element) ----------------
    function lockHeaderHeight() {
        var el = document.getElementById('chat-header');
        if (!el) return;
        var raw = getComputedStyle(document.documentElement).getPropertyValue('--header-height').trim();
        var target = parseFloat(raw) || 60; // fallback 60
        el.style.minHeight = target + 'px';
        el.style.height = target + 'px';

        var inner = el.querySelector('.header-shell');
        if (inner) {
            inner.style.minHeight = target + 'px';
            inner.style.height = '100%';
            inner.style.display = 'flex';
            inner.style.alignItems = 'center';
        }
    }

    // ---------------- hydrate ----------------
    async function hydrateMoE() {
        syncMetaFromCookie();
        ensureModalRoot();

        // Toggle MoE dropdown & Notification dropdown
        document.addEventListener('click', function (e) {
            // MoE
            var btn = e.target && e.target.closest && e.target.closest('#btn-moe-toggle');
            var dd = $('#moe-dropdown');
            if (btn && dd) {
                e.preventDefault();
                var willOpen = dd.classList.contains('hidden');
                closeNotificationIfOutside(null);
                if (willOpen) { dd.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); $('#moe-tooltip')?.classList.add('hidden'); }
                else { dd.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); $('#moe-tooltip')?.classList.remove('hidden'); }
                return;
            }
            // Notification
            var bell = e.target && e.target.closest && e.target.closest('#btn-notification');
            if (bell) { e.preventDefault(); toggleNotificationDropdown(); return; }

            // Modal close
            var closeBtn = e.target && e.target.closest && e.target.closest('#chat-modal-close-btn, #chat-modal-overlay');
            if (closeBtn) { e.preventDefault(); closeModal(); return; }

            // Click ngoài -> đóng dropdowns
            var dd2 = $('#moe-dropdown');
            if (dd2 && !dd2.classList.contains('hidden')) {
                var inside = dd2.contains(e.target) || ($('#btn-moe-toggle') && $('#btn-moe-toggle').contains(e.target));
                if (!inside) dd2.classList.add('hidden');
            }
            closeNotificationIfOutside(e.target);
        });

        // NEW: chặn HTMX & thực hiện optimistic "Đọc tất cả"
        document.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest && e.target.closest('#mark-all-read');
            if (!btn) return;
            e.preventDefault(); e.stopPropagation(); // tránh hx-post trùng
            btn.setAttribute('aria-busy', 'true');
            btn.classList.add('opacity-60', 'pointer-events-none');
            markAllReadUI();           // cập nhật UI ngay (li + node con)
            postMarkAllRead().finally(function () {
                btn.removeAttribute('aria-busy');
                btn.classList.remove('opacity-60', 'pointer-events-none');
            });
        }, true);

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                var dd = $('#moe-dropdown'); if (dd) dd.classList.add('hidden');
                hideNotificationDropdown();
                closeModal();
            }
        });

        // Khi modal đã được swap xong (kể cả OOB) → đóng dropdown thông báo
        ['htmx:afterSwap', 'htmx:oobAfterSwap'].forEach(function (ev) {
            document.body.addEventListener(ev, function () {
                if ($('#chat-modal')) hideNotificationDropdown();
                lockHeaderHeight(); // re-apply sau khi HTMX thay DOM
            });
        });

        hideOptionsIfLobby();

        var models = await loadModels(); if (!models.length) return;

        // Query preference
        var qp = new URLSearchParams(location.search);
        var qModel = (qp.get('model') || '').trim().toLowerCase();
        var qTier = normalizeTier(qp.get('tier') || '');
        if (qModel) {
            var byName = models.find(function (m) { return (String(m.name || '').toLowerCase() === qModel); });
            if (byName) { await selectModel(byName, true); return; }
        }
        if (qTier) {
            var byTier = models.find(function (m) { return normalizeTier(m.tier) === qTier; });
            if (byTier) { await selectModel(byTier, true); return; }
        }

        // Cookie
        var ck = readSelectedFromCookie();
        if (ck) {
            var f2 = models.find(function (m) {
                return String(m.id) === String(ck.id) || (m.name || '').toLowerCase() === (ck.name || '').toLowerCase();
            });
            if (f2) { MOE_SELECTED = f2; setHeaderLabel(f2); markTick(f2.id); return; }
        }

        // Fallback
        if (models.length === 1) { MOE_SELECTED = models[0]; setHeaderLabel(models[0]); markTick(models[0].id); return; }
        setHeaderLabel({ name: models[0].name, tier: models[0].tier });
        markTick(models[0].id);
    }

    // ---------------- init ----------------
    document.addEventListener('DOMContentLoaded', function () {
        syncMetaFromCookie();
        hydrateMoE();

        // Khoá chiều cao header theo biến (không đo).
        lockHeaderHeight();
        window.addEventListener('resize', lockHeaderHeight, { passive: true });
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(lockHeaderHeight).catch(function () { });
        }

        // notifications badge poll
        async function refresh() {
            try {
                var r = await fetch('/chat/notify/unread_count', { headers: { 'Accept': 'application/json' } });
                var d = await r.json();
                var v = +(d && (d.unread != null ? d.unread : d.count) || 0);
                var b = $('#notification-badge');
                if (b) b.classList.toggle('hidden', v === 0);
            } catch (_) { }
        }
        refresh();
        var poll = setInterval(refresh, 45000);
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(); });
        window.__CHAT_HDR_BADGE_STOP__ = function () { clearInterval(poll); };
    });
})();

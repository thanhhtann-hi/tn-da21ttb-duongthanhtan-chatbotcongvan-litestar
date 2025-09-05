// file: src/modules/chat/static/js/chat_sidebar_left.js
// updated: 2025-08-19 (v3.38)
// note: Header/Footer cố định ngoài scroller; Shadow dựa theo #sidebar-scroll
//       Portal “…”: dùng icon_header_trash.svg (template) + nhãn xoá theo ngữ cảnh (dự án/chat).
//       NEW: HTMX glue cho danh sách Đoạn chat (#sidebar-chat-list)
//            - load lần đầu
//            - reload khi 'chat:refresh'
//            - highlight client-side theo URL hiện tại
//            - KHÔNG clear DOM list sau khi render

(function () {
    'use strict';

    // ===== DEBUG switch (tùy chọn) =====
    const __DBG = !!window.__DEBUG_SIDEBAR__;
    const dbg = (...a) => { if (__DBG) try { console.debug('[sidebar]', ...a); } catch { } };

    // [1] Early state (anti-flicker) + singleton guard
    (function early() {
        try {
            const el = document.getElementById('sidebar') || document.getElementById('sidebar-shell');
            if (!el) return;
            const isOpenSaved = localStorage.getItem('sidebarOpen') !== 'false';
            el.style.transition = 'none';
            el.classList.add(isOpenSaved ? 'sidebar-open' : 'sidebar-collapsed', 'toggle-ready');
            setTimeout(() => (el.style.transition = ''), 120);
        } catch { /* silent */ }
    })();
    if (window.__CHAT_SIDEBAR_APPLIED__) return;
    window.__CHAT_SIDEBAR_APPLIED__ = true;

    // [2] DOM, state, helpers
    // Cho phép chạy với layout có #sidebar hoặc #sidebar-shell (tương thích 2 template)
    const sidebar = document.getElementById('sidebar') || document.getElementById('sidebar-shell') || document.querySelector('[data-sidebar-root], aside[id*="sidebar"]');
    if (!sidebar) { dbg('No sidebar root found'); return; }

    const scroller = sidebar.querySelector('#sidebar-scroll') || sidebar; // vùng NAV cuộn
    const $all = (sel, root = sidebar) => Array.from(root.querySelectorAll(sel));
    const logo = document.getElementById('sidebar-logo');
    const btnToggleOpen = document.getElementById('btn-toggle-sidebar-open');
    const btnToggleCollapsed = document.getElementById('btn-toggle-sidebar-collapsed');
    const linkNewChat = document.getElementById('sidebar-new-chat');

    const headerEl = sidebar.querySelector('.sidebar-header');
    const footerEl = sidebar.querySelector('.sidebar-footer');

    let isOpen = localStorage.getItem('sidebarOpen') !== 'false';

    const showLogo = () => { if (logo) { logo.classList.remove('opacity-0'); logo.style.pointerEvents = 'auto'; } };
    const hideLogo = () => { if (logo) { logo.classList.add('opacity-0'); logo.style.pointerEvents = 'none'; } };
    const enlargeTooltip = on => $all('.sidebar-tooltip').forEach(t => t.classList.toggle('scale-tooltip', !!on));
    const showAllShortcuts = on => sidebar.classList.toggle('show-shortcuts', !!on);
    const isEditable = (el) => {
        const t = (el && el.tagName) ? el.tagName.toLowerCase() : '';
        return el && (el.isContentEditable || t === 'input' || t === 'textarea' || t === 'select');
    };

    // [3] Căn trục X/Y các icon (“…”, toggle…)
    function syncDotsAlignment() {
        const nudge = (getComputedStyle(document.documentElement).getPropertyValue('--icon-nudge-y') || '0px').trim();
        sidebar.querySelectorAll('.row-more svg, #btn-toggle-sidebar-open svg, #btn-toggle-sidebar-collapsed svg')
            .forEach(svg => { svg.style.transform = `translateY(${nudge})`; });
        sidebar.querySelectorAll('.row-actions').forEach(box => { box.style.right = '0px'; });
    }

    function updateToggleVisibility() {
        if (btnToggleOpen) { btnToggleOpen.classList.toggle('hidden', !isOpen); btnToggleOpen.disabled = !isOpen; }
        if (btnToggleCollapsed) { btnToggleCollapsed.classList.toggle('hidden', isOpen); btnToggleCollapsed.disabled = isOpen; }
    }

    // [3.a] Shadow dựa theo scroller (KHÔNG sticky)
    function updateStickyShadows() {
        const atTop = scroller.scrollTop <= 0;
        const atBottom = Math.ceil(scroller.scrollTop + scroller.clientHeight) >= scroller.scrollHeight;
        if (headerEl) headerEl.classList.toggle('has-shadow-top', !atTop);
        if (footerEl) footerEl.classList.toggle('has-shadow-bottom', !atBottom);
    }

    // [4] Apply open/collapsed
    function apply() {
        sidebar.classList.remove('sidebar-open', 'sidebar-collapsed');
        if (isOpen) {
            sidebar.classList.add('sidebar-open');
            $all('.sidebar-label').forEach(el => { el.style.opacity = '1'; el.style.display = ''; });
            $all('.shortcut').forEach(el => { el.style.opacity = '1'; el.style.display = ''; });
            enlargeTooltip(false); showLogo();
        } else {
            showAllShortcuts(false);
            sidebar.classList.add('sidebar-collapsed');
            $all('.sidebar-label').forEach(el => { el.style.opacity = '0'; setTimeout(() => el.style.display = 'none', 150); });
            $all('.shortcut').forEach(el => { el.style.opacity = '0'; setTimeout(() => el.style.display = 'none', 150); });
            enlargeTooltip(true); showLogo();
            setTimeout(() => sidebar.classList.add('toggle-ready'), 150);
        }
        updateToggleVisibility();

        try { localStorage.setItem('sidebarOpen', String(isOpen)); } catch { /* noop */ }

        syncDotsAlignment();
        updateStickyShadows();
    }

    // [5] Micro UX
    sidebar.addEventListener('mouseenter', () => { if (!isOpen && sidebar.classList.contains('toggle-ready')) hideLogo(); });
    sidebar.addEventListener('mouseleave', () => { if (!isOpen && sidebar.classList.contains('toggle-ready')) showLogo(); });

    sidebar.classList.add('transition-all', 'duration-200');
    [logo, btnToggleOpen, btnToggleCollapsed].filter(Boolean)
        .forEach(el => el && el.classList.add('transition-opacity', 'duration-150'));

    apply();

    // [6] Toggle width
    btnToggleOpen?.addEventListener('click', (e) => {
        e.preventDefault();
        $all('.sidebar-label,.shortcut').forEach(el => el.style.opacity = '0');
        setTimeout(() => {
            isOpen = false;
            sidebar.classList.remove('toggle-ready');
            apply(); resetCtrl(); closePortal();
        }, 150);
    });
    btnToggleCollapsed?.addEventListener('click', (e) => {
        e.preventDefault();
        sidebar.classList.remove('sidebar-collapsed', 'toggle-ready');
        sidebar.classList.add('sidebar-open'); showLogo();
        setTimeout(() => { isOpen = true; apply(); }, 180);
    });

    // [7] Hold CTRL ≥ 350ms – OPEN only
    const HOLD_MS = 350;
    let ctrlDown = false, ctrlTimer = null;
    const resetCtrl = () => { ctrlDown = false; if (ctrlTimer) { clearTimeout(ctrlTimer); ctrlTimer = null; } showAllShortcuts(false); };

    document.addEventListener('keydown', (e) => {
        const isCtrl = (e.key === 'Control') || (e.code === 'ControlLeft') || (e.code === 'ControlRight');
        if (!isCtrl || sidebar.classList.contains('sidebar-collapsed') || isEditable(e.target)) return;
        if (!ctrlDown) {
            ctrlDown = true;
            if (ctrlTimer) clearTimeout(ctrlTimer);
            ctrlTimer = setTimeout(() => { if (ctrlDown && !sidebar.classList.contains('sidebar-collapsed')) showAllShortcuts(true); }, HOLD_MS);
        }
    }, { passive: true });
    document.addEventListener('keyup', (e) => {
        const isCtrl = (e.key === 'Control') || (e.code === 'ControlLeft') || (e.code === 'ControlRight');
        if (isCtrl) resetCtrl();
    }, { passive: true });
    window.addEventListener('blur', resetCtrl, { passive: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) resetCtrl(); }, { passive: true });

    // [8] Ctrl+Alt+N
    document.addEventListener('keydown', (e) => {
        if (isEditable(e.target)) return;
        const isKeyN = (e.key && e.key.toLowerCase() === 'n') || e.code === 'KeyN';
        if ((e.ctrlKey || e.metaKey) && e.altKey && isKeyN) {
            e.preventDefault();
            const a = linkNewChat; if (a && typeof a.click === 'function') a.click(); else window.location.href = '/chat';
        }
    });

    // =================== DROPDOWN “…” PORTAL ===================
    const ASIDE = sidebar;
    const GUTTER_X = (() => {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--row-menu-gutter-x').trim();
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
    })();

    let portal = null, anchorBtn = null, anchorRow = null;

    function ensurePortal() {
        if (portal) return portal;
        portal = document.createElement('div');
        portal.className = 'portal-row-menu';
        portal.id = 'portal-row-menu';
        portal.setAttribute('role', 'menu');
        document.body.appendChild(portal);
        return portal;
    }

    // ====== icon helpers & dynamic menu ======
    function cloneFromTemplate(tplId) {
        try {
            const tpl = document.getElementById(tplId);
            if (tpl && tpl.content && tpl.content.firstElementChild) {
                const node = tpl.content.firstElementChild.cloneNode(true);
                node.setAttribute?.('width', '18');
                node.setAttribute?.('height', '18');
                return node;
            }
        } catch { }
        return null;
    }
    function makeIconTrash() {
        const svg = cloneFromTemplate('tpl-icon-header-trash');
        if (svg) return svg;
        const ns = 'http://www.w3.org/2000/svg';
        const s = document.createElementNS(ns, 'svg');
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '18'); s.setAttribute('height', '18');
        s.innerHTML = '<path d="M9 3h6a1 1 0 0 1 1 1v1h4v2H4V5h4V4a1 1 0 0 1 1-1zm1 0v1h4V3h-4zM7 9h2v10H7V9zm4 0h2v10h-2V9zm4 0h2v10h-2V9z" fill="#fff"/>';
        return s;
    }
    function makeIconRename() {
        const ns = 'http://www.w3.org/2000/svg';
        const s = document.createElementNS(ns, 'svg');
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '18'); s.setAttribute('height', '18');
        s.innerHTML = '<g fill="#fff"><path d="M16.98 13.2c-.19 0-.39-.08-.53-.22l-5.4-5.41a.742.742 0 0 1-.1-.93l1.69-2.67c.47-.74 1.18-1.2 2.01-1.29.93-.09 1.89.27 2.64 1.02l3.03 3.03c.72.72 1.08 1.69.97 2.65-.09.84-.54 1.57-1.24 2.01l-2.67 1.69c-.12.08-.26.12-.4.12z"/><path d="M5.89 21.34c-.89 0-1.69-.32-2.29-.91-.7-.7-1.01-1.67-.88-2.75l.98-8.33c.3-2.52 1.41-3.44 4-3.29l3.92.23c.41.03.73.38.7.79s-.38.73-.79.7l-3.92-.22c-1.78-.11-2.22.24-2.42 1.97l-.98 8.32c-.07.61.09 1.15.45 1.51.37.36.91.53 1.52.45l8.32-.98c1.75-.21 2.14-.67 1.97-2.39l-.24-3.95c-.02-.41.29-.77.7-.79.41-.03.77.29.79.7l.23 3.92c.24 2.49-.74 3.69-3.29 4l-8.32.98c-.14.03-.3.04-.45.04z"/><path d="M4.61 20.17c-.19 0-.38-.07-.53-.22a.754.754 0 0 1 0-1.06l3.04-3.04c.29-.29.77-.29 1.06 0s.29.77 0 1.06l-3.04 3.04c-.15.15-.34.22-.53.22z"/></g>';
        return s;
    }

    function buildMenu(kind /* 'project' | 'chat' */) {
        const ul = document.createElement('ul');

        // Rename
        const liRename = document.createElement('li');
        liRename.setAttribute('role', 'menuitem');
        liRename.dataset.action = 'rename';
        liRename.innerHTML = '<span class="ic"></span><span></span>';
        liRename.querySelector('.ic').appendChild(makeIconRename());
        liRename.querySelector('span:last-child').textContent =
            (kind === 'chat') ? 'Đổi tên đoạn chat' : 'Đổi tên dự án';
        ul.appendChild(liRename);

        // Delete
        const liDel = document.createElement('li');
        liDel.setAttribute('role', 'menuitem');
        liDel.dataset.action = 'delete';
        liDel.className = 'danger';
        liDel.innerHTML = '<span class="ic"></span><span></span>';
        liDel.querySelector('.ic').appendChild(makeIconTrash());
        liDel.querySelector('span:last-child').textContent =
            (kind === 'chat') ? 'Xoá đoạn chat' : 'Xoá dự án';
        ul.appendChild(liDel);

        return ul;
    }

    function ensurePortalFor(btn) {
        ensurePortal();
        const row = btn.closest('.sidebar-link');
        const isChat = !!row?.dataset?.chat || !!row?.getAttribute('href')?.startsWith?.('/chat/');
        const kind = isChat ? 'chat' : 'project';

        portal.innerHTML = '';
        const minW = getComputedStyle(document.documentElement).getPropertyValue('--row-menu-min-w') || '168px';
        portal.style.minWidth = (minW || '168px').trim();
        portal.appendChild(buildMenu(kind));
    }

    function placePortal(btn) {
        if (!portal || !btn) return;
        const asideRect = ASIDE.getBoundingClientRect();
        const row = btn.closest('.sidebar-link');
        const rowRect = row?.getBoundingClientRect();
        if (!rowRect) return;

        const left = Math.round(asideRect.right + GUTTER_X);
        const top = Math.round(rowRect.top);

        portal.style.left = left + 'px';
        portal.style.top = top + 'px';
        portal.style.height = '';
        portal.style.transform = 'none';

        const margin = 8;
        const availableBelow = window.innerHeight - top - margin;
        portal.style.maxHeight = Math.max(rowRect.height, availableBelow) + 'px';
        portal.style.overflowY = 'auto';
    }

    function openPortalFor(btn) {
        ensurePortalFor(btn);
        placePortal(btn);
        portal.__open = true;
        anchorBtn = btn;
        anchorRow = btn.closest('.sidebar-link') || null;
        btn.setAttribute('aria-expanded', 'true');
    }

    function closePortal() {
        if (!portal?.__open) return;
        portal.__open = false;
        portal.style.left = '-9999px';
        portal.style.top = '-9999px';
        portal.style.height = '';
        portal.style.maxHeight = '';
        portal.style.transform = '';
        anchorBtn?.setAttribute('aria-expanded', 'false');
        anchorBtn = null; anchorRow = null;
    }

    // Global handlers
    function handleDocClick(e) {
        // chỉ xử lý nếu click trong sidebar
        const btn = e.target?.closest?.('.row-more');
        if (btn && sidebar.contains(btn)) {
            e.preventDefault(); e.stopPropagation();
            if (portal?.__open && anchorBtn === btn) { closePortal(); return; }
            closePortal(); openPortalFor(btn); return;
        }
        if (portal && portal.__open && portal.contains(e.target)) {
            e.preventDefault(); e.stopPropagation();
            const li = e.target.closest('li[role="menuitem"]');
            if (!li) return;
            const action = li.dataset.action;
            // TODO: hook hành vi thật (hx-*, modal…) theo action & anchorRow
            closePortal();
            return;
        }
        if (!e.target.closest('.row-more')) closePortal();
    }
    function handleEsc(e) { if (e.key === 'Escape') closePortal(); }
    function handleGlobalWheel() { /* giữ nguyên – đóng theo click/esc là đủ */ }

    document.addEventListener('click', handleDocClick);
    document.addEventListener('keydown', handleEsc, { passive: true });
    document.addEventListener('wheel', handleGlobalWheel, { passive: true });

    // Reposition (raf throttle)
    function rafThrottle(fn) {
        let rafId = 0, lastArgs = null, lastThis = null;
        return function throttled() {
            lastArgs = arguments; lastThis = this;
            if (rafId) return;
            rafId = requestAnimationFrame(() => { rafId = 0; fn.apply(lastThis, lastArgs); });
        };
    }
    const onReposition = () => {
        if (portal?.__open && anchorBtn?.isConnected && ASIDE?.isConnected) placePortal(anchorBtn); else closePortal();
    };
    const onRepositionRaf = rafThrottle(onReposition);

    window.addEventListener('resize', onRepositionRaf, { passive: true });
    scroller.addEventListener('scroll', onRepositionRaf, { passive: true });

    // Shadow theo cuộn & resize
    scroller.addEventListener('scroll', updateStickyShadows, { passive: true });
    window.addEventListener('resize', updateStickyShadows, { passive: true });
    document.body.addEventListener('htmx:afterOnLoad', updateStickyShadows);

    // Close khi state đổi
    const obs = new MutationObserver(() => { closePortal(); updateStickyShadows(); });
    obs.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    document.body.addEventListener('chat:navigated', () => { closePortal(); updateStickyShadows(); });

    // Re-sync alignment khi viewport/HTMX thay đổi
    window.addEventListener('resize', syncDotsAlignment, { passive: true });
    document.body.addEventListener('htmx:afterOnLoad', syncDotsAlignment);

    // Guard khi sidebar bị unmount
    const unmountObserver = new MutationObserver(() => {
        if (!document.body.contains(sidebar)) cleanup();
    });
    unmountObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('pagehide', cleanup, { once: true });
    window.addEventListener('beforeunload', cleanup, { once: true });

    function cleanup() {
        try { closePortal(); } catch { }
        document.removeEventListener('click', handleDocClick);
        document.removeEventListener('keydown', handleEsc);
        document.removeEventListener('wheel', handleGlobalWheel);
        window.removeEventListener('resize', onRepositionRaf);
        window.removeEventListener('resize', syncDotsAlignment);
        window.removeEventListener('resize', updateStickyShadows);
        try { scroller.removeEventListener('scroll', onRepositionRaf); } catch { }
        try { scroller.removeEventListener('scroll', updateStickyShadows); } catch { }
        try { obs.disconnect(); } catch { }
        try { unmountObserver.disconnect(); } catch { }
    }

    // ============== [9] Chat list HTMX glue (NEW) ==============
    function getChatListEl() {
        return sidebar.querySelector('#sidebar-chat-list');
    }

    // Tô “đang mở” phía client (fallback nếu server chưa highlight)
    function highlightActiveClient() {
        try {
            const path = (location.pathname || '').replace(/\/+$/, '');
            const list = getChatListEl();
            if (!list) return;
            list.querySelectorAll('a.sidebar-link').forEach(a => {
                const href = (a.getAttribute('href') || '').replace(/\/+$/, '');
                const active = href && href === path;
                a.classList.toggle('bg-[#27272a]', active);
                a.classList.toggle('border', active);
                a.classList.toggle('border-gray-700', active);
            });
        } catch { }
    }

    // Gọi load fragment:
    // - nếu là shell (có hx-get) → trigger 'load'
    // - nếu là fragment (không hx-get) → htmx.ajax GET /chat/sidebar/list
    function loadChatList(force = false) {
        try {
            const el = getChatListEl();
            if (!el || !window.htmx) return;
            if (el.getAttribute('hx-get')) {
                window.htmx.trigger(el, 'load'); // shell sẽ tự fetch
                dbg('trigger shell load');
            } else if (force) {
                window.htmx.ajax('GET', '/chat/sidebar/list', {
                    target: '#sidebar-chat-list',
                    swap: 'outerHTML',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' }
                });
                dbg('ajax reload fragment');
            }
        } catch { }
    }

    // Load lần đầu (nếu còn là shell / có placeholder)
    setTimeout(() => { loadChatList(false); }, 0);

    // Khi gửi tin nhắn xong (chat_base.js phát), sidebar tự refresh
    document.body.addEventListener('chat:refresh', () => loadChatList(true), false);

    // Sau khi swap fragment, tô active + cập nhật shadow
    document.body.addEventListener('htmx:afterSwap', (ev) => {
        const t = ev.target;
        if (t && t.id === 'sidebar-chat-list') {
            dbg('afterSwap chat-list');
            highlightActiveClient();
            updateStickyShadows();
            syncDotsAlignment();
        }
    });

    // Khi điều hướng (hotkey, popstate, sidebar click) → tô lại
    document.body.addEventListener('chat:navigated', () => { highlightActiveClient(); }, false);

    // Khởi tạo lần đầu
    syncDotsAlignment();
    updateStickyShadows();
    highlightActiveClient();
})();

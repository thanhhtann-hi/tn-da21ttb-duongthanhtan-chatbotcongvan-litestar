/********************************************************************
 * file: src/modules/admin/static/js/admin_left.js
 * updated: 2025-08-25 (v4.4)
 * note:
 *  - Sidebar desktop controller: collapse/expand, dropdown-in-collapsed,
 *    accordion state persist (ARIA), active-route highlight.
 *  - Frame loader (HTMX) + QS carry for /admin/notify.
 *  - Map /admin/<mod> → /admin/<mod>/fragment (push URL đẹp).
 *  - v4.4: Thêm 'documents' & 'datasets' vào FRAGMENTABLE; highlight “Dữ liệu”.
 ********************************************************************/

(() => {
    'use strict';

    /* === 1) EARLY SIDEBAR STATE (anti-flicker) ======================= */
    (function earlySidebarState() {
        try {
            const sidebar = document.getElementById('admin-sidebar');
            if (!sidebar) return;
            const isOpenSaved = localStorage.getItem('adminSidebarOpen') !== 'false';
            sidebar.style.transition = 'none';
            sidebar.classList.add(isOpenSaved ? 'sidebar-open' : 'sidebar-collapsed', 'toggle-ready');
            setTimeout(() => (sidebar.style.transition = ''), 150);
        } catch { /* silent */ }
    })();

    /* === 2) DOM-CACHE ================================================= */
    const sidebar = document.getElementById('admin-sidebar');
    const logo = document.getElementById('admin-sidebar-logo');
    const btnCollapse = document.getElementById('btn-admin-toggle-sidebar-open');
    const btnExpand = document.getElementById('btn-admin-toggle-sidebar-collapsed');
    const dropdown = document.getElementById('admin-collapsed-dropdown');
    const frameEl = document.getElementById('admin-frame');
    const headerTitle = document.getElementById('admin-header-text');

    // Logout modal bits
    const logoutModal = document.getElementById('logout-modal');
    const logoutOverlay = document.getElementById('logout-modal-overlay');
    const logoutConfirmBtn = document.getElementById('logout-modal-confirm');
    const logoutCancelBtn = document.getElementById('logout-modal-cancel');
    const logoutUsername = document.getElementById('logout-modal-username');

    if (!sidebar || !logo || !btnCollapse || !btnExpand || !dropdown) return;

    /* === 3) CONSTANTS & HELPERS ====================================== */
    const DROPDOWN_GAP_PX = 2;
    const ANIMATION_TIME = 400;
    const DURATION_LOGOUT = 80;
    const DEFAULT_TITLE = 'Trang chủ';

    // Notify toolbar keys
    const KEY_VIS = 'admin_notify_visibility';
    const KEY_SORT = 'admin_notify_sort';
    const KEY_Q = 'admin_notify_search';
    const KEY_RANGE = 'admin_notify_date_range';

    const $inSidebar = sel => Array.from(sidebar.querySelectorAll(sel));
    const $$ = sel => Array.from(document.querySelectorAll(sel));
    const getMeta = n => document.querySelector(`meta[name="${n}"]`)?.content || '';
    const htmxOk = () => typeof window.htmx !== 'undefined';

    const getCurrentEmail = () => (
        logoutModal?.dataset.userEmail ||
        logoutUsername?.dataset.email ||
        getMeta('current-user-email') ||
        (typeof window.CURRENT_ADMIN_EMAIL !== 'undefined' ? window.CURRENT_ADMIN_EMAIL : '')
    );

    /* === 4) STATE ===================================================== */
    let isOpen = localStorage.getItem('adminSidebarOpen') !== 'false';

    /* === 5) COLLAPSED DROPDOWN ======================================= */
    const hideDropdown = () => {
        sidebar.querySelectorAll('.sidebar-tooltip').forEach(tip => {
            tip.style.transition = 'none';
            tip.style.opacity = '0';
            tip.style.visibility = 'hidden';
            tip.style.pointerEvents = 'none';
        });
        sidebar.querySelector('.sidebar-link.dropdown-open')?.classList.remove('dropdown-open');
        dropdown.classList.add('hidden');
        dropdown.removeAttribute('style');
    };

    const buildDropdown = (subs = [], currentPath) => {
        if (!Array.isArray(subs) || !subs.length) return false;
        dropdown.innerHTML = '';
        dropdown.className = 'fixed z-[100] p-2 bg-white rounded-lg shadow-lg border border-gray-200';
        dropdown.style.cssText = 'min-width:200px;max-width:300px;display:flex;flex-direction:column;';
        subs.forEach(sub => {
            const a = document.createElement('a');
            a.className = 'dropdown-item flex items-center justify-between px-3 py-2 text-sm text-blue-900 rounded-md transition-all';
            a.href = sub.href || '#';
            if (sub.frame) a.dataset.frame = sub.frame; // delegation sẽ xử lý click
            (sub.href === currentPath || sub.frame === currentPath) && a.classList.add('active');
            a.innerHTML = `
        <span class="truncate">${sub.label}</span>
        <span class="dropdown-arrow flex items-center justify-center">
          <img src="/static/images/icons/icon_admin_left_arrow_right.svg" width="16" height="16" style="display:block" />
        </span>`;
            dropdown.appendChild(a);
        });
        return true;
    };

    const positionDropdown = btn => {
        const r = btn.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = `${r.top + window.scrollY}px`;
        dropdown.style.left = `${r.right + DROPDOWN_GAP_PX}px`;
        dropdown.classList.remove('hidden');
    };

    /* === 6) FRAME LOADER (HTMX target = element) ====================== */
    // Map route full-page → fragment để nạp vào khung, nhưng vẫn push URL đẹp
    const FRAGMENTABLE = new Set(['users', 'departments', 'tools', 'models', 'security', 'notify', 'documents', 'datasets']);
    const toPath = (url) => String(url || '').split('#')[0].split('?')[0];
    const resolveFrameUrl = (rawUrl) => {
        const url = String(rawUrl || '');
        const path = toPath(url);
        const m = /^\/admin\/([a-z0-9_-]+)$/.exec(path);
        if (m && FRAGMENTABLE.has(m[1])) {
            const tail = url.slice(path.length); // include query/hash
            return `/admin/${m[1]}/fragment${tail}`;
        }
        return url;
    };

    const attachNotifyFilterQS = (rawUrl) => {
        try {
            const url = String(rawUrl || '');
            if (!/\/admin\/notify(?:\/fragment)?(?:$|[?#/])/.test(url)) return url;

            const qs = [];
            try {
                const saved = JSON.parse(localStorage.getItem(KEY_RANGE) || '{}');
                if (saved && saved.from && saved.to) {
                    qs.push('start_date=' + encodeURIComponent(saved.from));
                    qs.push('end_date=' + encodeURIComponent(saved.to));
                }
            } catch { /* noop */ }

            const vis = localStorage.getItem(KEY_VIS) || 'all';
            const sort = localStorage.getItem(KEY_SORT) || 'created_desc';
            const q = localStorage.getItem(KEY_Q) || '';

            if (vis && vis !== 'all') qs.push('v=' + encodeURIComponent(vis));
            if (sort && sort !== 'created_desc') qs.push('sort=' + encodeURIComponent(sort));
            if (q) qs.push('q=' + encodeURIComponent(q));

            if (!qs.length) return url;
            return url.indexOf('?') === -1 ? (url + '?' + qs.join('&')) : (url + '&' + qs.join('&'));
        } catch {
            return rawUrl;
        }
    };

    const loadFrag = (url, pushUrl = null) => {
        if (!htmxOk()) { window.location.href = pushUrl || url; return; }

        const target = frameEl || document.getElementById('admin-frame');
        if (!target || !target.isConnected) {
            window.location.href = pushUrl || url;
            return;
        }

        try {
            const frameUrl = resolveFrameUrl(url);
            const finalUrl = attachNotifyFilterQS(frameUrl);
            window.htmx.ajax('GET', finalUrl, { target, swap: 'innerHTML' });
            if (pushUrl) history.pushState({ frame: url }, '', pushUrl); // push URL đẹp (không /fragment)
        } catch (err) {
            console.error('loadFrag swapError:', err);
            window.location.href = pushUrl || url;
        }
    };

    /* === 7) HEADER TITLE ============================================== */
    const updateHeaderText = () => {
        if (!headerTitle) return;
        const actives = sidebar.querySelectorAll('.admin-left-nav-link.active');
        const label = actives.length ? actives[actives.length - 1].querySelector('.sidebar-label') : null;
        headerTitle.textContent = label ? label.textContent.trim() : DEFAULT_TITLE;
    };

    /* === 8) TEXT SHOW/HIDE ============================================ */
    const showText = () => $inSidebar('.sidebar-label, .shortcut').forEach(el => {
        el.style.display = '';
        requestAnimationFrame(() => (el.style.opacity = '1'));
    });
    const hideText = () => $inSidebar('.sidebar-label, .shortcut').forEach(el => {
        el.style.opacity = '0';
        setTimeout(() => (el.style.display = 'none'), 150);
    });

    /* === 8.1) Submenu helpers (collapse/restore + ARIA) =============== */
    function closeAllSubmenusForCollapsed() {
        sidebar.querySelectorAll('.sidebar-accordion').forEach(container => {
            const key = container.dataset.accordion;
            const btn = container.querySelector('button[data-toggle]');
            const content = container.querySelector(`[data-content="${key}"]`);
            if (!btn || !content) return;

            const wasOpen = !content.classList.contains('hidden');
            content.dataset._wasOpen = wasOpen ? '1' : '0';

            btn.setAttribute('aria-controls', key);
            btn.setAttribute('aria-expanded', 'false');
            content.classList.add('hidden');
            btn.classList.remove('open');
            btn.querySelector('.arrow-icon')?.classList.remove('rotate-180');
        });
    }

    function restoreSubmenusAfterExpand() {
        sidebar.querySelectorAll('.sidebar-accordion').forEach(container => {
            const key = container.dataset.accordion;
            const btn = container.querySelector('button[data-toggle]');
            const content = container.querySelector(`[data-content="${key}"]`);
            if (!btn || !content) return;

            const shouldOpen = content.dataset._wasOpen === '1' || (!content.classList.contains('hidden'));
            content.classList.toggle('hidden', !shouldOpen);
            btn.setAttribute('aria-controls', key);
            btn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
            btn.classList.toggle('open', shouldOpen);
            btn.querySelector('.arrow-icon')?.classList.toggle('rotate-180', shouldOpen);
            delete content.dataset._wasOpen;
        });
    }

    /* === 9) APPLY SIDEBAR STATE ======================================= */
    const applySidebarState = () => {
        sidebar.classList.toggle('sidebar-open', isOpen);
        sidebar.classList.toggle('sidebar-collapsed', !isOpen);

        if (isOpen) {
            restoreSubmenusAfterExpand();
            showText();
        } else {
            closeAllSubmenusForCollapsed();
            hideDropdown();
            hideText();
        }
        localStorage.setItem('adminSidebarOpen', isOpen);
    };

    /* === 10) NAV HIGHLIGHT ============================================ */
    const norm = (s) => {
        const raw = String(s || '');
        const noHash = raw.split('#')[0];
        const pathOnly = noHash.split('?')[0] || '';
        return pathOnly.length > 1 ? pathOnly.replace(/\/+$/, '') : pathOnly;
    };
    const isHome = (t) => norm(t) === '/admin';
    const startsWithSeg = (base, p) => {
        base = norm(base); p = norm(p);
        return base && base !== '/' && p.startsWith(base + '/');
    };

    const isPathMatch = (link, path) => {
        const href = link.getAttribute('href') || '';
        const frame = link.dataset.frame || '';
        const p = norm(path);

        if (norm(href) === p || norm(frame) === p) return true;
        if (isHome(href) || isHome(frame)) return false;
        return startsWithSeg(href, p) || startsWithSeg(frame, p);
    };

    const highlightFromPath = (path = window.location.pathname) => {
        sidebar.querySelectorAll('.sidebar-accordion').forEach(acc => {
            acc.classList.remove('child-active');
            const btn = acc.querySelector('button[data-toggle]');
            btn.classList.remove('active', 'open');
            btn.querySelector('.arrow-icon')?.classList.remove('rotate-180');
            btn.setAttribute('aria-expanded', 'false');
        });
        $inSidebar('.admin-left-nav-link').forEach(l => l.classList.remove('active'));

        let found = false;

        $inSidebar('.admin-left-nav-link').forEach(link => {
            if (!isPathMatch(link, path)) return;

            link.classList.add('active');
            found = true;

            const parent = link.closest('.sidebar-accordion');
            if (parent) {
                parent.classList.add('child-active');
                const btn = parent.querySelector('button[data-toggle]');
                btn.classList.add('active', 'open');
                btn.querySelector('.arrow-icon')?.classList.add('rotate-180');
                btn.setAttribute('aria-expanded', 'true');

                const key = parent.dataset.accordion;
                if (key) localStorage.setItem(`adminAccordion-${key}`, 'true');
                const content = parent.querySelector(`[data-content="${key}"]`);
                content && content.classList.remove('hidden');
            }
            if (link.matches('button[data-toggle]')) {
                link.classList.add('active', 'open');
                link.querySelector('.arrow-icon')?.classList.add('rotate-180');
                link.setAttribute('aria-expanded', 'true');
            }
        });

        // Fallback mở đúng accordion nếu đang ở route đã biết nhưng chưa gắn active
        if (!found) {
            const pathStr = norm(path);
            const ensureOpen = (accId) => {
                const acc = sidebar.querySelector(`.sidebar-accordion[data-accordion="${accId}"]`);
                if (!acc) return;
                const btn = acc.querySelector('button[data-toggle]');
                const content = acc.querySelector(`[data-content="${accId}"]`);
                btn?.classList.add('active', 'open');
                content?.classList.remove('hidden');
                btn?.querySelector('.arrow-icon')?.classList.add('rotate-180');
                btn?.setAttribute('aria-expanded', 'true');
                localStorage.setItem(`adminAccordion-${accId}`, 'true');
            };
            if (/^\/admin\/(users|departments|security|notify)(?:$|[/?#])/.test(pathStr)) {
                ensureOpen('system');
            } else if (/^\/admin\/(documents|datasets)(?:$|[/?#])/.test(pathStr)) {
                ensureOpen('data');
            } else if (/^\/admin\/(tools|models)(?:$|[/?#])/.test(pathStr)) {
                ensureOpen('tools');
            }
        }

        updateHeaderText();
    };

    /* === 11) NAV LINKS → EVENT DELEGATION ============================= */
    const isModifiedClick = (ev) =>
        ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0;

    function onSidebarClickForFrame(ev) {
        const a = ev.target.closest('a[data-frame]');
        if (!a || !sidebar.contains(a)) return;
        if (isModifiedClick(ev)) return; // cho phép Ctrl/Cmd+Click mở tab mới

        ev.preventDefault();
        const href = a.getAttribute('href') || '#';
        const frame = a.dataset.frame || href;

        loadFrag(frame, href);  // frame sẽ được map → /fragment nếu cần
        hideDropdown();
        setTimeout(() => highlightFromPath(href), 30); // highlight theo URL đẹp
    }

    sidebar.addEventListener('click', onSidebarClickForFrame);
    const bindFrameLinks = () => { }; // giữ API cũ (no-op)

    /* === 12) HISTORY & HTMX EVENTS ==================================== */
    window.addEventListener('popstate', e => {
        e.state?.frame ? loadFrag(e.state.frame) : window.location.reload();
        highlightFromPath();
        hideDropdown();
    });

    document.body.addEventListener('htmx:afterOnLoad', () => {
        highlightFromPath();
        hideDropdown();
        bindFrameLinks();
        bindLogoutLinks();
    });

    document.body.addEventListener('htmx:swapError', e => {
        console.error('HTMX swapError:', e.detail?.xhr?.status, e.detail?.xhr?.responseText);
    });

    /* === 13) SIDEBAR SIZE TOGGLE ====================================== */
    btnCollapse.addEventListener('click', () => {
        sidebar.classList.remove('toggle-ready');
        btnCollapse.style.display = 'none';
        isOpen = false;
        applySidebarState();
        setTimeout(() => {
            btnCollapse.style.display = '';
            sidebar.classList.add('toggle-ready');
        }, ANIMATION_TIME);
    });

    btnExpand.addEventListener('click', () => {
        sidebar.classList.remove('toggle-ready');
        btnExpand.style.display = 'none';
        isOpen = true;
        applySidebarState();
        setTimeout(() => (btnExpand.style.display = ''), ANIMATION_TIME);
    });

    /* === 14) ACCORDION ================================================= */
    sidebar.querySelectorAll('.sidebar-accordion').forEach(container => {
        const key = container.dataset.accordion;
        const btn = container.querySelector('button[data-toggle]');
        const content = container.querySelector(`[data-content="${key}"]`);
        const icon = btn.querySelector('.arrow-icon');

        let expanded = localStorage.getItem(`adminAccordion-${key}`) === 'true';

        if (key === 'system' && localStorage.getItem(`adminAccordion-${key}`) === null) {
            expanded = /^\/admin\/(users|departments|security|notify)(?:$|[/?#])/.test(window.location.pathname);
            localStorage.setItem(`adminAccordion-${key}`, expanded ? 'true' : 'false');
        }

        const render = () => {
            content.classList.toggle('hidden', !expanded);
            icon.classList.toggle('rotate-180', expanded);
            btn.classList.toggle('open', expanded);
            btn.setAttribute('aria-controls', key);
            btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        };
        render();

        btn.addEventListener('click', e => {
            if (!sidebar.classList.contains('sidebar-collapsed')) {
                expanded = !expanded;
                localStorage.setItem(`adminAccordion-${key}`, expanded);
                render();
                highlightFromPath();
                return;
            }
            // collapsed → popup dropdown
            e.stopPropagation();
            let subs = [];
            try { subs = JSON.parse(btn.dataset.subs || '[]'); } catch { /* ignore */ }
            if (!buildDropdown(subs, window.location.pathname)) { hideDropdown(); return; }

            sidebar.querySelectorAll('.sidebar-link.dropdown-open')
                .forEach(b => b !== btn && b.classList.remove('dropdown-open'));

            btn.classList.add('dropdown-open');
            positionDropdown(btn);

            setTimeout(() => {
                const onDocClick = ev => {
                    if (!dropdown.contains(ev.target) && !btn.contains(ev.target)) {
                        hideDropdown();
                        document.removeEventListener('mousedown', onDocClick);
                        document.removeEventListener('touchstart', onDocClick);
                    }
                };
                document.addEventListener('mousedown', onDocClick);
                document.addEventListener('touchstart', onDocClick);
            }, 0);
        });

        // Keyboard toggle (Enter/Space)
        btn.addEventListener('keydown', ev => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                btn.click();
            }
        });
    });

    /* === 15) HEADER/FOOTER SHADOW ===================================== */
    const scrollArea = sidebar.querySelector('.sidebar-scrollbar');
    const footer = sidebar.querySelector('.sidebar-footer');
    const header = sidebar.querySelector('header');

    const updateBorder = () => {
        if (!scrollArea) return;
        header?.classList.toggle('has-scroll-header', scrollArea.scrollTop > 1);
        footer?.classList.toggle(
            'has-scroll-footer',
            scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight > 1
        );
    };
    scrollArea && scrollArea.addEventListener('scroll', updateBorder);
    setTimeout(updateBorder, 10);

    /* === 16) GLOBAL LISTENERS ========================================= */
    document.addEventListener('keydown', e => e.key === 'Escape' && hideDropdown());
    window.addEventListener('resize', hideDropdown); // không gọi hàm ngay
    window.addEventListener('scroll', hideDropdown, true);

    /* === 17) LOGOUT MODAL ============================================= */
    const findLogoutLinks = () =>
        $$('.sidebar-footer .admin-left-nav-link[href="/auth/logout"], .sidebar-footer .sidebar-link[href="/auth/logout"]');

    const openLogoutModal = () => {
        logoutUsername && (logoutUsername.textContent = getCurrentEmail());
        logoutModal?.classList.remove('hidden');
        logoutModal?.classList.add('flex');
        logoutOverlay && (logoutOverlay.dataset.state = 'open');
        logoutModal && (logoutModal.dataset.state = 'open');

        // lock scroll only on sidebar scroll area
        if (scrollArea && !scrollArea.classList.contains('overflow-hidden')) {
            scrollArea.dataset.prevOverflowY = scrollArea.style.overflowY || '';
            scrollArea.classList.add('overflow-hidden');
            scrollArea.style.overflowY = 'hidden';
        }
    };

    const closeLogoutModal = () => {
        if (logoutOverlay) logoutOverlay.dataset.state = 'closed';
        if (logoutModal) logoutModal.dataset.state = 'closed';
        setTimeout(() => {
            logoutModal?.classList.remove('flex');
            logoutModal?.classList.add('hidden');

            // restore scroll-area
            if (scrollArea && scrollArea.classList.contains('overflow-hidden')) {
                scrollArea.classList.remove('overflow-hidden');
                if (scrollArea.dataset.prevOverflowY !== undefined) {
                    if (scrollArea.dataset.prevOverflowY === '') {
                        scrollArea.style.removeProperty('overflow-y');
                    } else {
                        scrollArea.style.overflowY = scrollArea.dataset.prevOverflowY;
                    }
                    delete scrollArea.dataset.prevOverflowY;
                } else {
                    scrollArea.style.removeProperty('overflow-y');
                }
            }
        }, DURATION_LOGOUT);
    };

    const bindLogoutLinks = () => {
        findLogoutLinks().forEach(l => {
            if (l.dataset.bound) return;
            l.dataset.bound = '1';
            l.addEventListener('click', ev => { ev.preventDefault(); openLogoutModal(); });
        });
    };

    bindLogoutLinks();
    logoutConfirmBtn?.addEventListener('click', () => { window.location.href = '/auth/logout'; });
    logoutCancelBtn?.addEventListener('click', closeLogoutModal);
    logoutOverlay?.addEventListener('click', closeLogoutModal);
    logoutModal?.addEventListener('click', e => { if (e.target === logoutModal) closeLogoutModal(); });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && logoutModal?.dataset.state === 'open') closeLogoutModal(); });

    /* === 18) INIT ====================================================== */
    [logo, btnCollapse, btnExpand].forEach(el => el.classList.add('transition-opacity', 'duration-150'));
    applySidebarState();
    highlightFromPath();
    updateHeaderText();
    bindFrameLinks(); // no-op

    /* === 19) TOGGLE TOOLTIP VISIBILITY ================================ */
    const ensureToggleTooltip = () => {
        [btnCollapse, btnExpand].forEach(btn => {
            btn.addEventListener('mouseenter', () => {
                const tooltip = btn.querySelector('.sidebar-tooltip');
                if (tooltip) { tooltip.style.opacity = '1'; tooltip.style.visibility = 'visible'; tooltip.style.pointerEvents = 'auto'; }
            });
            btn.addEventListener('mouseleave', () => {
                const tooltip = btn.querySelector('.sidebar-tooltip');
                if (tooltip) { tooltip.style.opacity = '0'; tooltip.style.visibility = 'hidden'; tooltip.style.pointerEvents = 'none'; }
            });
            btn.addEventListener('focus', () => {
                const tooltip = btn.querySelector('.sidebar-tooltip');
                if (tooltip) { tooltip.style.opacity = '1'; tooltip.style.visibility = 'visible'; tooltip.style.pointerEvents = 'auto'; }
            });
            btn.addEventListener('blur', () => {
                const tooltip = btn.querySelector('.sidebar-tooltip');
                if (tooltip) { tooltip.style.opacity = '0'; tooltip.style.visibility = 'hidden'; tooltip.style.pointerEvents = 'none'; }
            });
        });
    };
    ensureToggleTooltip();
})();

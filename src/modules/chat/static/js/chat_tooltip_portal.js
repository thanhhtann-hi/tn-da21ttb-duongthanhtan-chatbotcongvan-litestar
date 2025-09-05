// file: src/modules/chat/static/js/chat_tooltip_portal.js
// updated: 2025-08-17
// note: OPEN → tooltip đặt ngoài mép phải sidebar, canh tâm hàng; delay 3s & chỉ khi label bị cắt.
//       COLLAPSED/TOGGLE → như cũ (bên phải icon, delay nhanh). Tự loại bỏ native title để tránh tooltip đôi.

(function () {
    'use strict';

    if (window.__CHAT_TIP_PORTAL__) return;
    window.__CHAT_TIP_PORTAL__ = '1.9';
    const ASIDE = document.getElementById('sidebar');
    if (!ASIDE) return;

    // Inject style (giống header tooltip)
    (function injectStyleOnce() {
        if (document.getElementById('portal-tip-style')) return;
        const css = `
      .portal-tooltip{
        position:fixed; left:-9999px; top:-9999px;
        z-index:2147483647;
        background:#111827; color:#f3f4f6;
        padding:2px 8px; border-radius:0.75rem;
        font-size:10px; line-height:1; white-space:nowrap;
        filter:drop-shadow(0 10px 20px rgba(0,0,0,.25));
        pointer-events:none; opacity:0;
        transition:opacity .15s ease, transform .15s ease;
        transform:translateY(-50%);
      }
      .portal-tooltip.show{ opacity:1; }
      .portal-tooltip .tt-label{ color:#f3f4f6; }
      .portal-tooltip .tt-sep{ margin:0 6px; color:#6B7280; }
      .portal-tooltip .tt-shortcut{ color:#B1B1B1; }
    `;
        const tag = document.createElement('style');
        tag.id = 'portal-tip-style';
        tag.textContent = css;
        document.head.appendChild(tag);
    })();

    // === Config ===
    const DELAY_FAST = 90;           // collapsed & toggle
    const DELAY_SLOW = 3000;         // open + truncated
    // Lấy khoảng cách ngoài mép phải từ CSS var (mặc định 4px)
    const GAP_OUTSIDE_X = (() => {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--tt-gap-outside-x').trim();
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 4;
    })();
    const LINK_GAP_X = 12;           // collapsed
    const TOGGLE_GAP_Y = 4;
    const VIEW_PAD = 8, EDGE_BREATH = 4;

    // State
    let tipEl = null, $label = null, $shortcut = null, $sep = null;
    let currentNode = null, showTimer = 0, hideTimer = 0, rafId = 0;

    const NAV = ASIDE.querySelector('#sidebar-nav');
    const BTN_OPEN = document.getElementById('btn-toggle-sidebar-open');
    const BTN_COLL = document.getElementById('btn-toggle-sidebar-collapsed');
    const isCollapsed = () => ASIDE.classList.contains('sidebar-collapsed');

    // Loại bỏ native title để tránh tooltip đôi
    function stripNativeTitles(root = ASIDE) {
        try {
            root.querySelectorAll('[title]').forEach(el => {
                el.removeAttribute('title');
            });
        } catch { }
    }
    stripNativeTitles();
    document.body.addEventListener('htmx:afterOnLoad', () => stripNativeTitles());

    // DOM helpers
    function ensureTip() {
        if (tipEl) return tipEl;
        tipEl = document.createElement('div');
        tipEl.className = 'portal-tooltip';

        $label = document.createElement('span'); $label.className = 'tt-label';
        $sep = document.createElement('span'); $sep.className = 'tt-sep'; $sep.textContent = '·';
        $shortcut = document.createElement('span'); $shortcut.className = 'tt-shortcut';

        tipEl.appendChild($label); tipEl.appendChild($sep); tipEl.appendChild($shortcut);
        document.body.appendChild(tipEl);
        return tipEl;
    }
    function isToggleNode(node) {
        return !!(node && (node.classList?.contains('sidebar-toggle') || node.closest?.('.sidebar-toggle')));
    }
    const isTruncated = (el) => !!el && el.clientWidth > 0 && (el.scrollWidth - el.clientWidth) > 1;

    function getLabel(node) {
        if (isToggleNode(node)) return isCollapsed() ? 'Mở sliderbars' : 'Đóng sliderbars';
        const root = node.closest?.('.sidebar-link') || node;
        if (root && root.id === 'sidebar-user') {
            const nameEl = root.querySelector?.('.sidebar-label');
            return (nameEl?.textContent || '').trim();
        }
        const a = root.querySelector?.('.sidebar-label');
        if (a?.textContent?.trim()) return a.textContent.trim();
        const b = root.querySelector?.('.sidebar-tooltip');
        const c = root.getAttribute?.('aria-label');
        return ((b?.textContent || c || '') + '').trim();
    }
    function getShortcut(node) {
        if (isToggleNode(node)) return '';
        const root = node.closest?.('.sidebar-link') || node;
        if (root && root.id === 'sidebar-user') {
            const role = root.querySelector?.('.shortcut')?.textContent?.trim() || '';
            return role;
        }
        const s = root.querySelector?.('.shortcut');
        return (s?.textContent || '').trim();
    }
    function getAnchor(node) {
        if (isToggleNode(node)) return (node.closest?.('.sidebar-toggle') || node);
        const root = node.closest?.('.sidebar-link') || node;
        if (!isCollapsed()) {
            const label = root.querySelector?.('.sidebar-label');
            if (label) return label;
        }
        return root.querySelector?.('.sidebar-icon') || root;
    }

    // Placement
    function placeTip(node) {
        if (!tipEl || !node) return;

        const asideRect = ASIDE.getBoundingClientRect();
        const root = node.closest?.('.sidebar-link') || node;
        const anchor = getAnchor(node);
        const rect = anchor.getBoundingClientRect();
        const rowRect = root.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
        const vh = window.innerHeight || document.documentElement.clientHeight || 768;

        const w = tipEl.offsetWidth || 0;
        const h = tipEl.offsetHeight || 0;

        let left, top;

        if (isToggleNode(node)) {
            left = Math.round(rect.left + (rect.width / 2) - (w / 2));
            top = Math.round(rect.bottom + TOGGLE_GAP_Y);
            tipEl.style.transform = 'translateY(0)';
        } else if (isCollapsed()) {
            // Right of icon (cũ)
            left = Math.round(rect.right + LINK_GAP_X);
            top = Math.round(rect.top + rect.height / 2);
            tipEl.style.transform = 'translateY(-50%)';
        } else {
            // OPEN: ĐẶT BÊN NGOÀI MÉP PHẢI SIDEBAR, canh theo tâm hàng
            left = Math.round(asideRect.right + GAP_OUTSIDE_X);
            top = Math.round(rowRect.top + rowRect.height / 2);
            tipEl.style.transform = 'translateY(-50%)';
        }

        // Clamp
        const maxLeft = vw - VIEW_PAD - w - EDGE_BREATH;
        const minLeft = VIEW_PAD + EDGE_BREATH;
        if (left < minLeft) left = minLeft;
        if (left > maxLeft) left = maxLeft;

        const maxTop = vh - VIEW_PAD - h - EDGE_BREATH;
        const minTop = VIEW_PAD + EDGE_BREATH;
        if (top < minTop) top = minTop;
        if (top > maxTop) top = maxTop;

        tipEl.style.left = left + 'px';
        tipEl.style.top = top + 'px';
    }

    // Render / Show / Hide
    function renderTip(node) {
        ensureTip();
        const label = getLabel(node);
        const sc = getShortcut(node);
        $label.textContent = label || '';
        if (sc) { $sep.style.display = ''; $shortcut.style.display = ''; $shortcut.textContent = sc; }
        else { $sep.style.display = 'none'; $shortcut.style.display = 'none'; $shortcut.textContent = ''; }
    }
    function showTip(node) { renderTip(node); placeTip(node); tipEl.classList.add('show'); }
    function hideTipNow() {
        if (!tipEl) return;
        tipEl.classList.remove('show');
        tipEl.style.left = '-9999px';
        tipEl.style.top = '-9999px';
        tipEl.style.transform = 'translateY(-50%)';
    }

    function scheduleShow(node) {
        clearTimeout(showTimer); clearTimeout(hideTimer);
        let delay = DELAY_FAST;
        if (!isCollapsed() && !isToggleNode(node)) {
            const label = (node.closest?.('.sidebar-link') || node).querySelector?.('.sidebar-label');
            if (!(label && isTruncated(label))) return; // không cắt → không show
            delay = DELAY_SLOW;
        }
        showTimer = setTimeout(() => { currentNode = node; showTip(node); }, delay);
    }
    function scheduleHide() {
        clearTimeout(showTimer); clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { hideTipNow(); currentNode = null; }, 120);
    }

    // Events
    ASIDE.addEventListener('mouseover', (e) => {
        const toggle = e.target?.closest?.('.sidebar-toggle');
        if (toggle) {
            if (currentNode === toggle) { clearTimeout(hideTimer); return; }
            scheduleShow(toggle);
            return;
        }
        const link = e.target?.closest?.('.sidebar-link');
        if (!link || !ASIDE.contains(link)) { hideTipNow(); return; }

        if (isCollapsed()) {
            if (currentNode === link) { clearTimeout(hideTimer); return; }
            scheduleShow(link);
            return;
        }
        if (currentNode === link) { clearTimeout(hideTimer); return; }
        scheduleShow(link);
    }, true);

    ASIDE.addEventListener('mouseout', (e) => {
        const node = e.target?.closest?.('.sidebar-toggle, .sidebar-link');
        if (!node) return;
        const to = e.relatedTarget;
        if (to && node.contains(to)) return;
        if (currentNode === node) scheduleHide();
    }, true);

    ASIDE.addEventListener('mouseleave', () => { scheduleHide(); }, true);

    ASIDE.addEventListener('mousemove', () => {
        if (currentNode && tipEl?.classList.contains('show') && !rafId) {
            rafId = requestAnimationFrame(() => { rafId = 0; placeTip(currentNode); });
        }
    }, true);

    function requestReposition() {
        if (!currentNode || !tipEl?.classList.contains('show')) return;
        if (rafId) return;
        rafId = requestAnimationFrame(() => { rafId = 0; placeTip(currentNode); });
    }
    window.addEventListener('scroll', requestReposition, { passive: true });
    window.addEventListener('resize', requestReposition, { passive: true });
    NAV?.addEventListener('scroll', requestReposition, { passive: true });

    const obs = new MutationObserver(() => { hideTipNow(); currentNode = null; });
    obs.observe(ASIDE, { attributes: true, attributeFilter: ['class'] });
})();

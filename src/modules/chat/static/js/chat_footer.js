// file: src/modules/chat/static/js/chat_footer.js
// updated: 2025-09-03 (v2.3.0)
// notes:
// - STOP thật sự: click nút gửi khi đang chạy, phím ESC, hay event `chat:cancel`/`chat:navigated` đều huỷ ngay & đưa UI về bình thường
// - Tôn trọng giới hạn upload từ BE; ước tính Content-Length trước khi gửi; cảnh báo sớm
// - Gửi: phát `chat:send` (payload gồm text, tool_id, main_files, attachments); nhận `chat:sent|chat:error|chat:cancel` để thoát STOP
// - Menu Tools qua portal; pills theo chat; dọn URL.createObjectURL an toàn
// - Role-aware (user/internal/admin): lấy từ data-* nếu có; đồng bộ thêm qua /chat/api/upload_limits **và** headers từ /chat/tools
// - Dropzone full-click; multi-main policy (first full, rest head+tail) áp dụng cho internal/admin
// - NEW(2.2.3): khoá tool "phân loại văn bản" (text_classifier) khi chưa có text; tự bỏ chọn pill nếu tool đang bật nhưng thiếu điều kiện.
// - NEW(2.3.0): FE dùng slug + requires_text từ BE; sửa bug nút xoá ở preview/chips bên PHẢI lỡ xoá luôn tệp bên TRÁI (remove theo zone).

(function () {
    'use strict';

    // [n01] Guard: wire once
    if (window.__CHAT_FOOTER_WIRED__) return;
    window.__CHAT_FOOTER_WIRED__ = true;

    // [n02] Short-hands & root
    const $ = (s, r) => (r || document).querySelector(s);
    const on = (el, ev, fn, o) => el && el.addEventListener(ev, fn, o || false);
    const shell = $('#chat-footer-shell'); if (!shell) return;

    // ─────────────────────────────────────────────────────────────
    // Role detection (khởi tạo từ data-*; sẽ cập nhật lại sau khi call BE)
    let USER_ROLE = String(shell.dataset.userRole || 'guest').toLowerCase();
    let USER_STATUS = String(shell.dataset.userStatus || 'guest').toLowerCase();
    const isInternal = () => (USER_ROLE === 'internal' || USER_ROLE === 'admin');
    function applyRoleStatus(role, status) {
        const newRole = (role || USER_ROLE || 'guest').toLowerCase();
        const newStatus = (status || USER_STATUS || 'guest').toLowerCase();
        if (newRole !== USER_ROLE || newStatus !== USER_STATUS) {
            USER_ROLE = newRole; USER_STATUS = newStatus;
            try { shell.dataset.userRole = USER_ROLE; shell.dataset.userStatus = USER_STATUS; } catch { }
            updateMainMultiNote();
        }
    }
    // ─────────────────────────────────────────────────────────────

    // [n03] Essentials
    const wrap = $('.cf-wrap', shell);
    const btnAttach = $('#cf-attach', shell), menu = $('#cf-menu', shell), menuPanel = $('.cf-menu-panel', menu);
    const menuTools = $('#cf-menu-tools', menu), menuStatic = $('#cf-menu-static', menu);
    const btnSend = $('#cf-send', shell), input = $('#cf-input', shell);
    const pills = $('#cf-pills', shell), sep = $('#cf-sep', shell), attbar = $('#cf-attbar', shell);

    // [n04] Modal + dropzones + pickers
    const modal = $('#cf-modal', shell), backdrop = $('.cf-backdrop', modal), btnClose = $('#cf-close', modal);
    const dzMain = $('#dz-main', shell), dzAtts = $('#dz-atts', shell);
    const prevMain = $('#dz-main-previews', shell), prevAtts = $('#dz-atts-previews', shell);
    const btnPickMain = $('#btn-pick-main', shell), btnPickAtts = $('#btn-pick-atts', shell);
    const pickMain = $('#cf-pick-main', document), pickAtts = $('#cf-pick-atts', document);
    const noteMain = $('#dz-main-note', shell); // multi-file note (internal/admin)
    const globalDrop = $('#cf-global-drop');

    // [n05] Limits (fetch từ BE) + defaults
    const DEFAULTS = {
        maxFiles: 10,
        perFileBytes: 25 * 1024 * 1024,     // 25MB fallback
        effectiveCapBytes: 50 * 1024 * 1024 // 50MB fallback (tổng Content-Length)
    };
    /** @type {{ maxFiles:number, perFileBytes:number, effectiveCapBytes:number, human?:object }} */
    const LIMITS = { ...DEFAULTS };
    const CHIP_LIMIT_RATIO = 0.98;

    // [n06] State
    const state = {
        toolsCache: /** @type {Array<Object>|null} */(null),
        currentToolId: null,
        mainFiles: /** @type {File[]} */([]),
        attFiles:  /** @type {File[]} */([]),
        urls: new Map(), // key(file)->objectURL
        voice: { recog: null, active: false, lastFinal: '' },
        limitsLoaded: false,
        sending: false,
        multiWarned: false, // tránh spam toast khi >1 file ở cột trái
    };

    // [n07] Utils
    function getCookie(name) {
        try {
            const raw = document.cookie || '';
            for (const seg of raw.split('; ')) {
                const i = seg.indexOf('=');
                const k = decodeURIComponent(i >= 0 ? seg.slice(0, i) : seg);
                if (k === name) return decodeURIComponent(i >= 0 ? seg.slice(i + 1) : '');
            }
        } catch { }
        return '';
    }
    const key = (f) => [f?.name, f?.size, f?.lastModified].join('|');
    const isImg = (f) => /^image\//i.test(f?.type || '') || /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/i.test(f?.name || '');
    const ext = (name = '') => (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
    const findTool = (id) => (state.toolsCache || []).find(t => String(t.id) === String(id));
    const iconFrag = (tplId) => { const bank = $('#cf-icon-bank'); const tpl = $('#' + tplId, bank); return tpl?.content?.cloneNode(true) || null; };

    // [n07.a] CSRF helpers (đồng bộ cách làm với header.js)
    function syncMetaFromCookie() {
        try {
            const v = getCookie('csrftoken'); if (!v) return;
            let m = document.querySelector('meta[name="csrf-token"]');
            if (!m) { m = document.createElement('meta'); m.setAttribute('name', 'csrf-token'); document.head.appendChild(m); }
            m.setAttribute('content', v);
        } catch { }
    }
    async function warmUpCSRF() {
        try {
            await fetch('/chat/notify/unread_count', {
                credentials: 'include',
                headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
            });
        } catch { }
        syncMetaFromCookie();
    }
    function getCsrfToken() {
        const m = document.querySelector('meta[name="csrf-token"]');
        return getCookie('csrftoken') || (m ? m.content : '') || '';
    }
    async function jsonFetch(url, opts) {
        opts = opts || {};
        const method = String(opts.method || 'GET').toUpperCase();
        const h = new Headers(opts.headers || {});
        h.set('Accept', 'application/json');
        h.set('X-Requested-With', 'XMLHttpRequest');
        if (method !== 'GET') {
            const t = getCsrfToken();
            if (t) h.set('X-CSRFToken', t);
        }
        if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
            const t2 = getCsrfToken();
            const bodyObj = { ...(opts.body || {}) };
            if (t2 && !('csrf_token' in bodyObj)) bodyObj.csrf_token = t2;
            h.set('Content-Type', 'application/json');
            opts.body = JSON.stringify(bodyObj);
        }
        return fetch(url, Object.assign({ credentials: 'include' }, opts, { headers: h }));
    }

    // [n07.1] Byte fmt
    function fmtBytes(n) {
        if (!n || n <= 0) return '';
        const mb = n / (1024 * 1024);
        if (mb >= 1) return (Math.abs(Math.round(mb) - mb) < 1e-6) ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
        const kb = n / 1024;
        return (Math.abs(Math.round(kb) - kb) < 1e-6) ? `${kb.toFixed(0)} KB` : `${kb.toFixed(1)} KB`;
    }

    // [n08] File-type groups (Office-aware)
    const WORD = new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt']);
    const EXCEL = new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'csv', 'ods']);
    const PPT = new Set(['ppt', 'pptx', 'pptm', 'pot', 'potx', 'odp']);
    const PDF = new Set(['pdf']);

    const CODE = new Set([
        'js', 'ts', 'jsx', 'tsx', 'json', 'py', 'rb', 'php', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs',
        'html', 'htm', 'xml', 'css', 'scss', 'sass', 'less', 'md', 'sql', 'sh', 'bat', 'ps1',
        'yml', 'yaml', 'toml', 'ini', 'gradle', 'm', 'mm', 'swift', 'dart', 'lua', 'r', 'pl'
    ]);
    const isCodeExt = (e) => CODE.has(e);

    // [n09] Color-key for badges
    const extForColor = (e) => (
        PDF.has(e) ? 'pdf' :
            WORD.has(e) ? 'docx' :
                EXCEL.has(e) ? 'xlsx' :
                    PPT.has(e) ? 'pptx' :
                        (isCodeExt(e) ? e : (e || 'file'))
    );

    // [n10] Icon chooser
    function iconForExt(e) {
        if (!e) return iconFrag('tpl-ico-doc');
        if (PDF.has(e)) return iconFrag('tpl-ico-office-pdf') || iconFrag('tpl-ico-doc');
        if (WORD.has(e)) return iconFrag('tpl-ico-office-word') || iconFrag('tpl-ico-doc');
        if (EXCEL.has(e)) return iconFrag('tpl-ico-office-excel') || iconFrag('tpl-ico-doc');
        if (PPT.has(e)) return iconFrag('tpl-ico-office-powerpoint') || iconFrag('tpl-ico-doc');
        return iconFrag(isCodeExt(e) ? 'tpl-ico-code' : 'tpl-ico-doc');
    }

    // [n11] Safer badge builder
    function makeIconBadge(e) {
        const badge = document.createElement('div');
        badge.className = 'ext';
        const frag = iconForExt(e);
        if (frag) badge.appendChild(frag);
        return badge;
    }

    // [n12] Clean native titles
    try { shell.querySelectorAll('[title]').forEach(el => el.removeAttribute('title')); } catch { }

    // [n13] Input padding align to attach icon
    function alignPadToIcon() {
        try {
            if (!input || !btnAttach) return;
            const icon = btnAttach.querySelector('.ic-18'); if (!icon) return;
            const rI = input.getBoundingClientRect(), rK = icon.getBoundingClientRect();
            const EXTRA = varPx('--cf-pad-left-nudge', 0);
            let pad = Math.round(rK.left - rI.left) - 1 - EXTRA;
            pad = Math.max(0, Math.min(20, pad));
            shell.style.setProperty('--cf-pad-x-left', pad + 'px');
        } catch { }
    }
    function varPx(name, fallback) {
        const v = getComputedStyle(shell).getPropertyValue(name).trim();
        const n = parseFloat(v); return Number.isFinite(n) ? n : fallback;
    }
    function autoGrow() {
        if (!input) return;
        const MAX = varPx('--cf-max-input', 162), MIN = varPx('--cf-min-input', 40);
        input.style.height = 'auto';
        const next = Math.min(MAX, Math.max(MIN, input.scrollHeight));
        input.style.height = next + 'px';
        input.style.overflowY = (next >= MAX) ? 'auto' : 'hidden';
        updateSendMode();
    }

    // 🔁 gộp onTextChanged để còn cập nhật trạng thái enable/disable tool
    function onTextChanged() { autoGrow(); updateToolsDisabledStates(); }

    on(input, 'input', onTextChanged); on(input, 'focus', autoGrow);
    autoGrow(); alignPadToIcon();
    const reAlign = () => requestAnimationFrame(alignPadToIcon);
    on(window, 'resize', () => { reAlign(); compressChips(); });
    on(window, 'orientationchange', () => { reAlign(); compressChips(); });
    if (document.fonts?.ready) document.fonts.ready.then(() => { reAlign(); compressChips(); }).catch(() => { });

    // [n19] Chat scope helpers (per-conversation selection)
    const CHAT_ID = (() => {
        try {
            const m = (location.pathname || '').match(/^\/chat\/([^\/]+)$/i);
            return m ? m[1] : null;
        } catch { return null; }
    })();
    const KEY_CHAT = (id) => `cf_tools_chat:${id}`;

    // [n20] Tool pills
    function renderActivePills() {
        pills.innerHTML = '';
        if (state.currentToolId) {
            const meta = findTool(state.currentToolId) || {};
            const pill = document.createElement('button');
            pill.type = 'button'; pill.className = 'cf-pill'; pill.setAttribute('aria-pressed', 'true');

            const icon = document.createElement('span'); icon.className = 'ic-18';
            const iconKey = (meta.slug || meta.name || '').toLowerCase();
            const frag = iconFrag('tpl-ico-' + iconKey) || iconFrag('tpl-ico-default');
            if (frag) icon.appendChild(frag);

            const text = document.createElement('span'); text.textContent = meta.label || meta.name || 'Tool';

            pill.appendChild(icon); pill.appendChild(text);
            pills.appendChild(pill);
            sep.hidden = false;
        } else {
            sep.hidden = true;
        }
    }
    on(pills, 'click', (e) => {
        if (!e.target.closest('.cf-pill')) return;
        state.currentToolId = null;
        renderActivePills();
        saveSelectedTool(null);
    });

    // [n30] Attach menu via portal
    let portal, overlayLayer, storedParent;
    function ensurePortal() {
        if (portal) return portal;
        portal = document.createElement('div');
        portal.id = 'cf-menu-portal';
        Object.assign(portal.style, { position: 'fixed', inset: '0 auto auto 0', zIndex: '1000', pointerEvents: 'auto' });
        document.body.appendChild(portal);
        return portal;
    }
    function ensureOverlay() {
        if (overlayLayer) return overlayLayer;
        overlayLayer = document.createElement('div');
        overlayLayer.className = 'cf-menu-overlay';
        Object.assign(overlayLayer.style, { position: 'fixed', inset: '0', background: 'transparent', pointerEvents: 'auto', zIndex: '999' });
        overlayLayer.addEventListener('pointerdown', () => closeMenu(), { passive: true });
        return overlayLayer;
    }
    function positionMenu() {
        if (!menu || !menuPanel || !btnAttach) return;
        const oldVis = menu.style.visibility; menu.style.visibility = 'hidden';
        const b = btnAttach.getBoundingClientRect();
        const mW = menuPanel.offsetWidth || 260, mH = menuPanel.offsetHeight || 180;
        const spaceAbove = b.top, spaceBelow = window.innerHeight - b.bottom;
        const showAbove = spaceAbove > mH + 12 || spaceAbove > spaceBelow;
        const top = showAbove ? (b.top - mH - 8) : (b.bottom + 8);
        const left = Math.max(8, Math.min(b.left, window.innerWidth - mW - 8));
        menu.style.top = `${Math.round(top)}px`; menu.style.left = `${Math.round(left)}px`; menu.style.visibility = oldVis || '';
    }
    function openMenu() {
        if (!menu || !btnAttach) return;
        ensurePortal(); ensureOverlay(); storedParent = menu.parentNode;
        if (!overlayLayer.parentNode) portal.appendChild(overlayLayer);
        portal.appendChild(menu);
        menu.classList.remove('hidden');
        btnAttach.setAttribute('aria-expanded', 'true'); btnAttach.classList.add('is-open');
        menu.style.position = 'fixed'; menu.style.zIndex = '1001'; positionMenu();

        const onFocus = (e) => { if (!menu.contains(e.target) && e.target !== btnAttach) closeMenu(); };
        const onPointerDownDoc = (e) => { if (!menu.contains(e.target) && e.target !== btnAttach) closeMenu(); };
        document.addEventListener('focusin', onFocus, true);
        document.addEventListener('pointerdown', onPointerDownDoc, true);
        menu.__closers__ = { onFocus, onPointerDownDoc };

        const rePos = () => {
            if (menu.classList.contains('hidden')) {
                window.removeEventListener('resize', rePos);
                window.removeEventListener('scroll', rePos, true);
                return;
            }
            positionMenu();
        };
        window.addEventListener('resize', rePos, { passive: true });
        window.addEventListener('scroll', rePos, true);

        // cập nhật trạng thái disabled theo nội dung hiện tại
        updateToolsDisabledStates();
    }
    function closeMenu() {
        if (!menu) return;
        menu.classList.add('hidden');
        btnAttach?.setAttribute('aria-expanded', 'false'); btnAttach?.classList.remove('is-open');
        if (menu.__closers__) {
            document.removeEventListener('focusin', menu.__closers__.onFocus, true);
            document.removeEventListener('pointerdown', menu.__closers__.onPointerDownDoc, true);
            menu.__closers__ = null;
        }
        if (storedParent) storedParent.appendChild(menu);
        if (overlayLayer?.parentNode) overlayLayer.parentNode.removeChild(overlayLayer);
    }
    on(btnAttach, 'click', (e) => { e.preventDefault(); if (menu.classList.contains('hidden')) renderMenu().then(openMenu); else closeMenu(); });

    // [n35] ESC = đóng overlay/modal/voice và STOP nếu đang gửi
    on(document, 'keydown', (e) => {
        if (e.key === 'Escape') {
            closeMenu(); closeModal(true);
            if (state.voice.active) stopVoice();
            if (state.sending) requestCancel();
        }
    });

    // [n40] Tools list + selection hydration (per chat)
    function hydrateSelection() {
        if (CHAT_ID) {
            try {
                const csv = (localStorage.getItem(KEY_CHAT(CHAT_ID)) || '').trim();
                state.currentToolId = (csv && csv !== 'null' && csv !== 'undefined') ? csv.split(',')[0] : null;
            } catch { state.currentToolId = null; }
        } else {
            const csv = (getCookie('cf_tools') || '').trim();
            state.currentToolId = (csv && csv !== 'null' && csv !== 'undefined') ? csv.split(',')[0] : null;
        }
    }
    async function fetchTools() {
        try {
            const r = await jsonFetch('/chat/tools');
            const ct = (r.headers.get('content-type') || '').toLowerCase();
            if (!ct.includes('application/json')) throw new Error('NON_JSON');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const data = await r.json();

            // Đồng bộ role/status từ headers mới của BE
            const hdrRole = (r.headers.get('X-User-Role') || '').toLowerCase().trim();
            const hdrStatus = (r.headers.get('X-User-Status') || '').toLowerCase().trim();
            applyRoleStatus(hdrRole, hdrStatus);

            let tools = (data && data.tools && Array.isArray(data.tools)) ? data.tools : [];
            // Server đã sort DESC + name ASC; sort lại đề phòng
            tools.sort((a, b) => ((b.sort_order ?? -9999) - (a.sort_order ?? -9999)) || String(a.name || '').localeCompare(String(b.name || '')));
            state.toolsCache = tools;
            return tools;
        } catch (e) {
            console.warn('Không tải được tools:', e);
            state.toolsCache = [];
            return [];
        }
    }
    function appendIcon(li, keySlugOrName) {
        const bank = $('#cf-icon-bank');
        const tpl = $('#tpl-ico-' + keySlugOrName, bank) || $('#tpl-ico-default', bank);
        if (tpl?.content) li.appendChild(tpl.content.cloneNode(true));
    }

    // Helpers: nhận diện tool cần văn bản
    const lc = (s) => String(s || '').toLowerCase();
    const toolKey = (t) => lc(t.key || t.slug || t.name);
    const toolLabel = (t) => lc(t.label || t.name);
    function toolRequiresText(t) {
        if (!t) return false;
        if (t.requires_text === true) return true; // ưu tiên flag từ BE
        const k = toolKey(t);
        const lbl = toolLabel(t);
        // bắt các biến thể thường gặp
        if (k.includes('text_classifier') || k.includes('text-classifier')) return true;
        if (/phân\s*loại\s*văn\s*bản/.test(lbl)) return true;
        if (/classif(y|ier)/.test(k)) return true;
        return false;
    }
    function hasTypedText() { return !!(input && input.value.trim().length); }
    function disabledReason(t) {
        if (toolRequiresText(t) && !hasTypedText()) return 'Nhập văn bản trước khi dùng công cụ này.';
        return '';
    }
    function shouldDisableTool(t) {
        if (toolRequiresText(t) && !hasTypedText()) return true;
        return false;
    }

    function renderToolsList(tools) {
        menuTools.innerHTML = '';
        const f = document.createDocumentFragment();
        tools.forEach(t => {
            const li = document.createElement('li'); li.setAttribute('role', 'menuitemradio');
            li.dataset.toolId = t.id;
            li.dataset.toolSlug = (t.slug || t.name || '').toLowerCase();
            appendIcon(li, li.dataset.toolSlug);
            const label = document.createElement('span'); label.textContent = t.label || t.name; li.appendChild(label);
            li.setAttribute('aria-checked', String(state.currentToolId === t.id));

            // ✅ disable theo điều kiện
            const dis = shouldDisableTool(t);
            if (dis) { li.setAttribute('aria-disabled', 'true'); const r = disabledReason(t); if (r) li.title = r; }
            else { li.removeAttribute('aria-disabled'); li.removeAttribute('title'); }

            f.appendChild(li);
        });
        menuTools.appendChild(f);
    }

    // Cập nhật trạng thái enable/disable cho tool + tự bỏ chọn nếu tool đang bật mà không đủ điều kiện
    function updateToolsDisabledStates() {
        const tools = state.toolsCache || [];
        if (!tools.length) return;

        // nếu tool đang chọn bị disable → bỏ chọn
        if (state.currentToolId) {
            const cur = findTool(state.currentToolId);
            if (cur && shouldDisableTool(cur)) {
                state.currentToolId = null;
                renderActivePills();
                saveSelectedTool(null);
            }
        }

        // nếu menu đang mở, cập nhật aria-disabled ngay
        if (!menu.classList.contains('hidden')) {
            const lis = menuTools.querySelectorAll('li[role="menuitemradio"]');
            lis.forEach(li => {
                const t = findTool(li.dataset.toolId);
                const dis = shouldDisableTool(t);
                if (dis) { li.setAttribute('aria-disabled', 'true'); const r = disabledReason(t); if (r) li.title = r; }
                else { li.removeAttribute('aria-disabled'); li.removeAttribute('title'); }
            });
        }
    }

    let saveDebounce;
    async function saveSelectedTool(idOrNull) {
        // Per-chat localStorage
        try {
            if (CHAT_ID) {
                if (idOrNull) localStorage.setItem(KEY_CHAT(CHAT_ID), String(idOrNull));
                else localStorage.removeItem(KEY_CHAT(CHAT_ID));
            }
        } catch { }

        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(async () => {
            const body = { tool_ids: idOrNull ? [idOrNull] : [] };
            const attempt = () => jsonFetch('/chat/tools/select', { method: 'POST', body });
            try {
                let res = await attempt();
                if (res.status === 403) { await warmUpCSRF(); res = await attempt(); }
                await res.json().catch(() => ({}));
            } catch (e) { console.warn('save tool failed', e); }
        }, 160);
    }

    async function renderMenu() { hydrateSelection(); const tools = await fetchTools(); renderToolsList(tools); updateToolsDisabledStates(); }

    on(menuStatic, 'click', (e) => {
        const li = e.target.closest('li'); if (!li) return;
        if (li.id === 'cf-act-file') { closeMenu(); openModal(); }
    });
    on(menuTools, 'click', (e) => {
        const li = e.target.closest('li[role="menuitemradio"]'); if (!li) return;
        if (li.getAttribute('aria-disabled') === 'true') { // chặn chọn tool bị khóa
            const msg = li.title || 'Công cụ hiện chưa sẵn sàng.';
            warn(msg, 'info');
            return;
        }
        const id = li.dataset.toolId;
        if (state.currentToolId === id) {
            state.currentToolId = null;
            [...menuTools.querySelectorAll('li[role="menuitemradio"]')].forEach(x => x.setAttribute('aria-checked', 'false'));
            saveSelectedTool(null); closeMenu(); renderActivePills(); return;
        }
        state.currentToolId = id || null;
        [...menuTools.querySelectorAll('li[role="menuitemradio"]')].forEach(x => x.setAttribute('aria-checked', 'false'));
        li.setAttribute('aria-checked', 'true'); saveSelectedTool(state.currentToolId); closeMenu(); renderActivePills();
    });

    // Đồng bộ giữa các tab
    on(window, 'storage', (e) => {
        if (!CHAT_ID) return;
        if (e.key === KEY_CHAT(CHAT_ID)) {
            hydrateSelection();
            renderActivePills();
        }
    });

    // [n45] Fetch upload limits + đồng bộ role/status từ BE
    async function loadUploadLimits() {
        try {
            const res = await fetch('/chat/api/upload_limits', { method: 'GET', credentials: 'include', cache: 'no-store' });
            const data = await res.json().catch(() => null);

            // limits
            if (data && data.ok && data.limits) {
                const lim = data.limits || {};
                if (typeof lim.max_files === 'number' && lim.max_files > 0) LIMITS.maxFiles = lim.max_files;
                if (typeof lim.multipart_per_file_bytes === 'number' && lim.multipart_per_file_bytes > 0) LIMITS.perFileBytes = lim.multipart_per_file_bytes;
                if (typeof lim.effective_request_cap_bytes === 'number' && lim.effective_request_cap_bytes > 0) LIMITS.effectiveCapBytes = lim.effective_request_cap_bytes;
                LIMITS.human = data.human || {};
                state.limitsLoaded = true;
                window.__UPLOAD_LIMITS__ = { ...LIMITS };
            }

            // role/status từ headers JSON
            let hdrRole = (res.headers.get('X-User-Role') || '').toLowerCase().trim();
            let hdrStatus = (res.headers.get('X-User-Status') || '').toLowerCase().trim();
            const jRole = String((data && data.user && data.user.role) || '').toLowerCase().trim();
            const jStatus = String((data && data.user && data.user.status) || '').toLowerCase().trim();
            applyRoleStatus(hdrRole || jRole, hdrStatus || jStatus);
        } catch (e) {
            console.warn('upload_limits fetch failed; using defaults', e);
        }
    }

    // [n50] Attachments
    const warn = (msg, type = 'warning') => {
        try {
            if (window.showToast) window.showToast(msg, type);
            else alert(msg);
        } catch { alert(msg); }
    };
    function totalFilesCount() { return state.mainFiles.length + state.attFiles.length; }

    // Toggle note (internal/admin)
    function updateMainMultiNote() {
        if (!noteMain) return;
        const onN = isInternal() && state.mainFiles.length > 1;
        noteMain.classList.toggle('is-on', !!onN);
        if (onN && !state.multiWarned) {
            warn('Lưu ý: Hệ thống tối ưu khi mỗi lượt chỉ gửi 1 tệp. Tệp đầu sẽ được xử lý đầy đủ; các tệp còn lại chỉ lấy trang đầu + trang cuối.', 'info');
            state.multiWarned = true;
        }
        if (!onN) state.multiWarned = false;
    }

    function addFilesTo(zone, list) {
        if (!list || !list.length) return;
        const arr = zone === 'main' ? state.mainFiles : state.attFiles;
        const map = new Map(arr.map(f => [key(f), f]));
        let skippedLarge = 0, skippedLimit = 0, added = 0;
        const remaining = Math.max(0, LIMITS.maxFiles - totalFilesCount());

        Array.from(list).forEach((f) => {
            if (LIMITS.perFileBytes > 0 && f.size > LIMITS.perFileBytes) { skippedLarge++; return; }
            if (added >= remaining) { skippedLimit++; return; }
            const k = key(f);
            if (!map.has(k)) {
                map.set(k, f); added++;
                if (isImg(f)) {
                    try {
                        const old = state.urls.get(k); if (old) URL.revokeObjectURL(old);
                        state.urls.set(k, URL.createObjectURL(f));
                    } catch { }
                }
            }
        });

        const next = Array.from(map.values());
        if (zone === 'main') state.mainFiles = next; else state.attFiles = next;
        renderPreviews(); renderChips(); updateSendMode();

        // show internal/admin note if multi-main
        if (zone === 'main') updateMainMultiNote();

        if (skippedLarge) warn(`Đã bỏ qua ${skippedLarge} tệp vượt quá giới hạn mỗi tệp (${fmtBytes(LIMITS.perFileBytes)}).`, 'warning');
        if (skippedLimit) warn(`Chỉ gửi tối đa ${LIMITS.maxFiles} tệp cho mỗi tin nhắn.`, 'warning');
    }

    // ❗️Sửa bug: xoá theo ZONE; chỉ revoke objectURL nếu key không còn ở cả 2 bên
    function removeFile(zone, k) {
        if (zone === 'main') {
            state.mainFiles = state.mainFiles.filter(f => key(f) !== k);
        } else {
            state.attFiles = state.attFiles.filter(f => key(f) !== k);
        }

        // chỉ revoke nếu key không còn ở bất kỳ bên nào
        const stillExists = state.mainFiles.some(f => key(f) === k) || state.attFiles.some(f => key(f) === k);
        if (!stillExists) {
            const url = state.urls.get(k);
            if (url) { try { URL.revokeObjectURL(url); } catch { } state.urls.delete(k); }
        }

        renderPreviews(); renderChips(); updateSendMode();
        updateMainMultiNote();
    }

    // [n55] Ước tính dung lượng FormData
    function estimatePayloadBytes() {
        try {
            const encoder = new TextEncoder();
            const text = (input?.value || '').trim();
            const textBytes = text ? encoder.encode(text).length : 0;

            const files = [...state.mainFiles, ...state.attFiles];
            const filesBytes = files.reduce((s, f) => s + (f?.size || 0), 0);

            const parts = files.length + (text ? 1 : 0);
            const overhead = 2048 + Math.max(0, parts) * 1024;

            return textBytes + filesBytes + overhead;
        } catch {
            return 0;
        }
    }

    // [n60] Previews
    function previewRow(zone, file) {
        const k = key(file), e = ext(file.name);
        const row = document.createElement('div'); row.className = 'cf-prev';
        row.dataset.ext = extForColor(e);
        const fig = document.createElement('figure');

        if (isImg(file)) {
            const img = document.createElement('img'); img.alt = file.name || 'image';
            const u = state.urls.get(k) || ''; if (u) img.src = u; fig.appendChild(img);
        } else {
            fig.appendChild(makeIconBadge(e));
        }

        const name = document.createElement('div'); name.className = 'name'; name.textContent = file.name || '(tệp)';
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'remove'; btn.setAttribute('aria-label', 'Xoá');
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2"/></svg>';
        btn.addEventListener('click', () => removeFile(zone, k));

        row.appendChild(fig); row.appendChild(name); row.appendChild(btn);
        return row;
    }
    function renderPreviews() {
        if (prevMain) { prevMain.innerHTML = ''; state.mainFiles.forEach(f => prevMain.appendChild(previewRow('main', f))); }
        if (prevAtts) { prevAtts.innerHTML = ''; state.attFiles.forEach(f => prevAtts.appendChild(previewRow('atts', f))); }
    }

    // [n70] Chips
    function chipFor(zone, file) {
        const k = key(file), e = ext(file.name);
        const chip = document.createElement('div'); chip.className = 'cf-chip'; chip.dataset.key = k; chip.dataset.zone = zone; chip.dataset.ext = extForColor(e);

        const thumb = document.createElement('div'); thumb.className = 'cf-thumb';
        if (isImg(file)) {
            const img = document.createElement('img'); const u = state.urls.get(k) || ''; if (u) img.src = u; img.alt = ''; thumb.appendChild(img);
        } else {
            thumb.appendChild(makeIconBadge(e));
        }

        const name = document.createElement('span'); name.className = 'cf-chip-name';
        name.textContent = isImg(file) ? '' : (file.name || '(tệp)');

        const x = document.createElement('button'); x.type = 'button'; x.className = 'cf-chip-x'; x.setAttribute('aria-label', 'Xoá');
        x.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2"/></svg>';
        x.addEventListener('click', () => removeFile(zone, k));

        chip.appendChild(thumb); if (name.textContent) chip.appendChild(name); chip.appendChild(x);
        return chip;
    }

    function compressChips() {
        if (!attbar) return;
        Array.from(attbar.children).forEach(ch => ch.hidden = false);
        const chips = Array.from(attbar.children);
        if (!chips.length) return;

        const limitW = Math.max(0, Math.floor((attbar.clientWidth || wrap?.clientWidth || 0) * CHIP_LIMIT_RATIO));
        const GAP = 8;
        let used = 0;

        for (let i = 0; i < chips.length; i++) {
            const ch = chips[i];
            const w = Math.ceil(ch.getBoundingClientRect().width);
            const extra = i ? GAP : 0;
            if (i === 0 || (used + w + extra) <= limitW) {
                used += w + extra;
            } else {
                ch.hidden = true;
            }
        }
    }

    function renderChips() {
        if (!attbar) return;
        attbar.innerHTML = '';
        const f = document.createDocumentFragment();
        state.mainFiles.forEach(file => f.appendChild(chipFor('main', file)));
        state.attFiles.forEach(file => f.appendChild(chipFor('atts', file)));
        attbar.appendChild(f);
        attbar.classList.toggle('is-on', attbar.children.length > 0);
        requestAnimationFrame(() => { compressChips(); updateSendMode(); });
    }

    // [n80] Hover-wheel horizontal scroll + touch swipe
    (function wireAttbarScroll() {
        if (!attbar) return;
        on(attbar, 'pointerenter', () => attbar.classList.add('is-scroll'), { passive: true });
        on(attbar, 'pointerleave', () => attbar.classList.remove('is-scroll'), { passive: true });
        on(attbar, 'wheel', (e) => {
            const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? (e.deltaX) : (e.deltaY);
            if (delta !== 0) { attbar.scrollLeft += delta; e.preventDefault(); }
        }, { passive: false });
        let startX = 0, startLeft = 0;
        on(attbar, 'touchstart', (e) => { const t = e.touches?.[0]; if (!t) return; startX = t.clientX; startLeft = attbar.scrollLeft; }, { passive: true });
        on(attbar, 'touchmove', (e) => { const t = e.touches?.[0]; if (!t) return; const dx = t.clientX - startX; attbar.scrollLeft = startLeft - dx; }, { passive: true });
    })();

    // [n85] Khoá UI phía sau khi modal mở
    function lockBehind() {
        try {
            if (wrap) {
                try { wrap.inert = true; } catch { }
                wrap.setAttribute('aria-hidden', 'true');
                wrap.style.pointerEvents = 'none';
            }
            document.documentElement.style.overflow = 'hidden';
            input && (input.disabled = true);
            btnSend && (btnSend.disabled = true);
            btnAttach && (btnAttach.disabled = true);
        } catch { }
    }
    function unlockBehind() {
        try {
            if (wrap) {
                try { wrap.inert = false; } catch { }
                wrap.removeAttribute('aria-hidden');
                wrap.style.pointerEvents = '';
            }
            document.documentElement.style.overflow = '';
            input && (input.disabled = false);
            btnSend && (btnSend.disabled = false);
            btnAttach && (btnAttach.disabled = false);
        } catch { }
    }

    // [n90] Modal open/close
    function openModal() {
        modal.classList.add('is-open'); modal.setAttribute('aria-hidden', 'false');
        lockBehind();
        renderPreviews();
        updateMainMultiNote();
    }
    function closeModal(focusBack) {
        modal.classList.remove('is-open'); modal.setAttribute('aria-hidden', 'true');
        unlockBehind();
        if (focusBack && input) { try { input.focus(); } catch { } }
    }
    on(btnClose, 'click', () => closeModal(true));
    on(backdrop, 'click', (e) => { if (e.target === backdrop) closeModal(true); });

    // [n95] Full-zone click for dropzones (+ keyboard Enter/Space)
    function bindPickZone(el) {
        if (!el) return;
        const sel = el.getAttribute('data-pick'); if (!sel) return;
        const picker = document.querySelector(sel);
        const handler = (ev) => {
            if (ev.target && ev.target.closest && ev.target.closest('.cf-pick')) return;
            picker && picker.click();
        };
        on(el, 'click', handler);
        on(el, 'keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker && picker.click(); }
        });
    }
    bindPickZone(dzMain); bindPickZone(dzAtts);

    // [n100] Pickers
    on(btnPickMain, 'click', () => pickMain && pickMain.click());
    on(btnPickAtts, 'click', () => pickAtts && pickAtts.click());
    on(pickMain, 'change', () => {
        if (pickMain?.files) addFilesTo('main', pickMain.files);
        pickMain.value = '';
        setTimeout(() => { if (!modal.classList.contains('is-open')) { try { input?.focus(); } catch { } } }, 0);
    });
    on(pickAtts, 'change', () => {
        if (pickAtts?.files) addFilesTo('atts', pickAtts.files);
        pickAtts.value = '';
        setTimeout(() => { if (!modal.classList.contains('is-open')) { try { input?.focus(); } catch { } } }, 0);
    });

    // [n110] Dropzones
    function wireDZ(el, zone) {
        if (!el) return;
        const over = (e) => { e.preventDefault(); el.classList.add('is-over'); };
        const leave = (e) => { e.preventDefault(); el.classList.remove('is-over'); };
        on(el, 'dragover', over); on(el, 'dragenter', over); on(el, 'dragleave', leave);
        on(el, 'drop', (e) => { e.preventDefault(); el.classList.remove('is-over'); const files = e.dataTransfer?.files; if (files?.length) addFilesTo(zone, files); });
    }
    wireDZ(dzMain, 'main'); wireDZ(dzAtts, 'atts');

    // [n120] Global drag
    let dragDepth = 0;
    on(document, 'dragenter', (e) => {
        if (!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))) return;
        dragDepth++; globalDrop?.classList.add('is-on');
    }, true);
    on(document, 'dragover', (e) => { if (globalDrop) e.preventDefault(); }, true);
    on(document, 'dragleave', () => { if (dragDepth > 0) dragDepth--; if (dragDepth === 0) globalDrop?.classList.remove('is-on'); }, true);
    on(document, 'drop', (e) => {
        if (!globalDrop) return;
        const inDZ = (() => {
            const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
            const hit = (node) => !!node && (node === dzMain || node === dzAtts ||
                (node.classList && node.classList.contains('cf-dropzone')) ||
                (node.closest && (node.closest('#dz-main') || node.closest('#dz-atts'))));
            return path.some(hit) || hit(e.target);
        })();
        if (inDZ) { globalDrop.classList.remove('is-on'); dragDepth = 0; return; }
        if (globalDrop.classList.contains('is-on')) e.preventDefault();
        globalDrop.classList.remove('is-on'); dragDepth = 0;
        const files = e.dataTransfer?.files; if (files?.length) { openModal(); addFilesTo('main', files); }
    }, true);

    // [n125] Paste files/images → đổ vào TRÁI
    let lastPasteAt = 0, lastPasteSig = '';
    on(document, 'paste', (e) => {
        const cd = e.clipboardData;
        if (!cd) return;
        const items = Array.from(cd.items || []);
        const fromItems = items.filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
        const fromFiles = Array.from(cd.files || []);
        const list = fromItems.length ? fromItems : fromFiles;
        if (!list.length) return;

        // Throttle
        const sig = list.map(f => key(f)).join(',');
        const now = Date.now();
        if (now - lastPasteAt < 200 && sig === lastPasteSig) return;
        lastPasteAt = now; lastPasteSig = sig;

        openModal();
        addFilesTo('main', list);
    });

    // [n140] Send & STT
    const PLACEHOLDER_DEFAULT = 'Bạn muốn viết gì?';
    function setPlaceholder(t) { if (input) input.placeholder = t || PLACEHOLDER_DEFAULT; }
    function setSendTooltip(label, shortcut) {
        if (!btnSend) return;
        btnSend.setAttribute('data-tooltip', label || '');
        if (shortcut) btnSend.setAttribute('data-tooltip-shortcut', shortcut);
        else btnSend.removeAttribute('data-tooltip-shortcut');
    }
    function setSendMode(mode) {
        btnSend.dataset.mode = mode;
        if (mode === 'send') setSendTooltip('Gửi', 'Enter');
        else if (mode === 'stop') setSendTooltip('Dừng', 'Esc');
        else setSendTooltip('Nhấn để nói', '');
    }
    function hasFilesSelected() { return totalFilesCount() > 0; }
    function updateSendMode() {
        if (state.sending) { setSendMode('stop'); return; }
        const hasText = !!(input && input.value.trim().length);
        const hasFiles = hasFilesSelected();
        if (state.voice.active) { setSendMode('voice'); return; }
        setSendMode((hasText || hasFiles) ? 'send' : 'voice');
    }

    function startVoice() {
        if (state.voice.active) return;
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { alert('Trình duyệt của bạn chưa hỗ trợ nhận dạng giọng nói (Web Speech API). Vui lòng dùng Chrome.'); return; }
        const rec = new SR(); state.voice.recog = rec;
        const guess = (navigator.language || 'vi-VN') + ''; rec.lang = /vi[-_]/i.test(guess) ? 'vi-VN' : guess;
        rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;

        state.voice.lastFinal = (input.value || '').trim() ? (input.value.trim() + ' ') : '';
        state.voice.active = true;

        rec.onresult = (evt) => {
            let interim = '';
            for (let i = evt.resultIndex; i < evt.results.length; i++) {
                const r = evt.results[i];
                const txt = (r[0] && r[0].transcript) ? r[0].transcript : '';
                if (r.isFinal) state.voice.lastFinal += txt + ' ';
                else interim += txt;
            }
            const out = (state.voice.lastFinal + interim).replace(/\s+/g, ' ').trimStart();
            input.value = out; onTextChanged();
        };
        rec.onerror = (e) => {
            if (!['aborted', 'no-speech', 'audio-capture', 'network'].includes(e.error || ''))
                alert('Đã xảy ra lỗi nhận dạng giọng nói.');
            stopVoice(false);
        };
        rec.onend = () => { if (state.voice.active) { try { rec.start(); } catch { } } };

        try {
            rec.start();
            btnSend.classList.add('is-recording');
            setPlaceholder('Micro đang hoạt động...');
            setSendTooltip('Dừng ghi', 'Esc');
            updateSendMode();
        } catch {
            state.voice.active = false;
            alert('Không thể bật micro.');
            setPlaceholder(); updateSendMode();
        }
    }
    function stopVoice(user = true) {
        try { state.voice.active = false; state.voice.recog && state.voice.recog.stop(); } catch { }
        btnSend.classList.remove('is-recording');
        setPlaceholder(); updateSendMode();
        if (user) try { btnSend.focus(); } catch { }
        // text có thể rỗng sau khi dừng → cập nhật trạng thái tool
        updateToolsDisabledStates();
    }

    // Sending state controls
    function setSending(flag) {
        state.sending = !!flag;
        if (flag) {
            btnAttach?.setAttribute('disabled', 'true');
            btnAttach?.setAttribute('aria-disabled', 'true');
        } else {
            btnAttach?.removeAttribute('disabled');
            btnAttach?.removeAttribute('aria-disabled');
        }
        updateSendMode();
    }
    function hardClearFilesUI() {
        try { state.urls.forEach(u => { try { URL.revokeObjectURL(u); } catch { } }); } catch { }
        state.urls.clear();
        state.mainFiles = [];
        state.attFiles = [];
        renderPreviews();
        renderChips();
        updateMainMultiNote();
    }
    function requestCancel() {
        try { document.body.dispatchEvent(new Event('chat:cancel')); } catch { }
        setSending(false);
    }

    // Preflight kiểm tra trước khi phát event gửi
    function guardBeforeSend() {
        if (modal && modal.classList.contains('is-open')) return false;

        const filesCnt = totalFilesCount();
        if (LIMITS.maxFiles > 0 && filesCnt > LIMITS.maxFiles) {
            warn(`Bạn đang chọn ${filesCnt} tệp. Giới hạn là ${LIMITS.maxFiles} tệp.`, 'warning');
            return false;
        }
        if (LIMITS.perFileBytes > 0) {
            const over = [...state.mainFiles, ...state.attFiles].find(f => f.size > LIMITS.perFileBytes);
            if (over) {
                warn(`Tệp "${over.name}" vượt quá giới hạn mỗi tệp (${fmtBytes(LIMITS.perFileBytes)}).`, 'warning');
                return false;
            }
        }
        if (LIMITS.effectiveCapBytes > 0) {
            const est = estimatePayloadBytes();
            if (est > 0 && est > LIMITS.effectiveCapBytes) {
                warn(`Tổng dữ liệu ước tính (${fmtBytes(est)}) vượt quá giới hạn (${fmtBytes(LIMITS.effectiveCapBytes)}). Vui lòng bớt tệp hoặc rút gọn nội dung.`, 'warning');
                return false;
            }
        }
        return true;
    }

    // Gửi
    function emitSend() {
        const text = (input?.value || '').trim();
        const filesCnt = totalFilesCount();
        if (!text && filesCnt === 0) return;

        // Nếu đang gửi → STOP
        if (state.sending) { requestCancel(); return; }

        if (!guardBeforeSend()) return;

        // multi-main policy for internal/admin
        const mainAll = state.mainFiles.slice();
        let mainFiles = mainAll;
        let mainExtra = [];
        let multiPolicy = null;
        let multiHint = null;

        if (isInternal() && mainAll.length > 1) {
            mainFiles = [mainAll[0]];
            mainExtra = mainAll.slice(1);
            multiPolicy = { mode: 'first_full_then_head_tail', head_pages: 1, tail_pages: 1 };
            multiHint = 'Nếu người dùng cần làm việc sâu với từng tệp còn lại, vui lòng đề nghị họ tải lên từng tệp độc lập để mô hình nhận dạng rõ hơn.';
        }

        const payload = {
            text,
            tool_id: state.currentToolId || null,
            main_files: mainFiles,
            attachments: state.attFiles.slice(),
            total_files: Math.min(filesCnt, LIMITS.maxFiles),

            // gợi ý thêm (BE có thể bỏ qua an toàn)
            main_extra_files: mainExtra,
            main_multi_policy: multiPolicy,
            main_multi_hint: multiHint,
            user_role: USER_ROLE
        };

        // UX: dọn UI ngay, đóng modal, chuyển STOP
        hardClearFilesUI();
        closeModal(false);
        setSending(true);

        if (text) { input.value = ''; onTextChanged(); alignPadToIcon(); }

        shell.dispatchEvent(new CustomEvent('chat:send', { detail: payload, bubbles: true }));
        shell.dispatchEvent(new CustomEvent('chat:send-started', { bubbles: true }));
    }

    on(btnSend, 'click', (e) => {
        e.preventDefault();
        const mode = btnSend?.dataset?.mode || 'voice';
        if (mode === 'stop') { requestCancel(); return; }
        if (mode === 'voice') { if (state.voice.active) stopVoice(true); else startVoice(); }
        else { if (state.voice.active) stopVoice(false); emitSend(); }
    });

    // [n150] Enter=Gửi; Shift+Enter=NL (bị vô hiệu khi modal mở)
    on(input, 'keydown', (e) => {
        if (modal && modal.classList.contains('is-open')) return;
        if (e.key === 'Enter') {
            if (e.shiftKey) return;
            e.preventDefault();
            if (state.sending) { requestCancel(); return; }
            if (state.voice.active) stopVoice(false);
            emitSend();
        }
    });
    on(input, 'keydown', () => { if (state.voice.active) stopVoice(false); });

    // [n155] Hooks hoàn tất/ lỗi/ hủy → thoát STOP
    document.body.addEventListener('chat:sent', () => { try { setSending(false); updateToolsDisabledStates(); } catch { } });
    document.body.addEventListener('chat:error', () => { try { setSending(false); updateToolsDisabledStates(); } catch { } });
    document.body.addEventListener('chat:send-started', () => { setSending(true); });
    document.body.addEventListener('chat:cancel', () => { try { setSending(false); closeMenu(); closeModal(false); if (state.voice.active) stopVoice(false); } catch { } });
    document.body.addEventListener('chat:navigated', () => { try { setSending(false); closeMenu(); closeModal(false); if (state.voice.active) stopVoice(false); } catch { } });

    // [n160] Hotkey Ctrl+/
    function isTypingTarget(el) {
        if (!el) return false;
        if (el.closest && el.closest('[contenteditable="true"]')) return true;
        const t = (el.tagName || '').toUpperCase();
        if (t === 'TEXTAREA' || t === 'SELECT') return true;
        if (t === 'INPUT') { const ty = (el.type || '').toLowerCase(); return ty !== 'button' && ty !== 'submit' && ty !== 'reset'; }
        return el.isContentEditable === true;
    }
    on(document, 'keydown', (e) => {
        const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
        const modOk = isMac ? e.metaKey : e.ctrlKey;
        if (modOk && (e.key === '/' || e.code === 'Slash')) {
            if (isTypingTarget(e.target)) return;
            e.preventDefault();
            if (menu.classList.contains('hidden')) renderMenu().then(openMenu);
            else closeMenu();
        }
    }, true);

    // [n170] Cleanup objectURLs khi rời trang
    on(window, 'beforeunload', () => {
        try { state.urls.forEach(u => { try { URL.revokeObjectURL(u); } catch { } }); state.urls.clear(); } catch { }
    });

    // [n180] Init
    (async function () {
        try {
            syncMetaFromCookie();
            await loadUploadLimits(); // đồng bộ role/status + limits
            await fetchTools();
            hydrateSelection();
            renderActivePills();
            renderChips();
            alignPadToIcon();
            updateSendMode();
            updateMainMultiNote();
            updateToolsDisabledStates();
        } catch { }
    })();
})();

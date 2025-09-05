// file: src/modules/chat/static/js/chat_base.js
// updated: 2025-09-02
// changes: + CSRF warm-up + retry 403 cho send/edit/redo/model list/select; giữ nguyên UI & logic

(function () {
    'use strict';
    if (window.__CHAT_BASE_APPLIED__) return;
    window.__CHAT_BASE_APPLIED__ = true;
    window.__CHAT_BASE_VER__ = '3.48';

    /* ===== Polyfill CSS.escape ===== */
    (function ensureCssEscape() {
        if (!window.CSS) window.CSS = {};
        if (!CSS.escape) {
            CSS.escape = function (val) {
                const s = String(val == null ? '' : val);
                let out = '';
                for (let i = 0; i < s.length; i++) {
                    const ch = s.charAt(i);
                    if (/[\0-\x1F\x7F]|[ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/.test(ch)) out += '\\' + ch;
                    else out += ch;
                }
                return out;
            };
        }
    })();

    /* ===== Toast mini ===== */
    window.showToast = function (msg, type = "warning", ms = 5000) {
        try {
            let stack = document.querySelector('.toast-stack');
            if (!stack) { stack = document.createElement('div'); stack.className = 'toast-stack'; document.body.appendChild(stack); }
            const item = document.createElement('div'); item.className = `toast-item toast-${type}`; item.textContent = String(msg || '');
            stack.appendChild(item);
            setTimeout(() => { item.classList.add('hide'); setTimeout(() => item.remove(), 300); }, ms);
        } catch { alert(msg); }
    };

    /* ===== Helpers ===== */
    const $id = (id) => document.getElementById(id);
    function getCookie(name) { try { const raw = document.cookie || ''; for (const seg of raw.split('; ')) { const i = seg.indexOf('='); const k = decodeURIComponent(i >= 0 ? seg.slice(0, i) : seg); const v = decodeURIComponent(i >= 0 ? seg.slice(i + 1) : ''); if (k === name) return v; } return ''; } catch { return ''; } }
    const toLowerKeys = (o) => { const x = {}; for (const k in (o || {})) if (Object.hasOwn(o, k)) x[k.toLowerCase()] = o[k]; return x; };
    const sameOrigin = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch { return true; } };
    function withDefaults(h) { h = h || {}; const l = toLowerKeys(h); if (!('x-timezone' in l)) h['X-Timezone'] = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; if (!('x-requested-with' in l)) h['X-Requested-With'] = 'XMLHttpRequest'; const csrf = getCookie('csrftoken') || getCookie('csrf_token'); if (csrf && !('x-csrftoken' in l)) h['X-CSRFToken'] = csrf; return h; }
    function parseChatIdFromURL() { try { const m = (location.pathname || '').match(/^\/chat\/([0-9a-fA-F-]{36})\/?$/); return m ? m[1] : null; } catch { return null; } }
    let CURRENT_CHAT_ID = ($id('chat-root')?.dataset?.chatId || parseChatIdFromURL() || null);
    try { const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '') + ''; document.cookie = 'tz=' + encodeURIComponent(tz) + '; path=/; max-age=31536000; samesite=lax'; } catch { }

    /* ===== NEW: CSRF meta sync + warm-up (đồng bộ với header/footer) ===== */
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
                headers: withDefaults({ 'Accept': 'application/json' })
            });
        } catch { }
        syncMetaFromCookie();
    }

    /* ===== Network/Timers Cancel Registry (TASK2) ===== */
    const NET = (() => {
        const ctrls = new Map();     // label -> AbortController
        const timers = new Set();    // Set<number>
        function hasAbortController() { return typeof AbortController !== 'undefined'; }
        function make(label) {
            if (!hasAbortController()) return { signal: undefined, abort: () => { } };
            const old = ctrls.get(label); if (old) { try { old.abort('replaced'); } catch { } }
            const c = new AbortController();
            ctrls.set(label, c);
            return c;
        }
        function get(label) { return ctrls.get(label) || null; }
        function abort(label, reason = 'user_cancel') {
            const c = ctrls.get(label);
            if (c) { try { c.abort(reason); } catch { } ctrls.delete(label); }
        }
        function abortAll(reason = 'user_cancel') {
            for (const [k, c] of ctrls.entries()) { try { c.abort(reason); } catch { } ctrls.delete(k); }
            for (const t of timers) { try { clearTimeout(t); } catch { } }
            timers.clear();
        }
        function trackTimer(id) { timers.add(id); return id; }
        function clearTimer(id) { try { clearTimeout(id); } catch { } timers.delete(id); }
        return { make, get, abort, abortAll, trackTimer, clearTimer };
    })();

    /* ===== Markdown (tối giản an toàn) ===== */
    const HTMLEscapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const escHtml = (s) => String(s || '').replace(/[&<>"']/g, c => HTMLEscapeMap[c]);
    function mdToHtml(md) {
        md = String(md || '').replace(/\r\n?/g, '\n');
        const fences = [];
        md = md.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
            const idx = fences.length;
            fences.push({ lang: (lang || '').trim().toLowerCase(), code });
            return `\uFFF0CODEBLOCK_${idx}\uFFF1`;
        });
        let out = escHtml(md);
        out = out.replace(/`([^`]+?)`/g, (_, c) => `<code>${c}</code>`);
        out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, href) => `<a href="${href}" target="_blank" rel="nofollow noopener noreferrer">${t}</a>`);
        out = out.replace(/^###### (.+)$/gm, '<h6>$1</h6>').replace(/^##### (.+)$/gm, '<h5>$1</h5>').replace(/^#### (.+)$/gm, '<h4>$1</h4>')
            .replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>');
        out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
        out = out.split('\n').reduce((a, line, i, arr) => {
            const ul = /^\s*[-*+]\s+(.+)$/.exec(line); const ol = /^\s*\d+\.\s+(.+)$/.exec(line);
            const prev = a._prev || 'p';
            if (ul) { if (prev !== 'ul') a.html += '<ul>'; a.html += `<li>${ul[1]}</li>`; a._prev = 'ul'; }
            else if (ol) { if (prev !== 'ol') a.html += '<ol>'; a.html += `<li>${ol[1]}</li>`; a._prev = 'ol'; }
            else if (line.trim() === '') { if (prev === 'ul') a.html += '</ul>'; if (prev === 'ol') a.html += '</ol>'; a._prev = 'brk'; a.html += '\n\n'; }
            else { if (prev === 'ul') a.html += '</ul>'; if (prev === 'ol') a.html += '</ol>'; a._prev = 'p'; a.html += line + '\n'; }
            if (i === arr.length - 1) { if (a._prev === 'ul') a.html += '</ul>'; if (a._prev === 'ol') a.html += '</ol>'; }
            return a;
        }, { html: '', _prev: 'p' }).html;
        out = out.split(/\n{2,}/).map(seg => { const t = seg.trim(); if (!t) return ''; if (/^<(h\d|ul|ol|blockquote|pre|table)/.test(t)) return t; return `<p>${t.replace(/\n/g, '<br/>')}</p>`; }).join('');
        out = out.replace(/\uFFF0CODEBLOCK_(\d+)\uFFF1/g, (_, n) => {
            const blk = fences[Number(n)] || { lang: '', code: '' };
            return `<pre><code class="language-${escHtml(blk.lang)}">${escHtml(blk.code)}</code></pre>`;
        });
        return out;
    }

    /* ===== UI helpers ===== */
    const esc = escHtml;
    function ensureMsgList() {
        let list = $id('chat-msg-list'); if (list) return list;
        const scroll = $id('chat-scroll'); if (!scroll) return null;
        $id('chat-greeting')?.remove();
        list = document.createElement('div');
        list.id = 'chat-msg-list';
        list.className = 'w-full flex flex-col items-center gap-4 px-4 sm:px-0';
        scroll.appendChild(list); return list;
    }

    /* ===== Files helpers ===== */
    function isImgFile(f) { try { const t = (f?.type || '').toLowerCase(); const n = (f?.name || '').toLowerCase(); return /^image\//.test(t) || /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/.test(n); } catch { return false; } }
    function splitFiles(files) { const imgs = [], others = []; for (const f of (files || [])) (isImgFile(f) ? imgs : others).push(f); return { imgs, others }; }
    const isMultiline = (t) => /\n/.test(t || '');

    const CODE_EXT = new Set(['js', 'ts', 'jsx', 'tsx', 'json', 'py', 'rb', 'php', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'html', 'htm', 'xml', 'css', 'scss', 'sass', 'less', 'md', 'sql', 'sh', 'bat', 'ps1', 'yml', 'yaml', 'toml', 'ini', 'gradle', 'm', 'mm', 'swift', 'dart', 'lua', 'r', 'pl']);
    const WORD_EXT = new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt']);
    const EXCEL_EXT = new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'csv', 'ods']);
    const PPT_EXT = new Set(['ppt', 'pptx', 'pptm', 'pot', 'potx', 'odp']);
    const PDF_EXT = new Set(['pdf']);

    const fileExt = (name = '') => { const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/i); return m ? m[1] : ''; };
    const badgeCategory = (e) => { if (PDF_EXT.has(e)) return 'pdf'; if (WORD_EXT.has(e)) return 'doc'; if (EXCEL_EXT.has(e)) return 'xlsx'; if (PPT_EXT.has(e)) return 'ppt'; if (CODE_EXT.has(e)) return 'code'; return 'file'; };

    /* ===== ICON BANK ===== */
    function getTplHtml(tplId) { try { const tpl = document.getElementById(tplId); if (!tpl) return ''; if (tpl.tagName === 'TEMPLATE') return tpl.innerHTML || tpl.content?.firstElementChild?.outerHTML || ''; return tpl.innerHTML || ''; } catch { return ''; } }
    function iconTplForExt(ext) {
        const e = String(ext || '').toLowerCase();
        if (e === 'pdf') return 'tpl-ico-office-pdf';
        if (['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt'].includes(e)) return 'tpl-ico-office-word';
        if (['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'csv', 'ods'].includes(e)) return 'tpl-ico-office-excel';
        if (['ppt', 'pptx', 'pptm', 'pot', 'potx', 'odp'].includes(e)) return 'tpl-ico-office-powerpoint';
        if (CODE_EXT.has(e)) return 'tpl-ico-code';
        return 'tpl-ico-doc';
    }

    /* ===== User bubbles ===== */
    function appendBubbleUser(list, mid, text) {
        const multi = isMultiline(text);
        list.insertAdjacentHTML('beforeend',
            '<div class="relative group message-group message-row w-full items-end rtl:items-start" data-role="user" data-message-id="' + esc(mid) + '">' +
            '<div id="msg-' + mid + '-q" dir="auto" class="user-message-bubble-color"' + (multi ? ' data-multiline="true"' : '') + '>' +
            '<div class="whitespace-pre-wrap">' + esc(text) + '</div>' +
            '</div>' +
            '<div class="message-actions print:hidden"></div>' +
            '</div>');
    }
    function appendBubbleUserFiles(list, mid, files) {
        const urls = [];
        const { imgs, others } = splitFiles(files);
        let block = '<div class="relative group message-group message-row w-full items-end rtl:items-start" data-role="user" data-message-id="' + esc(mid) + '">';
        if (imgs.length) block += userImagesHTML(imgs, urls);
        if (others.length || (!imgs.length && files.length)) block += userFileBadgesHTML(others.length ? others : files);
        block += '<div class="message-actions print:hidden"></div></div>';
        list.insertAdjacentHTML('beforeend', block);
        setTimeout(() => { urls.forEach(u => { try { URL.revokeObjectURL(u); } catch { } }); }, 60000);
    }
    function appendBubbleUserComposite(list, mid, text, files) {
        const multi = isMultiline(text);
        const urls = [];
        const { imgs, others } = splitFiles(files);
        let block = '<div class="relative group message-group message-row w-full items-end rtl:items-start" data-role="user" data-message-id="' + esc(mid) + '">';
        if (imgs.length) block += userImagesHTML(imgs, urls);
        if (others.length) block += userFileBadgesHTML(others);
        block += (
            '<div id="msg-' + mid + '-q" dir="auto" class="user-message-bubble-color"' + (multi ? ' data-multiline="true"' : '') + '>' +
            '<div class="whitespace-pre-wrap">' + esc(text) + '</div>' +
            '</div>'
        );
        block += '<div class="message-actions print:hidden"></div></div>';
        list.insertAdjacentHTML('beforeend', block);
        setTimeout(() => { urls.forEach(u => { try { URL.revokeObjectURL(u); } catch { } }); }, 60000);
    }
    function userImagesHTML(files, urlBucket) {
        if (!files || !files.length) return '';
        let html = '<div class="user-images">';
        for (const f of files) {
            try { const u = URL.createObjectURL(f); urlBucket.push(u); html += `<button type="button" class="user-paste-img"><img alt="" src="${u}"/></button>`; }
            catch { html += '<div class="user-paste-img" style="background:rgba(255,255,255,.06)"></div>'; }
        }
        html += '</div>'; return html;
    }
    function userFileBadgesHTML(files) {
        if (!files || !files.length) return '';
        let html = '<div class="user-file-badges">';
        for (const f of files) {
            const name = f?.name || 'Tệp';
            const ext = fileExt(name);
            const cat = badgeCategory(ext);
            const typeLabel = (ext || 'FILE').toUpperCase();
            const tplId = iconTplForExt(ext);
            const iconFromBank = getTplHtml(tplId);
            const fallbackSvg =
                `<svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
                    <rect width="36" height="36" rx="6" fill="currentColor" opacity="0"></rect>
                    <path d="M21 9h-8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V14l-4-5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
                    <path d="M21 9v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
                    <path d="M14 17h8M14 21h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
                </svg>`;
            html += (
                `<div class="ufc-card" data-ext="${cat}">
                    <div class="inner">
                        <div class="ufc-ic">${iconFromBank || fallbackSvg}</div>
                        <div class="ufc-meta">
                            <div class="name">${esc(name)}</div>
                            <div class="type">${esc(typeLabel)}</div>
                        </div>
                    </div>
                </div>`
            );
        }
        html += '</div>';
        return html;
    }

    /* ===== AI placeholder & activate ===== */
    function appendBubbleAIPlaceholder(list, mid, content) {
        list.insertAdjacentHTML('beforeend',
            '<div class="relative group message-group message-row w-full items-start rtl:items-end" data-role="ai" data-message-id="' + esc(mid) + '">' +
            '<div id="msg-' + mid + '-ai" dir="auto" class="message-bubble ai italic opacity-70" data-state="pending">' +
            '<div class="message-content"><div class="markdown" data-md="1">' + esc(content || '(queued)') + '</div></div>' +
            '</div>' +
            '<div class="message-actions print:hidden"></div>' +
            '</div>');
    }
    function activateReplyBubble(aiEl, text) {
        if (!aiEl) return;
        aiEl.classList.remove('italic'); aiEl.style.opacity = ''; aiEl.classList.add('text-gray-100');
        aiEl.setAttribute('data-state', 'ready');
        const md = aiEl.querySelector('.markdown[data-md="1"]') || aiEl.querySelector('.message-content .markdown[data-md="1"]');
        if (md) { md.innerHTML = mdToHtml(text || '(trống)'); md.dataset.mdProcessed = '1'; }
        else { aiEl.innerHTML = '<div class="markdown" data-md="1">' + mdToHtml(text || '(trống)') + '</div>'; }
    }

    /* ===== Bootstrap markdown/multiline ===== */
    function bootstrapMarkdown() {
        document.querySelectorAll('.message-bubble.ai .markdown[data-md="1"]').forEach((el) => {
            if (el.dataset.mdProcessed === '1') return;
            const raw = el.textContent || '';
            el.innerHTML = mdToHtml(raw);
            el.dataset.mdProcessed = '1';
            const bubble = el.closest('.message-bubble.ai');
            if (bubble && bubble.getAttribute('data-state') !== 'ready') bubble.setAttribute('data-state', 'ready');
        });
    }
    function bootstrapMultiline() {
        document.querySelectorAll('.message-bubble.user, .user-message-bubble-color').forEach((el) => {
            if (el.dataset.multiline) return;
            const t = el.querySelector('.whitespace-pre-wrap')?.textContent || el.textContent || '';
            if (/\n/.test(t)) el.setAttribute('data-multiline', 'true');
        });
    }

    /* ===== HTMX defaults + events ===== */
    (function () {
        if (!window.htmx) { bootstrapMarkdown(); bootstrapMultiline(); return; }
        try {
            const base = Object.assign({}, (window.htmx.config && window.htmx.config.defaultHeaders) || {});
            window.htmx.config.defaultHeaders = withDefaults(base);
            document.body.addEventListener('htmx:configRequest', (e) => { e.detail.headers = withDefaults(e.detail.headers || {}); }, false);
            ['htmx:afterSwap', 'htmx:afterSettle', 'htmx:historyRestore'].forEach((ev) => {
                document.body.addEventListener(ev, (e) => {
                    const t = e?.detail?.target; if (t && t.id === 'chat-root') {
                        CURRENT_CHAT_ID = $id('chat-root')?.dataset?.chatId || parseChatIdFromURL() || null;
                        try { document.body.dispatchEvent(new CustomEvent('chat:navigated', { bubbles: true, detail: { via: ev } })); } catch { }
                    }
                }, false);
            });
            document.body.addEventListener('chat:navigated', () => {
                try { document.body.dispatchEvent(new Event('chat:cancel')); } catch { }
                try { document.body.dispatchEvent(new CustomEvent('chat:refresh', { bubbles: true })); } catch { }
                try { bootstrapQueued(); } catch { }
                try { bootstrapMarkdown(); } catch { }
                try { bootstrapMultiline(); } catch { }
                try { injectActionsAll(); } catch { }
                try { TTS.stop(); } catch { }
            }, false);
        } catch { }
        try { bootstrapMarkdown(); } catch { }
        try { bootstrapMultiline(); } catch { }
        try { injectActionsAll(); } catch { }
    })();

    /* ===== Refresh hook ===== */
    try { document.body.addEventListener('chat:refresh', () => { try { injectActionsAll(); } catch { } }, false); } catch { }

    /* ===== fetch patch (CSRF) ===== */
    if (!window.__CHAT_FETCH_PATCHED__) {
        window.__CHAT_FETCH_PATCHED__ = true;
        const _orig = window.fetch;
        window.fetch = function (input, init) {
            init = init || {};
            let h = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : Object.assign({}, init.headers || {});
            h = withDefaults(h);
            try {
                const m = (init.method || 'GET').toUpperCase();
                const isSame = sameOrigin(typeof input === 'string' ? input : (input && input.url) || location.href);
                const csrf = getCookie('csrftoken') || getCookie('csrf_token');
                if (csrf && isSame && m !== 'GET' && init.body != null) {
                    if (init.body instanceof FormData && !init.body.has('csrf_token')) init.body.append('csrf_token', csrf);
                    else if (init.body instanceof URLSearchParams && !init.body.has('csrf_token')) init.body.append('csrf_token', csrf);
                    else if (typeof init.body === 'object' && !(init.body instanceof Blob) && !(init.body instanceof ArrayBuffer)) {
                        if (!('csrf_token' in init.body)) init.body.csrf_token = csrf;
                    }
                }
            } catch { }
            if (!('credentials' in init)) init.credentials = 'same-origin';
            return _orig(input, Object.assign({}, init, { headers: h }));
        };
    }

    /* ===== Hotkey New Chat / ESC-STOP ===== */
    function isTypingTarget(el) {
        if (!el) return false;
        if (el.closest && el.closest('[contenteditable="true"]')) return true;
        const t = (el.tagName || '').toUpperCase();
        if (t === 'TEXTAREA' || t === 'SELECT') return true;
        if (t === 'INPUT') { const ty = (el.type || '').toLowerCase(); return ty !== 'button' && ty !== 'submit' && ty !== 'reset'; }
        return el.isContentEditable === true;
    }
    function openNewChat() {
        const link = $id('sidebar-new-chat'); try { $id('chat-modal-root')?.replaceChildren(); } catch { }
        CURRENT_CHAT_ID = null;
        if (window.htmx && link) { window.htmx.trigger(link, 'click'); try { document.body.dispatchEvent(new CustomEvent('chat:navigated', { bubbles: true, detail: { via: 'hotkey' } })); } catch { } return; }
        history.pushState({}, '', '/chat'); location.assign('/chat');
    }
    document.addEventListener('keydown', (e) => {
        try {
            if (e.key === 'Escape') {
                const hasPending = document.querySelector('.message-bubble.ai[data-state="pending"]');
                if (hasPending) { e.preventDefault(); document.body.dispatchEvent(new Event('chat:cancel')); return; }
            }
            if (isTypingTarget(e.target)) return;
            const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform), mod = isMac ? e.metaKey : e.ctrlKey;
            if (mod && e.altKey && !e.shiftKey && (e.key || '').toLowerCase() === 'n') { e.preventDefault(); e.stopPropagation(); openNewChat(); }
        } catch { }
    }, true);
    document.addEventListener('click', (e) => { const a = e.target?.closest?.('#sidebar-new-chat'); if (a) { CURRENT_CHAT_ID = null; try { document.body.dispatchEvent(new CustomEvent('chat:navigated', { bubbles: true, detail: { via: 'sidebar:click' } })); } catch { } } }, true);
    window.addEventListener('popstate', () => { try { document.body.dispatchEvent(new CustomEvent('chat:navigated', { bubbles: true, detail: { via: 'popstate' } })); } catch { } }, false);

    /* ===== URL resolvers (ưu tiên data-attrs) ===== */
    function resolvePollURL(mid) {
        try {
            const group = document.querySelector(`.message-group[data-message-id="${CSS.escape(mid)}"]`);
            const dataUrl = group?.dataset?.pollUrl;
            return dataUrl || (`/chat/api/message/${encodeURIComponent(mid)}`);
        } catch { return `/chat/api/message/${encodeURIComponent(mid)}`; }
    }
    function resolveEditURL(mid) {
        try {
            const group = document.querySelector(`.message-group[data-role="user"][data-message-id="${CSS.escape(mid)}"]`);
            const dataUrl = group?.dataset?.editUrl;
            return dataUrl || (`/chat/api/message/${encodeURIComponent(mid)}/edit`);
        } catch { return `/chat/api/message/${encodeURIComponent(mid)}/edit`; }
    }
    function resolveRedoURL(mid, btn) {
        try {
            const btnUrl = btn?.getAttribute?.('data-redo-url');
            if (btnUrl) return btnUrl;
            const group = document.querySelector(`.message-group[data-message-id="${CSS.escape(mid)}"]`);
            const dataUrl = group?.dataset?.redoUrl;
            return dataUrl || (`/chat/api/message/${encodeURIComponent(mid)}/regenerate`);
        } catch { return `/chat/api/message/${encodeURIComponent(mid)}/regenerate`; }
    }

    /* ===== Poll AI (TASK3: backoff + abortable) ===== */
    function pollDelay(tries) {
        const base = Math.min(10000, Math.round(1000 * Math.pow(1.35, Math.max(0, tries)))); // ~exponential
        const jitter = Math.floor(Math.random() * 200);
        return base + jitter;
    }
    function markCanceledBubbles() {
        document.querySelectorAll('.message-bubble.ai[data-state="pending"]').forEach(el => {
            const md = el.querySelector('.markdown[data-md="1"]') || el.querySelector('.message-content .markdown[data-md="1"]');
            if (md) { md.textContent = '(canceled)'; md.dataset.mdProcessed = '0'; }
            el.setAttribute('data-state', 'canceled');
            el.classList.remove('italic');
            el.style.opacity = '';
        });
    }
    function pollAI(messageId, tries = 0) {
        if (!messageId) return;
        const bubble = $id('msg-' + messageId + '-ai');
        if (bubble && bubble.getAttribute('data-state') === 'canceled') return;

        const label = `poll:${messageId}`;
        const ctrl = NET.make(label);
        fetch(resolvePollURL(messageId), { method: 'GET', signal: ctrl.signal })
            .then(r => r.ok ? r.json() : Promise.reject(r.status))
            .then(data => {
                if (data && data.ok && data.status === 'ready') {
                    const el = document.getElementById('msg-' + messageId + '-ai');
                    if (el) {
                        activateReplyBubble(el, data.ai_response || '');
                        const sc = $id('chat-scroll'); try { sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' }); } catch { sc.scrollTop = sc.scrollHeight; }
                    }
                    NET.abort(label);
                } else {
                    if (tries > 80) {
                        const el = document.getElementById('msg-' + messageId + '-ai');
                        if (el) {
                            const md = el.querySelector('.markdown[data-md="1"]') || el.querySelector('.message-content .markdown[data-md="1"]');
                            if (md) { md.textContent = '(timeout)'; md.dataset.mdProcessed = '0'; }
                            el.setAttribute('data-state', 'canceled');
                            el.classList.remove('italic'); el.style.opacity = '';
                        }
                        NET.abort(label);
                        return;
                    }
                    const delay = pollDelay(tries);
                    NET.trackTimer(setTimeout(() => pollAI(messageId, tries + 1), delay));
                }
            })
            .catch(() => {
                const c = NET.get(label);
                if (!c) return;
                const delay = pollDelay(tries);
                NET.trackTimer(setTimeout(() => pollAI(messageId, tries + 1), delay));
            });
    }
    function bootstrapQueued() {
        document.querySelectorAll('[id^="msg-"][id$="-ai"].italic').forEach((el) => {
            if (el.getAttribute('data-state') === 'canceled') return;
            const mid = el.id.replace(/^msg-/, '').replace(/-ai$/, ''); if (mid) pollAI(mid, 0);
        });
    }
    bootstrapQueued();

    /* ===== TTS (Web Speech API) — VI/EN auto-switch (giữ từ 3.46) ===== */
    const TTS = (() => {
        const htmlLang = (document.documentElement.lang || '').toLowerCase();
        function supported() { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; }
        function isVietnameseText(text) { return /[ăâêôơưđĂÂÊÔƠƯĐáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịýỳỷỹỵóòỏõọốồổỗộớờởỡợúùủũụứừửữự]/i.test(text || ''); }
        function hasAsciiLetters(text) { return /[A-Za-z]/.test(text || ''); }
        function detectLang(text) { if (htmlLang.startsWith('vi')) return 'vi'; return isVietnameseText(text) ? 'vi' : 'en'; }
        function stripDiacriticsVi(s = '') { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D'); }
        function waitVoices(timeout = 4000) {
            return new Promise(resolve => {
                try {
                    let voices = speechSynthesis.getVoices();
                    if (voices && voices.length) return resolve(voices);
                    let done = false;
                    const t = setTimeout(() => { if (!done) { done = true; resolve(speechSynthesis.getVoices() || []); } }, timeout);
                    const on = () => {
                        voices = speechSynthesis.getVoices();
                        if (voices && voices.length && !done) { done = true; clearTimeout(t); speechSynthesis.removeEventListener?.('voiceschanged', on); resolve(voices); }
                    };
                    speechSynthesis.addEventListener?.('voiceschanged', on);
                } catch { resolve(speechSynthesis.getVoices() || []); }
            });
        }
        function pickVoice(target) {
            const voices = speechSynthesis.getVoices() || [];
            const L = (target || 'en').toLowerCase();
            if (L === 'vi') {
                let cand = voices.filter(v => (v.lang || '').toLowerCase().startsWith('vi'));
                if (!cand.length) cand = voices.filter(v => /viet|vi[-_]?vn|vietnam/i.test(((v.name || '') + ' ' + (v.lang || '')).toLowerCase()));
                const priority = [/hoaimy/i, /namminh/i, /google (standard|cloud)? ?vietnamese/i, /google.*vi/i, /viet|vi[-_]?vn/i];
                cand.sort((a, b) => { const ra = priority.findIndex(re => re.test(a.name)); const rb = priority.findIndex(re => re.test(b.name)); return (ra < 0 ? 999 : ra) - (rb < 0 ? 999 : rb); });
                if (cand[0]) return cand[0];
            }
            let en = voices.filter(v => (v.lang || '').toLowerCase().startsWith('en'));
            if (!en.length) en = voices;
            return en[0] || null;
        }
        function cleanTextForTTS(text) { let t = String(text || ''); t = t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]+`/g, ' ').replace(/\bhttps?:\/\/\S+/g, ' ').replace(/\s{2,}/g, ' ').trim(); return t; }

        function detectPieceLang(seg) {
            const s = String(seg || '');
            if (!s.trim()) return 'skip';
            if (isVietnameseText(s)) return 'vi';
            if (hasAsciiLetters(s)) return 'en';
            if (/[^\x00-\x7F]/.test(s)) return 'unknown';
            if (/^[\s0-9.,:;!?()[\]{}"'`~_^+\-/*=|<>@#$%&\\]+$/.test(s)) return 'skip';
            return 'en';
        }
        function splitLangSegments(text) {
            const toks = String(text || '').split(/(\n{2,}|[.!?…]+[\s]|[\u3002\uff01\uff1f]\s*)/g).filter(Boolean);
            const segs = [];
            let curLang = null, buf = '';
            const push = () => { if (buf.trim()) segs.push({ lang: curLang || 'en', text: buf }); buf = ''; };
            for (const tk of toks) {
                const lang = detectPieceLang(tk);
                if (lang === 'skip') { buf += tk; continue; }
                if (lang === 'unknown') { push(); segs.push({ lang: 'unknown', text: tk }); curLang = null; continue; }
                if (!curLang) { curLang = lang; buf = tk; continue; }
                if (lang !== curLang) { push(); curLang = lang; buf = tk; continue; }
                buf += tk;
            }
            push();
            return segs;
        }

        function chunk(text, max = 1400) {
            const arr = []; const parts = String(text || '').split(/(\n{2,}|[.!?]+[\s]|[\u3002\uff01\uff1f]\s*)/g).filter(Boolean);
            let buf = ''; for (const p of parts) { if ((buf + p).length > max) { if (buf) arr.push(buf.trim()); buf = p; if (buf.length > max) { arr.push(buf.slice(0, max)); buf = buf.slice(max); } } else buf += p; }
            if (buf.trim()) arr.push(buf.trim()); return arr;
        }
        function setBtnState(mid, pressed) { try { document.querySelectorAll(`button[data-action="tts"][data-mid="${CSS.escape(mid)}"]`).forEach(b => b.setAttribute('aria-pressed', pressed ? 'true' : 'false')); } catch { } }

        async function speak(mid, raw) {
            stop(); if (!supported()) { showToast('Trình duyệt không hỗ trợ đọc văn bản (TTS).', 'warning'); return; }
            await waitVoices(4000); await new Promise(r => setTimeout(r, 120));

            let text = cleanTextForTTS(raw);
            const segments = splitLangSegments(text);

            const hasSupported = segments.some(s => s.lang === 'vi' || s.lang === 'en');
            const hasUnknown = segments.some(s => s.lang === 'unknown');
            if (!hasSupported) { showToast('Chỉ hỗ trợ đọc tiếng Việt và Anh.', 'warning'); return; }
            if (hasUnknown) { showToast('Chỉ hỗ trợ đọc tiếng Việt và Anh. Một số đoạn đã được bỏ qua.', 'warning', 4200); }

            const viVoice = pickVoice('vi');
            const enVoice = pickVoice('en');
            let warnedNoVi = false;

            const utterances = [];
            for (const seg of segments) {
                if (seg.lang === 'unknown') continue;
                let segText = seg.text;
                let voice = null, uLang = 'en-US', rate = 0.98;

                if (seg.lang === 'vi') {
                    voice = viVoice; uLang = voice?.lang || 'vi-VN'; rate = 1.0;
                    if (!voice) {
                        if (!warnedNoVi) { showToast('Không tìm thấy giọng Việt trên máy. Đang đọc tạm (không dấu).', 'warning', 3800); warnedNoVi = true; }
                        segText = stripDiacriticsVi(segText);
                    }
                } else {
                    voice = enVoice; uLang = voice?.lang || 'en-US'; rate = 0.98;
                }

                const pieces = chunk(segText, (seg.lang === 'vi' && !voice) ? 600 : 1400);
                for (const t of pieces) {
                    const u = new SpeechSynthesisUtterance(t);
                    if (voice) u.voice = voice;
                    u.lang = uLang;
                    u.rate = rate;
                    u.pitch = 1.0;
                    utterances.push(u);
                }
            }

            if (!utterances.length) { showToast('Không có nội dung để đọc.', 'warning'); return; }

            window.__tts_utts = utterances; window.__tts_state = 'speaking'; window.__tts_mid = mid; setBtnState(mid, true);
            utterances.forEach((u, i) => {
                u.onend = () => { if (i === utterances.length - 1) { window.__tts_state = 'idle'; setBtnState(mid, false); window.__tts_mid = null; } };
                u.onerror = () => { window.__tts_state = 'idle'; setBtnState(mid, false); window.__tts_mid = null; };
                speechSynthesis.speak(u);
                try { if (window.speechSynthesis.paused) window.speechSynthesis.resume(); } catch { }
            });
        }

        async function toggle(mid, text) {
            if (!supported()) { showToast('Trình duyệt không hỗ trợ đọc văn bản (TTS).', 'warning'); return; }
            if (window.__tts_mid && mid === window.__tts_mid) {
                if (window.__tts_state === 'speaking') { speechSynthesis.pause(); window.__tts_state = 'paused'; setBtnState(mid, false); }
                else if (window.__tts_state === 'paused') { speechSynthesis.resume(); window.__tts_state = 'speaking'; setBtnState(mid, true); }
                else { await speak(mid, text); }
            } else { await speak(mid, text); }
        }
        function stop() { try { speechSynthesis.cancel(); } catch { } setBtnState(window.__tts_mid, false); window.__tts_mid = null; window.__tts_state = 'idle'; }
        try { window.speechSynthesis.onvoiceschanged = window.speechSynthesis.onvoiceschanged || (() => { }); } catch { }
        return { toggle, stop, _supported: supported };
    })();

    /* ===== ACTION BUTTONS ===== */
    const ICONS = {
        edit: '<img src="/static/icons/chat_base/icon_chat_edit_pen_white.svg" alt="Edit" width="18" height="18" loading="lazy" decoding="async">',
        copy: '<img src="/static/icons/chat_base/icon_chat_coppy_white.svg" alt="Copy" width="18" height="18" loading="lazy" decoding="async">',
        tts: '<img src="/static/icons/chat_base/icon_chat_loa_doc_cau_tra_loi_AI_white.svg" alt="TTS"  width="18" height="18" loading="lazy" decoding="async">',
        redo: '<img src="/static/icons/chat_base/icon_chat_reload_cau_tra_loi_AI_white.svg" alt="Regenerate" width="18" height="18" loading="lazy" decoding="async">',
        prev: '<img src="/static/icons/chat_base/icon_chat_arrow_trai_white.svg" alt="Prev" width="18" height="18" loading="lazy" decoding="async">',
        next: '<img src="/static/icons/chat_base/icon_chat_arrow_phai_white.svg" alt="Next" width="18" height="18" loading="lazy" decoding="async">',
        tick: '<img src="/static/icons/chat_base/icon_chat_tick_white.svg" alt="Done" width="18" height="18" loading="lazy" decoding="async">',
        'ver-prev': '<img src="/static/icons/chat_base/icon_chat_arrow_trai_white.svg" alt="Prev" width="18" height="18" loading="lazy" decoding="async">',
        'ver-next': '<img src="/static/icons/chat_base/icon_chat_arrow_phai_white.svg" alt="Next" width="18" height="18" loading="lazy" decoding="async">'
    };

    function actionBtnHTML({ aria, action, mid, copyTarget, disabled }) {
        const extra = [];
        if (action === 'copy' && copyTarget) extra.push(`data-copy-target="${copyTarget}"`);
        if (disabled) extra.push('disabled');
        return `<button class="inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium h-8 w-8 rounded-full"
                    type="button" aria-label="${aria}" data-action="${action}" data-mid="${mid}" ${extra.join(' ')}>
                    ${ICONS[action] || ''}
                </button>`;
    }
    function versionIndicatorHTML(cur, total) { cur = Math.max(1, parseInt(cur || '1', 10) || 1); total = Math.max(1, parseInt(total || '1', 10) || 1); return `<span class="version-indicator" aria-hidden="true">${cur}/${total}</span>`; }
    function buildVersionControls(mid, cur, total) {
        cur = Math.max(1, parseInt(cur || '1', 10) || 1);
        total = Math.max(1, parseInt(total || '1', 10) || 1);
        const prevDisabled = (cur <= 1);
        const nextDisabled = (cur >= total);
        return (
            actionBtnHTML({ aria: 'Phiên bản trước', action: 'ver-prev', mid, disabled: prevDisabled }) +
            versionIndicatorHTML(cur, total) +
            actionBtnHTML({ aria: 'Phiên bản sau', action: 'ver-next', mid, disabled: nextDisabled })
        );
    }

    function injectActions(groupEl) {
        if (!groupEl) return;
        if (groupEl.querySelector('.action-buttons')) return;
        const act = groupEl.querySelector('.message-actions');
        if (!act || act.dataset.inited === '1') return;

        const role = groupEl.getAttribute('data-role') || '';
        const q = groupEl.querySelector('[id^="msg-"][id$="-q"]');
        const a = groupEl.querySelector('[id^="msg-"][id$="-ai"]');
        const mid = (q || a)?.id?.replace(/^msg-/, '').replace(/-(q|ai)$/, '') || '';
        if (!mid) return;

        let inner = '<div class="action-buttons">';
        if (role === 'user' && q) {
            const vTotal = parseInt(groupEl.getAttribute('data-versions-total') || '1', 10) || 1;
            const vCur = parseInt(groupEl.getAttribute('data-versions-current') || '1', 10) || 1;
            if (vTotal > 1) inner += buildVersionControls(mid, vCur, vTotal);

            const hasAttachments = !!groupEl.querySelector('.user-images, .user-file-badges');
            if (!hasAttachments) inner += actionBtnHTML({ aria: 'Chỉnh sửa', action: 'edit', mid });

            inner += actionBtnHTML({ aria: 'Sao chép', action: 'copy', mid, copyTarget: `#msg-${mid}-q .whitespace-pre-wrap` });
        } else if (role === 'ai' && a) {
            inner += actionBtnHTML({ aria: 'Sao chép', action: 'copy', mid, copyTarget: `#msg-${mid}-ai .markdown` });
            inner += actionBtnHTML({ aria: 'Đọc to', action: 'tts', mid });
            inner += actionBtnHTML({ aria: 'Tạo lại', action: 'redo', mid });
        }
        inner += '</div>';
        act.innerHTML = inner;
        act.dataset.inited = '1';
    }
    function injectActionsAll() { document.querySelectorAll('.message-group').forEach(injectActions); }

    /* ===== Version indicator update API ===== */
    function updateVersionUI(mid, current, total) {
        try {
            const group = document.querySelector(`.message-group[data-role="user"][data-message-id="${CSS.escape(mid)}"]`);
            if (!group) return;
            if (typeof total === 'number') group.setAttribute('data-versions-total', String(Math.max(1, total)));
            if (typeof current === 'number') group.setAttribute('data-versions-current', String(Math.max(1, current)));

            const hasIndicator = !!group.querySelector('.version-indicator');
            const act = group.querySelector('.message-actions');
            if (act && !hasIndicator && (parseInt(group.getAttribute('data-versions-total') || '1', 10) > 1)) {
                act.removeAttribute('data-inited');
                act.querySelector('.action-buttons')?.remove();
                injectActions(group);
            }

            const cur = parseInt(group.getAttribute('data-versions-current') || '1', 10) || 1;
            const tot = parseInt(group.getAttribute('data-versions-total') || '1', 10) || 1;
            const indicator = group.querySelector('.version-indicator'); if (indicator) indicator.textContent = `${cur}/${tot}`;
            const btnPrev = group.querySelector('button[data-action="ver-prev"]'); const btnNext = group.querySelector('button[data-action="ver-next"]');
            if (btnPrev) btnPrev.disabled = cur <= 1;
            if (btnNext) btnNext.disabled = cur >= tot;
        } catch { }
    }
    try {
        document.body.addEventListener('chat:versions:update', (e) => { const d = e?.detail || {}; if (!d.message_id) return; updateVersionUI(String(d.message_id), d.current, d.total); });
        document.body.addEventListener('chat:version:info', (e) => { const d = e?.detail || {}; if (!d.message_id) return; updateVersionUI(String(d.message_id), d.current, d.total); });
    } catch { }

    /* ===== Inline editor ===== */
    function closeAnyEditors() {
        document.querySelectorAll('.message-editor').forEach(e => { if (e.id && e.id.startsWith('editor-')) e.classList.add('hidden'); else e.remove(); });
        document.querySelectorAll('.is-editing').forEach(el => el.classList.remove('is-editing'));
    }
    function isTempId(mid) { return typeof mid === 'string' && mid.startsWith('tmp-'); }
    function buildEditorHTML(mid, initialText) {
        const txt = esc(initialText || '');
        return (
            `<div class="message-editor bg-token-main-surface-tertiary rounded-3xl m-2 px-3 py-3" data-mid="${mid}">
                <div class="grid"><textarea class="js-msg-editor-text" spellcheck="true" autofocus>${txt}</textarea></div>
                <div class="editor-actions flex items-center gap-2 mt-2">
                    <button type="button" class="btn btn-secondary js-editor-cancel">Hủy</button>
                    <button type="button" class="btn btn-primary js-editor-save">Gửi</button>
                </div>
            </div>`
        );
    }
    function focusEditor(root) { const ta = root?.querySelector('.js-msg-editor-text'); if (ta) { try { ta.focus(); ta.selectionStart = ta.value.length; ta.selectionEnd = ta.value.length; } catch { } } }
    function markBubbleEditing(mid, on) { const qEl = $id('msg-' + mid + '-q'); if (qEl) qEl.classList.toggle('is-editing', !!on); const group = qEl?.closest('.message-group'); if (group) group.classList.toggle('is-editing', !!on); }
    function openEditor(mid) {
        const group = document.querySelector(`.message-group[data-role="user"][data-message-id="${CSS.escape(mid)}"]`);
        if (group && group.querySelector('.user-images, .user-file-badges')) {
            showToast('Tin nhắn có tệp đính kèm — không thể chỉnh sửa.', 'warning');
            return;
        }

        closeAnyEditors();
        const pre = $id('editor-' + mid);
        if (pre) { pre.classList.remove('hidden'); markBubbleEditing(mid, true); focusEditor(pre); return; }
        const qEl = $id('msg-' + mid + '-q'); if (!qEl) { showToast('Không tìm thấy tin nhắn để chỉnh sửa.', 'warning'); return; }
        const text = qEl.querySelector('.whitespace-pre-wrap')?.textContent || qEl.textContent || '';
        const wrap = qEl.closest('.message-group'); if (!wrap) return;
        const editorHTML = buildEditorHTML(mid, text);
        const actions = wrap.querySelector('.message-actions'); if (actions) actions.insertAdjacentHTML('beforebegin', editorHTML); else wrap.insertAdjacentHTML('beforeend', editorHTML);
        markBubbleEditing(mid, true); focusEditor(wrap);
    }

    async function submitEditor(mid) {
        let ed = document.querySelector(`#editor-${CSS.escape(mid)}.message-editor:not(.hidden)`); if (!ed) ed = document.querySelector(`.message-editor[data-mid="${CSS.escape(mid)}"]`); if (!ed) return;
        const ta = ed.querySelector('.js-msg-editor-text'); const newText = (ta?.value || '').trim(); if (!newText) { showToast('Nội dung trống.', 'warning'); return; }
        const qEl = $id('msg-' + mid + '-q'); const aEl = $id('msg-' + mid + '-ai'); if (!qEl || !aEl) { showToast('Không tìm thấy cặp tin nhắn.', 'warning'); hideOrRemoveEditor(ed, mid); return; }

        const span = qEl.querySelector('.whitespace-pre-wrap'); if (span) span.textContent = newText; else qEl.textContent = newText;
        if (/\n/.test(newText)) qEl.setAttribute('data-multiline', 'true'); else qEl.removeAttribute('data-multiline');

        aEl.classList.add('italic'); aEl.style.opacity = '0.7';
        const md = aEl.querySelector('.markdown') || aEl.querySelector('.message-content .markdown');
        if (md) { md.textContent = '(queued)'; md.dataset.mdProcessed = '0'; }
        aEl.setAttribute('data-state', 'pending');

        try {
            if (isTempId(mid)) {
                const fd = new FormData(); if (CURRENT_CHAT_ID) fd.append('chat_id', CURRENT_CHAT_ID); fd.append('text', newText);
                const ctrl = NET.make(`send:${mid}`);
                let res = await fetch('/chat/api/send', { method: 'POST', body: fd, signal: ctrl.signal });
                if (res.status === 403) { await warmUpCSRF(); res = await fetch('/chat/api/send', { method: 'POST', body: fd, signal: ctrl.signal }); } // NEW retry
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data?.ok === false) { showToast('Gửi lại thất bại.', 'error'); aEl.classList.remove('italic'); aEl.style.opacity = ''; if (md) md.textContent = '(failed)'; return; }
                if (data?.chat_id) { CURRENT_CHAT_ID = data.chat_id; const root = $id('chat-root'); if (root) { root.dataset.chatId = CURRENT_CHAT_ID; root.dataset.ChatId = CURRENT_CHAT_ID; } if (data?.created_new_chat) history.pushState({}, '', '/chat/' + CURRENT_CHAT_ID); else if (!parseChatIdFromURL()) history.replaceState({}, '', '/chat/' + CURRENT_CHAT_ID); }
                const newId = data?.message_id;
                if (newId) {
                    const oldQ = $id('msg-' + mid + '-q'); const oldA = $id('msg-' + mid + '-ai');
                    if (oldQ) oldQ.id = 'msg-' + newId + '-q'; if (oldA) oldA.id = 'msg-' + newId + '-ai';
                    const qGroup = oldQ?.closest?.('.message-group'); const aGroup = oldA?.closest?.('.message-group');
                    [qGroup, aGroup].forEach(g => { if (!g) return; g.setAttribute('data-message-id', newId); const act = g.querySelector('.message-actions'); if (act) { act.removeAttribute('data-inited'); act.querySelector('.action-buttons')?.remove(); } injectActions(g); });
                    try { document.body.dispatchEvent(new CustomEvent('chat:message-id-assigned', { bubbles: true, detail: { temp_id: mid, message_id: newId } })); } catch { }
                    pollAI(newId, 0);
                }
                showToast('Đã gửi.', 'success');
            } else {
                const fd = new FormData(); fd.append('text', newText); if (CURRENT_CHAT_ID) fd.append('chat_id', CURRENT_CHAT_ID);
                const ctrl = NET.make(`edit:${mid}`);
                let res = await fetch(resolveEditURL(mid), { method: 'POST', body: fd, signal: ctrl.signal });
                if (res.status === 403) { await warmUpCSRF(); res = await fetch(resolveEditURL(mid), { method: 'POST', body: fd, signal: ctrl.signal }); } // NEW retry
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data?.ok === false) { showToast('Chỉnh sửa thất bại.', 'error'); aEl.classList.remove('italic'); aEl.style.opacity = ''; if (md) md.textContent = '(failed)'; return; }
                const newId = data?.message_id;
                if (newId && newId !== mid) {
                    qEl.id = 'msg-' + newId + '-q'; aEl.id = 'msg-' + newId + '-ai';
                    const qGroup = qEl.closest('.message-group'); const aGroup = aEl.closest('.message-group');
                    [qGroup, aGroup].forEach(g => { if (!g) return; g.setAttribute('data-message-id', newId); const act = g.querySelector('.message-actions'); if (act) { act.removeAttribute('data-inited'); act.querySelector('.action-buttons')?.remove(); } injectActions(g); });
                    pollAI(newId, 0);
                } else { pollAI(mid, 0); }
                showToast('Đã gửi lại.', 'success');
            }
        } catch {
            showToast('Mất kết nối khi gửi.', 'error'); aEl.classList.remove('italic'); aEl.style.opacity = '';
            const md2 = aEl.querySelector('.markdown') || aEl.querySelector('.message-content .markdown'); if (md2) md2.textContent = '(failed)';
        } finally { hideOrRemoveEditor(ed, mid); }
    }
    function hideOrRemoveEditor(ed, mid) { if (!ed) return; if (ed.id && ed.id.startsWith('editor-')) ed.classList.add('hidden'); else ed.remove(); if (mid) markBubbleEditing(mid, false); }

    /* ===== Clear history after a given AI message ===== */
    function clearHistoryAfter(mid) {
        try {
            const aGroup = document.querySelector(`.message-group[data-role="ai"][data-message-id="${CSS.escape(mid)}"]`) || $id('msg-' + mid + '-ai')?.closest('.message-group');
            if (!aGroup || !aGroup.parentElement) return [];
            const removed = [];
            let n = aGroup.nextElementSibling;
            while (n) { const next = n.nextElementSibling; if (n.classList?.contains('message-group')) { const rid = n.getAttribute('data-message-id'); if (rid) removed.push(rid); } n.remove(); n = next; }
            try { document.body.dispatchEvent(new CustomEvent('chat:history:cleared', { bubbles: true, detail: { after_message_id: mid, removed_message_ids: removed } })); } catch { }
            return removed;
        } catch { return []; }
    }

    /* ===== Copy / TTS toggle / Redo / Version nav ===== */
    function getCopyTextBySelector(sel) { if (!sel) return ''; const el = document.querySelector(sel); if (!el) return ''; return (el.innerText || el.textContent || '').trim(); }
    function getCopyTextFallback(btn, mid) {
        const group = btn?.closest?.('.message-group');
        const q = group?.querySelector?.(`#msg-${CSS.escape(mid)}-q .whitespace-pre-wrap`); if (q) return (q.innerText || q.textContent || '').trim();
        const a = group?.querySelector?.(`#msg-${CSS.escape(mid)}-ai .markdown`); if (a) return (a.innerText || a.textContent || '').trim();
        const q2 = $id('msg-' + mid + '-q')?.querySelector?.('.whitespace-pre-wrap'); if (q2) return (q2.innerText || q2.textContent || '').trim();
        const a2 = $id('msg-' + mid + '-ai')?.querySelector?.('.markdown'); if (a2) return (a2.innerText || a2.textContent || '').trim();
        return '';
    }
    function getAIText(mid) { const el = document.querySelector(`#msg-${CSS.escape(mid)}-ai .markdown`) || document.querySelector(`#msg-${CSS.escape(mid)}-ai .message-content .markdown`); return (el?.innerText || el?.textContent || '').trim(); }

    async function copyByButton(btn, mid) {
        const sel = btn?.getAttribute?.('data-copy-target');
        let text = getCopyTextBySelector(sel);
        if (!text) text = getCopyTextFallback(btn, mid);
        if (!text) { showToast('Không có nội dung để sao chép.', 'warning'); return; }
        try {
            await navigator.clipboard.writeText(text);
            const orig = btn.__origHTML || (btn.__origHTML = btn.innerHTML);
            btn.innerHTML = ICONS.tick; btn.classList.add('copied');
            setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 2200);
            showToast('Đã sao chép.', 'success');
        } catch { showToast('Trình duyệt chặn sao chép.', 'warning'); }
    }

    async function regenerateMessage(mid, btn) {
        const aEl = $id('msg-' + mid + '-ai');
        if (!aEl) { showToast('Không tìm thấy phản hồi để tạo lại.', 'warning'); return; }
        if (isTempId(mid)) { showToast('Tin nhắn chưa được gửi thành công.', 'warning'); return; }
        try { TTS.stop(); } catch { }
        aEl.classList.add('italic'); aEl.style.opacity = '0.7';
        const md = aEl.querySelector('.markdown') || aEl.querySelector('.message-content .markdown'); if (md) { md.textContent = '(queued)'; md.dataset.mdProcessed = '0'; }
        aEl.setAttribute('data-state', 'pending');
        try {
            const ctrl = NET.make(`redo:${mid}`);
            let res = await fetch(resolveRedoURL(mid, btn), { method: 'POST', body: new FormData(), signal: ctrl.signal });
            if (res.status === 403) { await warmUpCSRF(); res = await fetch(resolveRedoURL(mid, btn), { method: 'POST', body: new FormData(), signal: ctrl.signal }); } // NEW retry
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data?.ok === false) { showToast('Không tạo lại được phản hồi.', 'error'); aEl.classList.remove('italic'); aEl.style.opacity = ''; if (md) md.textContent = '(failed)'; return; }
            clearHistoryAfter(mid);
            const newId = data?.message_id;
            if (newId && newId !== mid) {
                const qEl = $id('msg-' + mid + '-q'); if (qEl) qEl.id = 'msg-' + newId + '-q';
                aEl.id = 'msg-' + newId + '-ai';
                const qGroup = qEl?.closest?.('.message-group'); const aGroup = aEl?.closest?.('.message-group');
                [qGroup, aGroup].forEach(g => { if (!g) return; g.setAttribute('data-message-id', newId); const act = g.querySelector('.message-actions'); if (act) { act.removeAttribute('data-inited'); act.querySelector('.action-buttons')?.remove(); } injectActions(g); });
                pollAI(newId, 0);
            } else { pollAI(mid, 0); }
            showToast('Đang tạo lại…', 'success');
        } catch {
            showToast('Mất kết nối khi tạo lại.', 'error'); aEl.classList.remove('italic'); aEl.style.opacity = '';
            const md2 = aEl.querySelector('.markdown') || aEl.querySelector('.message-content .markdown'); if (md2) md2.textContent = '(failed)';
        }
    }

    function requestVersionNavigate(mid, dir) {
        try { document.body.dispatchEvent(new CustomEvent('chat:version:request', { bubbles: true, detail: { message_id: mid, direction: dir } })); } catch { }
        const group = document.querySelector(`.message-group[data-role="user"][data-message-id="${CSS.escape(mid)}"]`);
        if (!group) return;
        const total = parseInt(group.getAttribute('data-versions-total') || '1', 10) || 1;
        let cur = parseInt(group.getAttribute('data-versions-current') || '1', 10) || 1;
        if (dir === 'prev' && cur > 1) cur--; else if (dir === 'next' && cur < total) cur++;
        group.setAttribute('data-versions-current', String(cur));
        const indicator = group.querySelector('.version-indicator'); if (indicator) indicator.textContent = `${cur}/${total}`;
        const btnPrev = group.querySelector('button[data-action="ver-prev"]'); const btnNext = group.querySelector('button[data-action="ver-next"]');
        if (btnPrev) btnPrev.disabled = cur <= 1; if (btnNext) btnNext.disabled = cur >= total;
        showToast('Điều hướng phiên bản sẽ tải nội dung khi API sẵn sàng.', 'warning', 1800);
    }

    /* ===== Model Store ===== */
    const ModelStore = (() => {
        let cache = null; let at = 0;
        async function load(force = false) {
            if (cache && !force && (Date.now() - at < 60_000)) return cache;
            const ctrl = NET.make('models:list');
            let res = await fetch('/chat/models', { headers: withDefaults({ 'Accept': 'application/json' }), signal: ctrl.signal });
            if (res.status === 403) { await warmUpCSRF(); res = await fetch('/chat/models', { headers: withDefaults({ 'Accept': 'application/json' }), signal: ctrl.signal }); } // NEW retry
            if (!res.ok) throw new Error('MODEL_LIST_FAILED');
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            if (!ct.includes('application/json')) throw new Error('MODEL_LIST_NON_JSON');
            const data = await res.json();
            cache = data; at = Date.now();
            try {
                const header = $id('chat-header');
                if (header) header.setAttribute('data-allowed-models', JSON.stringify((data.models || []).map(m => m.name || m.id)));
            } catch { }
            return cache;
        }
        async function list(force = false) {
            const d = await load(force).catch(() => ({ models: [] }));
            const arr = (d.models || []);
            const seen = new Set();
            return arr.filter(m => {
                const k = String(m?.id ?? m?.name ?? m);
                if (seen.has(k)) return false; seen.add(k); return true;
            });
        }
        async function selected() { const d = await load().catch(() => ({})); return d?.meta?.selected || null; }
        async function selectByIdOrName({ id = '', name = '' } = {}) {
            const body = new FormData();
            if (id) body.append('model_id', id);
            if (name) body.append('model_name', name);
            const ctrl = NET.make('model:select');
            let res = await fetch('/chat/model/select', { method: 'POST', body, signal: ctrl.signal });
            if (res.status === 403) { await warmUpCSRF(); res = await fetch('/chat/model/select', { method: 'POST', body, signal: ctrl.signal }); } // NEW retry
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data?.ok === false) throw new Error(data?.error || 'MODEL_SELECT_FAILED');
            cache = null;
            try { document.body.dispatchEvent(new CustomEvent('moe:model:selected', { bubbles: true, detail: data.selected })); } catch { }
            return data.selected;
        }
        return { load, list, selected, selectByIdOrName };
    })();

    /* ===== AI Redo Dropdown (minipanel) ===== */
    (function () {
        if (window.__REDO_MENU_V2__) return;
        window.__REDO_MENU_V2__ = true;

        let wrapEl = null, panelEl = null, subWrapEl = null, subPanelEl = null;
        let outsideListener = null, resizeListener = null, winScrollListener = null, chatScrollListener = null;

        const headerBottom = () => {
            const hdr = document.querySelector('#site-header, header.sticky, .app-header, #app-header, .top-header');
            if (!hdr) return 0;
            const r = hdr.getBoundingClientRect();
            return r.bottom > 0 ? r.bottom : 0;
        };

        function ensurePortal() {
            let portal = document.getElementById('cf-menu-portal');
            if (!portal) { portal = document.createElement('div'); portal.id = 'cf-menu-portal'; portal.style.position = 'fixed'; portal.style.inset = '0 auto auto 0'; portal.style.zIndex = '1000'; portal.style.pointerEvents = 'auto'; document.body.appendChild(portal); }
            return portal;
        }
        function makeOverlay() { const ov = document.createElement('div'); ov.className = 'cf-menu-overlay'; ov.style.position = 'fixed'; ov.style.inset = '0'; ov.style.background = 'transparent'; ov.style.pointerEvents = 'none'; ov.style.zIndex = '999'; return ov; }
        function closeSub() { try { subWrapEl?.remove(); subWrapEl = null; } catch { } try { subPanelEl?.remove(); subPanelEl = null; } catch { } }
        function closeMenu() {
            closeSub(); try { panelEl?.remove(); panelEl = null; } catch { } try { wrapEl?.remove(); wrapEl = null; } catch { }
            const portal = document.getElementById('cf-menu-portal'); portal?.querySelector('.cf-menu-overlay')?.remove();
            document.removeEventListener('keydown', onKey, true);
            if (outsideListener) { document.removeEventListener('pointerdown', outsideListener, true); outsideListener = null; }
            if (resizeListener) { window.removeEventListener('resize', resizeListener, true); resizeListener = null; }
            if (winScrollListener) { window.removeEventListener('scroll', winScrollListener, true); winScrollListener = null; }
            if (chatScrollListener) { const sc = document.getElementById('chat-scroll'); sc?.removeEventListener('scroll', chatScrollListener, true); chatScrollListener = null; }
        }
        function onKey(ev) { if (ev.key === 'Escape') closeMenu(); }
        function positionMenu() {
            if (!panelEl) return;
            const btn = panelEl.__btn__; if (!btn) return;
            const b = btn.getBoundingClientRect();
            const mW = panelEl.offsetWidth || 260, mH = panelEl.offsetHeight || 180, gap = 8;

            const spaceAbove = b.top;
            const spaceBelow = window.innerHeight - b.bottom;

            const showAbove = (spaceBelow < mH + gap) && (spaceAbove > spaceBelow);

            let top = showAbove ? (b.top - mH - gap) : (b.bottom + gap);
            if (!showAbove) {
                const clamp = headerBottom() + 8;
                if (top < clamp) top = clamp;
            }
            const left = Math.max(8, Math.min(b.left, window.innerWidth - mW - 8));

            panelEl.parentElement.style.position = 'fixed';
            panelEl.parentElement.style.left = `${Math.round(left)}px`;
            panelEl.parentElement.style.top = `${Math.round(top)}px`;
            panelEl.parentElement.style.zIndex = '1002';
        }
        function placePanel(el, nearRectLike, prefer = 'submenu-right') {
            const r = nearRectLike.getBoundingClientRect(); const w = el.offsetWidth || 260; const h = el.offsetHeight || 160; const gap = 8;
            let left, top;
            if (prefer === 'submenu-right') { left = Math.min(r.right + gap, window.innerWidth - w - 8); top = Math.max(8, Math.min(r.top, window.innerHeight - h - 8)); }
            else if (prefer === 'submenu-left') { left = Math.max(8, r.left - w - gap); top = Math.max(8, Math.min(r.top, window.innerHeight - h - 8)); }
            else { left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)); top = Math.max(8, Math.min(r.bottom + gap, window.innerHeight - h - 8)); }
            const clamp = headerBottom() + 8;
            if (top < clamp) top = clamp;
            el.style.position = 'fixed'; el.style.left = left + 'px'; el.style.top = top + 'px'; el.style.zIndex = (prefer.startsWith('submenu') ? '1003' : '1002');
        }

        function ensureNoIconCSS() {
            if (document.getElementById('redo-noicon-style')) return;
            const css = `
              #cf-menu-portal .cf-menu-panel.redo-submenu{
                width:max-content !important;
                min-width:200px !important;
                max-width:min(560px,92vw) !important;
              }
              #cf-menu-portal .cf-menu-panel.redo-submenu ul{
                padding:6px 0 !important;
                max-width:inherit !important;
              }
              #cf-menu-portal .cf-menu-panel.redo-submenu ul li{
                display:block !important;
                grid-template-columns:none !important;
                align-items:center !important;
                gap:0 !important;
                padding:8px 12px !important;
              }
              #cf-menu-portal .cf-menu-panel.redo-submenu ul li .ic-18{
                display:none !important; width:0 !important; margin:0 !important;
              }
              #cf-menu-portal .cf-menu-panel.redo-submenu ul li > span{
                display:block !important;
                white-space:nowrap !important;
                overflow:visible !important;
                text-overflow:clip !important;
                max-width:none !important;
              }
              #cf-menu-portal .cf-menu-panel.redo-submenu ul li:hover{
                background:rgba(255,255,255,.06) !important;
              }
            `;
            const st = document.createElement('style'); st.id = 'redo-noicon-style'; st.textContent = css; document.head.appendChild(st);
        }

        function buildMainHTML() {
            // TASK1: icon mũi tên phải ở BÊN PHẢI dòng “Đổi mô hình”
            return (
                '<div class="cf-menu">' +
                '<div class="cf-menu-panel" role="menu">' +
                '<div class="redo-input-row px-1.5 py-1">' +
                '<input type="text" placeholder="Cải thiện phản hồi …" aria-label="Bồi prompt nối đuôi">' +
                '<button type="button" class="redo-mini-send" aria-label="Gửi">' +
                '<img src="/static/icons/chat_base/icon_footer_arrow_top_white.svg" alt="" width="16" height="16" loading="lazy" decoding="async">' +
                '</button>' +
                '</div>' +
                '<div class="cf-divider"></div>' +
                '<ul class="px-1">' +
                '<li role="menuitem" data-act="shorter"><span class="ic-18"><img src="/static/icons/chat_base/icon_chat_thugon_text_white.svg" width="18" height="18" alt=""></span><span>Ngắn hơn</span></li>' +
                '<li role="menuitem" data-act="longer"><span class="ic-18"><img src="/static/icons/chat_base/icon_chat_morong_text_white.svg" width="18" height="18" alt=""></span><span>Dài hơn</span></li>' +
                '<li role="menuitem" data-act="switch-model" class="redo-has-sub">' +
                '<span class="ic-18"><img src="/static/icons/chat_base/icon_chat_chuyendoi_AI_white.svg" width="18" height="18" alt=""></span>' +
                '<span>Đổi mô hình</span>' +
                '<span class="ic-18" style="margin-left:auto;display:inline-flex;"><img src="/static/icons/chat_base/icon_chat_arrow_phai_white.svg" width="18" height="18" alt=""></span>' +
                '</li>' +
                '<li role="menuitem" data-act="retry"><span class="ic-18"><img src="/static/icons/chat_base/icon_chat_reload_cau_tra_loi_AI_white.svg" width="18" height="18" alt=""></span><span>Thử lại</span></li>' +
                '</ul>' +
                '</div>' +
                '</div>'
            );
        }

        function buildSubmenuHTML(models) {
            const items = models.map(m => {
                const id = esc(String(m?.id ?? m));
                const label = esc(String(m?.short_label ?? m?.name ?? m));
                const tier = esc(String(m?.tier ?? ''));
                const tierBadge = tier ? ` <small class="opacity-70">· ${tier}</small>` : '';
                return `<li role="menuitem" data-act="choose-model" data-model-id="${id}" data-model-name="${esc(String(m?.name ?? ''))}">
                          <span>${label}${tierBadge}</span>
                        </li>`;
            }).join('');
            return (
                '<div class="cf-menu">' +
                '<div class="cf-menu-panel redo-submenu no-icons" role="menu">' +
                `<ul class="px-1">${items}</ul>` +
                '</div>' +
                '</div>'
            );
        }

        function attachOutsideAndReposition() {
            outsideListener = (ev) => { const inMain = panelEl && panelEl.contains(ev.target); const inSub = subPanelEl && subPanelEl.contains(ev.target); if (!inMain && !inSub) closeMenu(); };
            document.addEventListener('pointerdown', outsideListener, true);
            resizeListener = () => positionMenu(); window.addEventListener('resize', resizeListener, true);
            winScrollListener = () => positionMenu(); window.addEventListener('scroll', winScrollListener, true);
            const sc = document.getElementById('chat-scroll'); if (sc) { chatScrollListener = () => positionMenu(); sc.addEventListener('scroll', chatScrollListener, true); }
        }

        async function redoWithParams(mid, opts = {}, btn) {
            const aEl = document.getElementById('msg-' + mid + '-ai');
            if (!aEl) { showToast('Không tìm thấy phản hồi để tạo lại.', 'warning'); return; }
            if (String(mid).startsWith('tmp-')) { showToast('Tin nhắn này chưa gửi.', 'warning'); return; }

            try { TTS.stop?.(); } catch { }
            aEl.classList.add('italic'); aEl.style.opacity = '0.7';
            const md = aEl.querySelector('.markdown') || aEl.querySelector('.message-content .markdown');
            if (md) { md.textContent = '(queued)'; md.dataset.mdProcessed = '0'; }
            aEl.setAttribute('data-state', 'pending');

            const fd = new FormData();
            if (opts.extra_prompt) fd.append('extra_prompt', String(opts.extra_prompt));
            if (opts.style) fd.append('style', String(opts.style));
            if (opts.model) fd.append('model', String(opts.model));
            if (opts.model_id) fd.append('model_id', String(opts.model_id));
            if (opts.model_name) fd.append('model_name', String(opts.model_name));

            try {
                const ctrl = NET.make(`redo:${mid}`);
                let res = await fetch(resolveRedoURL(mid, btn), { method: 'POST', body: fd, signal: ctrl.signal });
                if (res.status === 403) { await warmUpCSRF(); res = await fetch(resolveRedoURL(mid, btn), { method: 'POST', body: fd, signal: ctrl.signal }); } // NEW retry
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data?.ok === false) { showToast('Không tạo lại được phản hồi.', 'error'); aEl.classList.remove('italic'); aEl.style.opacity = ''; if (md) md.textContent = '(failed)'; return; }
                clearHistoryAfter(mid);
                const newId = data?.message_id;
                if (newId && newId !== mid) {
                    const qEl = document.getElementById('msg-' + mid + '-q'); if (qEl) qEl.id = 'msg-' + newId + '-q';
                    aEl.id = 'msg-' + newId + '-ai';
                    [qEl?.closest('.message-group'), aEl.closest('.message-group')].forEach(g => { if (!g) return; g.setAttribute('data-message-id', newId); const act = g.querySelector('.message-actions'); if (act) { act.removeAttribute('data-inited'); act.querySelector('.action-buttons')?.remove(); } injectActions(g); });
                    pollAI(newId, 0);
                } else { pollAI(mid, 0); }
                showToast('Đang tạo lại…', 'success');
            } catch {
                showToast('Mất kết nối khi tạo lại.', 'error'); aEl.classList.remove('italic'); aEl.style.opacity = '';
                const md2 = aEl.querySelector('.markdown') || aEl.querySelector('.message-content .markdown'); if (md2) md2.textContent = '(failed)';
            }
        }

        function openRedoMenu(btn, mid) {
            closeMenu();
            const portal = ensurePortal();
            const ov = makeOverlay(); portal.appendChild(ov);

            wrapEl = document.createElement('div');
            wrapEl.innerHTML = buildMainHTML();
            panelEl = wrapEl.querySelector('.cf-menu-panel');
            panelEl.__btn__ = btn; panelEl.dataset.mid = mid;

            portal.appendChild(wrapEl);
            panelEl.addEventListener('pointerdown', (e) => e.stopPropagation(), true);
            requestAnimationFrame(() => positionMenu());
            document.addEventListener('keydown', onKey, true);
            attachOutsideAndReposition();

            const input = panelEl.querySelector('input'); try { input?.focus(); } catch { }
            panelEl.querySelector('.redo-mini-send')?.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                const extra = (input?.value || '').trim();
                if (!extra) { showToast('Bạn chưa nhập gì để bồi prompt.', 'warning'); return; }
                const MID = panelEl.dataset.mid; closeMenu(); redoWithParams(MID, { extra_prompt: extra }, btn);
            });
            input?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); panelEl.querySelector('.redo-mini-send')?.dispatchEvent(new Event('click', { bubbles: true })); } if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(); } });

            (async () => {
                const models = await ModelStore.list().catch(() => []);
                const liSwitch = panelEl.querySelector('li[data-act="switch-model"]');
                if (liSwitch) liSwitch.style.display = (models.length > 1 ? '' : 'none');
            })();

            panelEl.addEventListener('click', async (e) => {
                const li = e.target?.closest?.('li[role="menuitem"]'); if (!li) return;
                e.preventDefault(); e.stopPropagation();
                const act = li.getAttribute('data-act');
                const MID = panelEl.dataset.mid;

                if (act === 'shorter') { closeMenu(); redoWithParams(MID, { style: 'shorter', extra_prompt: 'Hãy rút gọn câu trả lời, chỉ giữ ý chính (≈70% độ dài).' }, btn); return; }
                if (act === 'longer') { closeMenu(); redoWithParams(MID, { style: 'longer', extra_prompt: 'Hãy mở rộng câu trả lời với ví dụ cụ thể và chi tiết hơn.' }, btn); return; }
                if (act === 'retry') { closeMenu(); redoWithParams(MID, {}, btn); return; }

                if (act === 'switch-model') {
                    if (subWrapEl) { closeSub(); return; }
                    ensureNoIconCSS();
                    const models = await ModelStore.list().catch(() => []);
                    if (!models.length) { showToast('Chưa có danh sách mô hình khả dụng.', 'warning'); return; }
                    subWrapEl = document.createElement('div'); subWrapEl.innerHTML = buildSubmenuHTML(models);
                    subPanelEl = subWrapEl.querySelector('.cf-menu-panel'); portal.appendChild(subWrapEl);
                    const liRect = li.getBoundingClientRect();
                    const prefer = (liRect.right + (subPanelEl.offsetWidth || 260) + 12 <= window.innerWidth) ? 'submenu-right' : 'submenu-left';
                    placePanel(subPanelEl, { getBoundingClientRect: () => liRect }, prefer);
                    subPanelEl.addEventListener('pointerdown', (ev) => ev.stopPropagation(), true);

                    subPanelEl.addEventListener('click', async (ev) => {
                        const item = ev.target?.closest?.('li[role="menuitem"][data-act="choose-model"]'); if (!item) return;
                        ev.preventDefault(); ev.stopPropagation();
                        const id = item.getAttribute('data-model-id') || '';
                        const name = item.getAttribute('data-model-name') || '';
                        closeMenu();
                        redoWithParams(MID, { model: id || name, model_id: id, model_name: name }, btn);
                        showToast('Đã đổi mô hình cho phản hồi này', 'success', 2800);
                    });
                }
            }, false);
        }

        window.openRedoMenu = openRedoMenu;
        window.redoWithParams = redoWithParams;

        if (!window.__REDO_CLICK_PATCHED__) {
            window.__REDO_CLICK_PATCHED__ = true;
            document.addEventListener('click', (e) => {
                const btn = e.target?.closest?.('button[data-action="redo"]'); if (!btn) return;
                e.preventDefault();
                const mid = btn.getAttribute('data-mid'); if (!mid) return;
                openRedoMenu(btn, mid);
            }, true);
        }
    })();

    /* ===== Event delegation (copy/edit/tts/redo/versions/STOP) ===== */
    document.addEventListener('click', (e) => {
        const stopBtn = e.target?.closest?.('[data-action="stop"]');
        if (stopBtn) {
            e.preventDefault();
            try { TTS.stop(); } catch { }
            NET.abortAll('user_cancel');
            markCanceledBubbles();
            try { document.body.dispatchEvent(new Event('chat:cancel')); } catch { }
            showToast('Đã dừng tạo sinh.', 'success', 1500);
            return;
        }

        const btn = e.target?.closest?.('button[data-action]');
        if (btn) {
            const action = btn.getAttribute('data-action');
            const mid = btn.getAttribute('data-mid');
            if (!mid && !['stop'].includes(action)) return;
            if (action === 'copy') { e.preventDefault(); copyByButton(btn, mid); return; }
            if (action === 'edit') { e.preventDefault(); openEditor(mid); return; }
            if (action === 'redo') { e.preventDefault(); window.openRedoMenu ? openRedoMenu(btn, mid) : regenerateMessage(mid, btn); return; }
            if (action === 'tts') { e.preventDefault(); const t = getAIText(mid); TTS.toggle(mid, t); return; }
            if (action === 'ver-prev') { e.preventDefault(); requestVersionNavigate(mid, 'prev'); return; }
            if (action === 'ver-next') { e.preventDefault(); requestVersionNavigate(mid, 'next'); return; }
        }

        const edRoot = e.target?.closest?.('.message-editor');
        if (edRoot) {
            if (e.target?.closest?.('.js-editor-cancel') || e.target?.closest?.('.js-msg-editor-cancel')) { e.preventDefault(); hideOrRemoveEditor(edRoot, edRoot.dataset.mid || edRoot.id?.replace(/^editor-/, '') || ''); return; }
            if (e.target?.closest?.('.js-editor-save')) { e.preventDefault(); submitEditor(edRoot.dataset.mid || ''); return; }
            if (e.target?.closest?.('.js-msg-editor-submit')) { e.preventDefault(); const mid2 = edRoot.dataset.mid || edRoot.id?.replace(/^editor-/, '') || ''; submitEditor(mid2); return; }
        }
    }, true);

    // Lắng nghe event chat:cancel từ nơi khác phát ra (TASK2) + gọi BE hủy job
    document.addEventListener('chat:cancel', () => {
        try { TTS.stop(); } catch { }
        NET.abortAll('user_cancel');
        markCanceledBubbles();
        // thông báo BE (best-effort, không đưa vào NET để khỏi bị abort chính nó)
        try {
            const fd = new FormData();
            if (CURRENT_CHAT_ID) fd.append('chat_id', CURRENT_CHAT_ID);
            const mids = Array.from(document.querySelectorAll('.message-bubble.ai[data-state="pending"]')).map(el => (el.id || '').replace(/^msg-/, '').replace(/-ai$/, ''));
            mids.forEach(m => fd.append('message_ids[]', m));
            fetch('/chat/api/cancel', { method: 'POST', body: fd, credentials: 'same-origin', headers: withDefaults({}) }).catch(() => { });
        } catch { }
    }, false);

    /* ===== Send (optimistic) ===== */
    (function () {
        const footer = $id('chat-footer-shell'); if (!footer) return;
        const filesToArray = (x) => x ? (x instanceof FileList ? Array.from(x).filter(Boolean) : (Array.isArray(x) ? x.filter(Boolean) : (x?.name ? [x] : []))) : [];
        function resolveToolId(detail, rootEl) {
            const d = detail || {};
            if (d.tool_id) return String(d.tool_id);
            const ds = (rootEl && rootEl.dataset && rootEl.dataset.toolId) ? rootEl.dataset.toolId : null; if (ds) return String(ds);
            const byId = rootEl?.querySelector?.('#cf-tool-id')?.value; if (byId) return String(byId);
            const byName = rootEl?.querySelector?.('input[name="tool_id"]')?.value; if (byName) return String(byName);
            return 'auto';
        }

        footer.addEventListener('chat:send', async (ev) => {
            const d = ev.detail || {};
            const listEl = ensureMsgList();
            const sendBtn = footer.querySelector('#cf-send');
            const inputEl = footer.querySelector('#cf-input');

            const userText = (d.text || '').trim();
            const mainFiles = [...filesToArray(d.main_files), ...filesToArray(d.main_file)];
            const attachFiles = filesToArray(d.attachments);
            const allFiles = [...mainFiles, ...attachFiles];

            if (!userText && allFiles.length === 0) {
                try { sendBtn?.classList?.add('animate-bounce'); setTimeout(() => sendBtn?.classList?.remove('animate-bounce'), 500); } catch { }
                return;
            }

            const fd = new FormData();
            if (CURRENT_CHAT_ID) fd.append('chat_id', CURRENT_CHAT_ID);
            fd.append('text', userText);
            fd.append('tool_id', resolveToolId(d, footer));
            if (typeof d.total_files === 'number') fd.append('total_files', String(d.total_files));
            if (d.user_role) fd.append('user_role', String(d.user_role));

            // files: giữ tương thích cũ — tất cả đổ vào main_files[]
            allFiles.forEach(f => fd.append('main_files[]', f));

            // chuyển tiếp các field “multi main” mới (nếu có)
            const extra = filesToArray(d.main_extra_files);
            extra.forEach(f => fd.append('main_extra_files[]', f));
            if (d.main_multi_policy) try { fd.append('main_multi_policy', JSON.stringify(d.main_multi_policy)); } catch { }
            if (d.main_multi_hint) fd.append('main_multi_hint', String(d.main_multi_hint || ''));

            const tempId = 'tmp-' + Math.random().toString(36).slice(2, 10);
            if (userText && allFiles.length) { appendBubbleUserComposite(listEl, tempId, userText, allFiles); }
            else if (userText) { appendBubbleUser(listEl, tempId, userText); }
            else { appendBubbleUserFiles(listEl, tempId, allFiles); }
            appendBubbleAIPlaceholder(listEl, tempId, '(queued)');
            injectActionsAll();
            const sc = $id('chat-scroll'); try { sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' }); } catch { sc.scrollTop = sc.scrollHeight; }

            try {
                const ctrl = NET.make(`send:${tempId}`);
                let res = await fetch('/chat/api/send', { method: 'POST', body: fd, signal: ctrl.signal });
                if (res.status === 403) { await warmUpCSRF(); res = await fetch('/chat/api/send', { method: 'POST', body: fd, signal: ctrl.signal }); } // NEW retry
                const ct = res.headers.get('content-type') || '';
                const data = ct.toLowerCase().includes('application/json') ? await res.json().catch(() => ({})) : { raw: await res.text().catch(() => '') };

                if (!res.ok || data?.ok === false) {
                    const a = document.getElementById('msg-' + tempId + '-ai');
                    if (a) { a.classList.remove('italic'); a.classList.add('text-amber-300'); const s = a.querySelector('.markdown[data-md="1"]') || a.querySelector('.message-content .markdown[data-md="1"]'); if (s) s.textContent = '(failed)'; else a.textContent = '(failed)'; }
                    const err = data?.error || 'CALL_FAILED';
                    const detailTxt = typeof data?.detail === 'string' ? data.detail : JSON.stringify(data?.detail || '');
                    const is403 = (res.status === 403) || /csrf/i.test(detailTxt);
                    const is413 = (res.status === 413) || err === 'UPLOAD_TOO_LARGE';
                    if (is403) showToast('Phiên làm việc đã hết hạn. Hãy đăng xuất tài khoản rồi đăng nhập lại!', 'warning');
                    else if (is413) {
                        const lim = Number(data?.limit || 0);
                        const limMB = lim ? Math.max(1, Math.round(lim / (1024 * 1024))) : null;
                        showToast(`Dung lượng tải lên vượt giới hạn${limMB ? ' ~' + limMB + 'MB' : ''}. Hãy giảm dung lượng hoặc tách nhỏ tệp.`, 'warning', 7000);
                    }
                    else if (err === 'MODEL_NOT_REGISTERED') showToast('Mô hình chưa sẵn sàng. Vui lòng chọn lại hoặc thử sau.', 'warning');
                    else if (/404/.test(detailTxt)) showToast('Server RunPod chưa mở. Vui lòng thử lại sau.', 'error');
                    else if (err === 'EMPTY_MESSAGE') showToast('Không có nội dung để gửi. Mời bạn nhập hoặc đính lại tệp.', 'warning');
                    else showToast('Không gửi được. Vui lòng thử lại.', 'warning');
                    try { document.body.dispatchEvent(new CustomEvent('chat:sent', { bubbles: true })); } catch { }
                    return;
                }

                if (data?.chat_id) {
                    CURRENT_CHAT_ID = data.chat_id;
                    const root = $id('chat-root'); if (root) { root.dataset.chatId = CURRENT_CHAT_ID; root.dataset.ChatId = CURRENT_CHAT_ID; }
                    if (data?.created_new_chat) history.pushState({}, '', '/chat/' + CURRENT_CHAT_ID);
                    else if (!parseChatIdFromURL()) history.replaceState({}, '', '/chat/' + CURRENT_CHAT_ID);
                }

                if (data?.message_id) {
                    const q = $id('msg-' + tempId + '-q'); const a = $id('msg-' + tempId + '-ai');
                    if (q) q.id = 'msg-' + data.message_id + '-q';
                    if (a) a.id = 'msg-' + data.message_id + '-ai';
                    const qGroup = q?.closest?.('.message-group'); const aGroup = a?.closest?.('.message-group');
                    [qGroup, aGroup].forEach(g => { if (!g) return; g.setAttribute('data-message-id', data.message_id); const act = g.querySelector('.message-actions'); if (act) { act.removeAttribute('data-inited'); act.querySelector('.action-buttons')?.remove(); } injectActions(g); });
                    try { document.body.dispatchEvent(new CustomEvent('chat:message-id-assigned', { bubbles: true, detail: { temp_id: tempId, message_id: data.message_id } })); } catch { }
                    pollAI(data.message_id, 0);
                }

                if (inputEl) inputEl.value = '';
                try { document.body.dispatchEvent(new CustomEvent('chat:sent', { bubbles: true, detail: { chat_id: data?.chat_id, message_id: data?.message_id } })); } catch { }
                try { sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' }); } catch { sc.scrollTop = sc.scrollHeight; }
                try { document.body.dispatchEvent(new CustomEvent('chat:refresh', { bubbles: true })); } catch { }

            } catch (err) {
                const a = $id('msg-' + tempId + '-ai');
                if (a) { a.classList.remove('italic'); a.classList.add('text-amber-300'); const s = a.querySelector('.markdown[data-md="1"]') || a.querySelector('.message-content .markdown[data-md="1"]'); if (s) s.textContent = '(failed)'; else a.textContent = '(failed)'; }
                showToast('Mất kết nối. Vui lòng thử lại.', 'error');
                try { document.body.dispatchEvent(new CustomEvent('chat:sent', { bubbles: true })); } catch { }
            }
        });
    })();

    /* ===== Init ===== */
    try { syncMetaFromCookie(); } catch { }
    try { injectActionsAll(); } catch { }
})();

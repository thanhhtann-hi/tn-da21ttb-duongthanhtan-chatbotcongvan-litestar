/********************************************************************
 * file   : src/modules/admin/static/js/admin_notify.js
 * updated: 2025-09-03 (v5.9.5)
 * change log:
 * - [3]  Auto per-page theo viewport (đo động: thead/row + chiều cao pager) + DỒN DỮ LIỆU THẬT.
 * - [3.a] NO-DATA SAFE: màn rỗng giữ nguyên per_page (min=5). (v5.9.2: xử lý cả trường hợp có <table> nhưng không có dữ liệu)
 * - [5.a] Toolbar CSV: thêm fallback khi window.open bị chặn (chuyển sang location.href).
 * - [6.b] Sort dropdown 2 cột, neo chuẩn theo anchor (mép phải), tự re-position khi resize/scroll.
 * - [9.a] Header checkbox: click lái gỡ “–” ngay + ARIA + đồng bộ bulk bar.
 * - [9.b] Bulk Export modal (trong file này): thêm fallback khi window.open bị chặn.
 * - [9.c] Safety net: delegated click (capture) cho #btn-bulk-delete / #btn-bulk-export + UX khi chưa chọn gì.
 * - [9.d] FIX: ép pointer-events cho .bulk-inner khi bar mở/đóng (tránh theme cũ chặn click).
 * - [9.e] Guard: kill overlays có thể che bulk bar/modal + giữ bulk bar luôn interactive khi mở.
 * - [11] Filler rows: luôn bù đúng per_page ở MỌI trang.
 * - [11A] Page-jump: clamp + đồng bộ #state-page, không reset khi afterSwap.
 * - [15] HTMX: bơm page/per_page + (v,sort,q,start_date,end_date) vào e.detail.parameters và gỡ per_page trong URL.
 * - [15.a] Fallback POST bulk-hide: lấy CSRF từ input hidden và set cả X-CSRF-Token & X-CSRFToken.
 * - [9]  Bulk bar: toggle .bulk-open trên container để CSS ẩn Prev/Next giữa; gọi updatePagerLayout() khi đổi.
 * - [14.a] afterSwap: TÍNH per_page TRƯỚC rồi mới rebind + bù filler.
 * - NEW: __openBulkExportModal / __openBulkDeleteModal (GET modal + bind nút trong modal),
 *        export theo bộ lọc bỏ page/per_page.
 ********************************************************************/
(function () {
    /* ─────────────────────── [1] Helpers & constants ─────────────────────── */
    function fmtLabel(f, t) {
        if (!f || !t) return "Lịch";
        var pf = String(f).split("-"); var pt = String(t).split("-");
        if (pf.length < 3 || pt.length < 3) return "Lịch";
        var yf = pf[0], mf = pf[1], df = pf[2];
        var yt = pt[0], mt = pt[1], dt = pt[2];
        var dash = " \u2013 ";
        if (f === t) return df + "/" + mf + "/" + yf;
        if (yf === yt) return df + "/" + mf + dash + dt + "/" + mt + "/" + yt;
        return df + "/" + mf + "/" + yf + dash + dt + "/" + mt + "/" + yt;
    }
    function setCalLabel(from, to) {
        var lbl = document.getElementById("btn-notify-calendar-label");
        var btn = document.getElementById("btn-notify-calendar");
        if (!lbl || !btn) return;
        if (from && to) {
            lbl.textContent = fmtLabel(from, to);
            btn.setAttribute("data-start", from);
            btn.setAttribute("data-end", to);
        } else {
            lbl.textContent = "Lịch";
            btn.removeAttribute("data-start");
            btn.removeAttribute("data-end");
        }
    }
    function intv(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
    function $(sel) { return document.querySelector(sel); }
    function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    // LocalStorage keys
    var KEY_VIS = "admin_notify_visibility";  // "all" | "visible" | "hidden"
    var KEY_SORT = "admin_notify_sort";       // "created_desc" | "created_asc" | "az" | "za"
    var KEY_Q = "admin_notify_search";
    var KEY_RANGE = "admin_notify_date_range"; // {from,to}

    /* ─────────────────────── [1.b] Guards cho bulk & overlay ─────────────────────── */
    function __killBlockers() {
        // Ẩn tạm các overlay/menu có thể che mất bulk bar & modal
        ['.global-search', '.search-overlay', '.search-panel', '[data-global-search-overlay]', '.notify-menu']
            .forEach(function (sel) {
                $all(sel).forEach(function (el) {
                    try {
                        el.style.pointerEvents = 'none'; el.style.display = 'none'; el.setAttribute('aria-hidden', 'true');
                    } catch (_) { }
                });
            });
    }
    function ensureBulkBarInteractive() {
        var bar = document.getElementById("notify-bulk-bar"); if (!bar) return;
        if (bar.classList.contains("is-active")) {
            bar.removeAttribute("inert");
            var inner = bar.querySelector(".bulk-inner");
            if (inner) inner.style.setProperty("pointer-events", "auto", "important");
            bar.style.setProperty("pointer-events", "auto", "important");
        }
    }
    function observeBulkInert() {
        var bar = document.getElementById("notify-bulk-bar"); if (!bar || bar.__obs) return;
        bar.__obs = new MutationObserver(function () {
            if (bar.classList.contains("is-active") && bar.hasAttribute("inert")) {
                bar.removeAttribute("inert");
                ensureBulkBarInteractive();
            }
        });
        bar.__obs.observe(bar, { attributes: true, attributeFilter: ["class", "inert", "aria-hidden"] });
    }

    /* ─────────────────────── [2] DOM state helpers ─────────────────────── */
    function getDomState() {
        var q = ""; var inp = document.getElementById("notify-search-input"); if (inp) q = inp.value || "";
        var sd = document.getElementById("state-start-date");
        var ed = document.getElementById("state-end-date");
        var vv = document.getElementById("state-view");
        var ss = document.getElementById("state-sort");
        var pg = document.getElementById("state-page");
        var pp = document.getElementById("state-per-page");
        return {
            start: sd && sd.value ? sd.value : "",
            end: ed && ed.value ? ed.value : "",
            v: vv && vv.value ? vv.value : "all",
            sort: ss && ss.value ? ss.value : "created_desc",
            page: intv(pg && pg.value ? pg.value : "1", 1),
            per_page: Math.max(5, intv(pp && pp.value ? pp.value : "10", 10)),
            q: q
        };
    }
    function setDomHidden(id, val) {
        var el = document.getElementById(id);
        if (el) el.value = (val == null ? "" : String(val));
    }
    function buildQSFromDom() {
        var f = getDomState(), qs = [];
        if (f.start && f.end) { qs.push("start_date=" + encodeURIComponent(f.start)); qs.push("end_date=" + encodeURIComponent(f.end)); }
        if (f.v && f.v !== "all") qs.push("v=" + encodeURIComponent(f.v));
        if (f.sort && f.sort !== "created_desc") qs.push("sort=" + encodeURIComponent(f.sort));
        if (f.q) qs.push("q=" + encodeURIComponent(f.q));
        qs.push("page=" + encodeURIComponent(f.page));
        qs.push("per_page=" + encodeURIComponent(f.per_page));
        return qs.length ? ("?" + qs.join("&")) : "";
    }
    function buildQSNoPaging() {
        var f = getDomState(), qs = [];
        if (f.start && f.end) { qs.push("start_date=" + encodeURIComponent(f.start)); qs.push("end_date=" + encodeURIComponent(f.end)); }
        if (f.v && f.v !== "all") qs.push("v=" + encodeURIComponent(f.v));
        if (f.sort && f.sort !== "created_desc") qs.push("sort=" + encodeURIComponent(f.sort));
        if (f.q) qs.push("q=" + encodeURIComponent(f.q));
        return qs.length ? ("?" + qs.join("&")) : "";
    }
    window.__notifyFilterVals = function () {
        var f = getDomState();
        return { start_date: f.start, end_date: f.end, v: f.v, sort: f.sort, q: f.q, page: f.page, per_page: f.per_page };
    };
    window.__notifyFilterQS = function () { return buildQSFromDom(); };
    window.__notifyFilterQSNoPaging = function () { return buildQSNoPaging(); };

    /* ─────────────────────── [3] Auto per-page theo viewport ─────────────────────── */
    var MIN_ROWS = 5, ROW_FALLBACK = 54, THEAD_FALLBACK = 45;
    var _perPageApplied = null;

    function measureBottomReserve() {
        var reserve = 0;
        var bar = document.getElementById("notify-pagination");
        if (bar) {
            var cs = window.getComputedStyle(bar);
            reserve += (bar.offsetHeight || 0)
                + (parseInt(cs.marginTop || "0", 10) || 0)
                + (parseInt(cs.marginBottom || "0", 10) || 0);
        }
        var wrap = document.querySelector(".notify-table-wrap");
        if (wrap) {
            var cs2 = window.getComputedStyle(wrap);
            reserve += (parseInt(cs2.paddingBottom || "0", 10) || 0);
        }
        return Math.max(90, reserve + 12);
    }
    function sampleHeights() {
        var table = document.getElementById("admin-notify-table");
        var theadH = THEAD_FALLBACK, rowH = ROW_FALLBACK, top = 140;
        if (table) {
            var th = table.querySelector("thead");
            if (th && th.offsetHeight) theadH = th.offsetHeight;
            var r = table.querySelector("tbody tr");
            if (r && r.offsetHeight) rowH = r.offsetHeight;
            top = table.getBoundingClientRect().top;
        } else {
            var region = document.getElementById("notify-list-region");
            if (region) top = region.getBoundingClientRect().top;
        }
        return { theadH: theadH, rowH: rowH, top: top };
    }
    function computeAutoPerPage() {
        var table = document.getElementById("admin-notify-table");
        var curEl = document.getElementById("state-per-page");
        var curPP = Math.max(MIN_ROWS, intv(curEl && curEl.value ? curEl.value : String(MIN_ROWS), MIN_ROWS));

        if (table) {
            try {
                var tbody = table.querySelector("tbody");
                var dataRows = tbody ? tbody.querySelectorAll("tr.notify-row:not(.notify-row--filler)").length : 0;
                if (dataRows === 0 && tbody) dataRows = tbody.querySelectorAll("tr[data-notify-id]").length;
                if (dataRows === 0) return curPP;
            } catch (_) { }
        } else {
            return curPP;
        }

        try {
            var h = sampleHeights();
            var viewportH = window.innerHeight || document.documentElement.clientHeight || 800;
            var avail = viewportH - h.top - measureBottomReserve();
            var rows = Math.floor((avail - h.theadH) / Math.max(1, h.rowH));
            if (!isFinite(rows) || rows < MIN_ROWS) rows = MIN_ROWS;
            if (rows > 500) rows = 500;
            return rows;
        } catch (e) {
            return curPP;
        }
    }
    function applyAutoPerPageIfChanged(reason) {
        var ppEl = document.getElementById("state-per-page");
        var pageEl = document.getElementById("state-page");
        if (!ppEl || !pageEl) return;

        var want = computeAutoPerPage();
        if (want < 1) want = 1;

        var curPP = intv(ppEl.value || "0", 0);
        if (curPP === want) return;

        var curPage = intv(pageEl.value || "1", 1);
        var firstIndex = ((curPage - 1) * Math.max(1, curPP)) + 1;

        var container = document.getElementById("admin-notify-container");
        var total = container ? intv(container.getAttribute("data-total") || "0", 0) : 0;
        var newPage = Math.floor((firstIndex - 1) / want) + 1;
        if (total > 0) {
            var totalPagesNew = Math.max(1, Math.ceil(total / want));
            if (newPage > totalPagesNew) newPage = totalPagesNew;
        }
        if (newPage < 1) newPage = 1;

        ppEl.value = String(want);
        pageEl.value = String(newPage);
        _perPageApplied = want;

        if (reason !== "afterSwap") {
            loadList();
        }
    }

    var _rsTimer = null;
    function debounceResize() {
        if (_rsTimer) clearTimeout(_rsTimer);
        _rsTimer = setTimeout(function () {
            applyAutoPerPageIfChanged("resize");
            updatePagerLayout();
            addFillerRowsIfNeeded();
            sanitizeHxGetPerPageInDom();
            handleViewportForMenus();
        }, 220);
    }

    /* ─────────────────────── [4] XHR helpers ─────────────────────── */
    function fetchText(url) {
        return new Promise(function (resolve, reject) {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url, true);
                xhr.setRequestHeader("HX-Request", "true");
                xhr.onreadystatechange = function () {
                    if (xhr.readyState === 4) {
                        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText || "");
                        else reject(new Error("HTTP " + xhr.status));
                    }
                };
                xhr.send();
            } catch (e) { reject(e); }
        });
    }
    function makeFakeXhr(status, responseText, headers) {
        if (typeof status === "undefined") status = 200;
        if (typeof responseText === "undefined") responseText = "";
        if (!headers) headers = {};
        return {
            status: status, responseText: responseText, response: responseText,
            getResponseHeader: function (k) { return headers[String(k || "").toLowerCase()] || null; }
        };
    }
    function createCustomEvent(name, detail) {
        try { return new CustomEvent(name, { detail: detail }); }
        catch (e) { var evt = document.createEvent("CustomEvent"); evt.initCustomEvent(name, false, false, detail); return evt; }
    }
    function dispatchHtmxLikeEvent(type, detail) {
        document.body.dispatchEvent(createCustomEvent(type, detail));
        if (window.htmx && detail && detail.target) { try { window.htmx.process(detail.target); } catch (e) { } }
    }
    function swapOuterHTML(url, targetSelector) {
        var targetEl = document.querySelector(targetSelector);
        if (!targetEl) return Promise.resolve();
        return fetchText(url).then(function (html) {
            var tmp = document.createElement("div"); tmp.innerHTML = (html || "").trim();
            var next = tmp.querySelector(targetSelector);
            if (!next) { console.error("swapOuterHTML: Không tìm thấy phần tử đích:", targetSelector); return; }
            var fakeXhr = makeFakeXhr(200, html);
            targetEl.parentNode.replaceChild(next, targetEl);
            dispatchHtmxLikeEvent("htmx:afterSwap", { target: next, xhr: fakeXhr });
            dispatchHtmxLikeEvent("htmx:afterOnLoad", { target: next, xhr: fakeXhr });
            dispatchHtmxLikeEvent("htmx:load", { elt: next });
            dispatchHtmxLikeEvent("htmx:afterSettle", { target: next, xhr: fakeXhr });
        })["catch"](function (err) { console.error("swapOuterHTML error:", err); });
    }
    function encodeForm(obj) { var s = []; for (var k in obj) if (obj.hasOwnProperty(k)) s.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(obj[k]))); return s.join("&"); }
    function postForm(url, data, headers, cb) {
        var xhr = new XMLHttpRequest(); xhr.open("POST", url, true);
        xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        xhr.setRequestHeader("HX-Request", "true");
        if (headers) for (var k in headers) if (headers.hasOwnProperty(k)) xhr.setRequestHeader(k, headers[k]);
        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) { if (cb) cb(null, xhr.responseText || ""); }
                else { if (cb) cb(new Error("HTTP " + xhr.status)); }
            }
        };
        xhr.send(typeof data === "string" ? data : encodeForm(data || {}));
    }

    /* ─────────────────────── [5] Toolbar core ─────────────────────── */
    function bindToolbarCore() {
        var csv = document.getElementById("btn-export-csv");
        if (csv && !csv.dataset.bound) {
            csv.dataset.bound = "1";
            csv.addEventListener("click", function (e) {
                e.preventDefault();
                var url = "/admin/notify/export-csv" + buildQSNoPaging();
                var w = window.open(url, "_blank");
                if (!w) location.href = url;
            });
        }
        var plus = document.getElementById("btn-open-notify-modal");
        if (plus && !plus.dataset.bound) { plus.dataset.bound = "1"; plus.addEventListener("click", openCreate); }
        var cal = document.getElementById("btn-notify-calendar");
        if (cal && !cal.dataset.bound) { cal.dataset.bound = "1"; cal.addEventListener("click", openCalModal); }
    }

    /* ─────────────────────── [6] Toolbar v2 (Search / Filter / Reset / Sort) ─────────────────────── */
    var openMenuEl = null;
    function closeOpenMenu() { if (openMenuEl && openMenuEl.parentNode) openMenuEl.parentNode.removeChild(openMenuEl); openMenuEl = null; }

    function resolveSortAnchor(btn) {
        return document.getElementById("notify-sort-label") || btn || document.querySelector("[data-sort-anchor]");
    }

    function buildMenu(items, selectedVal, onPick, opts) {
        opts = opts || {};
        closeOpenMenu();
        var wrap = document.createElement("div");
        wrap.className = "notify-menu is-opening" + (opts.extraClass ? (" " + opts.extraClass) : "");
        wrap.setAttribute("role", "menu");
        if (opts.minWidth) wrap.style.minWidth = (typeof opts.minWidth === "number" ? (opts.minWidth + "px") : String(opts.minWidth));
        wrap.style.zIndex = 9999;

        var holder = wrap;
        if (opts.cols === 2) {
            holder = document.createElement("div");
            holder.className = "menu-grid";
            holder.style.display = "grid";
            holder.style.gridTemplateColumns = "1fr 1fr";
            holder.style.gap = "4px";
            wrap.appendChild(holder);
        }

        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "menu-item" + (it.value === selectedVal ? " is-active" : "");
            btn.textContent = it.label;
            btn.setAttribute("data-value", it.value);
            btn.setAttribute("role", "menuitemradio");
            btn.setAttribute("aria-checked", it.value === selectedVal ? "true" : "false");
            btn.addEventListener("click", function (ev) {
                var v = ev.currentTarget.getAttribute("data-value");
                closeOpenMenu();
                if (onPick) onPick(v);
            });
            holder.appendChild(btn);
        }
        document.body.appendChild(wrap);
        openMenuEl = wrap;
        setTimeout(function () { document.addEventListener("mousedown", onDocDown, { once: true }); }, 0);
        return wrap;
    }
    function onDocDown(ev) { if (!openMenuEl) return; if (!openMenuEl.contains(ev.target)) closeOpenMenu(); }

    function positionMenu(anchor, menu, opts) {
        opts = opts || {};
        function place() {
            var r = anchor.getBoundingClientRect();
            var vw = (window.innerWidth || document.documentElement.clientWidth);
            var vh = (window.innerHeight || document.documentElement.clientHeight);

            var prevVis = menu.style.visibility, prevDisp = menu.style.display;
            menu.style.visibility = "hidden"; menu.style.display = "block";
            var mw = menu.offsetWidth || 0, mh = menu.offsetHeight || 0;
            menu.style.visibility = prevVis; menu.style.display = prevDisp;

            if (mw < 10) { requestAnimationFrame(place); return; }

            var top = r.bottom + 18;
            var left = opts.alignRight ? (r.right - mw) : r.left;

            left = Math.min(Math.max(8, left), Math.max(8, vw - mw - 8));
            if (top + mh > vh - 8) top = Math.max(8, vh - mh - 8);

            menu.style.position = "fixed";
            menu.style.top = Math.round(top) + "px";
            menu.style.left = Math.round(left) + "px";
        }
        place(); setTimeout(place, 0); setTimeout(place, 150);
    }

    function handleViewportForMenus() {
        if (!openMenuEl) return;
        var isSort = /\bnotify-menu--sort\b/.test(openMenuEl.className);
        if (isSort && openMenuEl._anchorEl) {
            positionMenu(openMenuEl._anchorEl, openMenuEl, { alignRight: !!openMenuEl._alignRight });
        } else {
            closeOpenMenu();
        }
    }

    function ensureResetLabelSpan() {
        var btn = document.getElementById("btn-notify-reset");
        if (!btn || btn.querySelector(".reset-label")) return;
        var texts = [];
        for (var i = 0; i < btn.childNodes.length; i++) {
            var n = btn.childNodes[i];
            if (n.nodeType === 3 && String(n.nodeValue || "").trim()) texts.push(n);
        }
        if (!texts.length) return;
        var label = document.createElement("span");
        label.className = "reset-label";
        label.textContent = texts.map(function (n) { return n.nodeValue; }).join(" ").trim();
        texts.forEach(function (n) { btn.removeChild(n); });
        btn.appendChild(label);
    }

    function updateSortLabel() {
        var holder = document.getElementById("notify-sort-label") || document.getElementById("sort-label");
        if (!holder) return;
        var sortDom = (document.getElementById("state-sort") || {}).value;
        var sort = sortDom || localStorage.getItem(KEY_SORT) || "created_desc";
        var map = { "created_desc": "Ngày mới nhất", "created_asc": "Ngày cũ nhất", "az": "A - Z", "za": "Z - A" };
        var valSpan = holder.querySelector(".sort-value");
        if (valSpan) valSpan.textContent = map[sort] || "Ngày mới nhất";
        else holder.innerHTML = '<span class="sort-prefix">Sắp xếp:&nbsp;</span><span class="sort-value">' + (map[sort] || "Ngày mới nhất") + '</span>';
    }

    function bindToolbarV2() {
        var input = document.getElementById("notify-search-input");
        if (input && !input.dataset.bound) {
            input.dataset.bound = "1";
            try { localStorage.setItem(KEY_Q, input.value || ""); } catch (e) { }
            input.addEventListener("input", function () {
                try { localStorage.setItem(KEY_Q, input.value || ""); } catch (e) { }
                setDomHidden("state-page", "1");
            });
            input.addEventListener("keydown", function (e) {
                var k = e.key || e.which;
                if (k === "Enter" || e.keyCode === 13) {
                    e.preventDefault();
                    var hv = document.getElementById("state-view");
                    var hs = document.getElementById("state-sort");
                    var hsd = document.getElementById("state-start-date");
                    var hed = document.getElementById("state-end-date");

                    if (!hv || !hv.value) {
                        try { var v = localStorage.getItem(KEY_VIS); if (v) setDomHidden("state-view", v); } catch (err1) { }
                    }
                    if (!hs || !hs.value) {
                        try { var s = localStorage.getItem(KEY_SORT); if (s) setDomHidden("state-sort", anySortToStorage(s)); } catch (err2) { }
                    }
                    if ((!hsd || !hsd.value) && (!hed || !hed.value)) {
                        try {
                            var r = JSON.parse(localStorage.getItem(KEY_RANGE) || "{}");
                            if (r && r.from && r.to) {
                                setDomHidden("state-start-date", r.from);
                                setDomHidden("state-end-date", r.to);
                            }
                        } catch (err3) { }
                    }

                    setDomHidden("state-page", "1");
                    loadList();
                }
            });
        }

        var btnFilter = document.getElementById("btn-notify-filter");
        if (btnFilter && !btnFilter.dataset.bound) {
            btnFilter.dataset.bound = "1";
            btnFilter.addEventListener("click", function (e) {
                e.preventDefault();
                var cur = (document.getElementById("state-view") || {}).value || "all";
                var items = [
                    { value: "all", label: "Tất cả" },
                    { value: "visible", label: "Thông báo hiển thị" },
                    { value: "hidden", label: "Thông báo ẩn" }
                ];
                var menu = buildMenu(items, cur, function (v) {
                    try { localStorage.setItem(KEY_VIS, v); } catch (err) { }
                    setDomHidden("state-view", v);
                    setDomHidden("state-page", "1");
                    loadList();
                });
                positionMenu(btnFilter, menu);
            });
        }

        var btnReset = document.getElementById("btn-notify-reset");
        if (btnReset && !btnReset.dataset.bound) {
            btnReset.dataset.bound = "1";
            btnReset.addEventListener("click", function (e) {
                e.preventDefault();
                try {
                    localStorage.removeItem(KEY_Q);
                    localStorage.removeItem(KEY_VIS);
                    localStorage.removeItem(KEY_SORT);
                    localStorage.removeItem(KEY_RANGE);
                } catch (err) { }
                var inp = document.getElementById("notify-search-input");
                if (inp) inp.value = "";
                setDomHidden("state-view", "all");
                setDomHidden("state-sort", "created_desc");
                setDomHidden("state-start-date", "");
                setDomHidden("state-end-date", "");
                setDomHidden("state-page", "1");
                setCalLabel("", "");
                updateSortLabel();
                loadList();
            });
        }

        var btnSort = document.getElementById("btn-notify-sort");
        if (btnSort && !btnSort.dataset.bound) {
            btnSort.dataset.bound = "1";
            btnSort.addEventListener("click", function (e) {
                e.preventDefault();
                var cur = (document.getElementById("state-sort") || {}).value || "created_desc";
                var items = [
                    { value: "created_desc", label: "Ngày mới nhất" },
                    { value: "created_asc", label: "Ngày cũ nhất" },
                    { value: "az", label: "A - Z" },
                    { value: "za", label: "Z - A" }
                ];
                var anchor = resolveSortAnchor(btnSort);
                var menu = buildMenu(items, cur, function (v) {
                    try { localStorage.setItem(KEY_SORT, v); } catch (err) { }
                    setDomHidden("state-sort", v);
                    setDomHidden("state-page", "1");
                    updateSortLabel();
                    loadList();
                }, { cols: 2, extraClass: "notify-menu--sort", minWidth: 360, alignRight: true });

                menu._anchorEl = anchor;
                menu._alignRight = true;

                positionMenu(anchor, menu, { alignRight: true });
            });
        }

        ensureResetLabelSpan();
        updateSortLabel();

        if (!document.body.dataset._notifyMenuBound) {
            document.body.dataset._notifyMenuBound = "1";
            window.addEventListener("resize", handleViewportForMenus);
            window.addEventListener("scroll", handleViewportForMenus, true);
            document.addEventListener("keydown", function (e) {
                var k = e.key || e.which;
                if (k === "Escape" || k === 27) closeOpenMenu();
            });
        }
    }

    /* ─────────────────────── [7] Query + reload (swap vùng list) ─────────────────────── */
    function loadList() {
        try { if (typeof closeOpenMenu === "function") closeOpenMenu(); } catch (_) { }
        var form = document.getElementById("notify-search-form");
        if (form && window.htmx) {
            if (form.requestSubmit) form.requestSubmit();
            else form.submit();
        } else {
            swapOuterHTML("/admin/notify" + window.__notifyFilterQS(), "#notify-list-region");
        }
    }

    /* ─────────────────────── [8] Modals ─────────────────────── */
    var MODAL_ROOT_SEL = "#admin-notify-modal-root"; var MODAL_ROOT_FALLBACK = "#modal-root";
    function modalGet(path, onAfter) {
        var targetSel = document.querySelector(MODAL_ROOT_SEL) ? MODAL_ROOT_SEL : MODAL_ROOT_FALLBACK;
        fetchText(String(path)).then(function (html) {
            var el = document.querySelector(targetSel); if (!el) return;
            el.innerHTML = html || "";
            var fake = makeFakeXhr(200, html);
            dispatchHtmxLikeEvent("htmx:afterSwap", { target: el, xhr: fake });
            dispatchHtmxLikeEvent("htmx:afterOnLoad", { target: el, xhr: fake });
            dispatchHtmxLikeEvent("htmx:load", { elt: el });
            dispatchHtmxLikeEvent("htmx:afterSettle", { target: el, xhr: fake });
            if (typeof onAfter === "function") onAfter(el);
        });
    }
    function showDelete(id) { modalGet("/admin/notify/" + id + "/delete-modal"); }
    function openCreate() { modalGet("/admin/notify/new-modal"); }
    function openDetail(id) { modalGet("/admin/notify/" + id + "/detail-modal"); }
    function openEdit(id) { modalGet("/admin/notify/" + id + "/edit-modal"); }
    function openCalModal() { modalGet("/admin/notify/calendar-modal"); }

    // ── NEW: Bulk modals (Export / Delete)
    function __bindBulkModalDom(root) {
        var overlays = root.querySelectorAll('#bulk-export-modal-overlay, #bulk-delete-modal-overlay');
        var closeBtns = root.querySelectorAll('#bulk-export-modal-close, #bulk-delete-modal-close');
        function closeNow() { try { root.innerHTML = ''; } catch (e) { } }
        overlays.forEach(function (ov) { ov.addEventListener('click', closeNow); });
        closeBtns.forEach(function (cb) { cb.addEventListener('click', closeNow); });
        function esc(e) { if (e.key === 'Escape') { closeNow(); document.removeEventListener('keydown', esc); } }
        document.addEventListener('keydown', esc);

        var btnSel = root.querySelector('#bulk-export-selected');
        var btnFil = root.querySelector('#bulk-export-filter');
        if (btnSel) btnSel.addEventListener('click', function () {
            var ids = (root.querySelector('#bulk-export-ids') || {}).value || '';
            if (!ids) return;
            var url = '/admin/notify/export-csv?ids=' + encodeURIComponent(ids);
            var w = window.open(url, '_blank');
            if (!w) location.href = url;
            closeNow();
        });
        if (btnFil) btnFil.addEventListener('click', function () {
            var url = '/admin/notify/export-csv' + buildQSNoPaging();
            var w = window.open(url, '_blank');
            if (!w) location.href = url;
            closeNow();
        });

        var form = root.querySelector('#bulk-delete-form');
        if (form) {
            form.addEventListener('submit', function () {
                var f = (typeof window.__notifyFilterVals === 'function') ? window.__notifyFilterVals() : getDomState();
                ['v', 'sort', 'q', 'start_date', 'end_date'].forEach(function (k) {
                    var input = form.querySelector('input[name="' + k + '"]');
                    if (input) input.value = (f[k] || '');
                });
            });
            var cancel = root.querySelector('#bulk-delete-cancel');
            cancel && cancel.addEventListener('click', closeNow);
        }
    }
    function openBulkExportModal(idsCsv) {
        __killBlockers(); // guard
        modalGet('/admin/notify/bulk-export-modal' + (idsCsv ? ('?ids=' + encodeURIComponent(idsCsv)) : ''), __bindBulkModalDom);
    }
    function openBulkDeleteModal(idsCsv) {
        __killBlockers(); // guard
        modalGet('/admin/notify/bulk-delete-modal' + (idsCsv ? ('?ids=' + encodeURIComponent(idsCsv)) : ''), __bindBulkModalDom);
    }
    window.__openBulkExportModal = window.__openBulkExportModal || openBulkExportModal;
    window.__openBulkDeleteModal = window.__openBulkDeleteModal || openBulkDeleteModal;

    /* ─────────────────────── [9] Selection + Bulk bar ─────────────────────── */
    function $$rows() { return Array.prototype.slice.call(document.querySelectorAll(".row-select")); }
    function $header() { return document.getElementById("sel-all"); }
    function $headerWrap() { return document.getElementById("sel-all-wrap"); }
    function $bulk() { return document.getElementById("notify-bulk-bar"); }
    function $bulkDel() { return document.getElementById("btn-bulk-delete"); }
    function $bulkDelLabel() { return document.getElementById("bulk-delete-label"); }
    function $bulkCsv() { return document.getElementById("btn-bulk-export"); }

    function getSelectedIds() {
        var ids = []; var list = $$rows();
        for (var i = 0; i < list.length; i++) if (list[i].checked) ids.push(list[i].getAttribute("data-notify-id"));
        return ids;
    }
    function getSelectedVisibleCount() {
        var c = 0; var list = $$rows();
        for (var i = 0; i < list.length; i++) if (list[i].checked) {
            var v = list[i].getAttribute("data-visible");
            if (v === "1" || v === "true") c++;
        }
        return c;
    }
    function setAllRows(checked) { var list = $$rows(); for (var i = 0; i < list.length; i++) list[i].checked = !!checked; }

    function setHeaderStateFromRows() {
        var head = $header();
        var list = $$rows(); var total = list.length; var sel = 0;
        for (var i = 0; i < total; i++) if (list[i].checked) sel++;

        if (head) {
            var all = (sel === total && total > 0);
            head.checked = all;
            head.indeterminate = (sel > 0 && !all);

            head.setAttribute("aria-checked", head.indeterminate ? "mixed" : (all ? "true" : "false"));
            var wrap = $headerWrap();
            if (wrap) {
                wrap.classList.toggle("is-indeterminate", head.indeterminate);
                wrap.classList.toggle("is-checked", all);
            }
        }
        updateBulkBar(sel, getSelectedVisibleCount());
    }

    function updateBulkBar(count, visibleCount) {
        var bar = $bulk(); var lbl = $bulkDelLabel(); if (!bar || !lbl) return;
        var vc = (visibleCount | 0), ct = (count | 0);
        var container = document.getElementById("admin-notify-container");
        var inner = bar ? bar.querySelector('.bulk-inner') : null;

        if (ct === 0) lbl.textContent = "Ẩn 0 mục";
        else if (vc === 0) lbl.textContent = "Ẩn 0 mục (đã ẩn hết)";
        else lbl.textContent = "Ẩn " + vc + " mục";

        if (ct > 0) {
            if (bar.className.indexOf("is-active") < 0) bar.className += " is-active";
            bar.setAttribute("aria-hidden", "false");
            bar.removeAttribute("inert");
            if (inner) inner.style.pointerEvents = "auto";   // [9.d]
            if (container) container.classList.add("bulk-open");
            ensureBulkBarInteractive();                      // guard
        } else {
            try {
                var active = document.activeElement;
                if (active && bar.contains(active) && typeof active.blur === "function") active.blur();
            } catch (e) { }
            bar.className = bar.className.replace(/\bis-active\b/, "").trim();
            bar.setAttribute("aria-hidden", "true");
            bar.setAttribute("inert", "");
            if (inner) inner.style.pointerEvents = "none";   // [9.d]
            if (container) container.classList.remove("bulk-open");
        }
        try { updatePagerLayout(); } catch (_) { }
    }

    function onHeaderClick(e) {
        e.preventDefault(); e.stopPropagation();
        var head = $header(); if (!head) return;
        var list = $$rows(); if (!list.length) return;

        var chooseAll = !(head.indeterminate || head.checked);
        setAllRows(chooseAll);

        head.indeterminate = false;
        head.checked = chooseAll;
        head.setAttribute("aria-checked", chooseAll ? "true" : "false");
        var wrap = $headerWrap();
        if (wrap) {
            wrap.classList.remove("is-indeterminate");
            wrap.classList.toggle("is-checked", !!chooseAll);
        }

        setHeaderStateFromRows();
    }
    function onRowChange() { setHeaderStateFromRows(); }

    function informAlreadyHiddenAll() {
        if (window.Toast && window.Toast.show) window.Toast.show("Tất cả mục bạn chọn đều đã được ẨN (xoá mềm). Muốn xoá vĩnh viễn, vui lòng thao tác trên SQL UI (PostgreSQL).", "warn", 4200);
        else alert("Tất cả mục chọn đã ẨN (xoá mềm). Muốn xoá vĩnh viễn, vui lòng thao tác trên SQL UI (PostgreSQL).");
    }
    function openBulkDeleteModalFromSelection() {
        var ids = getSelectedIds(); if (!ids.length) return;
        var visibleCount = getSelectedVisibleCount(); if (visibleCount === 0) { informAlreadyHiddenAll(); return; }
        __killBlockers();
        window.__openBulkDeleteModal(ids.join(","));
    }
    function openBulkExportModalFromSelection() {
        var ids = getSelectedIds();
        __killBlockers();
        window.__openBulkExportModal(ids.join(","));
    }

    function bindSelection() {
        var head = $header(); var headWrap = $headerWrap();
        if (head && !head.dataset.bound) { head.dataset.bound = "1"; head.addEventListener("click", onHeaderClick); }
        if (headWrap && !headWrap.dataset.bound) { headWrap.dataset.bound = "1"; headWrap.addEventListener("click", onHeaderClick); }

        var rows = $$rows();
        for (var i = 0; i < rows.length; i++) {
            if (!rows[i].dataset.bound) {
                rows[i].dataset.bound = "1";
                rows[i].addEventListener("change", onRowChange);
            }
        }

        var del = $bulkDel();
        if (del) { try { del.removeAttribute("data-bound"); } catch (_) { } }
        if (del && !del.__bulkBound) {
            del.__bulkBound = true;
            del.addEventListener("click", function (e) { e.preventDefault(); openBulkDeleteModalFromSelection(); });
        }

        var csv = $bulkCsv();
        if (csv) { try { csv.removeAttribute("data-bound"); } catch (_) { } }
        if (csv && !csv.__bulkBound) {
            csv.__bulkBound = true;
            csv.addEventListener("click", function (e) { e.preventDefault(); openBulkExportModalFromSelection(); });
        }

        setHeaderStateFromRows();
    }

    /* ─────────────────────── [10] Row buttons delegation ─────────────────────── */
    function bindRowBtns() {
        var table = document.getElementById("admin-notify-table");
        if (!table || table.dataset.boundDelegation === "1") return;
        table.dataset.boundDelegation = "1";
        table.addEventListener("click", function (e) {
            var target = e.target || e.srcElement;

            var wrap = target;
            while (wrap && wrap !== table && wrap.nodeType === 1) {
                if ((" " + wrap.className + " ").indexOf(" cb ") > -1) { e.stopPropagation(); break; }
                wrap = wrap.parentNode;
            }

            var el = target;
            while (el && el !== table && el.nodeType === 1) {
                if ((" " + el.className + " ").indexOf(" td-content ") > -1) break;
                el = el.parentNode;
            }
            if (el && el !== table && (" " + el.className + " ").indexOf(" td-content ") > -1) {
                var cid = el.getAttribute("data-notify-id"); if (cid) { e.preventDefault(); openDetail(cid); return; }
            }

            var btn = (function (from) {
                var x = from;
                while (x && x !== table && x.nodeType === 1) {
                    var cn = " " + x.className + " ";
                    if (cn.indexOf(" row-action-detail ") > -1 || cn.indexOf(" row-action-edit ") > -1 ||
                        cn.indexOf(" row-action-delete ") > -1 || cn.indexOf(" btn-notify-detail ") > -1 ||
                        cn.indexOf(" btn-notify-edit ") > -1 || cn.indexOf(" btn-delete-notify ") > -1) return x;
                    x = x.parentNode;
                }
                return null;
            })(target);
            if (!btn) return;

            e.preventDefault();
            var id = btn.getAttribute("data-notify-id");
            var cls = " " + btn.className + " ";
            if (cls.indexOf(" row-action-detail ") > -1 || cls.indexOf(" btn-notify-detail ") > -1) { openDetail(id); return; }
            if (cls.indexOf(" row-action-edit ") > -1 || cls.indexOf(" btn-notify-edit ") > -1) { openEdit(id); return; }
            if (cls.indexOf(" row-action-delete ") > -1 || cls.indexOf(" btn-delete-notify ") > -1) { showDelete(id); return; }
        });
    }

    /* ─────────────────────── [11] Pager layout & filler rows ─────────────────────── */
    function ensurePagerAtBottom() {
        var bar = document.getElementById("notify-pagination");
        if (!bar) return;
        if (!/\bmt-auto\b/.test(bar.className)) bar.classList.add("mt-auto");
    }
    function updatePagerLayout() {
        var bar = document.getElementById("notify-pagination");
        if (!bar) return;

        ensurePagerAtBottom();

        var left = bar.querySelector(".pg-first-area");
        var center = bar.querySelector(".pg-center-area");
        var right = bar.querySelector(".pg-tools-area");
        if (!center) return;

        var need = (left ? left.offsetWidth : 0) + center.offsetWidth + (right ? right.offsetWidth : 0) + 24;
        var have = bar.clientWidth;
        var compact = have < need || have < 720;

        if (left) left.style.display = compact ? "none" : "";
        if (right) right.style.display = compact ? "none" : "";

        if (compact) {
            bar.classList.remove("justify-between");
            if (!/\bjustify-center\b/.test(bar.className)) bar.classList.add("justify-center");
        } else {
            bar.classList.remove("justify-center");
            if (!/\bjustify-between\b/.test(bar.className)) bar.classList.add("justify-between");
        }
    }

    function addFillerRowsIfNeeded() {
        var table = document.getElementById("admin-notify-table");
        if (!table) return;

        var tbody = table.querySelector("tbody");
        var thead = table.querySelector("thead");
        if (!tbody || !thead) return;

        var olds = tbody.querySelectorAll(".notify-row--filler");
        for (var i = 0; i < olds.length; i++) if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]);

        var perPage = intv((document.getElementById("state-per-page") || {}).value || "0", 0);
        if (!perPage) return;

        var realRows = tbody.querySelectorAll("tr.notify-row:not(.notify-row--filler)").length;
        var needFill = perPage - realRows;
        if (needFill <= 0) return;

        var colsCount = thead.querySelectorAll("th").length || 6;

        function createFillerRow() {
            var tr = document.createElement("tr");
            tr.className = "notify-row notify-row--filler";
            for (var c = 0; c < colsCount; c++) {
                var td = document.createElement("td");
                td.className = "px-4 py-2 border-b border-gray-200";
                td.innerHTML = '<span class="invisible">–</span>';
                tr.appendChild(td);
            }
            return tr;
        }

        for (var k = 0; k < needFill; k++) tbody.appendChild(createFillerRow());
    }

    /* [11A] PAGE-JUMP FIX */
    function bindPageJump() {
        var form = document.getElementById("notify-page-jump-form");
        var input = document.getElementById("notify-page-input");

        if (form && !form.dataset.boundSubmit) {
            form.dataset.boundSubmit = "1";
            form.addEventListener("submit", function (e) {
                if (window.htmx) return;
                e.preventDefault();
                var fd = new FormData(form);
                var qs = new URLSearchParams(fd).toString();
                swapOuterHTML("/admin/notify?" + qs, "#notify-list-region");
            });
        }

        if (input && !input.dataset.boundJump) {
            input.dataset.boundJump = "1";

            function clamp() {
                var min = 1;
                var maxAttr = input.getAttribute("max");
                var container = document.getElementById("admin-notify-container");
                var totalPages = container ? (container.getAttribute("data-total-pages") || "1") : "1";
                var max = intv(maxAttr || totalPages, 1);
                var v = intv(input.value || "1", 1);
                if (v < min) v = min;
                if (v > max) v = max;
                input.value = String(v);
                setDomHidden("state-page", String(v));
                return v;
            }

            input.addEventListener("keydown", function (e) {
                if ((e.key || e.which) === "Enter" || e.keyCode === 13) {
                    e.preventDefault();
                    clamp();
                    if (!form) return;
                    if (window.htmx) {
                        if (form.requestSubmit) form.requestSubmit();
                        else form.submit();
                    } else {
                        var fd = new FormData(form);
                        var qs = new URLSearchParams(fd).toString();
                        swapOuterHTML("/admin/notify?" + qs, "#notify-list-region");
                    }
                }
            });

            input.addEventListener("blur", clamp);
        }
    }

    /* ─────────────────────── [12] Rebind pipeline ─────────────────────── */
    function rebindListOnly() {
        bindRowBtns();
        bindSelection();
        addFillerRowsIfNeeded();
        updatePagerLayout();
        bindPageJump();
        sanitizeHxGetPerPageInDom();
    }
    function rebindAll() {
        bindToolbarCore();
        bindToolbarV2();
        rebindListOnly();
    }

    /* ─────────────────────── [13] Reconcile server vs local ─────────────────────── */
    function anySortToStorage(k) {
        var v = String(k || "").toLowerCase();
        if (v === "created_desc" || v === "created_asc" || v === "az" || v === "za") return v;
        switch (v) {
            case "old": return "created_asc";
            case "az": return "az";
            case "za": return "za";
            case "new":
            default: return "created_desc";
        }
    }
    function reconcileOnce() {
        var container = document.getElementById("admin-notify-container");
        if (!container || container.dataset.reconciled === "1") return;

        var serverSortRaw = container.getAttribute("data-current-sort") || "created_desc";
        var serverSort = anySortToStorage(serverSortRaw);
        var serverView = (container.getAttribute("data-current-view") || "all").toLowerCase();
        if (serverView !== "visible" && serverView !== "hidden") serverView = "all";

        try {
            if (!localStorage.getItem(KEY_SORT)) localStorage.setItem(KEY_SORT, serverSort);
            if (!localStorage.getItem(KEY_VIS)) localStorage.setItem(KEY_VIS, serverView);
        } catch (e) { }

        setDomHidden("state-sort", (localStorage.getItem(KEY_SORT) || serverSort));
        setDomHidden("state-view", (localStorage.getItem(KEY_VIS) || serverView));
        updateSortLabel();

        container.dataset.reconciled = "1";
    }

    /* ─────────────────────── [14] Boot/Hydrate + HTMX hooks ─────────────────────── */
    function hydrateNotifyOnce(root) {
        if (!root) root = document;
        var container = root.querySelector ? root.querySelector("#admin-notify-container") : null;
        if (!container || container.dataset.hydrated === "1") return;
        container.dataset.hydrated = "1";

        try {
            var saved = JSON.parse(localStorage.getItem(KEY_RANGE) || "{}");
            if (saved && saved.from && saved.to) setCalLabel(saved.from, saved.to);
        } catch (e) { }

        applyAutoPerPageIfChanged("boot");

        rebindAll();
        reconcileOnce();

        window.addEventListener("resize", debounceResize);
        window.addEventListener("orientationchange", debounceResize);

        addFillerRowsIfNeeded();
        updatePagerLayout();
        sanitizeHxGetPerPageInDom();

        ensureBulkBarInteractive();   // guard ngay khi boot
        observeBulkInert();           // theo dõi inert tái xuất hiện
    }

    document.addEventListener("DOMContentLoaded", function () { hydrateNotifyOnce(document); });

    document.body.addEventListener("htmx:afterSwap", function (e) {
        var d = e ? e.detail : null; var tgt = d && d.target ? d.target : null;
        if (!tgt) return;
        if (tgt.id === "notify-list-region") {
            applyAutoPerPageIfChanged("afterSwap");
            rebindListOnly();
            try {
                var rowsNow = $$rows().length || 0;
                if (rowsNow === 0) updateBulkBar(0, 0);
            } catch (_) { }

            addFillerRowsIfNeeded();
            updatePagerLayout();
            sanitizeHxGetPerPageInDom();
            ensureBulkBarInteractive();
        }
    });
    function _maybeBindNotify(root) { try { hydrateNotifyOnce(root || document); } catch (e) { } }
    document.body.addEventListener("htmx:load", function (e) { _maybeBindNotify((e && e.target) ? e.target : document); });
    document.body.addEventListener("htmx:afterOnLoad", function (e) { var d = e ? e.detail : null; _maybeBindNotify(d && d.target ? d.target : document); });
    document.body.addEventListener("htmx:afterSettle", function (e) { var d = e ? e.detail : null; _maybeBindNotify(d && d.target ? d.target : document); });

    /* ─────────────────────── [15] Misc sync/events ─────────────────────── */
    function sanitizeHxGetPerPageInDom() {
        $all("[hx-get]").forEach(function (el) {
            try {
                var raw = el.getAttribute("hx-get") || "";
                if (!raw) return;
                var u = new URL(raw, location.origin);
                if (u.searchParams.has("per_page")) {
                    u.searchParams.delete("per_page");
                    el.setAttribute("hx-get", u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : ""));
                }
            } catch (_) { }
        });
    }

    document.body.addEventListener("htmx:configRequest", function (e) {
        try {
            var detail = e && e.detail ? e.detail : {};
            if (!detail) return;
            if (!detail.parameters) detail.parameters = {};
            var tgt = e && e.target ? e.target : null;

            var isListSwap = false;
            if (tgt) {
                var hxTarget = (tgt.getAttribute && tgt.getAttribute("hx-target")) || "";
                if (hxTarget === "#notify-list-region") isListSwap = true;
                if (!isListSwap && (tgt.id === "notify-list-region")) isListSwap = true;
            }
            if (!isListSwap) return;

            var f = (typeof window.__notifyFilterVals === "function") ? window.__notifyFilterVals() : null;
            if (!f) {
                var s = getDomState();
                f = { start_date: s.start, end_date: s.end, v: s.v, sort: s.sort, q: s.q, page: s.page, per_page: s.per_page };
            }

            detail.parameters.page = f.page || 1;
            if (f.per_page && f.per_page > 0) detail.parameters.per_page = f.per_page;

            if (f.v && f.v !== "all") detail.parameters.v = f.v;
            if (f.sort && f.sort !== "created_desc") detail.parameters.sort = f.sort;
            if (f.q) detail.parameters.q = f.q;
            if (f.start_date && f.end_date) {
                detail.parameters.start_date = f.start_date;
                detail.parameters.end_date = f.end_date;
            }

            var path = String(detail.path || detail.url || "");
            if ((/\/admin\/notify\b/).test(path)) {
                try {
                    var u = new URL(path, location.origin);
                    var pageFromUrl = intv(u.searchParams.get("page") || "0", 0);
                    if (pageFromUrl > 0) setDomHidden("state-page", String(pageFromUrl));
                    if (u.searchParams.has("per_page")) {
                        u.searchParams.delete("per_page");
                        detail.path = u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : "");
                    }
                } catch (_) {
                    var m = path.match(/[?&]page=(\d+)/);
                    if (m && m[1]) setDomHidden("state-page", String(intv(m[1], 1)));
                    detail.path = path.replace(/([?&])per_page=\d+&?/g, "$1").replace(/[?&]$/, "");
                }
            }
        } catch (_) { }
    });

    window.addEventListener("admin-notify:date-range-selected", function (e) {
        var detail = e && e.detail ? e.detail : {};
        setCalLabel(detail.from, detail.to);
        setDomHidden("state-start-date", detail.from || "");
        setDomHidden("state-end-date", detail.to || "");
        setDomHidden("state-page", "1");
        try { localStorage.setItem(KEY_RANGE, JSON.stringify(detail)); } catch (err) { }
        loadList();
    });

    function closeBulkDeleteModalIfAny() {
        var ov = document.getElementById("bulk-delete-modal-overlay"); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
        var md = document.getElementById("bulk-delete-modal"); if (md && md.parentNode) md.parentNode.removeChild(md);
    }
    document.addEventListener("submit", function (e) {
        var form = e && e.target ? e.target : null;
        if (!form || form.id !== "bulk-delete-form") return;
        if (window.htmx) return;
        e.preventDefault();
        var postUrl = form.getAttribute("hx-post") || form.action || "/admin/notify/bulk-hide";

        var tokenInput = form.querySelector('input[name="csrf_token"]');
        var csrf = tokenInput ? (tokenInput.value || "") : "";

        var idsEl = document.getElementById("bulk-delete-ids"); var ids = idsEl ? (idsEl.value || "") : "";
        var headers = {};
        if (csrf) { headers["X-CSRF-Token"] = csrf; headers["X-CSRFToken"] = csrf; }

        var f = window.__notifyFilterVals ? window.__notifyFilterVals() : {};
        var body = { ids: ids, csrf_token: csrf, v: f.v, sort: f.sort, q: f.q, start_date: f.start_date, end_date: f.end_date, page: f.page, per_page: f.per_page };

        postForm(postUrl, body, headers, function (err, html) {
            if (err) { console.error(err); if (window.Toast && window.Toast.show) Toast.show("Ẩn thông báo thất bại!", "error", 2200); return; }
            var tmp = document.createElement("div"); tmp.innerHTML = (html || "").trim();
            var next = tmp.querySelector("#notify-list-region");
            var cur = document.querySelector("#notify-list-region");
            if (next && cur && cur.parentNode) {
                cur.parentNode.replaceChild(next, cur);
                var fakeXhr = makeFakeXhr(200, html);
                dispatchHtmxLikeEvent("htmx:afterSwap", { target: next, xhr: fakeXhr });
                dispatchHtmxLikeEvent("htmx:afterOnLoad", { target: next, xhr: makeFakeXhr(200, html) });
                dispatchHtmxLikeEvent("htmx:load", { elt: next });
                dispatchHtmxLikeEvent("htmx:afterSettle", { target: next, xhr: makeFakeXhr(200, html) });
            }
            closeBulkDeleteModalIfAny();
            if (window.Toast && window.Toast.show) Toast.show("Đã ẩn các thông báo đã chọn!", "success", 2500);
        });
    });

    /* ─────────────────────── [9.c] Safety net: bulk buttons delegation (capture) ─────────────────────── */
    function _bulkClickDelegate(e) {
        var node = e.target;
        while (node && node !== document.body) {
            var id = node.id || "";
            if (id === "btn-bulk-delete") {
                e.preventDefault();
                var ids = getSelectedIds();
                if (!ids.length) {
                    if (window.Toast && window.Toast.show) { Toast.show("Hãy chọn ít nhất 1 mục để ẩn.", "warn", 2200); }
                    else { try { alert("Hãy chọn ít nhất 1 mục để ẩn."); } catch (_) { } }
                } else if (getSelectedVisibleCount() === 0) {
                    informAlreadyHiddenAll();
                } else {
                    __killBlockers();
                    openBulkDeleteModalFromSelection();
                }
                return;
            }
            if (id === "btn-bulk-export") {
                e.preventDefault();
                __killBlockers();
                openBulkExportModalFromSelection();
                return;
            }
            node = node.parentNode;
        }
    }
    if (!document.body.__bulkDelegateBound) {
        document.body.__bulkDelegateBound = true;
        document.addEventListener("click", _bulkClickDelegate, true); // capture phase
    }
})(); // IIFE

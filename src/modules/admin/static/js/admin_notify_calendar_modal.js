// file: src/modules/admin/static/js/admin_notify_calender_modal.js
// updated: 2025-08-11 (v2.6)
// note: ES5, event delegation cho click ngày (ổn định qua re-render),
//       disable nút "Chọn ngày" cho đến khi đủ 2 mốc,
//       không dùng htmx.ajax; bắn event + lưu localStorage.
//       Yêu cầu CSS: .calendar-range-*-::before { pointer-events:none; }

(function () {
    function cloneDate(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    function pad2(n) { n = n | 0; return (n < 10 ? '0' + n : '' + n); }
    function fmt(d) { return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }
    function parseISO(s) {
        if (!s) return null;
        var p = s.split('-');
        var y = parseInt(p[0], 10), m = parseInt(p[1], 10), d = parseInt(p[2], 10);
        if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
        return new Date(y, m - 1, d);
    }
    function hasClass(el, cls) {
        var cn = (el && el.className) ? (' ' + el.className + ' ') : ' ';
        return cn.indexOf(' ' + cls + ' ') !== -1;
    }

    // fetch fragment (không dùng htmx)
    function fetchHtml(url) {
        return new Promise(function (resolve, reject) {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                xhr.setRequestHeader('HX-Request', 'true');
                xhr.onreadystatechange = function () {
                    if (xhr.readyState === 4) {
                        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
                        else reject(new Error('HTTP ' + xhr.status));
                    }
                };
                xhr.send();
            } catch (e) { reject(e); }
        });
    }

    // lấy range hiện tại từ toolbar hoặc localStorage
    function getToolbarRange() {
        var btn = document.getElementById('btn-notify-calendar');
        var from = btn ? (btn.getAttribute('data-start') || '') : '';
        var to = btn ? (btn.getAttribute('data-end') || '') : '';
        if (from && to) return { from: from, to: to };
        try {
            var saved = JSON.parse(localStorage.getItem('admin_notify_date_range') || '{}');
            if (saved && saved.from && saved.to) return { from: saved.from, to: saved.to };
        } catch (e) { }
        return null;
    }

    var today = cloneDate(new Date());

    // state
    var st = {
        month: today.getMonth(),
        year: today.getFullYear(),
        start: null,
        end: null,
        picking: 'start'
    };

    function toggleSubmitState() {
        var btn = document.getElementById('calendar-submit-btn');
        if (!btn) return;
        var ok = !!(st.start && st.end && st.end > st.start);
        btn.disabled = !ok;
    }

    function updateHeader() {
        var startEls = document.querySelectorAll('#calendar-start-date');
        var i;
        for (i = 0; i < startEls.length; i++) {
            var elS = startEls[i];
            elS.textContent = st.start ? fmt(st.start) : 'Chưa chọn';
            if (!st.start) { elS.classList.add('text-gray-400'); elS.classList.remove('text-neutral-900'); }
            else { elS.classList.remove('text-gray-400'); elS.classList.add('text-neutral-900'); }
        }

        var endEls = document.querySelectorAll('#calendar-end-date');
        for (i = 0; i < endEls.length; i++) {
            var elE = endEls[i];
            if (st.start && !st.end) {
                elE.textContent = 'Đang chọn…';
                elE.classList.remove('text-gray-400'); elE.classList.add('text-neutral-900');
            } else if (!st.end || (st.start && st.end && st.start.getTime() === st.end.getTime())) {
                elE.textContent = 'Chưa chọn';
                elE.classList.add('text-gray-400'); elE.classList.remove('text-neutral-900');
            } else {
                elE.textContent = fmt(st.end);
                elE.classList.remove('text-gray-400'); elE.classList.add('text-neutral-900');
            }
        }

        var lb = document.getElementById('calendar-current-month');
        if (lb) {
            var spans = lb.querySelectorAll('span');
            if (spans.length) spans[spans.length - 1].textContent = pad2(st.month + 1) + '/' + st.year;
        }

        toggleSubmitState();
    }

    function renderDays() {
        var wrap = document.getElementById('calendar-table-days'); if (!wrap) return;
        wrap.innerHTML = '';

        var y = st.year, m = st.month;
        var first = new Date(y, m, 1);
        var offset = (first.getDay() + 6) % 7; // Monday-first
        var dim = new Date(y, m + 1, 0).getDate();
        var dimPrev = new Date(y, m, 0).getDate();

        var hasFullRange = !!(st.start && st.end && st.start.getTime() !== st.end.getTime());

        var d = 1 - offset;
        for (var r = 0; r < 6; r++) {
            var row = document.createElement('div');
            row.className = 'grid grid-cols-7';
            for (var c = 0; c < 7; c++, d++) {
                var cellWrap = document.createElement('div'); cellWrap.className = 'calendar-day-wrap';
                var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'calendar-day-cell calendar-day-btn';

                var cur, isOutside = false, dayNum;
                if (d < 1) { dayNum = dimPrev + d; cur = new Date(y, m - 1, dayNum); isOutside = true; }
                else if (d > dim) { dayNum = d - dim; cur = new Date(y, m + 1, dayNum); isOutside = true; }
                else { dayNum = d; cur = new Date(y, m, d); }

                btn.textContent = pad2(dayNum);
                // set ISO để delegation đọc
                btn.setAttribute('data-date', cur.getFullYear() + '-' + pad2(cur.getMonth() + 1) + '-' + pad2(cur.getDate()));

                if (isOutside) {
                    btn.classList.add('calendar-day-outside');
                } else {
                    // range fill
                    if (st.start && st.end && st.start.getTime() !== st.end.getTime()) {
                        if (cur > st.start && cur < st.end) cellWrap.classList.add('calendar-range-mid');
                        if (st.start && cur.getTime() === st.start.getTime()) cellWrap.classList.add('calendar-range-start');
                        if (st.end && cur.getTime() === st.end.getTime()) cellWrap.classList.add('calendar-range-end');
                    }
                    // endpoints
                    if (st.start && cur.getTime() === st.start.getTime()) btn.classList.add('bg-blue-900', 'text-white', 'calendar-endpoint');
                    if (st.end && (!st.start || st.start.getTime() !== st.end.getTime()) && cur.getTime() === st.end.getTime()) btn.classList.add('bg-blue-900', 'text-white', 'calendar-endpoint');

                    // highlight "today" chỉ khi chưa đủ range
                    if (cur.getTime() === today.getTime() && !hasFullRange) {
                        btn.classList.add('ring-1', 'ring-blue-700');
                    }
                }

                cellWrap.appendChild(btn);
                row.appendChild(cellWrap);
            }
            wrap.appendChild(row);
        }
    }

    function pickDate(d) {
        if (!st.start || (st.start && st.end && st.start.getTime() !== st.end.getTime())) {
            st.start = cloneDate(d); st.end = null; st.picking = 'end';
        } else if (st.picking === 'end') {
            if (d <= st.start) { st.start = cloneDate(d); st.end = null; }
            else { st.end = cloneDate(d); st.picking = 'start'; }
        }
        st.month = d.getMonth(); st.year = d.getFullYear();
        updateHeader(); renderDays();
    }

    function changeMonth(delta) {
        var m = st.month + delta, y = st.year;
        if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
        st.month = m; st.year = y; updateHeader(); renderDays();
    }

    var escHandler = function (e) { if (e.key === 'Escape') close(); };
    var enterHandler = function (e) {
        if (e.key === 'Enter') {
            var btn = document.getElementById('calendar-submit-btn');
            if (btn && !btn.disabled) btn.click();
        }
    };

    function close() {
        var ov = document.getElementById('admin-notify-calendar-modal-overlay'); if (ov) ov.remove();
        var md = document.getElementById('admin-notify-calendar-modal'); if (md) md.remove();
        document.body.removeEventListener('keydown', escHandler, true);
        document.body.removeEventListener('keydown', enterHandler, true);
    }
    window.closeNotifyCalendarModal = function () { close(); };

    function once(el, ev, fn) {
        if (!el) return;
        if (el.dataset && el.dataset.bound === '1') return;
        if (el.dataset) el.dataset.bound = '1';
        el.addEventListener(ev, fn, false);
    }

    function bindEvents() {
        once(document.getElementById('admin-notify-calendar-modal-overlay'), 'click', function (e) {
            if (e && e.target && e.target.id === 'admin-notify-calendar-modal-overlay') close();
        });
        once(document.getElementById('admin-notify-calendar-modal-close'), 'click', close);
        once(document.getElementById('admin-notify-calendar-modal'), 'click', function (e) {
            if (e && e.target && e.target.id === 'admin-notify-calendar-modal') close();
        });

        // Phím tắt
        document.body.removeEventListener('keydown', escHandler, true);
        document.body.removeEventListener('keydown', enterHandler, true);
        document.body.addEventListener('keydown', escHandler, true);
        document.body.addEventListener('keydown', enterHandler, true);

        once(document.getElementById('calendar-month-prev'), 'click', function () { changeMonth(-1); });
        once(document.getElementById('calendar-month-next'), 'click', function () { changeMonth(1); });

        // Delegation: click ngày
        var days = document.getElementById('calendar-table-days');
        if (days && days.dataset.boundClick !== '1') {
            days.dataset.boundClick = '1';
            days.addEventListener('click', function (e) {
                var t = e.target;
                // leo lên tới button .calendar-day-btn
                while (t && t !== days && !(t.className && (' ' + t.className + ' ').indexOf(' calendar-day-btn ') !== -1)) {
                    t = t.parentNode;
                }
                if (!t || t === days) return;
                if (hasClass(t, 'calendar-day-outside')) return;
                var iso = t.getAttribute('data-date'); if (!iso) return;
                var d = parseISO(iso); if (!d) return;
                pickDate(d);
            }, false);
        }

        // Quick range
        var quicks = document.querySelectorAll('.calendar-quick-btn');
        for (var i = 0; i < quicks.length; i++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    var n = parseInt(btn.getAttribute('data-range'), 10) || 7;
                    var end = cloneDate(today);
                    var start = cloneDate(today); start.setDate(today.getDate() - n + 1);
                    st.start = start; st.end = end; st.picking = 'start';
                    st.month = start.getMonth(); st.year = start.getFullYear();
                    updateHeader(); renderDays();
                }, false);
            })(quicks[i]);
        }

        // Submit
        once(document.getElementById('calendar-submit-btn'), 'click', function () {
            if (!(st.start && st.end && st.end > st.start)) return; // an toàn
            if (typeof window.onNotifyDateRangeSelected === 'function') {
                window.onNotifyDateRangeSelected(st.start, st.end);
            }
            close();
        });
    }

    function syncStateFromDataset() {
        var host = document.getElementById('admin-notify-calendar-modal');
        var ds = (host && host.dataset) ? host.dataset : {};
        var s = parseISO(ds.start || '');
        var e = parseISO(ds.end || '');

        if (s) {
            st.start = cloneDate(s);
            st.month = s.getMonth();
            st.year = s.getFullYear();
        } else {
            st.start = null;
            st.month = today.getMonth();
            st.year = today.getFullYear();
        }

        // FIX CHÍNH: chỉ nhận end khi > start; end == start coi như chưa có end
        st.end = (e && s && e > s) ? cloneDate(e) : null;
        st.picking = (st.start && !st.end) ? 'end' : 'start';
    }

    var init = function () {
        syncStateFromDataset();
        updateHeader();
        renderDays();
        bindEvents();
        toggleSubmitState(); // đảm bảo trạng thái ban đầu của nút
    };

    // API mở modal (prefill từ toolbar/localStorage)
    window.openNotifyCalendarModal = function () {
        var modal = document.getElementById('admin-notify-calendar-modal');
        var range = getToolbarRange();

        if (!modal) {
            var root = document.getElementById('admin-notify-modal-root') || document.getElementById('modal-root');
            if (!root) return;
            fetchHtml('/admin/notify/calendar-modal')
                .then(function (html) {
                    root.innerHTML = html;
                    var mEl = document.getElementById('admin-notify-calendar-modal');
                    if (mEl) {
                        if (range) {
                            mEl.setAttribute('data-start', range.from);
                            mEl.setAttribute('data-end', range.to);
                        } else {
                            // Tránh case end==start mặc định gây hiểu sai 'picking'
                            mEl.setAttribute('data-end', '');
                        }
                    }
                    init();
                    var btn = document.getElementById('admin-notify-calendar-modal-close');
                    if (btn) setTimeout(function () { try { btn.focus(); } catch (e) { } }, 60);
                })
                .catch(function (err) { console.error('openNotifyCalendarModal error:', err); });
            return;
        }

        if (range) {
            modal.setAttribute('data-start', range.from);
            modal.setAttribute('data-end', range.to);
        } else {
            modal.setAttribute('data-end', '');
        }
        modal.style.display = 'flex';
        var ov = document.getElementById('admin-notify-calendar-modal-overlay'); if (ov) ov.style.display = '';
        var btn = document.getElementById('admin-notify-calendar-modal-close'); if (btn) setTimeout(function () { try { btn.focus(); } catch (e) { } }, 60);
        init();
    };

    // Compat HTMX
    document.body.addEventListener('htmx:afterOnLoad', function (e) {
        var t = e && e.detail ? e.detail.target : null;
        var id = t && t.id ? t.id : '';
        if (id === 'admin-notify-modal-root' || id === 'admin-notify-calendar-modal') init();
    });

    if (document.getElementById('admin-notify-calendar-modal')) init();

    // bắn event + lưu state; không gọi ajax ở đây
    window.onNotifyDateRangeSelected = function (s, e) {
        if (!s || !e || e < s) return;
        function iso(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
        var from = iso(s), to = iso(e);
        try { localStorage.setItem('admin_notify_date_range', JSON.stringify({ from: from, to: to })); } catch (err) { }
        window.dispatchEvent(new CustomEvent('admin-notify:date-range-selected', { detail: { from: from, to: to } }));
    };
})();

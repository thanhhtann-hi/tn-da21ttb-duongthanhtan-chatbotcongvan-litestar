// file: src/modules/admin/static/js/tt_portal.js
// updated: 2025-08-11 (v1.1)
// note: Floating tooltip (portal) gắn vào <body>; MẶC ĐỊNH hiển thị DƯỚI,
//       tự đảo TOP khi hết chỗ; clamp theo viewport; ES5-safe.

(function () {
    'use strict';

    var tip, MARGIN = 8, GAP = 10;

    function el() {
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'tt-floating';
            document.body.appendChild(tip);
        }
        return tip;
    }

    function show(node, text) {
        if (!node || !text) return;
        var t = el();
        t.textContent = text;

        // reset để đo kích thước thật
        t.style.left = '0px';
        t.style.top = '0px';
        t.classList.add('tt-show');

        var rect = node.getBoundingClientRect();
        var vw = window.innerWidth || document.documentElement.clientWidth;
        var vh = window.innerHeight || document.documentElement.clientHeight;

        var w = t.offsetWidth, h = t.offsetHeight;
        var spaceBelow = vh - rect.bottom;
        var spaceAbove = rect.top;
        var need = h + GAP + 2;

        // Ưu tiên BÊN DƯỚI; nếu không đủ chỗ thì mới lật lên trên
        var placeBelow = (spaceBelow >= need) || (spaceBelow >= spaceAbove);

        var top = placeBelow ? (rect.bottom + GAP) : (rect.top - h - GAP);
        var left = rect.left + rect.width / 2 - w / 2;

        // Clamp vào viewport
        if (left < MARGIN) left = MARGIN;
        if (left + w > vw - MARGIN) left = vw - MARGIN - w;
        if (top < MARGIN) top = MARGIN;
        if (top + h > vh - MARGIN) top = vh - MARGIN - h;

        t.style.left = Math.round(left) + 'px';
        t.style.top = Math.round(top) + 'px';
    }

    function hide() {
        var t = el();
        t.classList.remove('tt-show');
    }

    function closestTt(target) {
        // tìm phần tử có .tt hoặc [data-tt]
        while (target && target.nodeType === 1) {
            if ((target.classList && target.classList.contains('tt')) || target.hasAttribute('data-tt')) return target;
            target = target.parentNode;
        }
        return null;
    }

    function getText(target) {
        var node = closestTt(target);
        if (!node) return { node: null, text: '' };
        var text = node.getAttribute('data-tt') || node.getAttribute('aria-label') || node.getAttribute('title') || '';
        // chặn tooltip mặc định của trình duyệt
        if (node.hasAttribute && node.hasAttribute('title')) {
            node.dataset.ttKeepTitle = node.getAttribute('title');
            node.removeAttribute('title');
        }
        return { node: node, text: text };
    }

    // Delegation: enter/move/leave
    document.addEventListener('mouseenter', function (e) {
        var info = getText(e.target || e.srcElement);
        if (!info.node || !info.text) return;
        show(info.node, info.text);
    }, true);

    document.addEventListener('mousemove', function (e) {
        var info = getText(e.target || e.srcElement);
        if (!info.node || !info.text) return;
        // cập nhật vị trí khi di chuyển trên cùng trigger
        show(info.node, info.text);
    }, true);

    document.addEventListener('mouseleave', function (e) {
        var t = e.target || e.srcElement;
        hide();
        if (t && t.dataset && t.dataset.ttKeepTitle) {
            t.setAttribute('title', t.dataset.ttKeepTitle);
            delete t.dataset.ttKeepTitle;
        }
    }, true);

    // Expose cho debug nếu cần
    window.TTFloating = { show: show, hide: hide };
})();

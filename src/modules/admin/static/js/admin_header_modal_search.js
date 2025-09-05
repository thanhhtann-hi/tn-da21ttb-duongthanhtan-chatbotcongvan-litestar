/********************************************************************
 * file: src/modules/admin/static/js/admin_header_modal_search.js
 * updated: 2025-08-03
 * note: đồng bộ logic chống scroll với modal logout; kết hợp class
 *       'modal-open' trên <body> và <html> để triệt tiêu scroll,
 *       lock overflow trên vùng #admin-frame, chỉ remove sau
 *       animate-out, và reset state khi reload/SPA
 ********************************************************************/

document.addEventListener("DOMContentLoaded", () => {
    /* ELEMENTS --------------------------------------------------- */
    const btnSearch = document.getElementById("admin-header-btn-search");
    const modalWrap = document.getElementById("admin-search-modal");
    const overlay = document.getElementById("admin-search-modal-overlay");
    const btnClose = document.getElementById("admin-search-modal-close");
    const input = modalWrap?.querySelector("input");
    // vùng cuộn chính của layout
    const frameEl = document.getElementById("admin-frame");

    /* CONFIG ----------------------------------------------------- */
    const DURATION = 80; // ms – khớp 'duration-75' bên HTML
    // lưu giá trị overflowY ban đầu để restore
    const prevFrameOverflowY = frameEl
        ? window.getComputedStyle(frameEl).overflowY
        : "";

    /* INITIAL RESET ---------------------------------------------- */
    // đảm bảo ở trạng thái closed sạch sẽ khi load/reload
    if (modalWrap && overlay) {
        modalWrap.classList.remove("flex");
        modalWrap.classList.add("hidden");
        overlay.dataset.state = modalWrap.dataset.state = "closed";
    }
    document.body.classList.remove("overflow-hidden", "modal-open");
    document.documentElement.classList.remove("modal-open");
    if (frameEl) {
        frameEl.style.overflowY = prevFrameOverflowY;
    }

    /* ACTIONS ---------------------------------------------------- */
    const show = () => {
        // Hiện modal
        modalWrap.classList.remove("hidden");
        modalWrap.classList.add("flex");
        overlay.dataset.state = modalWrap.dataset.state = "open";
        setTimeout(() => input?.focus(), 40);

        // khóa scroll toàn cục
        document.body.classList.add("overflow-hidden", "modal-open");
        document.documentElement.classList.add("modal-open");
        // khóa scroll vùng nội dung chính
        if (frameEl) {
            frameEl.style.overflowY = "hidden";
        }
    };

    const hide = () => {
        // bắt đầu animate-out
        overlay.dataset.state = modalWrap.dataset.state = "closed";
        setTimeout(() => {
            // ẩn modal
            modalWrap.classList.remove("flex");
            modalWrap.classList.add("hidden");
            // giải khóa toàn cục
            document.body.classList.remove("overflow-hidden", "modal-open");
            document.documentElement.classList.remove("modal-open");
            // giải khóa vùng nội dung chính
            if (frameEl) {
                frameEl.style.overflowY = prevFrameOverflowY;
            }
        }, DURATION);
    };

    /* EVENT BINDING ---------------------------------------------- */
    btnSearch?.addEventListener("click", show);
    btnClose?.addEventListener("click", hide);
    overlay?.addEventListener("click", hide);
    modalWrap?.addEventListener("click", (e) => {
        if (e.target === modalWrap) hide();
    });
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modalWrap.dataset.state === "open") {
            hide();
        }
    });

    /* RESET ON PAGE SHOW (back navigation, SPA) ------------------ */
    window.addEventListener("pageshow", () => {
        if (modalWrap && overlay) {
            modalWrap.classList.remove("flex");
            modalWrap.classList.add("hidden");
            overlay.dataset.state = modalWrap.dataset.state = "closed";
        }
        document.body.classList.remove("overflow-hidden", "modal-open");
        document.documentElement.classList.remove("modal-open");
        if (frameEl) {
            frameEl.style.overflowY = prevFrameOverflowY;
        }
    });
});

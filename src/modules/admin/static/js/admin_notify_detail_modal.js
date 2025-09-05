/********************************************************************
 * 1. Đường dẫn file : src/modules/admin/static/js/admin_notify_detail_modal.js
 * 2. Thời gian tạo   : 2025-07-26 19:15
 * 3. Lý do           : Modal xem chi tiết thông báo – đồng bộ UX với modal tạo mới, close chuẩn mọi tình huống.
 ********************************************************************/

/* Đóng modal chi tiết */
function closeNotifyDetailModal() {
    document.getElementById('notify-detail-modal-overlay')?.remove();
    document.getElementById('notify-detail-modal')?.remove();
}

/* Bind nút đóng, overlay, ESC và click ra ngoài modal */
function bindNotifyDetailModalClose() {
    // Handler click
    document.body.addEventListener('click', function (e) {
        // 1. Click overlay (vùng tối)
        if (e.target.id === 'notify-detail-modal-overlay') {
            closeNotifyDetailModal();
        }
        // 2. Click nút X hoặc nút đóng
        if (
            e.target.id === 'notify-detail-modal-close' ||
            e.target.id === 'notify-detail-modal-close-btn' ||
            (e.target.closest && (
                e.target.closest('#notify-detail-modal-close') ||
                e.target.closest('#notify-detail-modal-close-btn')
            ))
        ) {
            closeNotifyDetailModal();
        }
        // 3. Click ra ngoài modal (wrapper)
        if (
            e.target.id === 'notify-detail-modal' &&
            !e.target.querySelector('.duration-75:hover')
        ) {
            closeNotifyDetailModal();
        }
    });

    // Đóng qua phím ESC
    document.body.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && document.getElementById('notify-detail-modal')) {
            closeNotifyDetailModal();
        }
    });
}

/* Focus modal khi mở (accessibility) */
function focusNotifyDetailModal() {
    setTimeout(() => {
        const modal = document.getElementById('notify-detail-modal');
        if (modal) modal.focus();
    }, 60);
}

/* Sau khi modal được load động, bind lại các sự kiện */
function rebindAdminNotifyDetailModalEvents() {
    focusNotifyDetailModal();
}

/* Gắn các handler này 1 lần duy nhất khi SPA load */
bindNotifyDetailModalClose();

/* Gắn lại logic sau khi modal fragment được HTMX nạp */
document.body.addEventListener('htmx:afterOnLoad', evt => {
    const tid = evt.detail?.target?.id || '';
    if (tid === 'admin-notify-modal-root' || tid === 'notify-detail-modal') {
        rebindAdminNotifyDetailModalEvents();
    }
});

/* Nếu modal mở lần đầu (không qua HTMX), tự bind luôn */
if (document.getElementById('notify-detail-modal')) {
    rebindAdminNotifyDetailModalEvents();
}


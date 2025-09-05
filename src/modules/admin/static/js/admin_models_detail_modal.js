/********************************************************************
 * File  : src/modules/admin/static/js/admin_models_detail_modal.js
 * Updated: 2025-08-22 (v1.0 – ES5-safe)
 * Note  : Modal chi tiết mô hình – chỉ đóng/mở. Tự bind khi nạp HTMX
 *         hoặc khi có sẵn trong DOM.
 ********************************************************************/

/* Đóng modal chi tiết */
function closeModelsDetailModal() {
    var ov = document.getElementById('models-detail-modal-overlay'); if (ov && ov.remove) ov.remove();
    var md = document.getElementById('models-detail-modal'); if (md && md.remove) md.remove();
}

/* Bind nút đóng, overlay, ESC và click ra ngoài modal */
function bindModelsDetailModalClose() {
    document.body.addEventListener('click', function (e) {
        if (!e || !e.target) return;

        // 1) Click overlay
        if (e.target.id === 'models-detail-modal-overlay') { closeModelsDetailModal(); return; }

        // 2) Click nút X hoặc nút Đóng
        if (e.target.id === 'models-detail-modal-close' ||
            e.target.id === 'models-detail-modal-close-btn' ||
            (e.target.closest && (e.target.closest('#models-detail-modal-close') ||
                e.target.closest('#models-detail-modal-close-btn')))) {
            closeModelsDetailModal(); return;
        }

        // 3) Click ra ngoài modal wrapper
        if (e.target.id === 'models-detail-modal') { closeModelsDetailModal(); return; }
    });

    // ESC
    document.body.addEventListener('keydown', function (e) {
        if ((e.key === 'Escape' || e.keyCode === 27) && document.getElementById('models-detail-modal')) {
            closeModelsDetailModal();
        }
    });
}

/* Focus modal khi mở (accessibility) */
function focusModelsDetailModal() {
    setTimeout(function () {
        var modal = document.getElementById('models-detail-modal');
        if (modal && modal.focus) { try { modal.focus(); } catch (e) { } }
    }, 60);
}

/* Sau khi modal được HTMX nạp, bind lại */
function rebindAdminModelsDetailModalEvents() {
    focusModelsDetailModal();
}

/* One-time global binds */
bindModelsDetailModalClose();

/* HTMX: modal vừa nạp -> bind */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {};
    var tgt = d.target ? d.target : null;
    var tid = tgt && tgt.id ? tgt.id : '';
    if (tid === 'admin-models-modal-root' || tid === 'models-detail-modal') {
        rebindAdminModelsDetailModalEvents();
    }
});

/* Nếu modal đã có sẵn -> bind ngay */
if (document.getElementById('models-detail-modal')) {
    rebindAdminModelsDetailModalEvents();
}

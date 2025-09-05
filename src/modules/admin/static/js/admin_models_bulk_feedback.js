/* file: src/modules/admin/static/js/admin_models_bulk_feedback.js
   updated: 2025-08-23
   note: Lắng nghe sự kiện htmx "models-bulk-result" (từ header HX-Trigger)
         và hiển thị modal kết quả có ngữ cảnh cho bulk Enable/Disable.
*/

(function () {
    "use strict";

    function _el(html) {
        var d = document.createElement("div");
        d.innerHTML = html.trim();
        return d.firstChild;
    }

    function closeInfoModal() {
        var ov = document.getElementById("models-info-modal-overlay");
        if (ov && ov.remove) ov.remove();
        var md = document.getElementById("models-info-modal");
        if (md && md.remove) md.remove();
    }

    function showInfoModal(detail) {
        closeInfoModal();
        detail = detail || {};

        var action = detail.action || "";
        var title = "Kết quả thao tác";
        var lines = [];

        if (action === "disable") {
            if ((detail.affected || 0) > 0 && (detail.already_disabled || 0) > 0) {
                title = "Đã tắt một phần";
                lines.push("Đã tắt <b>" + detail.affected + "</b> mô hình.");
                lines.push("Bỏ qua <b>" + detail.already_disabled + "</b> mô hình vì đã tắt sẵn.");
            } else if ((detail.affected || 0) > 0) {
                title = "Đã tắt enabled";
                lines.push("Đã tắt <b>" + detail.affected + "</b> mô hình.");
            } else {
                title = "Không có gì thay đổi";
                lines.push("Tất cả các mục đã bị tắt sẵn.");
            }
        } else if (action === "enable") {
            var retired = detail.retired_blocked || 0;
            var already = detail.already_enabled || 0;

            if ((detail.affected || 0) > 0 && retired > 0) {
                title = "Đã bật một phần";
                lines.push("Đã bật <b>" + detail.affected + "</b> mô hình.");
                lines.push("Không thể bật <b>" + retired + "</b> mô hình do trạng thái <b>retired</b>.");
            } else if (retired > 0 && (detail.affected || 0) === 0) {
                title = "Không thể bật enabled";
                lines.push("Tất cả các mục được chọn đang ở trạng thái <b>retired</b>.");
            } else if ((detail.affected || 0) > 0 && already > 0) {
                title = "Đã bật enabled";
                lines.push("Đã bật <b>" + detail.affected + "</b> mô hình.");
                lines.push("Bỏ qua <b>" + already + "</b> mô hình vì đã bật sẵn.");
            } else if ((detail.affected || 0) > 0) {
                title = "Đã bật enabled";
                lines.push("Đã bật <b>" + detail.affected + "</b> mô hình.");
            } else {
                title = "Không có gì thay đổi";
                lines.push("Tất cả các mục đã bật sẵn.");
            }

            if (retired > 0) {
                lines.push(
                    '<span class="text-rose-700">' +
                    (detail.hint ||
                        "Vui lòng chuyển Trạng thái sang Active/Preview trước khi bật Enabled.") +
                    "</span>"
                );
                if (detail.retired_names && detail.retired_names.length) {
                    lines.push(
                        '<span class="text-xs text-gray-500">Ví dụ: ' +
                        detail.retired_names.join(", ") +
                        (retired > detail.retired_names.length ? "…" : "") +
                        "</span>"
                    );
                }
            }
        } else {
            if (detail.msg) lines.push(String(detail.msg));
        }

        var X_SVG =
            "<svg width='10' height='10' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>" +
            "<path d='M6 6l12 12M18 6L6 18' stroke='#1f2937' stroke-width='2' stroke-linecap='round'/></svg>";

        var overlay = _el(
            '<div id="models-info-modal-overlay" class="fixed inset-0 z-[9998] bg-black/70 backdrop-blur-[2px]"></div>'
        );
        var modal = _el(
            '<div id="models-info-modal" class="fixed inset-0 z-[9999] flex items-center justify-center" role="dialog" aria-modal="true" tabindex="-1">' +
            '<div class="duration-75 w-full max-w-[98vw] sm:max-w-[520px] max-h-[80vh] rounded-[28px] border border-gray-200 bg-white shadow-modal px-0 py-0 flex flex-col overflow-hidden font-manrope animate-in zoom-in-95">' +
            '<div class="relative flex items-center justify-center min-h-[56px] px-6 py-4">' +
            '<h3 class="text-base sm:text-lg font-semibold text-gray-900 text-center w-full">' +
            title +
            "</h3>" +
            '<button type="button" id="models-info-modal-close" class="absolute right-6 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full ring-1 ring-gray-300 bg-white shadow hover:bg-blue-50 hover:ring-blue-900 transition-all focus:outline-none">' +
            '<span class="block w-4 h-4 m-auto">' + X_SVG + "</span>" +
            "</button>" +
            "</div>" +
            '<hr class="border-t border-gray-200 m-0" />' +
            '<div class="overflow-y-auto px-6 py-4 text-[14px] text-gray-800">' +
            lines.map(function (l) { return '<div class="mt-1 leading-relaxed">' + l + "</div>"; }).join("") +
            "</div>" +
            '<div class="px-6 py-3 border-t border-gray-100 bg-white flex justify-center gap-3">' +
            (action === "enable" && (detail.retired_blocked || 0) > 0
                ? '<a href="/admin/models?status=retired" class="w-[140px] text-center rounded-full py-2.5 bg-blue-900 text-white font-medium hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-300 text-[14px]">Lọc retired</a>'
                : "") +
            '<button type="button" class="w-[120px] rounded-full py-2.5 bg-gray-200 text-gray-700 font-medium hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-300 text-[14px]" id="models-info-modal-ok">Đóng</button>' +
            "</div>" +
            "</div>" +
            "</div>"
        );

        document.body.appendChild(overlay);
        document.body.appendChild(modal);

        function _close() { closeInfoModal(); }
        overlay.addEventListener("click", _close);
        modal.addEventListener("click", function (e) {
            if (!e) return;
            var t = e.target;
            if (t && (t.id === "models-info-modal-close" || t.id === "models-info-modal-ok")) _close();
            if (t && t.closest && t.closest("#models-info-modal-close")) _close();
        });
        document.addEventListener("keydown", function esc(e) {
            if (e && (e.key === "Escape" || e.keyCode === 27)) { _close(); document.removeEventListener("keydown", esc); }
        });
    }

    // Lắng nghe sự kiện (bubble) do server gửi qua header HX-Trigger
    document.body.addEventListener("models-bulk-result", function (evt) {
        var detail = (evt && evt.detail) || {};
        showInfoModal(detail);
    });
})();

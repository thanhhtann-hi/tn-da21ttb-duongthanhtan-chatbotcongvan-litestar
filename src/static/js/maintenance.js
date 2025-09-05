// 📄 src/static/js/maintenance.js
// 🕒 Last updated: 2025-07-08 00:40
// =============================================================================
// Giới hạn reload tối đa 2 lần khi bật/tắt bảo trì
// =============================================================================
(() => {
    const CHECK_INTERVAL = 15_000; // 15s
    const STORAGE_KEY = 'maintenanceReloadCount';
    const MAX_RELOADS = 2;

    let lastStatus = null;
    let reloadCount = parseInt(sessionStorage.getItem(STORAGE_KEY) || '0', 10);

    async function checkMaintenanceStatus() {
        try {
            const resp = await fetch(window.location.href, { method: 'GET', cache: 'no-store' });
            const status = resp.status;

            if (lastStatus === null) {
                lastStatus = status;
            } else if (status !== lastStatus) {
                if (reloadCount < MAX_RELOADS) {
                    reloadCount++;
                    sessionStorage.setItem(STORAGE_KEY, reloadCount);
                    window.location.reload();
                } else {
                    clearInterval(intervalId);
                }
            }
        } catch (err) {
            console.error('Error checking maintenance status:', err);
        }
    }

    checkMaintenanceStatus();
    const intervalId = setInterval(checkMaintenanceStatus, CHECK_INTERVAL);
})();

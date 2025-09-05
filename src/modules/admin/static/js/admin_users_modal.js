/* file: src/modules/admin/static/js/admin_users_modal.js
 * updated: 2025-08-24 (v2.0 – reverify flag; ES5-safe; keep filters; unique-email; UX polish)
 * note:
 *  - Không auto-focus input.
 *  - OAuth account: email readonly, ẩn password, provider immutable, verified disabled.
 *  - Local account: thay đổi nhạy cảm (email/username/display/mật khẩu) → ép re-verify sau khi lưu.
 *  - Check trùng email (client) qua API /admin/users/check_email_unique.
 */
var EMAIL_UNIQUE_API = '/admin/users/check_email_unique'; // GET ?email=&exclude_id=

/* ========= Close helpers ========= */
function __closeUsersModalById(id) { var el = document.getElementById(id); if (el && el.remove) el.remove(); }
function closeUsersCreateModal() { __closeUsersModalById('users-new-modal-overlay'); __closeUsersModalById('users-new-modal'); }
function closeUsersEditModal() { __closeUsersModalById('users-edit-modal-overlay'); __closeUsersModalById('users-edit-modal'); }
function closeUsersDetailModal() { __closeUsersModalById('users-detail-modal-overlay'); __closeUsersModalById('users-detail-modal'); }
function closeUsersDeleteModal() { __closeUsersModalById('users-delete-modal-overlay'); __closeUsersModalById('users-delete-modal'); }

/* ========= Bind close events ========= */
function bindUsersModalClose() {
    document.body.addEventListener('click', function (e) {
        if (!e || !e.target) return;
        // NEW
        if (e.target.id === 'users-new-modal-overlay') { closeUsersCreateModal(); return; }
        if (e.target.id === 'users-new-modal-close') { closeUsersCreateModal(); return; }
        if (e.target.closest) { var x = e.target.closest('#users-new-modal-close'); if (x) { closeUsersCreateModal(); return; } }
        if (e.target.id === 'users-new-modal') { closeUsersCreateModal(); return; }
        if (e.target.id === 'users-cancel-btn') { closeUsersCreateModal(); return; }
        // EDIT
        if (e.target.id === 'users-edit-modal-overlay') { closeUsersEditModal(); return; }
        if (e.target.id === 'users-edit-modal-close' || e.target.id === 'users-edit-cancel-btn') { closeUsersEditModal(); return; }
        if (e.target.closest) { var y = e.target.closest('#users-edit-modal-close'); if (y) { closeUsersEditModal(); return; } }
        if (e.target.id === 'users-edit-modal') { closeUsersEditModal(); return; }
        // DETAIL
        if (e.target.id === 'users-detail-modal-overlay') { closeUsersDetailModal(); return; }
        if (e.target.id === 'users-detail-modal-close' || e.target.id === 'users-detail-modal-close-btn') { closeUsersDetailModal(); return; }
        if (e.target.closest) { var z = e.target.closest('#users-detail-modal-close') || e.target.closest('#users-detail-modal-close-btn'); if (z) { closeUsersDetailModal(); return; } }
        if (e.target.id === 'users-detail-modal') { closeUsersDetailModal(); return; }
        // DELETE
        if (e.target.id === 'users-delete-modal-overlay') { closeUsersDeleteModal(); return; }
        if (e.target.id === 'users-delete-modal-close' || e.target.id === 'users-delete-modal-cancel') { closeUsersDeleteModal(); return; }
        if (e.target.closest) { var d = e.target.closest('#users-delete-modal-close') || e.target.closest('#users-delete-modal-cancel'); if (d) { closeUsersDeleteModal(); return; } }
        if (e.target.id === 'users-delete-modal') { closeUsersDeleteModal(); return; }
    });
    document.body.addEventListener('keydown', function (e) {
        if ((e.key === 'Escape' || e.keyCode === 27) && (document.getElementById('users-new-modal') || document.getElementById('users-edit-modal') || document.getElementById('users-detail-modal') || document.getElementById('users-delete-modal'))) {
            closeUsersCreateModal(); closeUsersEditModal(); closeUsersDetailModal(); closeUsersDeleteModal();
        }
    });
}
bindUsersModalClose();

/* ========= Focus (only modal wrapper for DETAIL) ========= */
function focusUsersDetailModal() { setTimeout(function () { var md = document.getElementById('users-detail-modal'); if (md && md.focus) { try { md.focus(); } catch (_) { } } }, 60); }

/* ========= Small utils ========= */
function _u_toInt(x, d) { var n = parseInt(x, 10); return isNaN(n) ? d : n; }
function _u_upsertHidden(form, name, value) { var el = form.querySelector('input[name="' + name + '"]'); if (value == null || value === '') { if (el && el.remove) el.remove(); return; } if (!el) { el = document.createElement('input'); el.type = 'hidden'; el.name = name; form.appendChild(el); } el.value = String(value); }
function _u_mergeQs(base, qs) { if (!qs) return base; var hasQ = (base || '').indexOf('?') >= 0; var payload = (qs.charAt(0) === '?') ? qs.substring(1) : qs; return base + (hasQ ? '&' : '?') + payload; }
function _u_formVal(name, fallback) { var sf = document.getElementById('users-search-form'); if (sf) { var el = sf.querySelector('input[name="' + name + '"]'); if (el && el.value != null && String(el.value).trim() !== '') return String(el.value).trim(); } return fallback; }

/* ========= Current filters ========= */
function _getCurrentUserFilters() {
    var c = document.getElementById('admin-users-container') || {}; var ds = c.dataset || {};
    var searchForm = document.getElementById('users-search-form') || null;
    var sortInput = searchForm ? searchForm.querySelector('input[name="sort"]') : null;
    var qInput = document.getElementById('users-search-input');
    var dsStatus = ds.status || 'all', dsRole = ds.role || 'all', dsVerified = ds.verified || 'all', dsProvider = ds.provider || '';
    var dsSort = (sortInput ? (sortInput.value || '') : (ds.currentSort || 'created_desc'));
    var dsPage = _u_toInt(ds.page || '1', 1), dsPerPage = _u_toInt(ds.perPage || ds.perpage || '10', 10), dsQ = ds.q || '';
    var status = _u_formVal('status', dsStatus), role = _u_formVal('role', dsRole), verified = _u_formVal('verified', dsVerified), provider = _u_formVal('provider', dsProvider), sort = _u_formVal('sort', dsSort);
    var page = _u_toInt(_u_formVal('page', dsPage), dsPage), perPage = _u_toInt(_u_formVal('per_page', dsPerPage), dsPerPage);
    var q = qInput ? (qInput.value || '') : _u_formVal('q', dsQ);
    return { status: status || 'all', role: role || 'all', verified: verified || 'all', provider: (provider == null ? '' : provider), q: q || '', sort: sort || 'created_desc', page: page, per_page: perPage };
}
function _usersFilterQS() {
    var f = _getCurrentUserFilters(); var parts = [];
    if (f.status && f.status !== 'all') parts.push('status=' + encodeURIComponent(f.status));
    if (f.role && f.role !== 'all') parts.push('role=' + encodeURIComponent(f.role));
    if (f.verified && f.verified !== 'all') parts.push('verified=' + encodeURIComponent(f.verified));
    if (f.provider) parts.push('provider=' + encodeURIComponent(f.provider));
    if (f.q) parts.push('q=' + encodeURIComponent(f.q));
    if (f.sort && f.sort !== 'created_desc') parts.push('sort=' + encodeURIComponent(f.sort));
    if (f.page > 1) parts.push('page=' + encodeURIComponent(f.page));
    if (f.per_page && f.per_page !== 10) parts.push('per_page=' + encodeURIComponent(f.per_page));
    return parts.length ? ('?' + parts.join('&')) : '';
}

/* ========= Create: keep filters ========= */
function ensureUsersFormKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;
    form.addEventListener('submit', function (e) {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        var btn = document.getElementById('users-submit-btn'); if (btn) btn.disabled = true;
        var f = _getCurrentUserFilters();
        ['status', 'role', 'verified', 'provider', 'q', 'sort'].forEach(function (k) { _u_upsertHidden(form, k, f[k]); });
        _u_upsertHidden(form, 'page', (f.page > 0 ? f.page : '')); _u_upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));
        var base = form.getAttribute('hx-post') || form.action || '/admin/users'; var qs = _usersFilterQS();
        if (qs) {
            try {
                var u = new URL(base, window.location.origin), p = u.searchParams;['status', 'role', 'verified', 'provider', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.status && f.status !== 'all') p.set('status', f.status); if (f.role && f.role !== 'all') p.set('role', f.role);
                if (f.verified && f.verified !== 'all') p.set('verified', f.verified); if (f.provider) p.set('provider', f.provider);
                if (f.q) p.set('q', f.q); if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 1) p.set('page', String(f.page)); if (f.per_page && f.per_page !== 10) p.set('per_page', String(f.per_page));
                u.search = p.toString(); form.setAttribute('hx-post', u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (_) { form.setAttribute('hx-post', _u_mergeQs(base, qs)); }
        }
        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#users-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#users-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentUserFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.status && f.status !== 'all') e.detail.parameters.status = f.status;
            if (f.role && f.role !== 'all') e.detail.parameters.role = f.role;
            if (f.verified && f.verified !== 'all') e.detail.parameters.verified = f.verified;
            if (f.provider) e.detail.parameters.provider = f.provider;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            var qs = _usersFilterQS(); if (qs) e.detail.path = _u_mergeQs(e.detail.path || '', qs);
        } catch (_) { }
    });

    form.dataset.filterBound = '1';
}

/* ========= EDIT: keep filters + change detection + provider locks + email rules ========= */
function ensureUsersEditFormKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;

    form.addEventListener('submit', function (e) {
        if (form.dataset._submitting === '1') return;
        if (form.dataset.emailUnique === '0') { if (e && e.preventDefault) e.preventDefault(); return; }
        form.dataset._submitting = '1';
        var btn = document.getElementById('users-edit-submit-btn'); if (btn) btn.disabled = true;

        var f = _getCurrentUserFilters();
        ['status', 'role', 'verified', 'provider', 'q', 'sort'].forEach(function (k) { _u_upsertHidden(form, k, f[k]); });
        _u_upsertHidden(form, 'page', (f.page > 0 ? f.page : '')); _u_upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));

        var base = form.getAttribute('hx-put') || form.action || '/admin/users'; var qs = _usersFilterQS();
        if (qs) {
            try {
                var u = new URL(base, window.location.origin), p = u.searchParams;['status', 'role', 'verified', 'provider', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.status && f.status !== 'all') p.set('status', f.status); if (f.role && f.role !== 'all') p.set('role', f.role);
                if (f.verified && f.verified !== 'all') p.set('verified', f.verified); if (f.provider) p.set('provider', f.provider);
                if (f.q) p.set('q', f.q); if (f.sort && f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 1) p.set('page', String(f.page)); if (f.per_page && f.per_page !== 10) p.set('per_page', String(f.per_page));
                u.search = p.toString(); form.setAttribute('hx-put', u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (_) { form.setAttribute('hx-put', _u_mergeQs(base, qs)); }
        } else {
            try { var u2 = new URL(base, window.location.origin); form.setAttribute('hx-put', u2.pathname + (u2.search ? ('?' + u2.search) : '')); }
            catch (_) { form.setAttribute('hx-put', base); }
        }

        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#users-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#users-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true);

    /* Bơm tham số (kể cả khi control disabled) */
    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentUserFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.status && f.status !== 'all') e.detail.parameters.status = f.status;
            if (f.role && f.role !== 'all') e.detail.parameters.role = f.role;
            if (f.verified && f.verified !== 'all') e.detail.parameters.verified = f.verified;
            if (f.provider) e.detail.parameters.provider = f.provider;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort && f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;

            var email = form.querySelector('#user_email');
            var verified = form.querySelector('#user_email_verified');
            var provSel = form.querySelector('#user_oauth_provider');

            var initialProvider = (form.dataset.currentProvider || (provSel ? provSel.value : 'local') || 'local').toLowerCase();
            var initialEmail = form.dataset.initialEmail || '';
            var currentEmail = (email ? (email.value || '').trim() : '');
            var emailChanged = (currentEmail !== initialEmail) && (initialProvider === 'local');

            // gửi các giá trị cần thiết
            e.detail.parameters.user_email = currentEmail;
            e.detail.parameters.user_oauth_provider = initialProvider || 'local';
            e.detail.parameters.email_changed = emailChanged ? 1 : 0;
            e.detail.parameters.user_email_verified = (emailChanged ? 0 : (verified && verified.checked ? 1 : 0));

            var qs = _usersFilterQS(); if (qs) e.detail.path = _u_mergeQs(e.detail.path || '', qs);
        } catch (_) { }
    });

    form.dataset.filterBound = '1';
}

/* ========= Create form logic ========= */
function attachUsersCreateFormLogic() {
    var form = document.getElementById('admin-users-create-form'); if (!form) return;
    ensureUsersFormKeepsFilters(form);

    var email = form.querySelector('#user_email');
    var username = form.querySelector('#user_name');
    var role = form.querySelector('#user_role');
    var status = form.querySelector('#user_status');
    var provider = form.querySelector('#user_oauth_provider');
    var providerOtherWrap = document.getElementById('provider-other-wrap');
    var providerOther = document.getElementById('user_oauth_provider_other');
    var pass = form.querySelector('#user_password');
    var pass2 = form.querySelector('#user_password_confirm');
    var passHint = document.getElementById('users-pass-hint');
    var passwordBlock = document.getElementById('users-password-block');
    var submitBtn = document.getElementById('users-submit-btn');

    var emailUnique = true, emailCheckCtl = null, emailHintEl = null;
    function ensureEmailHintEl() { if (emailHintEl) return emailHintEl; emailHintEl = document.createElement('div'); emailHintEl.id = 'users-email-unique-hint'; emailHintEl.className = 'text-xs mt-1'; if (email && email.parentElement) email.parentElement.appendChild(emailHintEl); return emailHintEl; }
    function setEmailHint(msg, type) { var el = ensureEmailHintEl(); el.textContent = msg || ''; el.style.color = (type === 'error') ? '#b91c1c' : '#6b7280'; }
    function isEmailValid(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }
    function validatePasswords() {
        var pv = provider ? provider.value : 'local'; if (pv !== 'local') return true;
        var a = (pass && pass.value) ? pass.value : '', b = (pass2 && pass2.value) ? pass2.value : '';
        if ((a === '' && b === '')) { passHint && passHint.classList.add('hidden'); return true; }
        var ok = (a === b && a.length >= 6); passHint && passHint.classList.toggle('hidden', ok); return ok;
    }
    function currentProviderValue() { var pv = provider ? provider.value : 'local'; if (pv === '_other') return (providerOther && providerOther.value.trim()) ? providerOther.value.trim() : ''; return pv; }
    function providerUIUpdate() { var pv = provider ? provider.value : 'local'; if (providerOtherWrap) providerOtherWrap.classList.toggle('hidden', pv !== '_other'); if (pv !== 'local') { passHint && passHint.classList.add('hidden'); if (passwordBlock) passwordBlock.classList.add('hidden'); } else { if (passwordBlock) passwordBlock.classList.remove('hidden'); } }
    function toggleSubmit() {
        var okEmail = email && isEmailValid(email.value);
        var okRole = role && !!role.value;
        var okStat = status && !!status.value;
        var okPwd = validatePasswords();
        submitBtn && (submitBtn.disabled = !(okEmail && okRole && okStat && okPwd && emailUnique));
    }
    function checkEmailUniqueDebounced(v) {
        if (emailCheckCtl && emailCheckCtl.abort) emailCheckCtl.abort();
        if (!v || !isEmailValid(v)) { emailUnique = false; setEmailHint('Email không hợp lệ.', 'error'); toggleSubmit(); return; }
        emailCheckCtl = new AbortController();
        var url = EMAIL_UNIQUE_API + '?email=' + encodeURIComponent(v);
        fetch(url, { signal: emailCheckCtl.signal, headers: { 'Accept': 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : { unique: true }; })
            .then(function (j) { emailUnique = !!(j.unique === true || j.ok === true); setEmailHint(emailUnique ? '' : 'Email đã tồn tại trong hệ thống.', emailUnique ? '' : 'error'); toggleSubmit(); })
            .catch(function () { emailUnique = true; setEmailHint('', ''); toggleSubmit(); });
    }

    username && username.addEventListener('input', function () { this.value = this.value.replace(/[^a-zA-Z0-9_\-\.]/g, '').slice(0, 100); });
    email && email.addEventListener('input', function () { checkEmailUniqueDebounced(this.value); toggleSubmit(); });
    role && role.addEventListener('change', toggleSubmit);
    status && status.addEventListener('change', toggleSubmit);
    provider && provider.addEventListener('change', function () { providerUIUpdate(); toggleSubmit(); });
    providerOther && providerOther.addEventListener('input', toggleSubmit);
    pass && pass.addEventListener('input', toggleSubmit);
    pass2 && pass2.addEventListener('input', toggleSubmit);

    form.addEventListener('submit', function () { var pv = currentProviderValue(); if (provider && provider.value === '_other') { provider.value = pv || ''; } }, true);

    providerUIUpdate(); toggleSubmit();
}

/* ========= Edit form logic ========= */
function attachUsersEditFormLogic() {
    var form = document.getElementById('admin-users-edit-form'); if (!form) return;
    ensureUsersEditFormKeepsFilters(form);

    var email = form.querySelector('#user_email');
    var displayName = form.querySelector('#user_display_name');
    var username = form.querySelector('#user_name');
    var role = form.querySelector('#user_role');
    var status = form.querySelector('#user_status');
    var verified = form.querySelector('#user_email_verified');
    var provider = form.querySelector('#user_oauth_provider');
    var providerOtherWrap = document.getElementById('provider-other-wrap');
    var pass = form.querySelector('#user_password');
    var pass2 = form.querySelector('#user_password_confirm');
    var passHint = document.getElementById('users-pass-hint');
    var passwordBlock = document.getElementById('users-password-block');
    var submitBtn = document.getElementById('users-edit-submit-btn');
    var force = document.getElementById('force_reverify');

    function currentEditingUserId() { var base = form.getAttribute('hx-put') || form.action || ''; var m = base.match(/\/admin\/users\/([^\/\?\s]+)/); return m ? m[1] : ''; }
    var editingId = currentEditingUserId();

    var initialProvider = (form.dataset.currentProvider || (provider ? provider.value : 'local')).toLowerCase() || 'local';
    var initialEmail = (email ? (email.value || '').trim() : '');
    var initialVerified = verified ? !!verified.checked : false;
    form.dataset.initialEmail = initialEmail;

    var emailChangedHint = null, emailUniqueHint = null, emailCheckCtl = null, emailUnique = true;
    function ensureEmailChangedHint() { if (emailChangedHint) return emailChangedHint; emailChangedHint = document.createElement('div'); emailChangedHint.id = 'users-email-changed-hint'; emailChangedHint.className = 'text-xs text-amber-700 mt-1'; if (email && email.parentElement) email.parentElement.appendChild(emailChangedHint); return emailChangedHint; }
    function ensureEmailUniqueHint() { if (emailUniqueHint) return emailUniqueHint; emailUniqueHint = document.createElement('div'); emailUniqueHint.id = 'users-email-unique-hint'; emailUniqueHint.className = 'text-xs mt-1'; if (email && email.parentElement) email.parentElement.appendChild(emailUniqueHint); return emailUniqueHint; }
    function setEmailChangedUI(changed) {
        if (initialProvider !== 'local') return;
        if (verified) { verified.checked = false; verified.disabled = changed ? true : false; if (!changed) verified.checked = initialVerified; }
        var el = ensureEmailChangedHint(); if (changed) { el.textContent = 'Email đã thay đổi – cần xác thực lại sau khi lưu.'; el.style.display = 'block'; } else { el.textContent = ''; el.style.display = 'none'; }
    }
    function setEmailUniqueUI(ok) { var el = ensureEmailUniqueHint(); el.textContent = ok ? '' : 'Email đã tồn tại trong hệ thống.'; el.style.color = ok ? '#6b7280' : '#b91c1c'; }

    function applyProviderLocks() {
        var isLocal = (initialProvider === 'local');
        if (email) { email.readOnly = !isLocal; email.classList.toggle('cursor-not-allowed', !isLocal); email.classList.toggle('bg-gray-100', !isLocal); }
        if (passwordBlock) passwordBlock.classList.toggle('hidden', !isLocal);
        if (!isLocal) { pass && (pass.value = ''); pass2 && (pass2.value = ''); passHint && passHint.classList.add('hidden'); }
        if (provider) provider.disabled = true;
        if (providerOtherWrap) providerOtherWrap.classList.add('hidden');
        if (verified) verified.disabled = !isLocal;
    }

    function isEmailValid(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }
    function validatePasswords() {
        if (initialProvider !== 'local') return true;
        var a = (pass && pass.value) ? pass.value : '', b = (pass2 && pass2.value) ? pass2.value : '';
        if ((a === '' && b === '')) { passHint && passHint.classList.add('hidden'); return true; }
        var ok = (a === b && a.length >= 6); passHint && passHint.classList.toggle('hidden', ok); return ok;
    }

    function sensitiveChanged() {
        if (initialProvider !== 'local') return false;
        var changed = false;
        if (email && (email.value || '').trim() !== initialEmail) changed = true;
        if (username && username.value && username.value.length > 0) { /* so sánh snapshot dưới */ }
        // snapshot so sánh thêm
        return changed || (snapshot() !== initialSnap);
    }

    function snapshot() {
        return JSON.stringify({
            email: email ? email.value.trim() : '',
            dn: displayName ? displayName.value.trim() : '',
            un: username ? username.value.trim() : '',
            role: role ? role.value : '',
            status: status ? status.value : '',
            verified: verified ? !!verified.checked : false,
            provider: initialProvider,
            passSet: !!(pass && pass.value),
            pass2Set: !!(pass2 && pass2.value)
        });
    }
    var initialSnap = snapshot();

    function toggleSubmit() {
        var okEmail = email && isEmailValid(email.value);
        var okRole = role && !!role.value;
        var okStat = status && !!status.value;
        var okPwd = validatePasswords();
        var changed = (snapshot() !== initialSnap) || ((email && (email.value || '').trim() !== initialEmail));
        // set re-verify flag (ẩn) khi thay đổi nhạy cảm với local
        if (force) { force.value = (initialProvider === 'local' && changed) ? '1' : ''; }
        submitBtn && (submitBtn.disabled = !(okEmail && okRole && okStat && okPwd && changed && emailUnique));
        form.dataset.emailUnique = emailUnique ? '1' : '0';
    }

    function emailChanged() { return email && (email.value || '').trim() !== initialEmail; }

    function checkEmailUniqueDebounced(v) {
        if (initialProvider !== 'local') { emailUnique = true; setEmailUniqueUI(true); toggleSubmit(); return; }
        if (emailCheckCtl && emailCheckCtl.abort) emailCheckCtl.abort();
        if (!v || !isEmailValid(v)) { emailUnique = false; setEmailUniqueUI(false); toggleSubmit(); return; }
        emailCheckCtl = new AbortController();
        var url = EMAIL_UNIQUE_API + '?email=' + encodeURIComponent(v) + '&exclude_id=' + encodeURIComponent(editingId || '');
        fetch(url, { signal: emailCheckCtl.signal, headers: { 'Accept': 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : { unique: true }; })
            .then(function (j) { emailUnique = !!(j.unique === true || j.ok === true); setEmailUniqueUI(emailUnique); toggleSubmit(); })
            .catch(function () { emailUnique = true; setEmailUniqueUI(true); toggleSubmit(); });
    }

    function onEmailInput() {
        var changed = emailChanged(); setEmailChangedUI(changed); checkEmailUniqueDebounced((email && email.value) || ''); toggleSubmit();
    }

    username && username.addEventListener('input', function () { this.value = this.value.replace(/[^a-zA-Z0-9_\-\.]/g, '').slice(0, 100); });
    ['input', 'change'].forEach(function (ev) {
        email && email.addEventListener(ev, onEmailInput);
        displayName && displayName.addEventListener(ev, toggleSubmit);
        username && username.addEventListener(ev, toggleSubmit);
    });
    role && role.addEventListener('change', toggleSubmit);
    status && status.addEventListener('change', toggleSubmit);
    verified && verified.addEventListener('change', toggleSubmit);
    pass && pass.addEventListener('input', toggleSubmit);
    pass2 && pass2.addEventListener('input', toggleSubmit);

    applyProviderLocks();
    setEmailChangedUI(false);
    setEmailUniqueUI(true);
    toggleSubmit();
}

/* ========= Delete / Detail ========= */
function ensureUsersDeleteKeepsFilters(form) {
    if (!form || form.dataset.filterBound === '1') return;
    form.addEventListener('submit', function () {
        if (form.dataset._submitting === '1') return;
        form.dataset._submitting = '1';
        var btn = document.getElementById('users-delete-submit-btn'); if (btn) btn.disabled = true;
        var f = _getCurrentUserFilters();
        ['status', 'role', 'verified', 'provider', 'q', 'sort'].forEach(function (k) { _u_upsertHidden(form, k, f[k]); });
        _u_upsertHidden(form, 'page', (f.page > 0 ? f.page : '')); _u_upsertHidden(form, 'per_page', (f.per_page > 0 ? f.per_page : ''));
        var attr = form.hasAttribute('hx-delete') ? 'hx-delete' : (form.hasAttribute('hx-post') ? 'hx-post' : null);
        if (!attr) { attr = 'hx-post'; form.setAttribute(attr, form.action || ''); }
        var base = form.getAttribute(attr) || form.action || '';
        var qs = _usersFilterQS();
        if (qs) {
            try {
                var u = new URL(base, window.location.origin), p = u.searchParams;['status', 'role', 'verified', 'provider', 'q', 'sort', 'page', 'per_page'].forEach(function (k) { p.delete(k); });
                if (f.status !== 'all') p.set('status', f.status); if (f.role !== 'all') p.set('role', f.role); if (f.verified !== 'all') p.set('verified', f.verified);
                if (f.provider) p.set('provider', f.provider); if (f.q) p.set('q', f.q); if (f.sort !== 'created_desc') p.set('sort', f.sort);
                if (f.page > 0) p.set('page', String(f.page)); if (f.per_page > 0) p.set('per_page', String(f.per_page));
                u.search = p.toString(); form.setAttribute(attr, u.pathname + (u.search ? ('?' + u.search) : ''));
            } catch (_) { form.setAttribute(attr, _u_mergeQs(base, qs)); }
        }
        if (!form.getAttribute('hx-target')) form.setAttribute('hx-target', '#users-list-region');
        if (!form.getAttribute('hx-select')) form.setAttribute('hx-select', '#users-list-region');
        if (!form.getAttribute('hx-swap')) form.setAttribute('hx-swap', 'outerHTML');
    }, true);

    form.addEventListener('htmx:configRequest', function (e) {
        try {
            var f = _getCurrentUserFilters();
            e.detail.parameters.page = (f.page > 0 ? f.page : 1);
            if (f.per_page > 0) e.detail.parameters.per_page = f.per_page;
            if (f.status !== 'all') e.detail.parameters.status = f.status;
            if (f.role !== 'all') e.detail.parameters.role = f.role;
            if (f.verified !== 'all') e.detail.parameters.verified = f.verified;
            if (f.provider) e.detail.parameters.provider = f.provider;
            if (f.q) e.detail.parameters.q = f.q;
            if (f.sort !== 'created_desc') e.detail.parameters.sort = f.sort;
            var qs = _usersFilterQS(); if (qs) e.detail.path = _u_mergeQs(e.detail.path || '', qs);
        } catch (_) { }
    });

    form.dataset.filterBound = '1';
}
function attachUsersDeleteFormLogic() { var form = document.getElementById('admin-users-delete-form'); if (!form || form.dataset.bound === '1') return; form.dataset.bound = '1'; ensureUsersDeleteKeepsFilters(form); }
function attachUsersDetailModalLogic() { setTimeout(function () { try { focusUsersDetailModal(); } catch (_) { } }, 20); }

/* ========= Rebind when modal loads via HTMX ========= */
function rebindAdminUsersNewModalEvents() { attachUsersCreateFormLogic(); }
function rebindAdminUsersEditModalEvents() { attachUsersEditFormLogic(); }
function rebindAdminUsersDetailModalEvents() { attachUsersDetailModalLogic(); }
function rebindAdminUsersDeleteModalEvents() { attachUsersDeleteFormLogic(); }

/* ========= Global HTMX hooks ========= */
document.body.addEventListener('htmx:afterOnLoad', function (evt) {
    var d = evt && evt.detail ? evt.detail : {}; var tgt = d.target ? d.target : null; var tid = (tgt && tgt.id) ? tgt.id : '';
    if (tid === 'admin-users-modal-root' || tid === 'users-new-modal') { rebindAdminUsersNewModalEvents(); }
    if (tid === 'admin-users-modal-root' || tid === 'users-edit-modal') { rebindAdminUsersEditModalEvents(); }
    if (tid === 'admin-users-modal-root' || tid === 'users-detail-modal') { rebindAdminUsersDetailModalEvents(); }
    if (tid === 'admin-users-modal-root' || tid === 'users-delete-modal') { rebindAdminUsersDeleteModalEvents(); }
});

/* Không auto toast/close khi swap list */
document.body.addEventListener('htmx:afterSwap', function (evt) {
    var t = evt && evt.detail ? evt.detail.target : null; if (!t) return;
    if (t.id === 'users-list-region' || t.id === 'admin-users-container') {
        var f1 = document.getElementById('admin-users-create-form'); if (f1) f1.dataset._submitting = '';
        var b1 = document.getElementById('users-submit-btn'); if (b1) b1.disabled = false;
        var f2 = document.getElementById('admin-users-edit-form'); if (f2) f2.dataset._submitting = '';
        var b2 = document.getElementById('users-edit-submit-btn'); if (b2) b2.disabled = false;
        var f3 = document.getElementById('admin-users-delete-form'); if (f3) f3.dataset._submitting = '';
        var b3 = document.getElementById('users-delete-submit-btn'); if (b3) b3.disabled = false;
    }
});

/* ========= Error recovery ========= */
function _reEnableUsersCreateOnError() { var f = document.getElementById('admin-users-create-form'); if (f) f.dataset._submitting = ''; var btn = document.getElementById('users-submit-btn'); if (btn) btn.disabled = false; window.Toast && window.Toast.show && window.Toast.show('Tạo người dùng thất bại. Vui lòng thử lại!', 'error', 3000); }
function _reEnableUsersEditOnError() { var f = document.getElementById('admin-users-edit-form'); if (f) f.dataset._submitting = ''; var btn = document.getElementById('users-edit-submit-btn'); if (btn) btn.disabled = false; window.Toast && window.Toast.show && window.Toast.show('Cập nhật người dùng thất bại. Vui lòng thử lại!', 'error', 3000); }
function _reEnableUsersDeleteOnError() { var f = document.getElementById('admin-users-delete-form'); if (f) f.dataset._submitting = ''; var btn = document.getElementById('users-delete-submit-btn'); if (btn) btn.disabled = false; window.Toast && window.Toast.show && window.Toast.show('Vô hiệu hoá người dùng thất bại. Vui lòng thử lại!', 'error', 3000); }
document.body.addEventListener('htmx:responseError', function () { _reEnableUsersCreateOnError(); _reEnableUsersEditOnError(); _reEnableUsersDeleteOnError(); });
document.body.addEventListener('htmx:swapError', function () { _reEnableUsersCreateOnError(); _reEnableUsersEditOnError(); _reEnableUsersDeleteOnError(); });
document.body.addEventListener('htmx:sendError', function () { _reEnableUsersCreateOnError(); _reEnableUsersEditOnError(); _reEnableUsersDeleteOnError(); });

/* ========= HX-Trigger handlers =========
   resp.headers["HX-Trigger"] = {"users-single-result":{"action":"create|update|delete","ok":true|false,"reason":"..."}}
*/
document.body.addEventListener('users-single-result', function (ev) {
    var d = (ev && ev.detail) || {}; var action = d.action || ''; var ok = !!d.ok; var reason = d.reason || '';
    function toast(msg, type, ms) { if (window.Toast && Toast.show) Toast.show(msg, type || 'info', ms || 2600); }
    if (action === 'create') { if (ok) { closeUsersCreateModal(); toast('Tạo người dùng thành công!', 'success', 3000); } else { toast('Tạo người dùng thất bại.', 'error', 3000); } }
    if (action === 'update') {
        if (ok) { closeUsersEditModal(); toast('Cập nhật người dùng thành công!', 'success', 3000); }
        else {
            if (reason === 'duplicate_email') toast('Email đã tồn tại. Vui lòng dùng email khác.', 'warning', 3600);
            else toast('Cập nhật người dùng thất bại.', 'error', 3000);
            var f = document.getElementById('admin-users-edit-form'); if (f) f.dataset._submitting = '';
            var b = document.getElementById('users-edit-submit-btn'); if (b) b.disabled = false;
        }
    }
    if (action === 'delete') {
        if (ok) { closeUsersDeleteModal(); toast('Đã vô hiệu hoá người dùng.', 'success', 2800); }
        else {
            if (reason === 'self') toast('Không thể vô hiệu hoá chính bạn.', 'warning', 3200);
            else if (reason === 'last_admin') toast('Không thể vô hiệu hoá admin đang active cuối cùng.', 'warning', 3600);
            else toast('Thao tác vô hiệu hoá không thành công.', 'error', 3000);
            var f3 = document.getElementById('admin-users-delete-form'); if (f3) f3.dataset._submitting = '';
            var b3 = document.getElementById('users-delete-submit-btn'); if (b3) b3.disabled = false;
        }
    }
});

/* ========= If modal already exists (no HTMX) ========= */
if (document.getElementById('users-new-modal')) { rebindAdminUsersNewModalEvents(); }
if (document.getElementById('users-edit-modal')) { rebindAdminUsersEditModalEvents(); }
if (document.getElementById('users-detail-modal')) { rebindAdminUsersDetailModalEvents(); }
if (document.getElementById('users-delete-modal')) { rebindAdminUsersDeleteModalEvents(); }

(function markNativeApp() {
    const cap = window.Capacitor;
    const isNative = !!(cap && (typeof cap.isNativePlatform === 'function'
        ? cap.isNativePlatform()
        : (typeof cap.getPlatform === 'function' && cap.getPlatform() !== 'web')));
    if (isNative || /[?&]app=1\b/.test(location.search)) document.documentElement.classList.add('is-app');
})();

document.addEventListener('DOMContentLoaded', async () => {
    if (!localStorage.getItem(STORAGE_KEYS.SUBJECTS)) {
        localStorage.setItem(STORAGE_KEYS.SUBJECTS, JSON.stringify(initialSubjects));
    }

    initTheme();
    selectRole(ROLES.STUDENT);
    renderSubjects();
    renderTutors();
    renderRequests();
    updateStats();
    updateUserSession();
    setDefaultPreferredDate();

    document.getElementById('registerForm').addEventListener('submit', handleRegistration);
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('tutorRequestForm').addEventListener('submit', handleTutorRequest);
    document.getElementById('selectSubject').addEventListener('change', updateTutorSelectForSubject);

    setupAndroidBackButton();
    document.body.addEventListener('click', handleDelegatedClick);

    if (window.EduMatchBackend) {
        await window.EduMatchBackend.bootstrap();
        updateUserSession();
        renderSubjects();
        renderTutors();
        renderRequests();
        updateStats();
    }
});

function handleDelegatedClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const id = target.dataset.id ? Number(target.dataset.id) : null;
    const tutorId = target.dataset.tutorId ? target.dataset.tutorId : null;

    switch (action) {
        case 'request-subject':
            quickSelectSubject(target.dataset.subject);
            break;
        case 'view-tutor-subject-requests':
            viewTutorSubjectRequests(target.dataset.subject);
            break;
        case 'select-tutor':
            selectTutorForRequest(target.dataset.tutor);
            break;
        case 'accept-request':
            acceptRequest(id);
            break;
        case 'reject-request':
            openConfirmModal({
                title: '¿Deseas rechazar esta solicitud?',
                message: 'Se buscará automáticamente otro tutor que dicte esta materia y se le asignará la solicitud. Si no hay ninguno disponible, la solicitud se cancelará.',
                confirmLabel: 'Rechazar',
                onConfirm: () => rejectRequest(id)
            });
            break;
        case 'clear-tutor':
            clearRequestTutor(id);
            break;
        case 'cancel-request':
            cancelRequest(id);
            break;
        case 'complete-request':
            completeRequest(id);
            break;
        case 'toggle-propose':
            toggleProposalForm(id);
            break;
        case 'submit-propose':
            proposeSchedule(id);
            break;
        case 'accept-proposal':
            acceptProposedSchedule(id);
            break;
        case 'reject-proposal':
            openConfirmModal({
                title: '¿Deseas rechazar la propuesta?',
                message: 'La solicitud quedará como Rechazada. Si solo quieres cerrar este aviso, pulsa Cancelar: la propuesta seguirá pendiente de tu respuesta.',
                confirmLabel: 'Rechazar',
                onConfirm: () => rejectProposedSchedule(id)
            });
            break;
        case 'open-history':
            openHistoryModal(id);
            break;
        case 'confirm-accept':
            resolveConfirmModal(true);
            break;
        case 'confirm-dismiss':
            resolveConfirmModal(false);
            break;
        case 'confirm-dismiss-backdrop':
            if (event.target === target) resolveConfirmModal(false);
            break;
        case 'assign-new-tutor': {
            const select = document.getElementById(`newTutorSelect-${id}`);
            assignNewTutorToRequest(id, select ? String(select.value) : null);
            break;
        }
        case 'delete-history':
            deleteFromHistory(id);
            break;
        case 'set-rating':
            saveRating(id, Number(target.dataset.value));
            break;
        case 'assign-tutor-subject': {
            const select = document.getElementById(`addSubjectSelect-${tutorId}`);
            assignSubjectToTutor(tutorId, select ? select.value : '');
            break;
        }
        case 'remove-tutor-subject':
            removeSubjectFromTutor(tutorId, target.dataset.subject);
            break;
        case 'delete-custom-subject':
            openConfirmModal({
                title: '¿Deseas eliminar la materia definitivamente?',
                message: `"${target.dataset.subject}" se quitará del catálogo y de tu perfil.`,
                confirmLabel: 'Eliminar',
                cancelLabel: 'Cancelar',
                onConfirm: () => scheduleCustomSubjectDeletion(tutorId, target.dataset.subject)
            });
            break;
        case 'create-subject': {
            const nameInput = document.getElementById(`newSubjectName-${tutorId}`);
            const descInput = document.getElementById(`newSubjectDesc-${tutorId}`);
            createSubject(tutorId, nameInput ? nameInput.value : '', descInput ? descInput.value : '');
            break;
        }
        case 'delete-tutor':
            deleteTutorProfile(tutorId);
            break;
        case 'logout':
            handleLogout();
            break;
    }
}

function switchTab(tabId) {
    const currentUser = getCurrentUser();

    if (tabId === 'request' && currentUser && currentUser.role === ROLES.TUTOR) {
        showToast('Esta sección es solo para estudiantes.', 'error');
        tabId = 'explore';
    }

    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(btn => { btn.classList.remove('active'); btn.removeAttribute('aria-current'); });

    const selectedTab = document.getElementById(`${tabId}-tab`);
    if (selectedTab) selectedTab.classList.add('active');

    const activeNavBtn = document.querySelector(`.nav-btn[data-tab="${tabId}"]`);
    if (activeNavBtn) { activeNavBtn.classList.add('active'); activeNavBtn.setAttribute('aria-current', 'page'); }
    window.scrollTo(0, 0); // al cambiar de pestaña se empieza arriba (comportamiento de app)
}

function applyRoleBasedUI() {
    const currentUser = getCurrentUser();
    const role = currentUser ? currentUser.role : null;

    const navTutors = document.querySelector('.nav-btn[data-tab="tutors"]');
    const navRequest = document.querySelector('.nav-btn[data-tab="request"]');
    const navHistory = document.querySelector('.nav-btn[data-tab="history"]');
    if (navTutors) {
        navTutors.style.display = '';
        const navLabel = navTutors.querySelector('.nav-label');
        if (navLabel) navLabel.textContent = role === ROLES.TUTOR ? 'Mi perfil' : 'Tutores';
    }
    if (navRequest) navRequest.style.display = role === ROLES.TUTOR ? 'none' : '';
    if (navHistory) navHistory.style.display = currentUser ? '' : 'none';

    const exploreTitle = document.querySelector('#explore-tab .section-header h2');
    if (exploreTitle) exploreTitle.textContent = role === ROLES.TUTOR ? 'Mis materias a cargo' : 'Materias Disponibles';
    const tutorsTab = document.getElementById('tutors-tab');
    const tutorsTitle = tutorsTab?.querySelector('.section-header h2');
    if (tutorsTitle) tutorsTitle.textContent = role === ROLES.TUTOR ? 'Mi perfil de tutor' : 'Tutores Disponibles';
    if (tutorsTab) tutorsTab.style.display = '';

    const form = document.getElementById('tutorRequestForm');
    const locked = document.getElementById('requestLocked');
    const lockedTitle = document.getElementById('requestLockedTitle');
    const lockedText = document.getElementById('requestLockedText');
    const loginBtn = document.getElementById('requestLoginBtn');

    if (role === ROLES.STUDENT) {
        if (form) form.style.display = 'block';
        if (locked) locked.style.display = 'none';
    } else {
        if (form) form.style.display = 'none';
        if (locked) locked.style.display = 'block';

        if (role === ROLES.TUTOR) {
            if (lockedTitle) lockedTitle.textContent = 'Función exclusiva para estudiantes';
            if (lockedText) lockedText.textContent = 'Los tutores no crean solicitudes. Revisa "Mis Solicitudes" para ver las que tienes asignadas.';
            if (loginBtn) loginBtn.style.display = 'none';
        } else {
            if (lockedTitle) lockedTitle.textContent = 'Inicia sesión como estudiante';
            if (lockedText) lockedText.textContent = 'Para solicitar una tutoría académica necesitas iniciar sesión con una cuenta de estudiante.';
            if (loginBtn) loginBtn.style.display = 'inline-flex';
        }
    }

    const activeTab = document.querySelector('.tab-content.active');
    if (activeTab && activeTab.id === 'request-tab' && role === ROLES.TUTOR) {
        switchTab('explore');
    }
}

const PASSWORD_EYE_ICON = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"></path>
        <circle cx="12" cy="12" r="3"></circle>
    </svg>`;

const PASSWORD_EYE_OFF_ICON = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-6.06"></path>
        <path d="M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 8 11 8a21.7 21.7 0 0 1-3.22 4.65"></path>
        <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
    </svg>`;

function togglePasswordVisibility(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const willShow = input.type === 'password';
    input.type = willShow ? 'text' : 'password';
    if (btn) {
        btn.innerHTML = willShow ? PASSWORD_EYE_OFF_ICON : PASSWORD_EYE_ICON;
        btn.setAttribute('aria-label', willShow ? 'Ocultar contraseña' : 'Mostrar contraseña');
    }
}

function resetPasswordVisibility(...inputIds) {
    inputIds.forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;
        input.type = 'password';
        const btn = input.parentElement ? input.parentElement.querySelector('.password-toggle') : null;
        if (btn) {
            btn.innerHTML = PASSWORD_EYE_ICON;
            btn.setAttribute('aria-label', 'Mostrar contraseña');
        }
    });
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('active');
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
}

let pendingConfirmAction = null;
let pendingConfirmCancel = null;

function openConfirmModal({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }) {
    pendingConfirmAction = typeof onConfirm === 'function' ? onConfirm : null;
    pendingConfirmCancel = typeof onCancel === 'function' ? onCancel : null;
    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalMessage').textContent = message;
    document.getElementById('confirmModalAccept').textContent = confirmLabel || 'Confirmar';
    document.getElementById('confirmModalCancel').textContent = cancelLabel || 'Cancelar';
    openModal('confirmModal');
}

function resolveConfirmModal(confirmed) {
    const action = confirmed ? pendingConfirmAction : pendingConfirmCancel;
    pendingConfirmAction = null;
    pendingConfirmCancel = null;
    closeModal('confirmModal');
    if (action) action();
}

document.addEventListener('keydown', event => {
    const modal = document.getElementById('confirmModal');
    if (event.key === 'Escape' && modal && modal.classList.contains('active')) resolveConfirmModal(false);
});

function handleBackNavigation() {
    if (window.UIPickers && window.UIPickers.hasOpenPanel()) { window.UIPickers.closeOpen(); return true; } // lista / calendario / reloj abierto
    const isOpen = id => { const el = document.getElementById(id); return !!(el && el.classList.contains('active')); };

    if (isOpen('confirmModal')) { resolveConfirmModal(false); return true; }
    if (isOpen('historyModal')) { closeModal('historyModal'); return true; }
    if (isOpen('settingsModal')) {
        const confirmView = document.getElementById('settingsResetConfirm');
        if (confirmView && confirmView.style.display !== 'none') cancelResetConfirmation();
        else closeSettingsModal();
        return true;
    }
    if (isOpen('authModal')) { closeModal('authModal'); return true; }

    const activeTab = document.querySelector('.tab-content.active');
    if (activeTab && activeTab.id !== 'explore-tab') { switchTab('explore'); return true; }
    return false;
}

(function setupKeyboardWatcher() {
    const TEXT_TYPES = ['text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'time', ''];
    const isTextField = el => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_TYPES.includes(el.type)));
    let baseHeight = 0;
    let baseWidth = 0;

    function currentHeight() { return window.visualViewport ? window.visualViewport.height : window.innerHeight; }

    function update() {
        const h = currentHeight();
        if (window.innerWidth !== baseWidth) { baseWidth = window.innerWidth; baseHeight = h; } // giro de pantalla
        if (h > baseHeight) baseHeight = h;
        const open = baseHeight - h > 150 && isTextField(document.activeElement);
        document.documentElement.classList.toggle('kb-open', open);
    }

    window.addEventListener('resize', update);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', update);
    document.addEventListener('focusin', event => {
        update();
        const el = event.target;
        if (isTextField(el) && el.tagName !== 'SELECT' && window.innerWidth <= 768) {
            setTimeout(() => { if (document.activeElement === el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 350);
        }
    });
    document.addEventListener('focusout', () => setTimeout(update, 120));
    baseWidth = window.innerWidth;
    baseHeight = currentHeight();
})();

const NativeBridge = {
    get cap() { return window.Capacitor || null; },

    listen(plugin, eventName, callback) {
        const cap = this.cap;
        if (!cap) return false;
        try {
            const registered = cap.Plugins && cap.Plugins[plugin];
            if (registered && typeof registered.addListener === 'function') registered.addListener(eventName, callback);
            else if (typeof cap.addListener === 'function') cap.addListener(plugin, eventName, callback);
            else return false;
            return true;
        } catch (err) { console.warn(`[Capacitor] ${plugin}.${eventName}:`, err); return false; }
    },

    call(plugin, method, options = {}) {
        const cap = this.cap;
        if (!cap) return Promise.resolve(null);
        try {
            const registered = cap.Plugins && cap.Plugins[plugin];
            if (registered && typeof registered[method] === 'function') return Promise.resolve(registered[method](options)).catch(() => null);
            if (typeof cap.nativePromise === 'function') return cap.nativePromise(plugin, method, options).catch(() => null);
        } catch (err) { console.warn(`[Capacitor] ${plugin}.${method}:`, err); }
        return Promise.resolve(null);
    }
};

function setupAndroidBackButton() {
    NativeBridge.listen('App', 'backButton', () => {
        if (!handleBackNavigation()) NativeBridge.call('App', 'exitApp');
    });
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    const meta = document.getElementById('metaThemeColor');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#202124' : '#ffffff');
    NativeBridge.call('SystemBars', 'setStyle', { style: theme === 'dark' ? 'DARK' : 'LIGHT' });
}

function toggleTheme() {
    const newTheme = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEYS.THEME, newTheme);
    applyTheme(newTheme);
}

function initTheme() {
    applyTheme(localStorage.getItem(STORAGE_KEYS.THEME) || 'light');
}

const TOAST_MS = { info: 2500, success: 2500, error: 3000, action: 5000 };
const TOAST_MAX_VISIBLE = 2;

function showToast(message, type = 'info', options = {}) {
    const container = document.getElementById('toastContainer');
    if (!container) return null;

    const visible = [...container.querySelectorAll('.toast:not(.is-leaving)')];
    while (visible.length >= TOAST_MAX_VISIBLE) visible.shift().dispatchEvent(new CustomEvent('toast:dismiss'));

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️';
    toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${icon}</span><span class="toast-msg">${escapeHtml(message)}</span>`;

    let removed = false;
    let expired = false;
    let timer = null;
    function removeToast() {
        if (removed) return;
        removed = true;
        clearTimeout(timer);
        toast.classList.add('is-leaving');
        setTimeout(() => toast.remove(), 220);
    }
    toast.addEventListener('toast:dismiss', removeToast);
    toast.addEventListener('click', event => { if (!event.target.closest('.toast-action')) removeToast(); }); // tocar para cerrar

    const hasAction = !!(options.actionLabel && typeof options.onAction === 'function');
    if (hasAction) {
        const actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        actionBtn.className = 'toast-action';
        actionBtn.textContent = options.actionLabel;
        actionBtn.addEventListener('click', () => {
            clearTimeout(timer);
            expired = true;
            options.onAction();
            removeToast();
        });
        toast.appendChild(actionBtn);
    }

    container.appendChild(toast);

    const max = hasAction ? TOAST_MS.action : (TOAST_MS[type] || TOAST_MS.info);
    const duration = Math.min(options.duration || max, max);
    timer = setTimeout(() => {
        if (!expired) {
            expired = true;
            if (typeof options.onExpire === 'function') options.onExpire();
        }
        removeToast();
    }, duration);

    return { dismiss: () => { clearTimeout(timer); removeToast(); } };
}

function updateStats() {
    const subjects = getSubjects();
    const users = getStoredData(STORAGE_KEYS.USERS, []);
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    const currentUser = getCurrentUser();

    const statSubjects = document.getElementById('statSubjects');
    const statTutors = document.getElementById('statTutors');
    const statRequests = document.getElementById('statRequests');

    if (statSubjects) {
        statSubjects.textContent = currentUser?.role === ROLES.TUTOR
            ? (currentUser.subjects || []).length
            : subjects.length;
    }
    if (statTutors) {
        statTutors.textContent = currentUser?.role === ROLES.TUTOR
            ? '1'
            : users.filter(u => u.role === ROLES.TUTOR).length;
    }
    if (statRequests) {
        statRequests.textContent = currentUser
            ? requests.filter(r => r.studentId === currentUser.id || r.tutorId === currentUser.id).length
            : 0;
    }
}

function updateUserSession() {
    const currentUser = getCurrentUser();
    const userInfo = document.getElementById('userInfo');
    const authButton = document.getElementById('authButton');
    if (!userInfo || !authButton) return;

    if (currentUser) {
        document.getElementById('userNameDisplay').textContent = currentUser.name;
        document.getElementById('userRoleBadge').textContent = currentUser.role;
        userInfo.style.display = 'flex';
        authButton.style.display = 'none';
    } else {
        userInfo.style.display = 'none';
        authButton.style.display = 'inline-flex';
    }

    applyRoleBasedUI();
}

let resetCountdownInterval = null;
let resetCountdownRemaining = 0;

function openSettingsModal() {
    resetSettingsModalView();
    openModal('settingsModal');
}

function closeSettingsModal() {
    cancelResetConfirmation();
    closeModal('settingsModal');
}

function resetSettingsModalView() {
    const defaultView = document.getElementById('settingsDefaultView');
    const confirmView = document.getElementById('settingsResetConfirm');
    if (defaultView) defaultView.style.display = 'block';
    if (confirmView) confirmView.style.display = 'none';
}

function startResetConfirmation() {
    const defaultView = document.getElementById('settingsDefaultView');
    const confirmView = document.getElementById('settingsResetConfirm');
    const confirmBtn = document.getElementById('resetConfirmBtn');
    if (defaultView) defaultView.style.display = 'none';
    if (confirmView) confirmView.style.display = 'block';
    if (confirmBtn) confirmBtn.disabled = true;

    resetCountdownRemaining = 5;
    updateResetCountdownText();

    clearInterval(resetCountdownInterval);
    resetCountdownInterval = setInterval(() => {
        resetCountdownRemaining--;
        if (resetCountdownRemaining <= 0) {
            clearInterval(resetCountdownInterval);
            resetCountdownInterval = null;
            if (confirmBtn) confirmBtn.disabled = false;
            const countdownText = document.getElementById('resetCountdownText');
            if (countdownText) countdownText.textContent = 'Ya puedes confirmar la eliminación.';
        } else {
            updateResetCountdownText();
        }
    }, 1000);
}

function updateResetCountdownText() {
    const countdownText = document.getElementById('resetCountdownText');
    if (countdownText) {
        countdownText.textContent = `Podrás confirmar en ${resetCountdownRemaining} segundo${resetCountdownRemaining === 1 ? '' : 's'}...`;
    }
}

function cancelResetConfirmation() {
    clearInterval(resetCountdownInterval);
    resetCountdownInterval = null;
    resetSettingsModalView();
}

function confirmResetAllData() {
    const confirmBtn = document.getElementById('resetConfirmBtn');
    if (confirmBtn && confirmBtn.disabled) return; // La cuenta regresiva sigue activa: no hacer nada.

    clearInterval(resetCountdownInterval);
    resetCountdownInterval = null;

    localStorage.removeItem(STORAGE_KEYS.USERS);
    localStorage.removeItem(STORAGE_KEYS.REQUESTS);
    localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
    localStorage.setItem(STORAGE_KEYS.SUBJECTS, JSON.stringify(initialSubjects));

    pendingTutorDeletion = null;
    pendingSubjectDeletion = null;
    openProposalForms.clear();

    resetSettingsModalView();
    closeModal('settingsModal');

    showToast('Datos restablecidos correctamente.', 'success');

    switchTab('explore');
    renderSubjects();
    refreshAfterAuthChange();
    updateStats();
    window.EduMatchBackend?.hydrate?.();
}

function setDefaultPreferredDate() {
    const dateInput = document.getElementById('preferredDate');
    if (!dateInput) return;
    dateInput.min = todayIsoDate();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const pad = n => String(n).padStart(2, '0');
    dateInput.value = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
}

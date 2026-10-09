const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_RULES = {
    minLength: 8,
    lowercase: /[a-z]/,
    uppercase: /[A-Z]/,
    number: /\d/,
    special: /[^A-Za-z0-9\s]/
};

function validateRegistrationPassword(password) {
    if (password.length < PASSWORD_RULES.minLength) return 'La contraseña debe tener al menos 8 caracteres.';
    if (!PASSWORD_RULES.lowercase.test(password)) return 'La contraseña debe incluir al menos una letra minúscula.';
    if (!PASSWORD_RULES.uppercase.test(password)) return 'La contraseña debe incluir al menos una letra mayúscula.';
    if (!PASSWORD_RULES.number.test(password)) return 'La contraseña debe incluir al menos un número.';
    if (!PASSWORD_RULES.special.test(password)) return 'La contraseña debe incluir al menos un carácter especial.';
    return null;
}

function translateAuthError(error, fallback) {
    if (error?.userMessage) return error.userMessage;
    const message = String(error?.message || '').toLowerCase();
    const code = String(error?.code || '');
    const status = Number(error?.status || 0);
    if (code === 'user_already_exists' || code === 'email_exists' || /already registered|user already exists|already been registered/.test(message)) return 'Ya existe una cuenta registrada con ese correo.';
    if (code === 'invalid_credentials' || /invalid login credentials|invalid credentials/.test(message)) return 'Correo o contraseña incorrectos.';
    if (code === 'email_not_confirmed' || /email not confirmed/.test(message)) return 'Debes confirmar tu correo electrónico antes de iniciar sesión.';
    if (code === 'user_banned' || /user is banned|banned/.test(message)) return 'Esta cuenta está deshabilitada. Contacta con el administrador.';
    if (code === 'email_address_invalid' || code === 'validation_failed' || /unable to validate email|invalid format/.test(message)) return 'Ingresa un correo con formato válido.';
    if (code === 'over_request_rate_limit' || status === 429) return 'Has realizado demasiados intentos. Espera unos minutos y vuelve a intentarlo.';
    if (error?.name === 'AuthRetryableFetchError') return 'No se pudo conectar con Supabase. Comprueba tu conexión a Internet.';
    if (status >= 500) return 'El servicio de autenticación no está disponible en este momento. Inténtalo más tarde.';
    if (/password.*(weak|requirements|at least|contain|characters)/.test(message)) return 'La contraseña no cumple los requisitos de seguridad.';
    if (/signups? not allowed|signup is disabled/.test(message)) return 'El registro de cuentas está deshabilitado en Supabase.';
    if (/rate limit|too many requests|too many attempts/.test(message)) return 'Has realizado demasiados intentos. Espera unos minutos y vuelve a intentarlo.';
    if (/failed to fetch|network|connection|internet|timeout/.test(message)) return 'No se pudo conectar con Supabase. Comprueba tu conexión a Internet.';
    if (/jwt|token|session/.test(message)) return 'La sesión ya no es válida. Inicia sesión nuevamente.';
    return fallback;
}

async function handleRegistration(event) {
    event.preventDefault();

    const role = document.getElementById('userRole').value;
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirmPassword = document.getElementById('regPasswordConfirm').value;

    if (!name || !email || !password || !confirmPassword) {
        showToast('Completa todos los campos obligatorios.', 'error');
        return;
    }
    if (!EMAIL_REGEX.test(email)) {
        showToast('Ingresa un correo con formato válido.', 'error');
        return;
    }
    const passwordError = validateRegistrationPassword(password);
    if (passwordError) {
        showToast(passwordError, 'error');
        return;
    }
    if (password !== confirmPassword) {
        showToast('Las contraseñas no coinciden.', 'error');
        return;
    }

    const selectedSubjects = role === ROLES.TUTOR
        ? Array.from(document.querySelectorAll('#regSubjectsList input[type="checkbox"]:checked')).map(cb => cb.value)
        : [];

    try {
        if (!window.EduMatchBackend?.isEnabled()) {
            showToast('Configura Supabase antes de crear cuentas.', 'error');
            return;
        }

        const result = await window.EduMatchBackend.signUp({ email, password, name, role });
        const userId = result.user?.id;
        if (!userId) throw new Error('Supabase no devolvió el identificador de la cuenta.');

        const newUser = {
            id: userId,
            role,
            name,
            email,
            subjects: selectedSubjects,
            createdAt: nowLocalTimestamp(),
            activo: true
        };
        const users = getStoredData(STORAGE_KEYS.USERS, []).filter(u => u.id !== userId);
        users.push(newUser);
        saveData(STORAGE_KEYS.USERS, users);

        if (result.session) {
            let subjectsSaved = true;
            if (role === ROLES.TUTOR && selectedSubjects.length) {
                subjectsSaved = (await window.EduMatchBackend.syncTutorSubjects(userId)).ok !== false;
            }
            setCurrentUser(getStoredData(STORAGE_KEYS.USERS, []).find(u => u.id === userId) || newUser);
            if (subjectsSaved) showToast(`Cuenta creada correctamente, ${newUser.name}.`, 'success');
        } else {
            showToast(role === ROLES.TUTOR && selectedSubjects.length
                ? 'Cuenta creada. Revisa el correo de confirmación, inicia sesión y agrega tus materias desde tu perfil.'
                : 'Cuenta creada. Revisa el correo de confirmación y luego inicia sesión.', 'success');
        }

        document.getElementById('registerForm').reset();
        resetPasswordVisibility('regPassword', 'regPasswordConfirm');
        selectRole(ROLES.STUDENT);
        switchAuthMode('login');
        document.getElementById('loginEmail').value = newUser.email;
        document.getElementById('loginPassword').value = '';
        document.getElementById('loginPassword').focus();
    } catch (error) {
        console.error(error);
        showToast(translateAuthError(error, error.message || 'No se pudo crear la cuenta.'), 'error');
    }
}

async function handleLogin(event) {
    event.preventDefault();

    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!email || !password) {
        showToast('Ingresa tu correo y contraseña.', 'error');
        return;
    }
    if (!EMAIL_REGEX.test(email)) {
        showToast('Ingresa un correo con formato válido.', 'error');
        return;
    }

    try {
        if (!window.EduMatchBackend?.isEnabled()) {
            showToast('Configura Supabase antes de iniciar sesión.', 'error');
            return;
        }
        await window.EduMatchBackend.signIn(email, password);
        const user = getCurrentUser();
        if (!user) throw Object.assign(new Error('Perfil no encontrado'), { userMessage: 'No existe ninguna cuenta con estos datos.' });
        showToast(`Sesión iniciada como ${user.name} (${user.role}).`, 'success');
        document.getElementById('loginForm').reset();
        resetPasswordVisibility('loginPassword');
        closeModal('authModal');
        refreshAfterAuthChange();
    } catch (error) {
        console.error('Login error:', error?.code || error?.message);
        showToast(translateAuthError(error, 'No se pudo iniciar sesión. Inténtalo nuevamente.'), 'error');
    }
}

async function handleLogout() {
    try {
        if (window.EduMatchBackend?.isEnabled()) await window.EduMatchBackend.signOut();
    } catch (error) {
        console.error(error);
        showToast(translateAuthError(error, 'No se pudo cerrar sesión.'), 'error');
        return;
    }
    setCurrentUser(null);
    showToast('Sesión cerrada.', 'success');
    refreshAfterAuthChange();
}

function setCurrentUser(user) {
    if (user) {
        const safe = { id: user.id, role: user.role, name: user.name, email: user.email, subjects: user.subjects || [] };
        saveData(STORAGE_KEYS.CURRENT_USER, safe);
    } else {
        localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
    }
}

function getCurrentUser() {
    return getStoredData(STORAGE_KEYS.CURRENT_USER, null);
}

function refreshAfterAuthChange() {
    updateUserSession();
    renderTutors();
    renderRequests();
    updateStats();
}

function selectRole(role) {
    document.getElementById('userRole').value = role;
    document.getElementById('roleEstudiante').classList.toggle('active', role === ROLES.STUDENT);
    document.getElementById('roleTutor').classList.toggle('active', role === ROLES.TUTOR);

    const tutorFields = document.getElementById('tutorFields');
    tutorFields.style.display = role === ROLES.TUTOR ? 'block' : 'none';
    if (role === ROLES.TUTOR) renderSubjectCheckboxList();
}

function switchAuthMode(mode) {
    const isLogin = mode === 'login';
    document.getElementById('authTabRegister').classList.toggle('active', !isLogin);
    document.getElementById('authTabLogin').classList.toggle('active', isLogin);
    document.getElementById('registerForm').style.display = isLogin ? 'none' : 'block';
    document.getElementById('loginForm').style.display = isLogin ? 'block' : 'none';
    document.getElementById('roleSelectorWrapper').style.display = isLogin ? 'none' : 'block';
}

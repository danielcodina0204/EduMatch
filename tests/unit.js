const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function loadScript(file, contextExtras = {}) {
    const context = {
        console,
        window: {},
        document: { readyState: 'complete' },
        localStorage: {
            _data: new Map(),
            getItem(k) { return this._data.has(k) ? this._data.get(k) : null; },
            setItem(k, v) { this._data.set(k, String(v)); },
            removeItem(k) { this._data.delete(k); }
        },
        STORAGE_KEYS: {
            USERS: 'edumatch_users', SUBJECTS: 'edumatch_subjects', REQUESTS: 'edumatch_requests', CURRENT_USER: 'edumatch_current_user'
        },
        nowLocalTimestamp: () => '2026-09-30 12:00',
        getStoredData(key, fallback) {
            const value = context.localStorage.getItem(key);
            return value ? JSON.parse(value) : fallback;
        },
        updateUserSession() {}, renderSubjects() {}, renderTutors() {}, renderRequests() {}, updateStats() {},
        ...contextExtras
    };
    for (const [key, value] of Object.entries(contextExtras)) context[key] = value;
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    return context;
}

(function passwordValidationTests() {
    const ctx = loadScript('/mnt/data/edumatch_work/edumatch_inspect/assets/js/auth.js', {
        ROLES: { STUDENT: 'Estudiante', TUTOR: 'Tutor' },
        showToast() {},
        togglePasswordVisibility() {},
        resetPasswordVisibility() {},
        renderSubjectCheckboxList() {},
        saveData() {},
        closeModal() {},
        refreshAfterAuthChange() {}
    });
    assert.strictEqual(ctx.validateRegistrationPassword('abc'), 'La contraseña debe tener al menos 8 caracteres.');
    assert.strictEqual(ctx.validateRegistrationPassword('abcdefgh'), 'La contraseña debe incluir al menos una letra mayúscula.');
    assert.strictEqual(ctx.validateRegistrationPassword('Abcdefgh'), 'La contraseña debe incluir al menos un número.');
    assert.strictEqual(ctx.validateRegistrationPassword('Abcdefg1'), 'La contraseña debe incluir al menos un carácter especial.');
    assert.strictEqual(ctx.validateRegistrationPassword('Abcdefg1!'), null);
    assert.strictEqual(ctx.translateAuthError(new Error('Invalid login credentials'), 'fallback'), 'Correo o contraseña incorrectos.');
    assert.strictEqual(ctx.translateAuthError(new Error('User already registered'), 'fallback'), 'Ya existe una cuenta registrada con ese correo.');
    console.log('✓ Validación y traducción de autenticación');
})();

(async function backendRequestUpdateTest() {
    const calls = [];
    const requestId = 1709876543210;
    const existingRequest = { id: requestId };
    const rows = {
        perfiles: [{ id: 'student-1', nombre: 'Estudiante', correo: 'student@example.com', rol: 'Estudiante', activo: true, creado_en: '2026-09-30T15:00:00Z' }, { id: 'tutor-1', nombre: 'Tutor', correo: 'tutor@example.com', rol: 'Tutor', activo: true, creado_en: '2026-09-30T15:00:00Z' }],
        materias: [{ id: 1, nombre: 'Cálculo Diferencial', categoria: 'Matemáticas', descripcion: 'Descripción', creada_por: null }],
        tutor_materias: [{ tutor_id: 'tutor-1', materia_id: 1 }],
        solicitudes_tutoria: [existingRequest],
        calificaciones: [],
        historial_solicitud: []
    };

    function chain(table) {
        const state = { table, filters: {}, mode: 'select' };
        const api = {
            select() { state.mode = 'select'; return api; },
            order() { return api; },
            eq(k, v) { state.filters[k] = v; return api; },
            maybeSingle: async () => ({ data: table === 'solicitudes_tutoria' && state.filters.id === requestId ? existingRequest : null, error: null }),
            update(row) { state.mode = 'update'; state.row = row; return api; },
            insert(row) { state.mode = 'insert'; state.row = row; return api; },
            delete() { state.mode = 'delete'; return api; },
            upsert(row) { state.mode = 'upsert'; state.row = row; return api; },
            then(resolve) {
                calls.push({ table, mode: state.mode, row: state.row, filters: state.filters });
                if (state.mode === 'select') return resolve({ data: rows[table] || [], error: null });
                if (state.mode === 'update') return resolve({ data: null, error: null });
                if (state.mode === 'insert') return resolve({ data: null, error: null });
                if (state.mode === 'delete') return resolve({ data: null, error: null });
                if (state.mode === 'upsert') return resolve({ data: null, error: null });
            }
        };
        return api;
    }

    const client = {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'tutor-1' } } }, error: null }), onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; } },
        from(table) { return chain(table); },
        channel() { return { on() { return this; }, subscribe() { return this; } }; }
    };

    const ctx = loadScript('/mnt/data/edumatch_work/edumatch_inspect/assets/js/backend.js', {
        showToast() {},
        supabase: { createClient: () => client },
        EDUMATCH_SUPABASE_CONFIG: { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' }
    });

    ctx.localStorage.setItem('edumatch_users', JSON.stringify([
        { id: 'student-1', role: 'Estudiante', name: 'Estudiante', email: 'student@example.com', subjects: [] },
        { id: 'tutor-1', role: 'Tutor', name: 'Tutor', email: 'tutor@example.com', subjects: ['Cálculo Diferencial'] }
    ]));
    ctx.localStorage.setItem('edumatch_subjects', JSON.stringify([{ id: 1, name: 'Cálculo Diferencial', category: 'Matemáticas', description: 'Descripción' }]));

    await ctx.window.EduMatchBackend.bootstrap();
    const request = {
        id: requestId,
        studentId: 'student-1',
        subject: 'Cálculo Diferencial',
        tutorId: 'tutor-1',
        preferredDate: '2026-09-30',
        preferredTime: '16:10',
        topic: 'Gráficas',
        status: 'Aceptada',
        history: [{ type: 'created', at: '2026-09-30 12:00' }, { type: 'accepted', at: '2026-09-30 12:05', tutorName: 'Tutor' }],
        rating: null
    };
    await ctx.window.EduMatchBackend.syncRequest(request);

    const requestCalls = calls.filter(c => c.table === 'solicitudes_tutoria');
    assert(requestCalls.some(c => c.mode === 'update'), 'La actualización de una solicitud existente debe usar UPDATE.');
    assert(!requestCalls.some(c => c.mode === 'upsert'), 'No debe usar UPSERT para que un tutor actualice una solicitud existente.');
    assert(!requestCalls.some(c => c.mode === 'insert'), 'No debe INSERTAR al actualizar una solicitud existente.');
    console.log('✓ Actualización de solicitudes compatible con RLS (tutor)');
})();

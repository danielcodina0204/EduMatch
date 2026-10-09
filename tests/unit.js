const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = file => path.join(__dirname, '..', 'assets', 'js', file);
const KEYS = { USERS: 'edumatch_users', SUBJECTS: 'edumatch_subjects', REQUESTS: 'edumatch_requests', CURRENT_USER: 'edumatch_current_user' };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function createStorage() {
    return {
        _data: new Map(),
        getItem(k) { return this._data.has(k) ? this._data.get(k) : null; },
        setItem(k, v) { this._data.set(k, String(v)); },
        removeItem(k) { this._data.delete(k); }
    };
}

function createContext(files, extras = {}) {
    const context = {
        console: { ...console, error() {} },
        setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)),
        clearTimeout,
        document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
        localStorage: createStorage(),
        toasts: [],
        ...extras
    };
    context.showToast = context.showToast || ((message, type, options) => { context.toasts.push({ message, type, options }); });
    context.window = context;
    vm.createContext(context);
    for (const file of files) vm.runInContext(fs.readFileSync(JS(file), 'utf8'), context, { filename: file });
    return context;
}

const ACTIVE_DB_STATES = ['pendiente', 'propuesta_horario', 'aceptada'];

// options.rls emula las políticas de supabase/migrations para solicitudes e
// historial (incluida la exigencia de que la fila nueva de un UPDATE cumpla la
// política SELECT). options.authUsers emula Supabase Auth: { correo: { id, password } }.
function createFakeSupabase(initial, sessionUserId, options = {}) {
    const db = JSON.parse(JSON.stringify(initial));
    const calls = [];
    const failures = [];
    const authUsers = options.authUsers || {};
    let uid = sessionUserId;
    let nextId = 100;

    const solicitud = id => (db.solicitudes_tutoria || []).find(s => String(s.id) === String(id));
    const isParty = s => !!s && (s.estudiante_id === uid || s.tutor_id === uid);
    const canSelectRequest = s => isParty(s) || (s.tutores_rechazados || []).includes(uid);
    const rlsError = { code: '42501', message: 'new row violates row-level security policy' };

    function builder(table) {
        const st = { table, mode: 'select', filters: [], row: null, opts: {}, returning: false, head: false };
        const matches = r => st.filters.every(([op, k, v]) => op === 'eq' ? String(r[k]) === String(v) : v.map(String).includes(String(r[k])));
        const visible = r => !options.rls
            || (table === 'solicitudes_tutoria' ? canSelectRequest(r)
                : table === 'historial_solicitud' ? isParty(solicitud(r.solicitud_id))
                : true);
        const run = () => {
            calls.push({ table, mode: st.mode, row: st.row, filters: st.filters.slice(), opts: st.opts, cols: st.cols, uid });
            const forced = failures.find(f => f.table === table && f.mode === st.mode && (!f.when || f.when(st)));
            if (forced) return { data: null, error: forced.error, count: null };
            const rows = db[table] || (db[table] = []);
            if (options.rls && table === 'historial_solicitud' && st.mode === 'insert') {
                const list = Array.isArray(st.row) ? st.row : [st.row];
                if (list.some(item => !isParty(solicitud(item.solicitud_id)))) return { data: null, error: rlsError };
            }
            if (options.rls && table === 'solicitudes_tutoria' && st.mode === 'update') {
                const hit = rows.filter(r => matches(r) && isParty(r));
                if (hit.some(r => !canSelectRequest({ ...r, ...st.row }))) return { data: null, error: rlsError };
                hit.forEach(r => Object.assign(r, st.row));
                return { data: hit, error: null };
            }
            if (st.mode === 'select') {
                const data = rows.filter(r => matches(r) && visible(r));
                return { data: st.head ? null : data, error: null, count: data.length };
            }
            if (st.mode === 'insert' || st.mode === 'upsert') {
                const list = Array.isArray(st.row) ? st.row : [st.row];
                const inserted = [];
                for (const item of list) {
                    const record = { ...item };
                    if (table === 'materias' && record.id == null) record.id = nextId++;
                    const pk = table === 'tutor_materias' ? r => r.tutor_id === record.tutor_id && r.materia_id === record.materia_id
                        : table === 'calificaciones' ? r => r.solicitud_id === record.solicitud_id
                        : r => r.id != null && r.id === record.id;
                    const existing = rows.find(pk);
                    if (existing) {
                        if (st.mode === 'insert') return { data: null, error: { code: '23505', message: 'duplicate key' } };
                        if (!st.opts.ignoreDuplicates) Object.assign(existing, record);
                        continue;
                    }
                    rows.push(record);
                    inserted.push(record);
                }
                return { data: inserted, error: null };
            }
            if (st.mode === 'update') {
                const hit = rows.filter(matches);
                hit.forEach(r => Object.assign(r, st.row));
                return { data: hit, error: null };
            }
            if (st.mode === 'delete') {
                const hit = rows.filter(matches);
                db[table] = rows.filter(r => !hit.includes(r));
                return { data: hit, error: null };
            }
            return { data: null, error: null };
        };
        const api = {
            select(cols, opts = {}) { if (st.mode === 'select') st.cols = cols; else st.returning = true; st.head = !!opts.head; return api; },
            eq(k, v) { st.filters.push(['eq', k, v]); return api; },
            in(k, v) { st.filters.push(['in', k, v]); return api; },
            order() { return api; },
            limit() { return api; },
            insert(row) { st.mode = 'insert'; st.row = row; return api; },
            upsert(row, opts = {}) { st.mode = 'upsert'; st.row = row; st.opts = opts; return api; },
            update(row) { st.mode = 'update'; st.row = row; return api; },
            delete() { st.mode = 'delete'; return api; },
            maybeSingle: async () => { const r = run(); return { data: (r.data || [])[0] || null, error: r.error }; },
            single: async () => { const r = run(); return { data: (r.data || [])[0] || null, error: r.error }; },
            then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } }
        };
        return api;
    }

    const rpcHandlers = {
        existe_cuenta: ({ p_correo }) => Object.prototype.hasOwnProperty.call(authUsers, String(p_correo).trim().toLowerCase()),
        // Misma lógica que public.tutores_elegibles_reasignacion.
        tutores_elegibles_reasignacion: ({ p_solicitud_id }) => {
            const s = solicitud(p_solicitud_id);
            if (!s) return [];
            return (db.perfiles || [])
                .filter(p => p.rol === 'Tutor' && p.activo
                    && (db.tutor_materias || []).some(tm => tm.tutor_id === p.id && tm.materia_id === s.materia_id)
                    && p.id !== s.estudiante_id && p.id !== s.tutor_id
                    && !(s.tutores_rechazados || []).includes(p.id)
                    && !(db.solicitudes_tutoria || []).some(o => o.id !== s.id && o.estudiante_id === s.estudiante_id
                        && o.materia_id === s.materia_id && o.tutor_id === p.id && ACTIVE_DB_STATES.includes(o.estado)))
                .map(p => ({ id_tutor: p.id }));
        },
        // Misma lógica que public.rechazar_solicitud (valida, reasigna y escribe el historial).
        rechazar_solicitud: ({ p_solicitud_id }) => {
            const s = solicitud(p_solicitud_id);
            if (!s || s.tutor_id !== uid) throw { code: 'EM001', message: 'Esta solicitud ya no está asignada a ti.' };
            if (s.estado !== 'pendiente') throw { code: 'EM002', message: 'Esta solicitud ya no está pendiente.' };
            const nameOf = id => ((db.perfiles || []).find(p => p.id === id) || {}).nombre;
            const next = rpcHandlers.tutores_elegibles_reasignacion({ p_solicitud_id })[0];
            const addEvent = (tipo, detalles) => (db.historial_solicitud || (db.historial_solicitud = []))
                .push({ id: nextId++, solicitud_id: s.id, tipo, fecha_evento: new Date().toISOString(), detalles });
            const previous = s.tutor_id;
            s.tutores_rechazados = [...new Set([...(s.tutores_rechazados || []), previous])];
            addEvent('tutor_rejected', { tutorId: previous, tutorName: nameOf(previous) });
            if (next) {
                Object.assign(s, { tutor_id: next.id_tutor, estado: 'pendiente', respondida_en: null, motivo_cancelacion: null });
                addEvent('tutor_reassigned', { tutorId: next.id_tutor, tutorName: nameOf(next.id_tutor), fromTutorName: nameOf(previous), reason: 'rejected', resultingStatus: 'Pendiente' });
                return { reasignada: true, tutor_id: next.id_tutor, tutor_nombre: nameOf(next.id_tutor), estado: 'pendiente' };
            }
            Object.assign(s, { estado: 'cancelada', motivo_cancelacion: 'no_tutors' });
            addEvent('no_more_tutors', {});
            return { reasignada: false, tutor_id: null, tutor_nombre: null, estado: 'cancelada' };
        }
    };

    const client = {
        auth: {
            getSession: async () => ({ data: { session: uid ? { user: { id: uid, email: `${uid}@example.com` } } : null }, error: null }),
            onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
            signOut: async () => { calls.push({ table: 'auth', mode: 'signOut' }); uid = null; return { error: null }; },
            signInWithPassword: async ({ email, password }) => {
                const forced = failures.find(f => f.table === 'auth' && f.mode === 'signIn');
                if (forced) return { data: { user: null, session: null }, error: forced.error };
                const account = authUsers[String(email).toLowerCase()];
                if (!account || account.password !== password) {
                    return { data: { user: null, session: null }, error: { name: 'AuthApiError', status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } };
                }
                uid = account.id;
                return { data: { user: { id: uid }, session: { user: { id: uid } } }, error: null };
            }
        },
        from: builder,
        rpc: async (name, args = {}) => {
            calls.push({ table: 'rpc', mode: name, args });
            const f = failures.find(x => x.table === 'rpc' && (!x.name || x.name === name));
            if (f) return { data: null, error: f.error };
            try {
                return { data: rpcHandlers[name] ? rpcHandlers[name](args) : null, error: null };
            } catch (e) {
                return { data: null, error: { code: e.code, message: e.message } };
            }
        },
        channel() { return { on() { return this; }, subscribe() { return this; } }; }
    };
    return { client, db, calls, failures };
}

const BASE_DB = () => ({
    perfiles: [
        { id: 'student-1', nombre: 'Sol', correo: 'sol@example.com', rol: 'Estudiante', activo: true, creado_en: '2026-09-30T15:00:00Z' },
        { id: 'tutor-a', nombre: 'Ana', correo: 'ana@example.com', rol: 'Tutor', activo: true, creado_en: '2026-09-30T15:00:00Z' },
        { id: 'tutor-b', nombre: 'Beto', correo: 'beto@example.com', rol: 'Tutor', activo: true, creado_en: '2026-09-30T15:00:00Z' }
    ],
    materias: [
        { id: 1, nombre: 'Cálculo Diferencial', categoria: 'Matemáticas', descripcion: 'Límites', creada_por: null },
        { id: 7, nombre: 'Cálculo 4', categoria: 'Personalizada', descripcion: 'x', creada_por: 'tutor-a' }
    ],
    tutor_materias: [{ tutor_id: 'tutor-a', materia_id: 1 }, { tutor_id: 'tutor-b', materia_id: 1 }, { tutor_id: 'tutor-a', materia_id: 7 }],
    solicitudes_tutoria: [],
    historial_solicitud: [],
    calificaciones: []
});

async function bootBackend(db, userId, options = {}) {
    const fake = createFakeSupabase(db, userId, options);
    const ctx = createContext(options.files || ['data.js', 'backend.js'], {
        supabase: { createClient: () => fake.client },
        EDUMATCH_SUPABASE_CONFIG: { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' },
        ...(options.extras || {})
    });
    await ctx.EduMatchBackend.bootstrap();
    fake.calls.length = 0;
    return { ctx, ...fake, stored: key => JSON.parse(ctx.localStorage.getItem(key) || 'null') };
}

// App completa (data + backend + app) contra el Supabase simulado con RLS.
async function bootFull(db, userId) {
    const env = await bootBackend(db, userId, {
        rls: true,
        files: ['data.js', 'backend.js', 'app.js'],
        extras: { switchTab() {}, openConfirmModal() {}, refreshAfterAuthChange() {}, updateStats() {} }
    });
    const elements = {};
    env.ctx.document.getElementById = id => elements[id] || (elements[id] = fakeElement());
    env.ctx.document.createElement = () => ({
        textContent: '',
        get innerHTML() { return String(this.textContent).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    });
    env.ctx.getCurrentUser = () => env.stored(KEYS.CURRENT_USER);
    env.ctx.setCurrentUser = u => env.ctx.localStorage.setItem(KEYS.CURRENT_USER, JSON.stringify(u));
    return env;
}

function fakeElement() {
    return { innerHTML: '', value: '', textContent: '', style: {}, options: [], appendChild(o) { this.options.push(o); }, classList: { add() {}, remove() {}, toggle() {} } };
}

function bootApp(user, store = {}) {
    const elements = {};
    const ctx = createContext(['data.js', 'app.js'], {
        getCurrentUser: () => user,
        setCurrentUser(u) { user = u; },
        switchTab() {},
        openConfirmModal() {},
        refreshAfterAuthChange() {},
        updateStats() {}
    });
    ctx.document.getElementById = id => elements[id] || (elements[id] = fakeElement());
    ctx.document.createElement = () => ({
        value: '',
        textContent: '',
        get innerHTML() { return String(this.textContent).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    });
    for (const [key, value] of Object.entries(store)) ctx.localStorage.setItem(key, JSON.stringify(value));
    return { ctx, elements, stored: key => JSON.parse(ctx.localStorage.getItem(key) || 'null') };
}

const USERS = [
    { id: 'student-1', role: 'Estudiante', name: 'Sol', email: 'sol@example.com', subjects: [] },
    { id: 'tutor-a', role: 'Tutor', name: 'Ana', email: 'ana@example.com', subjects: ['Cálculo Diferencial', 'Cálculo 4'] },
    { id: 'tutor-b', role: 'Tutor', name: 'Beto', email: 'beto@example.com', subjects: ['Cálculo Diferencial'] }
];
const SUBJECTS = [
    { id: 1, name: 'Cálculo Diferencial', category: 'Matemáticas', description: 'Límites', createdBy: null },
    { id: 7, name: 'Cálculo 4', category: 'Personalizada', description: 'x', createdBy: 'tutor-a' },
    { id: 8, name: 'Física', category: 'Física', description: 'y', createdBy: null }
];
const pendingRequest = (extra = {}) => ({
    id: 1709876543210, studentId: 'student-1', studentName: 'Sol', subject: 'Cálculo Diferencial',
    tutorId: 'tutor-a', tutorName: 'Ana', preferredDate: '2026-10-10', preferredTime: '16:10', topic: 'Derivadas',
    status: 'Pendiente', rating: null, rejectedTutorIds: [], history: [{ type: 'created', at: '2026-10-01 12:00' }], ...extra
});

test('Tutor: "Mis materias a cargo" muestra solo sus materias y el botón "Ver tutorías"', () => {
    const { ctx, elements } = bootApp(USERS[1], { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS });
    ctx.renderSubjects();
    const html = elements.subjectsGrid.innerHTML;
    assert(html.includes('Cálculo 4') && html.includes('Cálculo Diferencial'));
    assert(!html.includes('Física'), 'No debe mostrar materias que no tiene asignadas.');
    assert(html.includes('Ver tutorías') && !html.includes('Solicitar Tutoría'));
});

test('Tutor: no ve la lista de otros tutores ni correos', () => {
    const { ctx, elements } = bootApp(USERS[1], { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS });
    ctx.renderTutors();
    const html = elements.tutorsGrid.innerHTML;
    assert(html.includes('Ana') && !html.includes('Beto'));
    assert(!html.includes('@example.com'));
    assert(!html.includes('Solicitar con este tutor'));
});

test('Estudiante: ve tutores con nombre y materias, sin correo ni IDs, y "Solicitar Tutoría"', () => {
    const { ctx, elements } = bootApp(USERS[0], { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS });
    ctx.renderTutors();
    ctx.renderSubjects();
    const tutors = elements.tutorsGrid.innerHTML;
    assert(tutors.includes('Ana') && tutors.includes('Beto') && tutors.includes('Cálculo 4'));
    assert(!tutors.includes('@example.com'));
    assert(!/>\s*tutor-a\s*</.test(tutors), 'No debe mostrar IDs como texto.');
    assert(!tutors.includes('Eliminar mi perfil') && !tutors.includes('Agregar materia'));
    assert(elements.subjectsGrid.innerHTML.includes('Solicitar Tutoría') && !elements.subjectsGrid.innerHTML.includes('Ver tutorías'));
});

test('Privacidad: no se consultan correos ajenos; el propio sale de la sesión', async () => {
    const { ctx, calls, stored } = await bootBackend(BASE_DB(), 'student-1');
    await ctx.EduMatchBackend.hydrate();
    const profileQuery = calls.find(c => c.table === 'perfiles');
    assert(profileQuery && !/correo/.test(profileQuery.cols), 'La consulta de perfiles no debe pedir la columna correo.');
    const users = stored(KEYS.USERS);
    assert(users.filter(u => u.id !== 'student-1').every(u => !u.email), 'No debe haber correos de otros usuarios en el estado local.');
    assert.strictEqual(stored(KEYS.CURRENT_USER).email, 'student-1@example.com');
});

test('Crear materia nueva: INSERT en materias, ID real y después tutor_materias', async () => {
    const { ctx, calls, db } = await bootBackend(BASE_DB(), 'tutor-a');
    const created = await ctx.EduMatchBackend.createTutorSubject('tutor-a', { name: 'Química Orgánica', description: 'z', category: 'Personalizada' });
    assert.strictEqual(created.id, 100, 'Debe usar el ID generado por Supabase.');
    assert.strictEqual(created.alreadyExisted, false);
    const iMateria = calls.findIndex(c => c.table === 'materias' && c.mode === 'insert');
    const iRel = calls.findIndex(c => c.table === 'tutor_materias' && c.mode === 'insert');
    assert(iMateria >= 0 && iRel > iMateria, 'Primero la materia, después la relación.');
    assert.strictEqual(calls[iRel].row.materia_id, 100);
    assert(db.tutor_materias.some(r => r.tutor_id === 'tutor-a' && r.materia_id === 100));
});

test('Crear materia con nombre existente (otra capitalización) no duplica el catálogo', async () => {
    const { ctx, calls, db } = await bootBackend(BASE_DB(), 'tutor-b');
    const result = await ctx.EduMatchBackend.createTutorSubject('tutor-b', { name: '  cálculo   4 ' });
    assert.strictEqual(result.id, 7);
    assert.strictEqual(result.alreadyExisted, true);
    assert(!calls.some(c => c.table === 'materias' && c.mode === 'insert'));
    assert.strictEqual(db.materias.length, 2);
    assert(db.tutor_materias.some(r => r.tutor_id === 'tutor-b' && r.materia_id === 7));
});

test('Agregar materia existente: solo INSERT en tutor_materias y sin duplicados', async () => {
    const { ctx, calls, db } = await bootBackend(BASE_DB(), 'tutor-b');
    const first = await ctx.EduMatchBackend.assignTutorSubject('tutor-b', 'Cálculo 4');
    assert.strictEqual(first.ok, true);
    const writes = calls.filter(c => c.mode !== 'select');
    assert(writes.every(c => c.table === 'tutor_materias' && c.mode === 'insert'), 'No debe tocar materias ni usar UPSERT/UPDATE/DELETE.');
    const again = await ctx.EduMatchBackend.assignTutorSubject('tutor-b', 'Cálculo 4');
    assert.strictEqual(again.ok, true, 'Una relación existente (23505) no es un error para el usuario.');
    assert.strictEqual(db.tutor_materias.filter(r => r.tutor_id === 'tutor-b' && r.materia_id === 7).length, 1);
});

test('Guardar el catálogo local ya no hace UPSERT masivo en materias (causa del error de permisos)', async () => {
    const { ctx, calls } = await bootBackend(BASE_DB(), 'tutor-a');
    const result = await ctx.EduMatchBackend.onLocalDataSaved(KEYS.SUBJECTS, SUBJECTS);
    assert.strictEqual(result, true);
    assert(!calls.some(c => c.table === 'materias' && c.mode !== 'select'));
});

test('Registro de tutor: relaciones en una sola escritura ON CONFLICT DO NOTHING', async () => {
    const { ctx, calls } = await bootBackend(BASE_DB(), 'tutor-a');
    const users = JSON.parse(ctx.localStorage.getItem(KEYS.USERS));
    users.find(u => u.id === 'tutor-a').subjects = ['Cálculo Diferencial', 'Cálculo 4'];
    ctx.localStorage.setItem(KEYS.USERS, JSON.stringify(users));
    const result = await ctx.EduMatchBackend.syncTutorSubjects('tutor-a');
    assert.strictEqual(result.ok, true);
    const writes = calls.filter(c => c.table === 'tutor_materias' && c.mode !== 'select');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].mode, 'upsert');
    assert.strictEqual(writes[0].opts.ignoreDuplicates, true);
});

test('Eliminar materia personalizada: bloqueos y eliminación verificada', async () => {
    const db = BASE_DB();
    db.tutor_materias.push({ tutor_id: 'tutor-b', materia_id: 7 });
    let env = await bootBackend(db, 'tutor-a');
    let r = await env.ctx.EduMatchBackend.deleteCustomSubject('tutor-a', 'Cálculo 4');
    assert(r.ok === false && /otro tutor/.test(r.message), JSON.stringify(r));
    assert(!env.calls.some(c => c.table === 'materias' && c.mode === 'delete'));

    env = await bootBackend(db, 'tutor-b');
    r = await env.ctx.EduMatchBackend.deleteCustomSubject('tutor-b', 'Cálculo 4');
    assert(r.ok === false && /creadas por ti/.test(r.message), 'Solo el creador puede eliminar.');

    const db2 = BASE_DB();
    db2.solicitudes_tutoria.push({ id: 5, materia_id: 7, estudiante_id: 'student-1', tutor_id: 'tutor-a', estado: 'realizada' });
    env = await bootBackend(db2, 'tutor-a');
    r = await env.ctx.EduMatchBackend.deleteCustomSubject('tutor-a', 'Cálculo 4');
    assert(r.ok === false && /solicitudes/.test(r.message), 'Debe proteger los datos históricos.');

    env = await bootBackend(BASE_DB(), 'tutor-a');
    r = await env.ctx.EduMatchBackend.deleteCustomSubject('tutor-a', 'Cálculo 4');
    assert.strictEqual(r.ok, true);
    assert(!env.db.materias.some(m => m.id === 7));
    assert(env.stored(KEYS.SUBJECTS).every(s => s.id !== 7), 'El estado local se actualiza desde Supabase.');

    env = await bootBackend(BASE_DB(), 'tutor-a');
    const realDelete = env.client.from;
    env.client.from = table => {
        const b = realDelete(table);
        if (table === 'materias') b.delete = () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) });
        return b;
    };
    r = await env.ctx.EduMatchBackend.deleteCustomSubject('tutor-a', 'Cálculo 4');
    assert(r.ok === false, 'Si RLS no borra ninguna fila no debe informarse éxito.');
});

test('Eliminar materia personalizada (UI): un solo resultado, deshacer y bloqueo previo', async () => {
    const tutor = { ...USERS[1] };
    const { ctx, elements } = bootApp(tutor, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS, [KEYS.REQUESTS]: [] });
    ctx.scheduleCustomSubjectDeletion('tutor-a', 'Cálculo 4');
    const undoToast = ctx.toasts.pop();
    assert.strictEqual(undoToast.options.actionLabel, 'Deshacer');
    assert.strictEqual(undoToast.options.duration, 5000);
    ctx.renderSubjects();
    assert(!elements.subjectsGrid.innerHTML.includes('Cálculo 4'), 'Durante la ventana de deshacer se oculta.');
    undoToast.options.onAction();
    ctx.renderSubjects();
    assert(elements.subjectsGrid.innerHTML.includes('Cálculo 4'), 'Deshacer restaura el estado.');

    ctx.toasts.length = 0;
    const withOtherTutor = USERS.map(u => u.id === 'tutor-b' ? { ...u, subjects: [...u.subjects, 'Cálculo 4'] } : u);
    ctx.localStorage.setItem(KEYS.USERS, JSON.stringify(withOtherTutor));
    ctx.scheduleCustomSubjectDeletion('tutor-a', 'Cálculo 4');
    assert.strictEqual(ctx.toasts.length, 1);
    assert.strictEqual(ctx.toasts[0].type, 'error');
    assert(!ctx.toasts[0].options, 'Si está bloqueada no se programa la eliminación.');

    ctx.toasts.length = 0;
    ctx.localStorage.setItem(KEYS.USERS, JSON.stringify(USERS));
    ctx.EduMatchBackend = { isEnabled: () => true, deleteCustomSubject: async () => ({ ok: false, message: 'x' }) };
    ctx.scheduleCustomSubjectDeletion('tutor-a', 'Cálculo 4');
    await ctx.toasts.pop().options.onExpire();
    assert(!ctx.toasts.some(t => t.type === 'success'), 'Un fallo remoto no debe mostrar éxito.');
    ctx.renderSubjects();
    assert(elements.subjectsGrid.innerHTML.includes('Cálculo 4'), 'Si falla, la materia vuelve a mostrarse.');
});

test('Eliminar cuenta de tutor: bloqueada con tutorías activas', async () => {
    const tutor = { ...USERS[1] };
    const { ctx } = bootApp(tutor, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS, [KEYS.REQUESTS]: [pendingRequest()] });
    let confirmOpened = false;
    ctx.openConfirmModal = () => { confirmOpened = true; };
    await ctx.deleteTutorProfile('tutor-a');
    assert(!confirmOpened);
    assert.strictEqual(ctx.toasts[0].message, 'No se puede eliminar en este momento: tienes tutorías a tu cargo.');

    const env = await bootBackend(BASE_DB(), 'tutor-a');
    env.failures.push({ table: 'rpc', error: { code: 'P0001', message: 'No se puede eliminar en este momento: tienes tutorías a tu cargo' } });
    const r = await env.ctx.EduMatchBackend.deleteTutorAccount('tutor-a');
    assert(r.ok === false && r.message === 'No se puede eliminar en este momento: tienes tutorías a tu cargo.');
});

test('Eliminar cuenta de tutor: confirmación, deshacer y RPC sin reescribir el historial', async () => {
    const tutor = { ...USERS[1] };
    const done = pendingRequest({ status: 'Realizada' });
    const { ctx, stored } = bootApp(tutor, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS, [KEYS.REQUESTS]: [done], [KEYS.CURRENT_USER]: tutor });
    let confirm = null;
    ctx.openConfirmModal = opts => { confirm = opts; };
    const rpcCalls = [];
    ctx.EduMatchBackend = {
        isEnabled: () => true,
        getTutorActiveRequestCount: async () => 0,
        deleteTutorAccount: async id => { rpcCalls.push(id); return { ok: true }; },
        onLocalDataSaved: async () => { throw new Error('No debe sincronizar solicitudes al eliminar la cuenta.'); }
    };
    await ctx.deleteTutorProfile('tutor-a');
    assert(confirm, 'Debe pedir confirmación.');
    confirm.onConfirm();
    const undo = ctx.toasts.pop();
    undo.options.onAction();
    confirm.onConfirm();
    await ctx.toasts.pop().options.onExpire();
    assert.strictEqual(JSON.stringify(rpcCalls), '["tutor-a"]');
    assert.strictEqual(stored(KEYS.REQUESTS)[0].tutorId, 'tutor-a', 'El historial lo gestiona la FK en Supabase.');
    assert(!stored(KEYS.USERS).some(u => u.id === 'tutor-a'));
    assert.strictEqual(ctx.toasts.filter(t => t.type === 'error').length, 0);
});

test('Solicitud: el estudiante inserta la fila antes que el historial', async () => {
    const env = await bootBackend(BASE_DB(), 'student-1');
    const requests = [pendingRequest()];
    assert.strictEqual(await env.ctx.EduMatchBackend.onLocalDataSaved(KEYS.REQUESTS, requests), true);
    const iRow = env.calls.findIndex(c => c.table === 'solicitudes_tutoria' && c.mode === 'insert');
    const iHist = env.calls.findIndex(c => c.table === 'historial_solicitud' && c.mode === 'insert');
    assert(iRow >= 0 && iHist > iRow);
});

test('Rechazo con reasignación automática: conserva materia, estudiante, fecha y hora', async () => {
    const { ctx, stored } = bootApp({ ...USERS[1] }, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS, [KEYS.REQUESTS]: [pendingRequest()] });
    await ctx.rejectRequest(1709876543210);
    const r = stored(KEYS.REQUESTS)[0];
    assert.strictEqual(r.tutorId, 'tutor-b');
    assert.strictEqual(r.status, 'Pendiente');
    assert.strictEqual(r.subject, 'Cálculo Diferencial');
    assert.strictEqual(r.studentId, 'student-1');
    assert.strictEqual(r.preferredDate, '2026-10-10');
    assert.strictEqual(r.preferredTime, '16:10');
    assert.deepStrictEqual(r.rejectedTutorIds, ['tutor-a']);
    assert.deepStrictEqual(r.history.map(e => e.type), ['created', 'tutor_rejected', 'tutor_reassigned']);
});

test('Rechazo sin más tutores: la solicitud se cancela', async () => {
    const users = USERS.map(u => u.id === 'tutor-b' ? { ...u, subjects: [] } : u);
    const { ctx, stored } = bootApp({ ...USERS[1] }, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: users, [KEYS.REQUESTS]: [pendingRequest()] });
    await ctx.rejectRequest(1709876543210);
    const r = stored(KEYS.REQUESTS)[0];
    assert.strictEqual(r.status, 'Cancelada');
    assert.strictEqual(r.cancellationReason, 'no_tutors');
});

test('Reasignación en Supabase: el tutor anterior escribe el historial y luego actualiza', async () => {
    const db = BASE_DB();
    db.solicitudes_tutoria.push({ id: 1709876543210, estudiante_id: 'student-1', tutor_id: 'tutor-a', materia_id: 1, estado: 'pendiente' });
    const env = await bootBackend(db, 'tutor-a');
    const request = pendingRequest({
        tutorId: 'tutor-b', tutorName: 'Beto', rejectedTutorIds: ['tutor-a'],
        history: [
            { type: 'created', at: '2026-10-01 12:00' },
            { type: 'tutor_rejected', at: '2026-10-01 12:05', tutorId: 'tutor-a', tutorName: 'Ana' },
            { type: 'tutor_reassigned', at: '2026-10-01 12:05', tutorId: 'tutor-b', tutorName: 'Beto', fromTutorName: 'Ana', reason: 'rejected', resultingStatus: 'Pendiente' }
        ]
    });
    assert.strictEqual(await env.ctx.EduMatchBackend.onLocalDataSaved(KEYS.REQUESTS, [request]), true);
    const iHist = env.calls.findIndex(c => c.table === 'historial_solicitud' && c.mode === 'insert');
    const iUpd = env.calls.findIndex(c => c.table === 'solicitudes_tutoria' && c.mode === 'update');
    assert(iHist >= 0 && iUpd > iHist, 'El historial debe escribirse mientras el tutor aún participa (RLS).');
    const update = env.calls[iUpd].row;
    assert.strictEqual(update.tutor_id, 'tutor-b');
    assert.strictEqual(update.fecha_preferida, '2026-10-10');
    assert.strictEqual(update.hora_preferida, '16:10');
    assert.strictEqual(JSON.stringify(update.tutores_rechazados), '["tutor-a"]');
    assert(!env.calls.some(c => c.table === 'solicitudes_tutoria' && ['insert', 'upsert'].includes(c.mode)));
});

test('Tutor anterior: no reintenta sincronizar solicitudes que ya no le pertenecen', async () => {
    const db = BASE_DB();
    db.solicitudes_tutoria.push({ id: 1709876543210, estudiante_id: 'student-1', tutor_id: 'tutor-b', materia_id: 1, estado: 'pendiente' });
    const env = await bootBackend(db, 'tutor-a');
    const request = pendingRequest({ tutorId: 'tutor-b', topic: 'cambio local', history: [{ type: 'tutor_rejected', at: '2026-10-01 12:05', tutorId: 'tutor-a' }] });
    assert.strictEqual(await env.ctx.EduMatchBackend.onLocalDataSaved(KEYS.REQUESTS, [request]), true);
    assert(!env.calls.some(c => c.mode !== 'select'), 'No debe intentar escrituras que RLS rechazaría.');
});

test('Sincronización: solo solicitudes modificadas y sin duplicar historial (orden de claves jsonb)', async () => {
    const db = BASE_DB();
    db.solicitudes_tutoria.push(
        { id: 1, estudiante_id: 'student-1', tutor_id: 'tutor-a', materia_id: 1, estado: 'pendiente', fecha_preferida: '2026-10-10', hora_preferida: '10:00:00', creada_en: '2026-10-01T17:00:00Z' },
        { id: 2, estudiante_id: 'student-1', tutor_id: 'tutor-a', materia_id: 1, estado: 'pendiente', fecha_preferida: '2026-10-11', hora_preferida: '11:00:00', creada_en: '2026-10-01T17:00:00Z' }
    );
    db.historial_solicitud.push({ id: 1, solicitud_id: 1, tipo: 'tutor_assigned', fecha_evento: '2026-10-01T17:00:00Z', detalles: { tutorId: 'tutor-a', tutorName: 'Ana' } });
    const env = await bootBackend(db, 'tutor-a');
    const requests = env.stored(KEYS.REQUESTS);
    const first = requests.find(r => r.id === 1);
    first.history[0] = { type: first.history[0].type, at: first.history[0].at, tutorName: 'Ana', tutorId: 'tutor-a' };
    first.status = 'Aceptada';
    first.history.push({ type: 'accepted', at: '2026-10-01 13:00', tutorName: 'Ana' });
    assert.strictEqual(await env.ctx.EduMatchBackend.onLocalDataSaved(KEYS.REQUESTS, requests), true);
    const updates = env.calls.filter(c => c.table === 'solicitudes_tutoria' && c.mode === 'update');
    assert.strictEqual(updates.length, 1, 'Solo la solicitud modificada se envía.');
    const histInsert = env.calls.find(c => c.table === 'historial_solicitud' && c.mode === 'insert');
    assert.strictEqual(JSON.stringify(histInsert.row.map(r => r.tipo)), '["accepted"]', 'No se reinsertan eventos ya guardados.');
});

test('Fallo de sincronización: se restaura el estado remoto y se informa un único error', async () => {
    const db = BASE_DB();
    db.solicitudes_tutoria.push({ id: 1, estudiante_id: 'student-1', tutor_id: 'tutor-a', materia_id: 1, estado: 'pendiente', fecha_preferida: '2026-10-10', hora_preferida: '10:00:00', creada_en: '2026-10-01T17:00:00Z' });
    const env = await bootBackend(db, 'tutor-a');
    const requests = env.stored(KEYS.REQUESTS);
    requests[0].status = 'Aceptada';
    env.ctx.localStorage.setItem(KEYS.REQUESTS, JSON.stringify(requests));
    env.failures.push({ table: 'solicitudes_tutoria', mode: 'update', error: { code: '42501', message: 'row-level security' } });
    const result = await env.ctx.EduMatchBackend.onLocalDataSaved(KEYS.REQUESTS, requests);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.message, 'No tienes permisos para realizar esta acción.');
    assert.strictEqual(env.stored(KEYS.REQUESTS)[0].status, 'Pendiente', 'El estado local vuelve a coincidir con Supabase.');
});

test('Quitar materia: la solicitud activa se reasigna y el tutor queda excluido', async () => {
    const tutor = { ...USERS[1] };
    const { ctx, stored } = bootApp(tutor, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS, [KEYS.REQUESTS]: [pendingRequest()] });
    await ctx.removeSubjectFromTutor('tutor-a', 'Cálculo Diferencial');
    const r = stored(KEYS.REQUESTS)[0];
    assert.strictEqual(r.tutorId, 'tutor-b');
    assert(r.rejectedTutorIds.includes('tutor-a'), 'Necesario para que RLS permita al tutor anterior completar la operación.');
    assert.strictEqual(r.preferredDate, '2026-10-10');
    assert.strictEqual(r.preferredTime, '16:10');
    assert(!stored(KEYS.USERS).find(u => u.id === 'tutor-a').subjects.includes('Cálculo Diferencial'));
});

test('"Ver tutorías": sin solicitudes muestra el aviso y no cambia de vista', () => {
    const { ctx } = bootApp({ ...USERS[1] }, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS, [KEYS.REQUESTS]: [] });
    let switched = false;
    ctx.switchTab = () => { switched = true; };
    ctx.viewTutorSubjectRequests('Cálculo 4');
    assert(!switched);
    assert(/No hay tutorías para .*Cálculo 4.* en este momento\./.test(ctx.toasts[0].message));
});

test('Botones de solicitud según rol: tutor asignado acepta/rechaza/propone; estudiante no', () => {
    const req = pendingRequest();
    const tutorView = bootApp({ ...USERS[1] }, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS });
    const tutorHtml = tutorView.ctx.renderRequestCard(req, USERS[1]);
    for (const action of ['accept-request', 'reject-request', 'toggle-propose']) assert(tutorHtml.includes(`data-action="${action}"`));
    const studentView = bootApp({ ...USERS[0] }, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS });
    const studentHtml = studentView.ctx.renderRequestCard(req, USERS[0]);
    for (const action of ['accept-request', 'reject-request', 'toggle-propose']) assert(!studentHtml.includes(`data-action="${action}"`));
});

// Tutoría ya aceptada de Ana con otro estudiante (por defecto, el mismo día y hora que pendingRequest()).
const acceptedSameSlot = (extra = {}) => pendingRequest({ id: 1700000000001, studentId: 'student-2', studentName: 'Leo', status: 'Aceptada', ...extra });

test('Horario ocupado: el tutor no puede aceptar una solicitud en una fecha y hora que ya tiene ocupada', async () => {
    const { ctx, stored } = bootApp({ ...USERS[1] }, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS, [KEYS.REQUESTS]: [acceptedSameSlot(), pendingRequest()] });
    await ctx.acceptRequest(1709876543210);
    assert.strictEqual(stored(KEYS.REQUESTS)[1].status, 'Pendiente');
    assert(/Horario no disponible/.test(ctx.toasts[0].message));
    assert.strictEqual(ctx.toasts[0].type, 'error');
});

test('Horario ocupado: tampoco puede proponer ese horario, pero sí uno libre o aceptar si el otro es de otro tutor', async () => {
    // Fecha lejana para que la validación de "fecha en el pasado" no interfiera con el paso del tiempo.
    const busy = acceptedSameSlot({ preferredDate: '2030-10-10', preferredTime: '16:10' });
    const { ctx, stored } = bootApp({ ...USERS[1] }, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS, [KEYS.REQUESTS]: [busy, pendingRequest()] });
    ctx.document.getElementById('proposeDate-1709876543210').value = '2030-10-10';
    ctx.document.getElementById('proposeTime-1709876543210').value = '16:10';
    await ctx.proposeSchedule(1709876543210);
    assert.strictEqual(stored(KEYS.REQUESTS)[1].status, 'Pendiente');
    assert(/Horario no disponible/.test(ctx.toasts[0].message));

    ctx.document.getElementById('proposeTime-1709876543210').value = '18:00';
    await ctx.proposeSchedule(1709876543210);
    assert.strictEqual(stored(KEYS.REQUESTS)[1].status, 'Propuesta_Horario');
    assert.strictEqual(stored(KEYS.REQUESTS)[1].proposedTime, '18:00');

    const otherTutor = bootApp({ ...USERS[1] }, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS, [KEYS.REQUESTS]: [{ ...acceptedSameSlot(), tutorId: 'tutor-b', tutorName: 'Beto' }, pendingRequest()] });
    await otherTutor.ctx.acceptRequest(1709876543210);
    assert.strictEqual(otherTutor.stored(KEYS.REQUESTS)[1].status, 'Aceptada');
});

test('Solicitar tutoría: solo estudiantes', async () => {
    const { ctx } = bootApp({ ...USERS[1] }, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS });
    await ctx.handleTutorRequest({ preventDefault() {} });
    assert(/estudiante/.test(ctx.toasts[0].message));
    assert.strictEqual(ctx.localStorage.getItem(KEYS.REQUESTS), null);
});

test('Autenticación: validación de contraseña y traducción de errores', () => {
    const ctx = createContext(['data.js', 'auth.js']);
    assert.strictEqual(ctx.validateRegistrationPassword('abc'), 'La contraseña debe tener al menos 8 caracteres.');
    assert.strictEqual(ctx.validateRegistrationPassword('Abcdefg1!'), null);
    assert.strictEqual(ctx.translateAuthError(new Error('Invalid login credentials'), 'x'), 'Correo o contraseña incorrectos.');
});

// ---------------------------------------------------------------------------
// Inicio de sesión: cuenta inexistente / eliminada / contraseña incorrecta
// ---------------------------------------------------------------------------

const AUTH_USERS = () => ({
    'ana@example.com': { id: 'tutor-a', password: 'Clave123!' },
    'beto@example.com': { id: 'tutor-b', password: 'Clave123!' },
    'fantasma@example.com': { id: 'ghost', password: 'Clave123!' }
});

async function bootAuth(authUsers = AUTH_USERS(), db = BASE_DB()) {
    const env = await bootBackend(db, null, {
        authUsers,
        files: ['data.js', 'backend.js', 'auth.js'],
        extras: { closeModal() {}, resetPasswordVisibility() {}, updateUserSession() {}, renderTutors() {}, renderRequests() {}, updateStats() {} }
    });
    const elements = { loginForm: { reset() {} } };
    env.ctx.document.getElementById = id => elements[id] || (elements[id] = { value: '' });
    env.login = async (email, password) => {
        elements.loginEmail = { value: email };
        elements.loginPassword = { value: password };
        env.ctx.toasts.length = 0;
        await env.ctx.handleLogin({ preventDefault() {} });
        return env.ctx.toasts[env.ctx.toasts.length - 1];
    };
    return env;
}

test('TEST 1 — Login con cuenta inexistente: "No existe ninguna cuenta con estos datos."', async () => {
    const env = await bootAuth();
    const toast = await env.login('nadie@example.com', 'Clave123!');
    assert.strictEqual(toast.type, 'error');
    assert.strictEqual(toast.message, 'No existe ninguna cuenta con estos datos.');
    assert(env.calls.some(c => c.table === 'rpc' && c.mode === 'existe_cuenta'));
});

test('TEST 2 — Login con cuenta existente y contraseña incorrecta: credenciales incorrectas', async () => {
    const env = await bootAuth();
    const toast = await env.login('ana@example.com', 'otra-clave');
    assert.strictEqual(toast.type, 'error');
    assert.strictEqual(toast.message, 'La contraseña es incorrecta.');
    assert.strictEqual(env.stored(KEYS.CURRENT_USER), null);
});

test('TEST 3 — Login con cuenta eliminada: "No existe ninguna cuenta con estos datos."', async () => {
    const users = AUTH_USERS();
    const db = BASE_DB();
    const env = await bootAuth(users, db);
    assert.strictEqual((await env.login('beto@example.com', 'Clave123!')).type, 'success', 'Antes de eliminarla, la cuenta funciona.');
    await env.ctx.handleLogout?.();
    delete users['beto@example.com'];
    env.db.perfiles = env.db.perfiles.filter(p => p.id !== 'tutor-b');
    assert.strictEqual((await env.login('beto@example.com', 'Clave123!')).message, 'No existe ninguna cuenta con estos datos.');

    // Usuario de Auth cuyo perfil ya no existe: se cierra la sesión y se informa igual.
    const toast = await env.login('fantasma@example.com', 'Clave123!');
    assert.strictEqual(toast.message, 'No existe ninguna cuenta con estos datos.');
    assert(env.calls.some(c => c.table === 'auth' && c.mode === 'signOut'));
    assert.strictEqual(env.stored(KEYS.CURRENT_USER), null);
});

test('Login: correo inválido, cuenta deshabilitada, sin conexión y respaldo si falla la comprobación', async () => {
    const env = await bootAuth();
    assert.strictEqual((await env.login('correo-invalido', 'x')).message, 'Ingresa un correo con formato válido.');
    assert(!env.calls.some(c => c.table === 'rpc'), 'El formato se valida antes de llamar a Supabase.');

    env.failures.push({ table: 'auth', mode: 'signIn', error: { name: 'AuthApiError', status: 400, code: 'user_banned', message: 'User is banned' } });
    assert.strictEqual((await env.login('ana@example.com', 'Clave123!')).message, 'Esta cuenta está deshabilitada. Contacta con el administrador.');
    env.failures.length = 0;

    env.failures.push({ table: 'auth', mode: 'signIn', error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } });
    assert.strictEqual((await env.login('ana@example.com', 'Clave123!')).message, 'No se pudo conectar con Supabase. Comprueba tu conexión a Internet.');
    env.failures.length = 0;

    env.failures.push({ table: 'rpc', name: 'existe_cuenta', error: { code: 'PGRST202', message: 'function not found' } });
    assert.strictEqual((await env.login('nadie@example.com', 'x')).message, 'Correo o contraseña incorrectos.');
});

test('Login correcto aunque haya una sincronización en curso', async () => {
    const env = await bootAuth();
    env.ctx.EduMatchBackend.hydrate();
    const toast = await env.login('ana@example.com', 'Clave123!');
    assert.strictEqual(toast.type, 'success');
    assert.strictEqual(toast.message, 'Sesión iniciada como Ana (Tutor).');
    assert.strictEqual(env.stored(KEYS.CURRENT_USER).id, 'tutor-a');
});

// ---------------------------------------------------------------------------
// Rechazo y reasignación automática (Supabase simulado con RLS)
// ---------------------------------------------------------------------------

const REQ_ID = 500;
function reassignDb({ withTutorC = true, row = {}, extraRows = [] } = {}) {
    const db = BASE_DB();
    if (withTutorC) {
        db.perfiles.push({ id: 'tutor-c', nombre: 'Carla', correo: 'carla@example.com', rol: 'Tutor', activo: true, creado_en: '2026-09-30T15:00:00Z' });
        db.tutor_materias.push({ tutor_id: 'tutor-c', materia_id: 1 });
    }
    db.solicitudes_tutoria.push({
        id: REQ_ID, estudiante_id: 'student-1', tutor_id: 'tutor-a', materia_id: 1,
        fecha_preferida: '2026-10-20', hora_preferida: '09:30:00', tema: 'Límites', estado: 'pendiente',
        tutores_rechazados: [], creada_en: '2026-10-01T15:00:00Z', ...row
    }, ...extraRows);
    db.historial_solicitud.push({ id: 1, solicitud_id: REQ_ID, tipo: 'created', fecha_evento: '2026-10-01T15:00:00Z', detalles: {} });
    return db;
}
const remoteRow = env => env.db.solicitudes_tutoria.find(r => r.id === REQ_ID);
const errorToasts = env => env.ctx.toasts.filter(t => t.type === 'error');

test('TEST 4–10 — Tutor A rechaza: pasa a B pendiente, con fecha/hora/materia/estudiante intactos y A registrado', async () => {
    const a = await bootFull(reassignDb(), 'tutor-a');
    await a.ctx.rejectRequest(REQ_ID);
    assert.strictEqual(errorToasts(a).length, 0, 'Sin errores de permisos (42501).');
    assert(/reasignó automáticamente a Beto/.test(a.ctx.toasts[a.ctx.toasts.length - 1].message));

    const row = remoteRow(a);
    assert.strictEqual(row.tutor_id, 'tutor-b', 'TEST 5/6: B tiene la materia y no tiene otra tutoría activa.');
    assert.strictEqual(row.estado, 'pendiente', 'TEST 10');
    assert.strictEqual(row.fecha_preferida, '2026-10-20', 'TEST 7');
    assert(String(row.hora_preferida).startsWith('09:30'), 'TEST 8');
    assert.strictEqual(row.materia_id, 1);
    assert.strictEqual(row.estudiante_id, 'student-1');
    assert.strictEqual(row.tema, 'Límites');
    assert.strictEqual(JSON.stringify(row.tutores_rechazados), '["tutor-a"]', 'TEST 9');
    const hist = a.db.historial_solicitud.filter(h => h.solicitud_id === REQ_ID);
    assert(hist.some(h => h.tipo === 'tutor_rejected' && h.detalles.tutorId === 'tutor-a'), 'TEST 9: historial');
    assert(hist.some(h => h.tipo === 'tutor_reassigned' && h.detalles.tutorId === 'tutor-b'));
    assert.strictEqual(hist.filter(h => h.tipo === 'created').length, 1, 'No se duplica el historial.');

    a.ctx.renderRequests();
    assert(!a.ctx.document.getElementById('requestsList').innerHTML.includes('Límites'), 'Ya no aparece para el tutor anterior.');
});

test('TEST 11 — Tutor B recibe la solicitud y puede aceptarla, proponer horario o rechazarla (sin 42501)', async () => {
    const a = await bootFull(reassignDb(), 'tutor-a');
    await a.ctx.rejectRequest(REQ_ID);

    const b = await bootFull(a.db, 'tutor-b');
    const req = b.stored(KEYS.REQUESTS).find(r => r.id === REQ_ID);
    assert.strictEqual(req.status, 'Pendiente');
    assert.strictEqual(req.preferredDate, '2026-10-20');
    assert.strictEqual(req.preferredTime, '09:30');
    const html = b.ctx.renderRequestCard(req, b.ctx.getCurrentUser());
    for (const action of ['accept-request', 'reject-request', 'toggle-propose']) assert(html.includes(`data-action="${action}"`), action);

    const accept = await bootFull(a.db, 'tutor-b');
    await accept.ctx.acceptRequest(REQ_ID);
    assert.strictEqual(errorToasts(accept).length, 0);
    assert.strictEqual(remoteRow(accept).estado, 'aceptada');

    const propose = await bootFull(a.db, 'tutor-b');
    propose.ctx.document.getElementById(`proposeDate-${REQ_ID}`).value = '2030-10-25';
    propose.ctx.document.getElementById(`proposeTime-${REQ_ID}`).value = '11:00';
    await propose.ctx.proposeSchedule(REQ_ID);
    assert.strictEqual(errorToasts(propose).length, 0);
    assert.strictEqual(remoteRow(propose).estado, 'propuesta_horario');
    assert.strictEqual(remoteRow(propose).fecha_preferida, '2026-10-20', 'La fecha original no cambia sin aceptación del estudiante.');

    // El segundo tutor rechaza: pasa a C conservando fecha y hora.
    await b.ctx.rejectRequest(REQ_ID);
    assert.strictEqual(errorToasts(b).length, 0, 'El segundo rechazo no debe producir 42501.');
    const row = remoteRow(b);
    assert.strictEqual(row.tutor_id, 'tutor-c');
    assert.strictEqual(row.estado, 'pendiente');
    assert.strictEqual(JSON.stringify(row.tutores_rechazados), '["tutor-a","tutor-b"]');
    assert.strictEqual(row.fecha_preferida, '2026-10-20');
    assert(String(row.hora_preferida).startsWith('09:30'));
});

test('TEST 12 — B con tutoría activa con el mismo estudiante y materia no recibe la solicitud', async () => {
    const other = { id: 400, estudiante_id: 'student-1', tutor_id: 'tutor-b', materia_id: 1, fecha_preferida: '2026-10-15', hora_preferida: '10:00:00', estado: 'aceptada', tutores_rechazados: [], creada_en: '2026-09-30T15:00:00Z' };
    const a = await bootFull(reassignDb({ extraRows: [other] }), 'tutor-a');
    assert(!a.stored(KEYS.REQUESTS).some(r => r.id === 400), 'Por RLS, A no ve la tutoría de B: la comprobación la hace Supabase.');
    await a.ctx.rejectRequest(REQ_ID);
    assert.strictEqual(remoteRow(a).tutor_id, 'tutor-c');

    // Respaldo local (sin función remota): mismo criterio con los datos visibles.
    const local = bootApp({ ...USERS[1] }, {
        [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS,
        [KEYS.REQUESTS]: [pendingRequest(), pendingRequest({ id: 42, tutorId: 'tutor-b', tutorName: 'Beto', status: 'Aceptada' })]
    });
    await local.ctx.rejectRequest(1709876543210);
    const r = local.stored(KEYS.REQUESTS).find(x => x.id === 1709876543210);
    assert.notStrictEqual(r.tutorId, 'tutor-b');
    assert.strictEqual(r.status, 'Cancelada');
});

test('TEST 13 — B incluido en tutores rechazados no recibe la solicitud', async () => {
    const a = await bootFull(reassignDb({ row: { tutores_rechazados: ['tutor-b'] } }), 'tutor-a');
    await a.ctx.rejectRequest(REQ_ID);
    assert.strictEqual(remoteRow(a).tutor_id, 'tutor-c');
    assert.strictEqual(JSON.stringify(remoteRow(a).tutores_rechazados), '["tutor-b","tutor-a"]');

    const local = bootApp({ ...USERS[1] }, { [KEYS.SUBJECTS]: SUBJECTS, [KEYS.USERS]: USERS, [KEYS.REQUESTS]: [pendingRequest({ rejectedTutorIds: ['tutor-b'] })] });
    await local.ctx.rejectRequest(1709876543210);
    assert.strictEqual(local.stored(KEYS.REQUESTS)[0].status, 'Cancelada');
});

test('TEST 14 — Sin otro tutor válido se mantiene la cancelación actual', async () => {
    const a = await bootFull(reassignDb({ withTutorC: false, row: { tutores_rechazados: ['tutor-b'] } }), 'tutor-a');
    await a.ctx.rejectRequest(REQ_ID);
    assert.strictEqual(errorToasts(a).length, 0);
    const row = remoteRow(a);
    assert.strictEqual(row.estado, 'cancelada');
    assert.strictEqual(row.motivo_cancelacion, 'no_tutors');
    assert.strictEqual(row.fecha_preferida, '2026-10-20');
    assert(/se canceló/.test(a.ctx.toasts[a.ctx.toasts.length - 1].message));
});

test('Copia obsoleta: no se muestra éxito ni se sobrescribe un cambio remoto', async () => {
    const a = await bootFull(reassignDb(), 'tutor-a');
    remoteRow(a).estado = 'cancelada';
    await a.ctx.rejectRequest(REQ_ID);
    assert(errorToasts(a).some(t => /modificada por otro usuario/.test(t.message)));
    assert(!a.ctx.toasts.some(t => t.type === 'success'));
    assert.strictEqual(remoteRow(a).tutor_id, 'tutor-a');
    assert.strictEqual(a.stored(KEYS.REQUESTS).find(r => r.id === REQ_ID).status, 'Cancelada', 'El estado local vuelve a coincidir con Supabase.');
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`✓ ${t.name}`);
        } catch (error) {
            failed++;
            console.log(`✗ ${t.name}\n  ${error.message}`);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} pruebas superadas`);
    process.exit(failed ? 1 : 0);
})();

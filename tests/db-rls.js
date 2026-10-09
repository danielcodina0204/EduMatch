// Pruebas contra un PostgreSQL real (PGlite, en proceso) con las migraciones de
// supabase/migrations y el código REAL de assets/js (backend.js + app.js).
// Un pequeño adaptador imita a PostgREST: cada llamada del cliente se ejecuta como
// el rol `authenticated` con el uid de la sesión, de modo que RLS, privilegios,
// triggers y funciones se evalúan igual que en Supabase.
//   node tests/db-rls.js        (requiere `npm install`; sin PGlite se omite)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const KEYS = { USERS: 'edumatch_users', SUBJECTS: 'edumatch_subjects', REQUESTS: 'edumatch_requests', CURRENT_USER: 'edumatch_current_user' };
const ID = {
    daniel: '00000000-0000-0000-0000-0000000000d1',
    jose: '00000000-0000-0000-0000-0000000000a1',
    tutorB: '00000000-0000-0000-0000-0000000000b2',
    tutorC: '00000000-0000-0000-0000-0000000000c3',
    otro: '00000000-0000-0000-0000-0000000000e5'
};
const CALCULO = 1; // materia 1 = Cálculo Diferencial (migración inicial)
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- Entorno Supabase mínimo para PGlite --------------------------------------------
const PRE = `
create schema if not exists auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb,
  deleted_at timestamptz, created_at timestamptz default now());
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create publication supabase_realtime;
-- Privilegios por defecto de Supabase en el esquema public.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
`;

let PGlite;
async function newWorld({ only } = {}) {
    const pg = new PGlite();
    await pg.exec(PRE);
    const dir = path.join(ROOT, 'supabase', 'migrations');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
        if (only && !only.includes(f)) continue;
        // pgcrypto no existe en PGlite y las migraciones no lo usan.
        await pg.exec(fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, ''));
    }
    await pg.exec('grant usage, select on all sequences in schema public to authenticated;');
    const users = [
        [ID.daniel, 'daniel@example.com', 'Daniel', 'Estudiante'],
        [ID.jose, 'jose@example.com', 'José Miguel', 'Tutor'],
        [ID.tutorB, 'b@example.com', 'Tutor B', 'Tutor'],
        [ID.tutorC, 'c@example.com', 'Tutor C', 'Tutor'],
        [ID.otro, 'otro@example.com', 'Otro Estudiante', 'Estudiante']
    ];
    let i = 0;
    for (const [id, email, nombre, rol] of users) {
        await pg.query('insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3::jsonb)', [id, email, JSON.stringify({ nombre, rol })]);
        // creado_en distinto y creciente: el orden de elegibilidad es determinista.
        await pg.query("update public.perfiles set creado_en = '2026-09-30T15:00:00Z'::timestamptz + ($2 || ' minutes')::interval where id = $1", [id, String(i++)]);
    }
    await pg.exec(`insert into public.tutor_materias(tutor_id, materia_id) values
        ('${ID.jose}',${CALCULO}),('${ID.tutorB}',${CALCULO}),('${ID.tutorC}',${CALCULO})`);
    return { pg };
}

const PARSERS = {
    1082: v => v, 1083: v => v, 1114: v => v,
    1184: v => new Date(String(v).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString(),
    2951: v => String(v).replace(/[{}]/g, '').split(',').filter(Boolean)
};
const q = id => `"${String(id).replace(/[^a-z_0-9]/gi, '')}"`;

function pgClient(pg, session) {
    const exec = (sql, params = []) => pg.transaction(async tx => {
        await tx.exec(session.uid ? 'set local role authenticated' : 'set local role anon');
        if (session.uid) await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [session.uid]);
        return tx.query(sql, params, { parsers: PARSERS });
    });
    const wrap = async fn => {
        try { return await fn(); } catch (e) { return { data: null, error: { code: e.code, message: e.message }, count: null }; }
    };

    function builder(table) {
        const st = { mode: 'select', cols: '*', filters: [], orders: [], row: null, opts: {}, head: false };
        const where = params => st.filters.length
            ? ' where ' + st.filters.map(([op, k, v]) => { params.push(v); return `${q(k)} ${op === 'eq' ? '=' : '= any('}$${params.length}${op === 'eq' ? '' : ')'}`; }).join(' and ')
            : '';
        const run = () => wrap(async () => {
            const t = `public.${q(table)}`;
            const params = [];
            let sql;
            if (st.mode === 'select') {
                const cols = st.cols === '*' ? '*' : st.cols.split(',').map(c => q(c.trim())).join(',');
                sql = st.head ? `select count(*)::int as n from ${t}` : `select ${cols} from ${t}`;
                sql += where(params);
                if (!st.head && st.orders.length) sql += ' order by ' + st.orders.map(([c, asc]) => `${q(c)} ${asc ? 'asc' : 'desc'}`).join(',');
                const r = await exec(sql, params);
                return st.head ? { data: null, error: null, count: r.rows[0].n } : { data: r.rows, error: null, count: r.rows.length };
            }
            if (st.mode === 'delete') {
                const r = await exec(`delete from ${t}${where(params)}`, params);
                return { data: null, error: null, count: r.affectedRows };
            }
            const list = Array.isArray(st.row) ? st.row : [st.row];
            const cols = [...new Set(list.flatMap(Object.keys))];
            const cl = cols.map(q).join(',');
            params.push(JSON.stringify(list));
            if (st.mode === 'update') {
                sql = `update ${t} set (${cl}) = (select ${cl} from json_populate_recordset(null::${t}, $1::json))${where(params)}`;
            } else {
                sql = `insert into ${t} (${cl}) select ${cl} from json_populate_recordset(null::${t}, $1::json)`;
                if (st.mode === 'upsert') {
                    const conflict = (st.opts.onConflict || '').split(',').map(c => q(c.trim())).join(',');
                    const sets = cols.filter(c => c !== st.opts.onConflict).map(c => `${q(c)} = excluded.${q(c)}`).join(',');
                    sql += st.opts.ignoreDuplicates ? ` on conflict (${conflict}) do nothing` : ` on conflict (${conflict}) do update set ${sets}`;
                }
            }
            if (st.returning) sql += ' returning *';
            const r = await exec(sql, params);
            return { data: st.returning ? r.rows : null, error: null, count: r.affectedRows };
        });
        const api = {
            select(cols = '*', opts = {}) { if (st.mode === 'select') { st.cols = cols; st.head = !!opts.head; } else st.returning = true; return api; },
            eq(k, v) { st.filters.push(['eq', k, v]); return api; },
            in(k, v) { st.filters.push(['in', k, v]); return api; },
            order(c, o = {}) { st.orders.push([c, o.ascending !== false]); return api; },
            insert(row) { st.mode = 'insert'; st.row = row; return api; },
            upsert(row, opts = {}) { st.mode = 'upsert'; st.row = row; st.opts = opts; return api; },
            update(row) { st.mode = 'update'; st.row = row; return api; },
            delete() { st.mode = 'delete'; return api; },
            maybeSingle: async () => { const r = await run(); return { data: (r.data || [])[0] || null, error: r.error }; },
            single: async () => { const r = await run(); const d = r.data || []; return d.length === 1 ? { data: d[0], error: r.error } : { data: null, error: r.error || { code: 'PGRST116', message: 'No single row' } }; },
            then(resolve, reject) { run().then(resolve, reject); }
        };
        return api;
    }

    return {
        auth: {
            getSession: async () => ({ data: { session: session.uid ? { user: { id: session.uid, email: `${session.uid}@example.com` } } : null }, error: null }),
            onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
            signOut: async () => { session.uid = null; return { error: null }; }
        },
        from: builder,
        rpc: (name, args = {}) => wrap(async () => {
            const keys = Object.keys(args);
            const meta = (await pg.query('select proretset from pg_proc where proname = $1 and pronamespace = $2::regnamespace', [name, 'public'])).rows[0];
            if (!meta) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
            const r = await exec(`select * from public.${q(name)}(${keys.map((k, i) => `${q(k)} => $${i + 1}`).join(',')})`, keys.map(k => args[k]));
            return { data: meta.proretset ? r.rows : Object.values(r.rows[0] || {})[0], error: null };
        }),
        channel() { return { on() { return this; }, subscribe() { return this; } }; }
    };
}

// --- App real (data.js + backend.js + app.js) conectada al PostgreSQL ------------------
function fakeElement() {
    return { innerHTML: '', value: '', textContent: '', style: {}, options: [], appendChild(o) { this.options.push(o); }, reset() {}, classList: { add() {}, remove() {}, toggle() {} } };
}

async function bootAs(world, uid) {
    const session = { uid };
    const client = pgClient(world.pg, session);
    const toasts = [];
    const errors = [];
    const elements = {};
    const ctx = {
        console: { ...console, error: (...a) => errors.push(a.map(String).join(' ')), warn() {} },
        setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)),
        clearTimeout,
        document: {
            readyState: 'complete', querySelector: () => null, querySelectorAll: () => [],
            getElementById: id => elements[id] || (elements[id] = fakeElement()),
            createElement: () => ({ textContent: '', get innerHTML() { return String(this.textContent).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } })
        },
        localStorage: { _d: new Map(), getItem(k) { return this._d.has(k) ? this._d.get(k) : null; }, setItem(k, v) { this._d.set(k, String(v)); }, removeItem(k) { this._d.delete(k); } },
        supabase: { createClient: () => client },
        EDUMATCH_SUPABASE_CONFIG: { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' },
        switchTab() {}, openConfirmModal() {}, refreshAfterAuthChange() {}, updateStats() {}, setDefaultPreferredDate() {}
    };
    ctx.showToast = (message, type) => toasts.push({ message, type });
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of ['data.js', 'backend.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'js', f), 'utf8'), ctx, { filename: f });
    await ctx.EduMatchBackend.bootstrap();
    ctx.getCurrentUser = () => JSON.parse(ctx.localStorage.getItem(KEYS.CURRENT_USER) || 'null');
    ctx.setCurrentUser = u => ctx.localStorage.setItem(KEYS.CURRENT_USER, JSON.stringify(u));
    return {
        ctx, toasts, errors, elements, session, client,
        stored: key => JSON.parse(ctx.localStorage.getItem(key) || 'null'),
        requests() { return this.stored(KEYS.REQUESTS) || []; },
        errorToasts: () => toasts.filter(t => t.type === 'error'),
        hydrate: () => ctx.EduMatchBackend.hydrate()
    };
}

// Cambios "externos" de prueba: el trigger exige un auth.uid() participante (también en el SQL Editor).
const touch = (world, uid, sql, params) => world.pg.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    return tx.query(sql, params);
});
const rowOf = async (world, id) => (await world.pg.query('select * from public.solicitudes_tutoria where id = $1', [id], { parsers: PARSERS })).rows[0];
const histOf = async (world, id) => (await world.pg.query('select tipo, detalles from public.historial_solicitud where solicitud_id = $1 order by id', [id])).rows;

// Daniel crea una solicitud con la app real (handleTutorRequest).
async function createRequest(world, { tutorName = 'José Miguel', date = '2030-10-04', time = '14:05' } = {}) {
    const d = await bootAs(world, ID.daniel);
    const el = id => d.ctx.document.getElementById(id);
    el('selectSubject').value = 'Cálculo Diferencial';
    el('selectTutor').value = tutorName;
    el('preferredDate').value = date;
    el('preferredTime').value = time;
    el('requestTopic').value = 'Derivadas';
    await d.ctx.handleTutorRequest({ preventDefault() {} });
    assert.strictEqual(d.errorToasts().length, 0, `Daniel no pudo crear la solicitud: ${JSON.stringify(d.toasts)}`);
    const created = d.requests().filter(r => r.topic === 'Derivadas').sort((x, y) => y.id - x.id)[0];
    assert(created, 'La solicitud debe existir.');
    return created.id;
}

// ---------------------------------------------------------------------------------------
test('Supabase: RLS activo, funciones seguras y permisos mínimos tras las 4 migraciones', async () => {
    const w = await newWorld();
    const { rows: rls } = await w.pg.query(`select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and relname in ('perfiles','materias','tutor_materias','solicitudes_tutoria','historial_solicitud','calificaciones')`);
    assert.strictEqual(rls.length, 6);
    assert(rls.every(r => r.relrowsecurity), 'RLS debe estar activo en las 6 tablas.');

    const { rows: fns } = await w.pg.query(`select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('rechazar_solicitud','tutores_elegibles_reasignacion','existe_cuenta','eliminar_cuenta_propia','crear_perfil_desde_auth','validar_modificacion_solicitud')`);
    assert.strictEqual(fns.length, 6, 'Existen las 6 funciones esperadas.');
    for (const f of fns.filter(x => x.prosecdef)) {
        assert((f.proconfig || []).some(c => c.startsWith('search_path=')), `${f.proname}: security definer sin search_path fijo`);
    }

    const can = async (role, sig) => (await w.pg.query('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'execute'])).rows[0].ok;
    for (const sig of ['public.rechazar_solicitud(bigint)', 'public.tutores_elegibles_reasignacion(bigint)', 'public.eliminar_cuenta_propia()']) {
        assert.strictEqual(await can('anon', sig), false, `anon no debe ejecutar ${sig}`);
        assert.strictEqual(await can('authenticated', sig), true, `authenticated debe ejecutar ${sig}`);
    }
    assert.strictEqual(await can('anon', 'public.existe_cuenta(text)'), true, 'existe_cuenta se usa antes de iniciar sesión.');
    for (const sig of ['public.crear_perfil_desde_auth()', 'public.validar_modificacion_solicitud()']) {
        assert.strictEqual(await can('anon', sig), false, `${sig}: función de trigger sin EXECUTE para anon`);
        assert.strictEqual(await can('authenticated', sig), false, `${sig}: función de trigger sin EXECUTE para authenticated`);
    }

    const { rows: pol } = await w.pg.query(`select tablename, policyname, cmd, qual, with_check from pg_policies
        where schemaname = 'public' and tablename in ('solicitudes_tutoria','historial_solicitud')`);
    for (const name of ['solicitudes_select_partes', 'solicitudes_update_partes', 'solicitudes_insert_estudiante', 'historial_select_partes', 'historial_insert_partes']) {
        assert(pol.some(p => p.policyname === name), `Falta la política ${name}`);
    }
    assert(!pol.some(p => String(p.qual).trim() === 'true' || String(p.with_check).trim() === 'true'), 'Ninguna política de solicitudes/historial es abierta (true).');
    const upd = pol.find(p => p.policyname === 'solicitudes_update_partes');
    assert(/tutores_rechazados/.test(upd.with_check), 'La fila resultante de un UPDATE debe seguir siendo visible para el tutor reemplazado.');

    const { rows: trg } = await w.pg.query(`select tgenabled from pg_trigger where tgname = 'validar_modificacion_solicitud_edumatch' and not tgisinternal`);
    assert(trg.length === 1 && trg[0].tgenabled === 'O', 'El trigger de validación existe y está activo.');
    const correo = (await w.pg.query("select has_column_privilege('authenticated', 'public.perfiles', 'correo', 'select') as ok")).rows[0].ok;
    assert.strictEqual(correo, false, 'El correo de perfiles no es legible por la API.');
});

test('CAUSA 42501: sin la política de la migración 2 el UPDATE A→B falla; con las migraciones actuales funciona', async () => {
    const only = ['20260930103000_edumatch_initial.sql'];
    const w = await newWorld({ only });
    const c = pgClient(w.pg, { uid: ID.daniel });
    await c.from('solicitudes_tutoria').insert({ id: 9, estudiante_id: ID.daniel, tutor_id: ID.jose, materia_id: CALCULO, fecha_preferida: '2030-10-04', hora_preferida: '14:05', estado: 'pendiente' });
    const a = pgClient(w.pg, { uid: ID.jose });
    const res = await a.from('solicitudes_tutoria').update({ tutor_id: ID.tutorB, tutores_rechazados: [ID.jose] }).eq('id', 9);
    assert.strictEqual(res.error && res.error.code, '42501', 'La fila nueva no cumple la política SELECT del tutor anterior.');
    assert(/new row violates row-level security policy for table "solicitudes_tutoria"/.test(res.error.message));
});

test('Rechazo real: Daniel → José Miguel rechaza → pasa a Tutor B pendiente, sin 42501 y con fecha/hora/materia/estudiante intactos', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    const antes = await rowOf(w, id);
    assert.strictEqual(antes.tutor_id, ID.jose);

    const a = await bootAs(w, ID.jose);
    assert(a.requests().some(r => r.id === id && r.status === 'Pendiente'));
    await a.ctx.rejectRequest(id);
    assert.strictEqual(a.errorToasts().length, 0, `Sin errores: ${JSON.stringify(a.toasts)} ${a.errors.join(' | ')}`);
    assert(/Se reasignó automáticamente a Tutor B/.test(a.toasts[a.toasts.length - 1].message));

    const row = await rowOf(w, id);
    assert.strictEqual(row.tutor_id, ID.tutorB);
    assert.strictEqual(row.estado, 'pendiente');
    assert.deepStrictEqual(row.tutores_rechazados, [ID.jose]);
    assert.strictEqual(row.estudiante_id, antes.estudiante_id);
    assert.strictEqual(row.materia_id, antes.materia_id);
    assert.strictEqual(row.fecha_preferida, '2030-10-04');
    assert(String(row.hora_preferida).startsWith('14:05'));
    assert.strictEqual(row.tema, 'Derivadas');
    assert.strictEqual(row.respondida_en, null);

    const hist = (await histOf(w, id)).map(h => h.tipo);
    assert.deepStrictEqual(hist, ['created', 'tutor_rejected', 'tutor_reassigned']);

    // La pantalla de José Miguel ya no la tiene como tutor actual; la copia local coincide con Supabase.
    const local = a.requests().find(r => r.id === id);
    assert.strictEqual(local.tutorId, ID.tutorB);
    assert.strictEqual(local.preferredDate, '2030-10-04');
    assert.strictEqual(local.preferredTime, '14:05');
    a.ctx.renderRequests();
    assert(!a.ctx.document.getElementById('requestsList').innerHTML.includes('Derivadas'), 'José Miguel ya no la gestiona.');
});

test('Tutor B recibe la solicitud y puede Aceptar, Proponer horario o Rechazar (sin 42501); el estudiante sigue viéndola', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    await (await bootAs(w, ID.jose)).ctx.rejectRequest(id);

    // Aceptar
    let b = await bootAs(w, ID.tutorB);
    const html = b.ctx.renderRequestCard(b.requests().find(r => r.id === id), b.ctx.getCurrentUser());
    for (const action of ['accept-request', 'reject-request', 'toggle-propose']) assert(html.includes(`data-action="${action}"`), action);
    await b.ctx.acceptRequest(id);
    assert.strictEqual(b.errorToasts().length, 0, JSON.stringify(b.toasts));
    assert.strictEqual((await rowOf(w, id)).estado, 'aceptada');

    // Proponer horario (otra copia del escenario)
    const w2 = await newWorld();
    const id2 = await createRequest(w2);
    await (await bootAs(w2, ID.jose)).ctx.rejectRequest(id2);
    b = await bootAs(w2, ID.tutorB);
    b.ctx.document.getElementById(`proposeDate-${id2}`).value = '2030-10-06';
    b.ctx.document.getElementById(`proposeTime-${id2}`).value = '11:00';
    await b.ctx.proposeSchedule(id2);
    assert.strictEqual(b.errorToasts().length, 0, JSON.stringify(b.toasts));
    const prop = await rowOf(w2, id2);
    assert.strictEqual(prop.estado, 'propuesta_horario');
    assert.strictEqual(prop.fecha_preferida, '2030-10-04', 'La fecha original no cambia hasta que el estudiante acepte.');

    // El estudiante acepta la propuesta
    const d = await bootAs(w2, ID.daniel);
    await d.ctx.acceptProposedSchedule(id2);
    assert.strictEqual(d.errorToasts().length, 0, JSON.stringify(d.toasts));

    // Rechazar (B → C), conservando fecha y hora
    const w3 = await newWorld();
    const id3 = await createRequest(w3);
    await (await bootAs(w3, ID.jose)).ctx.rejectRequest(id3);
    b = await bootAs(w3, ID.tutorB);
    await b.ctx.rejectRequest(id3);
    assert.strictEqual(b.errorToasts().length, 0, JSON.stringify(b.toasts));
    const r3 = await rowOf(w3, id3);
    assert.strictEqual(r3.tutor_id, ID.tutorC);
    assert.deepStrictEqual(r3.tutores_rechazados, [ID.jose, ID.tutorB]);
    assert.strictEqual(r3.fecha_preferida, '2030-10-04');
    assert.strictEqual(r3.estado, 'pendiente');
});

test('Tutor con tutoría activa incompatible (mismo estudiante + materia) o ya rechazado no se selecciona', async () => {
    // B ya tiene una tutoría aceptada con Daniel en Cálculo → pasa a C.
    const w = await newWorld();
    await w.pg.query(`insert into public.solicitudes_tutoria(id, estudiante_id, tutor_id, materia_id, fecha_preferida, hora_preferida, estado)
        values (50, $1, $2, ${CALCULO}, '2030-10-01', '09:00', 'aceptada')`, [ID.daniel, ID.tutorB]);
    const id = await createRequest(w);
    const a1 = await bootAs(w, ID.jose);
    await a1.ctx.rejectRequest(id);
    assert.strictEqual((await rowOf(w, id)).tutor_id, ID.tutorC, `B tiene una tutoría activa con el mismo estudiante y materia. ${a1.errors.join(' | ')}`);

    // C ya había rechazado antes y B está ocupado → no hay tutor válido → se cancela.
    const w2 = await newWorld();
    await w2.pg.query(`insert into public.solicitudes_tutoria(id, estudiante_id, tutor_id, materia_id, fecha_preferida, hora_preferida, estado)
        values (50, $1, $2, ${CALCULO}, '2030-10-01', '09:00', 'pendiente')`, [ID.daniel, ID.tutorB]);
    const id2 = await createRequest(w2);
    await touch(w2, ID.daniel, 'update public.solicitudes_tutoria set tutores_rechazados = $2 where id = $1', [id2, [ID.tutorC]]);
    const a2 = await bootAs(w2, ID.jose);
    await a2.ctx.rejectRequest(id2);
    assert.strictEqual(a2.errorToasts().length, 0, JSON.stringify(a2.toasts));
    const r = await rowOf(w2, id2);
    assert.strictEqual(r.estado, 'cancelada');
    assert.strictEqual(r.motivo_cancelacion, 'no_tutors');
    assert.strictEqual(r.fecha_preferida, '2030-10-04');
    assert.deepStrictEqual((await histOf(w2, id2)).map(h => h.tipo), ['created', 'tutor_rejected', 'no_more_tutors']);
    assert(/se canceló/.test(a2.toasts[a2.toasts.length - 1].message));

    // Perfil inactivo y tutor sin la materia tampoco se eligen.
    const w3 = await newWorld();
    await w3.pg.query('update public.perfiles set activo = false where id = $1', [ID.tutorB]);
    await w3.pg.query('delete from public.tutor_materias where tutor_id = $1', [ID.tutorC]);
    const id3 = await createRequest(w3);
    await (await bootAs(w3, ID.jose)).ctx.rejectRequest(id3);
    assert.strictEqual((await rowOf(w3, id3)).estado, 'cancelada');
});

test('Doble toque en Rechazar: una sola reasignación y un solo evento de rechazo', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    const a = await bootAs(w, ID.jose);
    await Promise.all([a.ctx.rejectRequest(id), a.ctx.rejectRequest(id)]);
    const hist = (await histOf(w, id)).map(h => h.tipo);
    assert.strictEqual(hist.filter(t => t === 'tutor_rejected').length, 1);
    assert.strictEqual(hist.filter(t => t === 'tutor_reassigned').length, 1);
    assert.strictEqual((await rowOf(w, id)).tutor_id, ID.tutorB, 'No salta a un segundo tutor.');
    assert.strictEqual(a.errorToasts().length, 0);

    // Dos pestañas/dispositivos del mismo tutor: la segunda llamada llega tarde y recibe un aviso claro.
    const w2 = await newWorld();
    const id2 = await createRequest(w2);
    const t1 = await bootAs(w2, ID.jose);
    const t2 = await bootAs(w2, ID.jose);
    await t1.ctx.rejectRequest(id2);
    await t2.ctx.rejectRequest(id2);
    assert.strictEqual((await rowOf(w2, id2)).tutor_id, ID.tutorB);
    assert(t2.errorToasts().some(t => /ya no está asignada a ti|modificada por otro usuario/.test(t.message)), JSON.stringify(t2.toasts));
    assert(!t2.toasts.some(t => t.type === 'success'));
});

test('Copia local obsoleta: Supabase prevalece, no hay falso éxito y se recarga el estado real', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    const a = await bootAs(w, ID.jose);          // A carga la solicitud pendiente
    await touch(w, ID.daniel, "update public.solicitudes_tutoria set estado = 'cancelada' where id = $1", [id]); // cambia en otro lado
    await a.ctx.rejectRequest(id);
    assert(a.errorToasts().some(t => /ya no está pendiente|modificada por otro usuario/.test(t.message)), JSON.stringify(a.toasts));
    assert(!a.toasts.some(t => t.type === 'success'));
    assert.strictEqual((await rowOf(w, id)).tutor_id, ID.jose, 'No se modifica la solicitud.');
    assert.strictEqual(a.requests().find(r => r.id === id).status, 'Cancelada', 'La copia local vuelve a coincidir con Supabase.');
});

test('Error de Supabase (RPC ausente o caída): sin falso éxito y sin cambios', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    const a = await bootAs(w, ID.jose);
    await w.pg.exec('drop function public.rechazar_solicitud(bigint)');
    await a.ctx.rejectRequest(id);
    assert(a.errorToasts().length === 1, JSON.stringify(a.toasts));
    assert(!a.toasts.some(t => t.type === 'success'));
    assert.strictEqual((await rowOf(w, id)).tutor_id, ID.jose);
    assert.strictEqual(a.requests().find(r => r.id === id).tutorId, ID.jose);
});

test('Hidratación en paralelo durante el rechazo no deja la copia local con el tutor anterior', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    const a = await bootAs(w, ID.jose);
    await Promise.all([a.ctx.rejectRequest(id), a.hydrate(), a.hydrate()]);
    await a.hydrate();
    assert.strictEqual(a.errorToasts().length, 0, JSON.stringify(a.toasts));
    assert.strictEqual((await rowOf(w, id)).tutor_id, ID.tutorB);
    assert.strictEqual(a.requests().find(r => r.id === id).tutorId, ID.tutorB);
    // El estudiante recibe los mismos datos reales.
    const d = await bootAs(w, ID.daniel);
    const mine = d.requests().find(r => r.id === id);
    assert.strictEqual(mine.tutorId, ID.tutorB);
    assert.deepStrictEqual(mine.history.map(e => e.type), ['created', 'tutor_rejected', 'tutor_reassigned']);
    assert.strictEqual(d.ctx.getAutoReassignment(mine).tutorName, 'Tutor B');
});

test('Reglas del servidor: solo el tutor actual, solo pendiente y solo con sesión', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    const call = uid => pgClient(w.pg, { uid }).rpc('rechazar_solicitud', { p_solicitud_id: id });

    assert.strictEqual((await call(ID.tutorB)).error.code, 'EM001', 'Un tutor ajeno no puede rechazar.');
    assert.strictEqual((await call(ID.daniel)).error.code, 'EM001', 'El estudiante no usa esta operación.');
    assert.strictEqual((await call(ID.otro)).error.code, 'EM001');
    const anon = await call(null);
    assert(anon.error && ['42501'].includes(anon.error.code), 'Sin sesión no se ejecuta.');
    assert.strictEqual((await rowOf(w, id)).tutor_id, ID.jose, 'Ninguna llamada inválida modifica la fila.');

    await touch(w, ID.daniel, "update public.solicitudes_tutoria set estado = 'aceptada' where id = $1", [id]);
    assert.strictEqual((await call(ID.jose)).error.code, 'EM002', 'Una solicitud aceptada no se rechaza por esta vía.');
    assert.strictEqual((await call(ID.jose)).error.code, 'EM002');
    assert.strictEqual((await pgClient(w.pg, { uid: ID.jose }).rpc('rechazar_solicitud', { p_solicitud_id: 987654 })).error.code, 'EM001');
});

test('RLS tras la reasignación: el tutor anterior no puede modificar ni escribir historial; B y el estudiante sí', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    await (await bootAs(w, ID.jose)).ctx.rejectRequest(id);
    const a = pgClient(w.pg, { uid: ID.jose });
    const upd = await a.from('solicitudes_tutoria').update({ estado: 'aceptada' }).eq('id', id);
    assert.strictEqual(upd.error, null);
    assert.strictEqual((await rowOf(w, id)).estado, 'pendiente', 'UPDATE filtrado por RLS: 0 filas.');
    const his = await a.from('historial_solicitud').insert({ solicitud_id: id, tipo: 'accepted', detalles: {} });
    assert.strictEqual(his.error && his.error.code, '42501');
    assert.strictEqual((await a.from('solicitudes_tutoria').select('id,tutor_id').eq('id', id)).data.length, 1, 'El tutor anterior aún ve la fila (tutores_rechazados) pero no la gestiona.');

    const b = pgClient(w.pg, { uid: ID.tutorB });
    assert.strictEqual((await b.from('solicitudes_tutoria').update({ estado: 'aceptada' }).eq('id', id)).error, null);
    assert.strictEqual((await rowOf(w, id)).estado, 'aceptada');
    const otro = pgClient(w.pg, { uid: ID.otro });
    assert.strictEqual((await otro.from('solicitudes_tutoria').select('id').eq('id', id)).data.length, 0, 'Un tercero no ve la solicitud.');
});

test('Trigger: no se puede asignar un tutor inválido (sin materia, inactivo, el propio estudiante) ni cambiar la materia', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    const d = pgClient(w.pg, { uid: ID.daniel });
    const sinMateria = await d.from('solicitudes_tutoria').update({ tutor_id: ID.otro }).eq('id', id);
    assert.strictEqual(sinMateria.error.code, 'EM003');
    await w.pg.query("update public.perfiles set activo = false where id = $1", [ID.tutorC]);
    assert.strictEqual((await d.from('solicitudes_tutoria').update({ tutor_id: ID.tutorC }).eq('id', id)).error.code, 'EM003');
    assert.strictEqual((await d.from('solicitudes_tutoria').update({ tutor_id: ID.daniel }).eq('id', id)).error.code, 'EM003');
    assert.strictEqual((await d.from('solicitudes_tutoria').update({ materia_id: 2 }).eq('id', id)).error.code, 'P0001');
    assert.strictEqual((await d.from('solicitudes_tutoria').update({ tutor_id: ID.tutorB }).eq('id', id)).error, null, 'Un tutor válido sí se puede asignar.');
    assert.strictEqual((await rowOf(w, id)).tutor_id, ID.tutorB);
});

test('Quitar materia del perfil con solicitud pendiente: se reasigna con el flujo existente (sin 42501)', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    const a = await bootAs(w, ID.jose);
    await a.ctx.removeSubjectFromTutor(ID.jose, 'Cálculo Diferencial');
    assert.strictEqual(a.errorToasts().length, 0, `${JSON.stringify(a.toasts)} ${a.errors.join(' | ')}`);
    const row = await rowOf(w, id);
    assert.strictEqual(row.tutor_id, ID.tutorB);
    assert.deepStrictEqual(row.tutores_rechazados, [ID.jose]);
    assert.strictEqual(row.estado, 'pendiente');
    assert.strictEqual(row.fecha_preferida, '2030-10-04');
    assert(!(await w.pg.query('select 1 from public.tutor_materias where tutor_id = $1 and materia_id = $2', [ID.jose, CALCULO])).rows.length);
});

test('Quitar materia con la consulta de elegibles caída: error visible y la solicitud no se toca ni se elige un tutor "a ciegas"', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    const a = await bootAs(w, ID.jose);
    await w.pg.exec('drop function public.tutores_elegibles_reasignacion(bigint) cascade');
    await a.ctx.removeSubjectFromTutor(ID.jose, 'Cálculo Diferencial');
    assert(a.errorToasts().length >= 1, JSON.stringify(a.toasts));
    assert(!a.toasts.some(t => t.type === 'success'));
    const row = await rowOf(w, id);
    assert.strictEqual(row.tutor_id, ID.jose);
    assert.strictEqual(row.estado, 'pendiente');
});

test('Eliminar cuenta de tutor: bloqueada con tutorías activas; con solo historial se elimina y conserva las solicitudes (trigger/cascada)', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    const j = pgClient(w.pg, { uid: ID.jose });
    const bloqueada = await j.rpc('eliminar_cuenta_propia');
    assert(bloqueada.error && bloqueada.error.code === 'P0001', 'Con una tutoría pendiente a su cargo no puede eliminarse.');

    await (await bootAs(w, ID.jose)).ctx.rejectRequest(id);          // pasa a B: José ya no tiene tutorías activas
    const ok = await j.rpc('eliminar_cuenta_propia');
    assert.strictEqual(ok.error, null, JSON.stringify(ok.error));
    assert.strictEqual((await w.pg.query('select count(*)::int n from public.perfiles where id = $1', [ID.jose])).rows[0].n, 0);
    const row = await rowOf(w, id);
    assert.strictEqual(row.tutor_id, ID.tutorB, 'La solicitud reasignada sigue con B.');
    assert.deepStrictEqual(row.tutores_rechazados, [ID.jose]);
});

test('Estudiante: cancelar, cambiar de tutor y calificar siguen funcionando con la política UPDATE más estricta', async () => {
    const w = await newWorld();
    const id = await createRequest(w);
    const d = await bootAs(w, ID.daniel);
    await d.ctx.cancelRequest(id);
    assert.strictEqual(d.errorToasts().length, 0, JSON.stringify(d.toasts));
    assert.strictEqual((await rowOf(w, id)).estado, 'cancelada');

    const w2 = await newWorld();
    const id2 = await createRequest(w2);
    await (await bootAs(w2, ID.jose)).ctx.acceptRequest(id2);
    const j = await bootAs(w2, ID.jose);
    await j.ctx.completeRequest(id2);
    assert.strictEqual(j.errorToasts().length, 0, JSON.stringify(j.toasts));
    const d2 = await bootAs(w2, ID.daniel);
    await d2.ctx.saveRating(id2, 5);
    assert.strictEqual(d2.errorToasts().length, 0, JSON.stringify(d2.toasts));
    const rating = (await w2.pg.query('select puntuacion from public.calificaciones where solicitud_id = $1', [id2])).rows[0];
    assert.strictEqual(rating && rating.puntuacion, 5);
});

// ---------------------------------------------------------------------------------------
(async () => {
    try {
        ({ PGlite } = await import('@electric-sql/pglite'));
    } catch (e) {
        console.log('PGlite no está instalado (npm install): se omiten las pruebas con PostgreSQL real.');
        process.exit(0);
    }
    const only = process.argv[2];
    let failed = 0;
    let ran = 0;
    for (const t of tests) {
        if (only && !t.name.includes(only)) continue;
        ran++;
        try {
            await t.fn();
            console.log(`✓ ${t.name}`);
        } catch (error) {
            failed++;
            console.log(`✗ ${t.name}\n  ${String(error.stack || error.message).split('\n').slice(0, 4).join('\n  ')}`);
        }
    }
    console.log(`\n${ran - failed}/${ran} pruebas con PostgreSQL real superadas`);
    process.exit(failed ? 1 : 0);
})();

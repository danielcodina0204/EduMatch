(function () {
    const cfg = window.EDUMATCH_SUPABASE_CONFIG || {};
    const ready = !!(cfg.url && cfg.publishableKey && window.supabase && typeof window.supabase.createClient === 'function');

    let client = null;
    let realtimeChannel = null;
    let hydrated = false;
    let currentHydrate = null;
    let queuedHydrate = null;
    let realtimeTimer = null;
    let activeRequestSyncs = 0;
    let realtimeDeferred = false;
    const syncedRequestSnapshots = new Map();

    const STATUS_TO_DB = {
        'Pendiente': 'pendiente',
        'Aceptada': 'aceptada',
        'Rechazada': 'rechazada',
        'Propuesta_Horario': 'propuesta_horario',
        'Cancelada': 'cancelada',
        'Realizada': 'realizada'
    };
    const STATUS_FROM_DB = Object.fromEntries(Object.entries(STATUS_TO_DB).map(([k, v]) => [v, k]));

    const STALE_REQUEST_MESSAGE = 'Esta solicitud fue modificada por otro usuario. Se recargaron los datos; revisa su estado actual.';
    const ACCOUNT_NOT_FOUND_MESSAGE = 'No existe ninguna cuenta con estos datos.';

    function userError(message, code) {
        return Object.assign(new Error(message), { userMessage: message, code });
    }

    function getFriendlyError(error, fallback = 'No se pudo completar la operación.') {
        if (error?.userMessage) return error.userMessage;
        const message = String(error?.message || '').toLowerCase();
        const code = String(error?.code || '');
        if (/failed to fetch|network|fetch|connection|internet|timeout/.test(message)) {
            return 'No se pudo conectar con Supabase. Comprueba tu conexión a Internet.';
        }
        if (code === 'EM001' || code === 'EM002') return STALE_REQUEST_MESSAGE;
        if (code === 'EM003') return 'El tutor seleccionado ya no es válido para esta materia.';
        if (code === 'PGRST202' || code === '42883') {
            return 'Esta función no está disponible en Supabase. Aplica las migraciones pendientes de supabase/migrations.';
        }
        if (code === '42501' || /permission denied|row-level security|rls/.test(message)) {
            // El mensaje de PostgreSQL indica la tabla/política exacta: se deja en consola para diagnosticar.
            console.error('Supabase 42501:', error?.message || code);
            return 'No tienes permisos para realizar esta acción.';
        }
        if (code === '23503') return 'No se pudo guardar porque uno de los registros relacionados no existe.';
        if (code === '23505') return 'El registro ya existe.';
        if (code === '22P02') return 'Uno de los datos enviados no tiene un formato válido.';
        if (/jwt|token|session/.test(message)) return 'La sesión ya no es válida. Inicia sesión nuevamente.';
        return fallback;
    }

    function isEnabled() {
        return ready && !!client;
    }

    // Las operaciones que escriben solicitudes se ejecutan de una en una: así un
    // doble toque o una sincronización en curso no se pisan entre sí.
    let operationQueue = Promise.resolve();
    function runExclusive(task) {
        const run = operationQueue.then(task, task);
        operationQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    async function getAuthenticatedUserId() {
        const sessionRes = await client.auth.getSession();
        if (sessionRes.error) throw sessionRes.error;
        const userId = sessionRes.data?.session?.user?.id;
        if (!userId) throw Object.assign(new Error('No hay una sesión autenticada.'), { code: '401' });
        return userId;
    }

    function normalizeSubjectName(value) {
        return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
    }

    function localTimestampToDate(value) {
        if (!value) return new Date();
        const m = String(value).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
        if (!m) return new Date(value);
        return new Date(`${m[1]}T${m[2]}:00`);
    }

    function remoteTimestampToLocal(value) {
        if (!value) return null;
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return String(value);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function cache(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.error('EduMatch cache:', e); }
    }

    async function fetchAll() {
        if (!isEnabled()) return false;
        const sessionRes = await client.auth.getSession();
        if (sessionRes.error) throw sessionRes.error;
        const authenticated = !!sessionRes.data?.session;
        const [profilesRes, subjectsRes, tutorSubjectsRes, requestsRes, ratingsRes, historyRes] = await Promise.all([
            client.from('perfiles').select('id,nombre,rol,activo,creado_en').eq('activo', true),
            client.from('materias').select('id,nombre,categoria,descripcion,creada_por').order('id'),
            client.from('tutor_materias').select('tutor_id,materia_id'),
            authenticated ? client.from('solicitudes_tutoria').select('*').order('creada_en', { ascending: true }) : Promise.resolve({ data: [], error: null }),
            authenticated ? client.from('calificaciones').select('solicitud_id,puntuacion,comentario,creado_en') : Promise.resolve({ data: [], error: null }),
            authenticated ? client.from('historial_solicitud').select('id,solicitud_id,tipo,fecha_evento,detalles').order('id') : Promise.resolve({ data: [], error: null })
        ]);

        const firstError = [profilesRes, subjectsRes, tutorSubjectsRes, requestsRes, ratingsRes, historyRes].find(x => x.error);
        if (firstError) throw firstError.error;

        const profiles = profilesRes.data || [];
        const subjects = subjectsRes.data || [];
        const tutorSubjects = tutorSubjectsRes.data || [];
        const ratings = ratingsRes.data || [];
        const history = historyRes.data || [];
        const requests = requestsRes.data || [];

        const profileById = new Map(profiles.map(p => [p.id, p]));
        const subjectById = new Map(subjects.map(s => [String(s.id), s]));
        const ratingsByRequest = new Map(ratings.map(r => [String(r.solicitud_id), r]));
        const historyByRequest = new Map();
        for (const ev of history) {
            const key = String(ev.solicitud_id);
            if (!historyByRequest.has(key)) historyByRequest.set(key, []);
            historyByRequest.get(key).push({
                type: ev.tipo,
                at: remoteTimestampToLocal(ev.fecha_evento),
                ...(ev.detalles || {})
            });
        }

        const tutorSubjectNames = new Map();
        for (const row of tutorSubjects) {
            const arr = tutorSubjectNames.get(row.tutor_id) || [];
            const subject = subjectById.get(String(row.materia_id));
            if (subject) arr.push(subject.nombre);
            tutorSubjectNames.set(row.tutor_id, arr);
        }

        const sessionUser = sessionRes.data?.session?.user || null;
        const users = profiles.map(p => ({
            id: p.id,
            role: p.rol,
            name: p.nombre,
            email: sessionUser && sessionUser.id === p.id ? (sessionUser.email || '') : '',
            subjects: tutorSubjectNames.get(p.id) || [],
            createdAt: remoteTimestampToLocal(p.creado_en) || nowLocalTimestamp(),
            activo: p.activo !== false
        }));

        const localRequests = requests.map(r => {
            const student = profileById.get(r.estudiante_id);
            const tutor = r.tutor_id ? profileById.get(r.tutor_id) : null;
            const subject = subjectById.get(String(r.materia_id));
            const rating = ratingsByRequest.get(String(r.id));
            const historyEvents = historyByRequest.get(String(r.id)) || [];
            return {
                id: Number(r.id),
                studentId: r.estudiante_id,
                studentName: student ? student.nombre : 'Estudiante',
                subject: subject ? subject.nombre : 'Materia',
                tutorId: r.tutor_id || null,
                tutorName: tutor ? tutor.nombre : null,
                preferredDate: r.fecha_preferida || null,
                preferredTime: r.hora_preferida ? String(r.hora_preferida).slice(0,5) : null,
                topic: r.tema || null,
                status: STATUS_FROM_DB[r.estado] || r.estado,
                rating: rating ? Number(rating.puntuacion) : null,
                ratingComment: rating ? (rating.comentario || '') : null,
                proposedDate: r.fecha_propuesta || null,
                proposedTime: r.hora_propuesta ? String(r.hora_propuesta).slice(0,5) : null,
                proposedMessage: r.mensaje_propuesta || null,
                rejectedTutorIds: Array.isArray(r.tutores_rechazados) ? r.tutores_rechazados : [],
                rejectionSource: r.origen_rechazo || null,
                rejectedProposalDate: r.fecha_propuesta_rechazada || null,
                rejectedProposalTime: r.hora_propuesta_rechazada ? String(r.hora_propuesta_rechazada).slice(0,5) : null,
                cancellationReason: r.motivo_cancelacion || null,
                openForReassignment: !!r.abierta_reasignacion,
                history: historyEvents.length ? historyEvents : [{ type: 'created', at: remoteTimestampToLocal(r.creada_en) }],
                hiddenFor: [
                    ...(r.oculta_para_estudiante ? [r.estudiante_id] : []),
                    ...(r.oculta_para_tutor && r.tutor_id ? [r.tutor_id] : [])
                ],
                createdAt: remoteTimestampToLocal(r.creada_en) || nowLocalTimestamp(),
                respondedAt: remoteTimestampToLocal(r.respondida_en),
                completedAt: remoteTimestampToLocal(r.realizada_en)
            };
        });

        cache(STORAGE_KEYS.USERS, users);
        cache(STORAGE_KEYS.SUBJECTS, subjects.map(s => ({
            id: Number(s.id),
            name: s.nombre,
            category: s.categoria,
            description: s.descripcion,
            createdBy: s.creada_por || null
        })));
        cache(STORAGE_KEYS.REQUESTS, localRequests);
        syncedRequestSnapshots.clear();
        for (const req of localRequests) syncedRequestSnapshots.set(req.id, JSON.stringify(req));

        const session = sessionRes.data?.session;
        if (session) {
            const profile = profileById.get(session.user.id);
            if (profile) {
                cache(STORAGE_KEYS.CURRENT_USER, users.find(u => u.id === profile.id) || {
                    id: profile.id, role: profile.rol, name: profile.nombre, email: session.user.email || '', subjects: tutorSubjectNames.get(profile.id) || []
                });
            } else {
                // La sesión pertenece a una cuenta cuyo perfil ya no existe (p. ej. eliminada).
                localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
                try { await client.auth.signOut({ scope: 'local' }); } catch (_) {}
            }
        } else {
            localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
        }

        hydrated = true;
        return true;
    }

    function notifyUi() {
        if (typeof updateUserSession === 'function') updateUserSession();
        if (typeof renderSubjects === 'function') renderSubjects();
        if (typeof renderTutors === 'function') renderTutors();
        if (typeof renderRequests === 'function') renderRequests();
        if (typeof updateStats === 'function') updateStats();
    }

    async function runHydrate(options) {
        try {
            await fetchAll();
            if (options.refreshUi !== false && document.readyState !== 'loading') notifyUi();
            return true;
        } catch (error) {
            console.error('Supabase hydrate error:', error?.code || error?.message || error);
            if (!options.silent) window.showToast?.(getFriendlyError(error, 'No se pudieron sincronizar los datos con Supabase.'), 'error');
            return false;
        }
    }

    // Si ya hay una hidratación en curso, quien llama espera a una nueva que
    // empieza al terminar la actual (así nunca recibe datos de otra sesión).
    function hydrate(options = {}) {
        if (!isEnabled()) return Promise.resolve(false);
        if (currentHydrate) {
            if (!queuedHydrate) {
                queuedHydrate = currentHydrate.then(() => {
                    queuedHydrate = null;
                    return hydrate(options);
                });
            }
            return queuedHydrate;
        }
        currentHydrate = runHydrate(options).finally(() => { currentHydrate = null; });
        return currentHydrate;
    }

    // Mientras se sincroniza una solicitud no se sobrescribe el estado local
    // con datos remotos intermedios; la recarga se hace al terminar.
    function scheduleRealtimeHydrate() {
        clearTimeout(realtimeTimer);
        realtimeTimer = setTimeout(() => {
            if (activeRequestSyncs > 0) { realtimeDeferred = true; return; }
            hydrate();
        }, 250);
    }

    async function createTutorSubject(tutorId, subjectInput) {
        if (!isEnabled() || !tutorId) throw new Error('No hay una conexión válida con Supabase.');
        const userId = await getAuthenticatedUserId();
        if (userId !== tutorId) throw Object.assign(new Error('La sesión no corresponde al tutor actual.'), { code: '42501' });

        const name = String(subjectInput?.name || '').trim().replace(/\s+/g, ' ');
        if (!name) throw userError('Escribe un nombre para la nueva materia.');
        const description = String(subjectInput?.description || '').trim() || 'Materia agregada por un tutor.';
        const category = String(subjectInput?.category || 'General').trim() || 'General';
        const existingRes = await client.from('materias').select('id,nombre,categoria,descripcion,creada_por').order('id');
        if (existingRes.error) throw existingRes.error;
        const existing = (existingRes.data || []).find(subject => normalizeSubjectName(subject.nombre) === normalizeSubjectName(name));

        let subject = existing;
        if (!subject) {
            const inserted = await client.from('materias').insert({
                nombre: name,
                categoria: category,
                descripcion: description,
                creada_por: tutorId
            }).select('id,nombre,categoria,descripcion,creada_por').single();
            if (inserted.error) throw inserted.error;
            subject = inserted.data;
        }

        const relation = await client.from('tutor_materias').insert({
            tutor_id: tutorId,
            materia_id: Number(subject.id)
        });
        if (relation.error && relation.error.code !== '23505') throw relation.error;

        const result = {
            id: Number(subject.id),
            name: subject.nombre,
            category: subject.categoria || 'General',
            description: subject.descripcion || description,
            createdBy: subject.creada_por || null,
            alreadyExisted: !!existing
        };
        await hydrate({ refreshUi: false });
        return result;
    }

    async function assignTutorSubject(tutorId, subjectName) {
        if (!isEnabled() || !tutorId) throw new Error('No hay una conexión válida con Supabase.');
        const userId = await getAuthenticatedUserId();
        if (userId !== tutorId) throw Object.assign(new Error('La sesión no corresponde al tutor actual.'), { code: '42501' });

        const target = normalizeSubjectName(subjectName);
        const subjectsRes = await client.from('materias').select('id,nombre,categoria,descripcion,creada_por').order('id');
        if (subjectsRes.error) throw subjectsRes.error;
        let subject = (subjectsRes.data || []).find(s => normalizeSubjectName(s.nombre) === target);

        if (!subject) {
            const localSubjects = getStoredData(STORAGE_KEYS.SUBJECTS, []);
            const localSubject = localSubjects.find(s => normalizeSubjectName(s.name) === target);
            if (!localSubject) throw userError('La materia no existe en el catálogo.');
            const inserted = await client.from('materias').insert({
                nombre: localSubject.name,
                categoria: localSubject.category || 'Personalizada',
                descripcion: localSubject.description || 'Materia agregada por un tutor.',
                creada_por: tutorId
            }).select('id,nombre,categoria,descripcion,creada_por').single();
            if (inserted.error) throw inserted.error;
            subject = inserted.data;
        }

        const relation = await client.from('tutor_materias').insert({ tutor_id: tutorId, materia_id: Number(subject.id) });
        if (relation.error && relation.error.code !== '23505') throw relation.error;
        await hydrate({ refreshUi: false });
        return { ok: true };
    }

    async function removeTutorSubject(tutorId, subjectName) {
        if (!isEnabled() || !tutorId) throw new Error('No hay una conexión válida con Supabase.');
        const userId = await getAuthenticatedUserId();
        if (userId !== tutorId) throw Object.assign(new Error('La sesión no corresponde al tutor actual.'), { code: '42501' });

        const subjectsRes = await client.from('materias').select('id,nombre').order('id');
        if (subjectsRes.error) throw subjectsRes.error;
        const subject = (subjectsRes.data || []).find(s => normalizeSubjectName(s.nombre) === normalizeSubjectName(subjectName));
        if (!subject) throw userError('La materia ya no existe en el catálogo.');
        const relation = await client.from('tutor_materias').delete().eq('tutor_id', tutorId).eq('materia_id', Number(subject.id));
        if (relation.error) throw relation.error;
        await hydrate({ refreshUi: false });
        return { ok: true };
    }

    async function deleteCustomSubject(tutorId, subjectName) {
        if (!isEnabled() || !tutorId) throw new Error('No hay una conexión válida con Supabase.');
        const userId = await getAuthenticatedUserId();
        if (userId !== tutorId) throw Object.assign(new Error('La sesión no corresponde al tutor actual.'), { code: '42501' });

        const subjectsRes = await client.from('materias').select('id,nombre,creada_por').order('id');
        if (subjectsRes.error) throw subjectsRes.error;
        const subject = (subjectsRes.data || []).find(s => normalizeSubjectName(s.nombre) === normalizeSubjectName(subjectName));
        if (!subject) throw userError('La materia ya no existe en el catálogo.');
        if (subject.creada_por !== tutorId) throw userError('Solo puedes eliminar materias creadas por ti.');

        const mappings = await client.from('tutor_materias').select('tutor_id').eq('materia_id', Number(subject.id));
        if (mappings.error) throw mappings.error;
        const otherTutors = (mappings.data || []).filter(row => row.tutor_id !== tutorId);
        if (otherTutors.length) throw userError('No puedes eliminar esta materia porque otro tutor todavía la tiene asignada.');

        const requests = await client.from('solicitudes_tutoria').select('id').eq('materia_id', Number(subject.id)).limit(1);
        if (requests.error) throw requests.error;
        if ((requests.data || []).length) throw userError('No puedes eliminar esta materia porque existen solicitudes o tutorías asociadas a ella.');

        const deleted = await client.from('materias').delete().eq('id', Number(subject.id)).select('id');
        if (deleted.error) {
            if (deleted.error.code === '23503') throw userError('No puedes eliminar esta materia porque existen solicitudes o tutorías asociadas a ella.');
            throw deleted.error;
        }
        if (!(deleted.data || []).length) throw userError('No se pudo eliminar la materia: otro tutor la tiene asignada o ya no existe.');
        await hydrate({ refreshUi: false });
        return { ok: true };
    }

    async function syncTutorMappings(tutorId) {
        if (!isEnabled() || !tutorId) return;
        const userId = await getAuthenticatedUserId();
        if (userId !== tutorId) throw Object.assign(new Error('La sesión no corresponde al tutor actual.'), { code: '42501' });
        const users = getStoredData(STORAGE_KEYS.USERS, []);
        const tutor = users.find(u => u.id === tutorId);
        if (!tutor) return;
        const subjectsRes = await client.from('materias').select('id,nombre').order('id');
        if (subjectsRes.error) throw subjectsRes.error;
        const remoteByName = new Map((subjectsRes.data || []).map(s => [normalizeSubjectName(s.nombre), Number(s.id)]));
        const rows = [...new Set((tutor.subjects || []).map(name => remoteByName.get(normalizeSubjectName(name))).filter(Boolean))]
            .map(materiaId => ({ tutor_id: tutorId, materia_id: materiaId }));
        if (!rows.length) return true;
        const relation = await client.from('tutor_materias').upsert(rows, { onConflict: 'tutor_id,materia_id', ignoreDuplicates: true });
        if (relation.error) throw relation.error;
        return true;
    }

    async function syncOneRequest(request) {
        if (!isEnabled() || !request) return;

        const sessionRes = await client.auth.getSession();
        if (sessionRes.error) throw sessionRes.error;
        const userId = sessionRes.data?.session?.user?.id;
        if (!userId) throw new Error('No hay una sesión autenticada.');

        const isParticipant = userId === request.studentId || userId === request.tutorId;
        const previousTutorAction = Array.isArray(request.history) && request.history.some(ev =>
            ['tutor_rejected', 'tutor_removed'].includes(ev.type) && ev.tutorId === userId
        );
        if (!isParticipant && !previousTutorAction) {
            throw Object.assign(new Error('El usuario autenticado no participa en esta solicitud.'), { code: '42501' });
        }

        const subjects = getStoredData(STORAGE_KEYS.SUBJECTS, []);
        const subject = subjects.find(s => s.name === request.subject);
        if (!subject || !request.studentId) throw userError('La materia de esta solicitud ya no existe en el catálogo.');

        const row = {
            id: Number(request.id),
            estudiante_id: request.studentId,
            tutor_id: request.tutorId || null,
            materia_id: Number(subject.id),
            fecha_preferida: request.preferredDate || null,
            hora_preferida: request.preferredTime || null,
            tema: request.topic || null,
            estado: STATUS_TO_DB[request.status] || String(request.status).toLowerCase(),
            fecha_propuesta: request.proposedDate || null,
            hora_propuesta: request.proposedTime || null,
            mensaje_propuesta: request.proposedMessage || null,
            tutores_rechazados: request.rejectedTutorIds || [],
            origen_rechazo: request.rejectionSource || null,
            fecha_propuesta_rechazada: request.rejectedProposalDate || null,
            hora_propuesta_rechazada: request.rejectedProposalTime || null,
            motivo_cancelacion: request.cancellationReason || null,
            abierta_reasignacion: !!request.openForReassignment,
            oculta_para_estudiante: Array.isArray(request.hiddenFor) && request.hiddenFor.includes(request.studentId),
            oculta_para_tutor: !!(request.tutorId && Array.isArray(request.hiddenFor) && request.hiddenFor.includes(request.tutorId)),
            respondida_en: request.respondedAt ? localTimestampToDate(request.respondedAt).toISOString() : null,
            realizada_en: request.completedAt ? localTimestampToDate(request.completedAt).toISOString() : null
        };
        const existing = await client.from('solicitudes_tutoria').select('id,estudiante_id,tutor_id,estado').eq('id', Number(request.id)).maybeSingle();
        if (existing.error) throw existing.error;

        // Último estado remoto conocido: si cambió desde entonces, la acción se
        // hizo sobre una copia obsoleta y no debe sobrescribir el cambio ajeno.
        const knownSnapshot = syncedRequestSnapshots.get(Number(request.id));
        const known = knownSnapshot ? JSON.parse(knownSnapshot) : null;

        if (!existing.data && userId !== request.studentId) return false;
        if (existing.data && userId !== existing.data.estudiante_id && userId !== existing.data.tutor_id) {
            if (known && known.tutorId === userId) throw userError(STALE_REQUEST_MESSAGE, 'stale');
            return false;
        }
        if (existing.data && known && (
            (existing.data.tutor_id || null) !== (known.tutorId || null) ||
            existing.data.estado !== (STATUS_TO_DB[known.status] || known.status)
        )) {
            throw userError(STALE_REQUEST_MESSAGE, 'stale');
        }

        if (existing.data) {
            await syncRequestHistory(request);
            const updated = await client.from('solicitudes_tutoria').update(row).eq('id', Number(request.id));
            if (updated.error) throw updated.error;
        } else {
            const inserted = await client.from('solicitudes_tutoria').insert(row);
            if (inserted.error) throw inserted.error;
            await syncRequestHistory(request);
        }

        if (userId === request.studentId) {
            if (request.rating == null) {
                const delRating = await client.from('calificaciones').delete().eq('solicitud_id', Number(request.id));
                if (delRating.error) throw delRating.error;
            } else {
                const ratingRow = {
                    solicitud_id: Number(request.id),
                    estudiante_id: request.studentId,
                    tutor_id: request.tutorId || null,
                    puntuacion: Number(request.rating),
                    comentario: request.ratingComment || null
                };
                const ratingUp = await client.from('calificaciones').upsert(ratingRow, { onConflict: 'solicitud_id' });
                if (ratingUp.error) throw ratingUp.error;
            }
        }
        syncedRequestSnapshots.set(Number(request.id), JSON.stringify(request));
        return true;
    }

    async function syncRequestHistory(request) {
        const hist = Array.isArray(request.history) ? request.history : [];
        if (hist.length) {
            const remoteHist = await client
                .from('historial_solicitud')
                .select('tipo,fecha_evento,detalles')
                .eq('solicitud_id', Number(request.id))
                .order('id');
            if (remoteHist.error) throw remoteHist.error;

            const signature = (tipo, fecha, detalles) => JSON.stringify([
                tipo,
                new Date(fecha).toISOString(),
                canonicalJson(detalles || {})
            ]);
            const existingSignatures = new Set((remoteHist.data || []).map(ev =>
                signature(ev.tipo, ev.fecha_evento, ev.detalles)
            ));

            const missingRows = [];
            for (const ev of hist) {
                const fecha = localTimestampToDate(ev.at || request.createdAt).toISOString();
                const detalles = Object.fromEntries(Object.entries(ev).filter(([k, v]) => !['type', 'at'].includes(k) && v !== undefined));
                const sig = signature(ev.type || 'evento', fecha, detalles);
                if (!existingSignatures.has(sig)) {
                    missingRows.push({
                        solicitud_id: Number(request.id),
                        tipo: ev.type || 'evento',
                        fecha_evento: fecha,
                        detalles
                    });
                    existingSignatures.add(sig);
                }
            }

            if (missingRows.length) {
                const hi = await client.from('historial_solicitud').insert(missingRows);
                if (hi.error) throw hi.error;
            }
        }
    }

    function canonicalJson(value) {
        if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
        if (value && typeof value === 'object') {
            return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    async function syncRequests(requests) {
        if (!isEnabled()) return;
        const sessionRes = await client.auth.getSession();
        if (sessionRes.error) throw sessionRes.error;
        const userId = sessionRes.data?.session?.user?.id;
        if (!userId) throw new Error('No hay una sesión autenticada.');

        const participantRequests = (requests || []).filter(req => {
            if (!req) return false;
            if (syncedRequestSnapshots.get(Number(req.id)) === JSON.stringify(req)) return false;
            if (req.studentId === userId || req.tutorId === userId) return true;
            return Array.isArray(req.history) && req.history.some(ev =>
                ['tutor_rejected', 'tutor_removed'].includes(ev.type) && ev.tutorId === userId
            );
        });
        for (const req of participantRequests) await syncOneRequest(req);
    }

    // Tutores elegibles según Supabase. Si la consulta falla se lanza el error: usar
    // un respaldo local podría elegir a un tutor que el servidor habría descartado.
    async function getEligibleTutorIds(requestId) {
        if (!isEnabled() || requestId == null) return null;
        const { data, error } = await client.rpc('tutores_elegibles_reasignacion', { p_solicitud_id: Number(requestId) });
        if (error) {
            console.error('Supabase eligible tutors error:', error.code || error.message);
            throw userError(getFriendlyError(error, 'No se pudo consultar qué tutores pueden recibir la solicitud.'), error.code);
        }
        return (Array.isArray(data) ? data : [])
            .map(row => (row && typeof row === 'object') ? row.id_tutor : row)
            .filter(Boolean);
    }

    // Rechazo y reasignación atómicos en Supabase (rechazar_solicitud): el servidor
    // valida que quien llama es el tutor actual, elige al nuevo tutor, actualiza la
    // solicitud y escribe el historial en una sola transacción. Solo se informa éxito
    // si Supabase lo confirma y los datos locales se recargan siempre desde el servidor.
    async function rejectRequestRemote(requestId) {
        if (!isEnabled() || requestId == null) {
            return { ok: false, message: 'No se pudo conectar con Supabase. Comprueba tu conexión e inténtalo nuevamente.' };
        }
        return runExclusive(async () => {
            activeRequestSyncs++;
            let outcome;
            try {
                await getAuthenticatedUserId();
                const { data, error } = await client.rpc('rechazar_solicitud', { p_solicitud_id: Number(requestId) });
                if (error) throw error;
                if (!data || typeof data.reasignada !== 'boolean') {
                    throw userError('Supabase no confirmó el rechazo de la solicitud. Revisa su estado actual.');
                }
                outcome = { ok: true, reassigned: data.reasignada, tutorId: data.tutor_id || null, tutorName: data.tutor_nombre || null };
            } catch (error) {
                console.error('Supabase reject error:', error?.code || error?.message || error);
                outcome = { ok: false, message: getFriendlyError(error, 'No se pudo rechazar la solicitud. Inténtalo nuevamente.') };
            } finally {
                activeRequestSyncs--;
            }
            // Los cambios en tiempo real recibidos durante la operación se sustituyen por esta recarga.
            realtimeDeferred = false;
            const refreshed = await hydrate({ silent: true });
            if (outcome.ok && !refreshed) {
                window.showToast?.('La solicitud se actualizó, pero no se pudieron recargar los datos. Actualiza la pantalla.', 'info');
            }
            return outcome;
        });
    }

    // Supabase Auth devuelve el mismo código (invalid_credentials) si la cuenta
    // no existe o si la contraseña es incorrecta; existe_cuenta lo distingue.
    async function classifySignInError(error, email) {
        const code = String(error?.code || '');
        const message = String(error?.message || '').toLowerCase();
        if (code !== 'invalid_credentials' && !/invalid login credentials/.test(message)) return error;
        try {
            const { data, error: rpcError } = await client.rpc('existe_cuenta', { p_correo: email });
            if (rpcError || typeof data !== 'boolean') return error;
            if (data === false) return userError(ACCOUNT_NOT_FOUND_MESSAGE, 'account_not_found');
            return userError('La contraseña es incorrecta.', 'wrong_password');
        } catch (_) {
            return error;
        }
    }

    async function getTutorActiveRequestCount(tutorId) {
        if (!isEnabled() || !tutorId) return -1;
        const userId = await getAuthenticatedUserId();
        if (userId !== tutorId) throw Object.assign(new Error('La sesión no corresponde al tutor actual.'), { code: '42501' });
        const result = await client.from('solicitudes_tutoria')
            .select('id', { count: 'exact', head: true })
            .eq('tutor_id', tutorId)
            .in('estado', ['pendiente', 'propuesta_horario', 'aceptada']);
        if (result.error) throw result.error;
        return Number(result.count || 0);
    }

    async function deleteTutorAccount(tutorId) {
        if (!isEnabled() || !tutorId) throw new Error('No hay una conexión válida con Supabase.');
        const userId = await getAuthenticatedUserId();
        if (userId !== tutorId) throw Object.assign(new Error('La sesión no corresponde al tutor actual.'), { code: '42501' });
        const { error } = await client.rpc('eliminar_cuenta_propia');
        if (error) {
            if (error.code === 'P0001' || /tutorías.*cargo|tutorias.*cargo/i.test(String(error.message || ''))) {
                throw userError('No se puede eliminar en este momento: tienes tutorías a tu cargo.');
            }
            throw error;
        }
        try { await client.auth.signOut({ scope: 'local' }); } catch (_) {}
        return { ok: true };
    }

    async function bootstrap() {
        if (!ready) {
            window.EDUMATCH_BACKEND_STATUS = { enabled: false, reason: 'Configura URL y publishable key de Supabase.' };
            return false;
        }
        client = window.supabase.createClient(cfg.url, cfg.publishableKey, {
            auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
        });
        window.EDUMATCH_SUPABASE = client;
        try {
            await hydrate({ refreshUi: false });
            realtimeChannel = client.channel('edumatch-realtime')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'perfiles' }, scheduleRealtimeHydrate)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'materias' }, scheduleRealtimeHydrate)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'tutor_materias' }, scheduleRealtimeHydrate)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'solicitudes_tutoria' }, scheduleRealtimeHydrate)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'historial_solicitud' }, scheduleRealtimeHydrate)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'calificaciones' }, scheduleRealtimeHydrate)
                .subscribe();

            client.auth.onAuthStateChange(() => {
                setTimeout(() => hydrate(), 0);
            });
            window.EDUMATCH_BACKEND_STATUS = { enabled: true, hydrated: true };
            return true;
        } catch (error) {
            console.error('Supabase bootstrap error:', error);
            window.EDUMATCH_BACKEND_STATUS = { enabled: false, error: error.message };
            return false;
        }
    }

    window.EduMatchBackend = {
        bootstrap,
        hydrate: () => hydrate({ refreshUi: true }),
        isEnabled,
        get client() { return client; },
        async signUp({ email, password, name, role }) {
            if (!isEnabled()) throw new Error('Supabase no está configurado.');
            const { data, error } = await client.auth.signUp({
                email,
                password,
                options: { data: { nombre: name, rol: role } }
            });
            if (error) throw error;
            if (data.user && data.session) {
                await hydrate();
            }
            return data;
        },
        async signIn(email, password) {
            if (!isEnabled()) throw new Error('Supabase no está configurado.');
            const { data, error } = await client.auth.signInWithPassword({ email, password });
            if (error) throw await classifySignInError(error, email);
            if (!(await hydrate({ silent: true }))) {
                throw userError('No se pudieron cargar los datos de la cuenta. Comprueba tu conexión e inténtalo nuevamente.', 'hydrate_failed');
            }
            if (!localStorage.getItem(STORAGE_KEYS.CURRENT_USER)) {
                // Autenticación válida pero sin perfil: la cuenta ya no existe en EduMatch.
                try { await client.auth.signOut({ scope: 'local' }); } catch (_) {}
                throw userError(ACCOUNT_NOT_FOUND_MESSAGE, 'account_not_found');
            }
            return data;
        },
        async signOut() {
            if (!isEnabled()) return;
            const { error } = await client.auth.signOut();
            if (error) throw error;
            localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
        },
        async onLocalDataSaved(key, value) {
            if (!isEnabled() || key !== STORAGE_KEYS.REQUESTS) return true;
            return runExclusive(async () => {
                if (!hydrated) {
                    // Sin una carga inicial correcta no hay referencia remota: no se
                    // informa éxito de un cambio que no llegó a Supabase.
                    await hydrate({ silent: true });
                    return { ok: false, message: 'No se pudo conectar con Supabase. Comprueba tu conexión e inténtalo nuevamente.' };
                }
                activeRequestSyncs++;
                let failure = null;
                try {
                    await syncRequests(value);
                } catch (error) {
                    console.error(`Supabase sync error (${key}):`, error?.code || error?.message || error);
                    failure = error;
                } finally {
                    activeRequestSyncs--;
                }
                if (failure) {
                    realtimeDeferred = false;
                    await hydrate({ silent: true });
                    return { ok: false, message: getFriendlyError(failure, 'No se pudo sincronizar con Supabase.') };
                }
                if (realtimeDeferred && activeRequestSyncs === 0) {
                    realtimeDeferred = false;
                    hydrate();
                }
                return true;
            });
        },
        rejectRequest: rejectRequestRemote,
        getEligibleTutorIds,
        async syncTutorSubjects(tutorId) {
            try {
                await syncTutorMappings(tutorId);
                await hydrate();
                return { ok: true };
            } catch (error) {
                console.error(error);
                const message = getFriendlyError(error, 'No se pudieron guardar las materias del tutor.');
                window.showToast?.(message, 'error');
                return { ok: false, message };
            }
        },
        async assignTutorSubject(tutorId, subjectName) {
            try { return await assignTutorSubject(tutorId, subjectName); }
            catch (error) {
                console.error(error);
                const message = getFriendlyError(error, 'No se pudo agregar la materia al perfil.');
                window.showToast?.(message, 'error');
                return { ok: false, message };
            }
        },
        async removeTutorSubject(tutorId, subjectName) {
            try { return await removeTutorSubject(tutorId, subjectName); }
            catch (error) {
                console.error(error);
                const message = getFriendlyError(error, 'No se pudo quitar la materia del perfil.');
                window.showToast?.(message, 'error');
                return { ok: false, message };
            }
        },
        async deleteCustomSubject(tutorId, subjectName) {
            try { return await deleteCustomSubject(tutorId, subjectName); }
            catch (error) {
                console.error(error);
                const message = getFriendlyError(error, 'No se pudo eliminar la materia personalizada.');
                window.showToast?.(message, 'error');
                return { ok: false, message };
            }
        },
        async createTutorSubject(tutorId, subjectInput) {
            try {
                return await createTutorSubject(tutorId, subjectInput);
            } catch (error) {
                console.error(error);
                const message = getFriendlyError(error, 'No se pudo crear la materia.');
                const wrapped = new Error(message);
                wrapped.code = error?.code;
                throw wrapped;
            }
        },
        async getTutorActiveRequestCount(tutorId) {
            try { return await getTutorActiveRequestCount(tutorId); }
            catch (error) {
                console.error(error);
                window.showToast?.(getFriendlyError(error, 'No se pudo comprobar el estado de las tutorías.'), 'error');
                return -1;
            }
        },
        async deleteTutorAccount(tutorId) {
            try { return await deleteTutorAccount(tutorId); }
            catch (error) {
                console.error(error);
                const message = getFriendlyError(error, 'No se pudo eliminar la cuenta.');
                window.showToast?.(message, 'error');
                return { ok: false, message };
            }
        }
    };
})();

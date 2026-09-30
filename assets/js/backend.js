(function () {
    const cfg = window.EDUMATCH_SUPABASE_CONFIG || {};
    const ready = !!(cfg.url && cfg.publishableKey && window.supabase && typeof window.supabase.createClient === 'function');

    let client = null;
    let realtimeChannel = null;
    let hydrated = false;
    let hydrating = false;

    const STATUS_TO_DB = {
        'Pendiente': 'pendiente',
        'Aceptada': 'aceptada',
        'Rechazada': 'rechazada',
        'Propuesta_Horario': 'propuesta_horario',
        'Cancelada': 'cancelada',
        'Realizada': 'realizada'
    };
    const STATUS_FROM_DB = Object.fromEntries(Object.entries(STATUS_TO_DB).map(([k, v]) => [v, k]));

    function getFriendlyError(error, fallback = 'No se pudo completar la operación.') {
        const message = String(error?.message || '').toLowerCase();
        const code = String(error?.code || '');
        if (/failed to fetch|network|fetch|connection|internet|timeout/.test(message)) {
            return 'No se pudo conectar con Supabase. Comprueba tu conexión a Internet.';
        }
        if (code === '42501' || /permission denied|row-level security|rls/.test(message)) {
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

    function localTimestampToDate(value) {
        if (!value) return new Date();
        const m = String(value).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
        if (!m) return new Date(value);
        return new Date(`${m[1]}T${m[2]}:00-05:00`);
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
            client.from('perfiles').select('id,nombre,correo,rol,activo,creado_en').eq('activo', true),
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

        const users = profiles.map(p => ({
            id: p.id,
            role: p.rol,
            name: p.nombre,
            email: p.correo,
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
        cache(STORAGE_KEYS.SUBJECTS, subjects.map(s => ({ id: Number(s.id), name: s.nombre, category: s.categoria, description: s.descripcion })));
        cache(STORAGE_KEYS.REQUESTS, localRequests);

        const session = sessionRes.data?.session;
        if (session) {
            const profile = profileById.get(session.user.id);
            if (profile) {
                cache(STORAGE_KEYS.CURRENT_USER, users.find(u => u.id === profile.id) || {
                    id: profile.id, role: profile.rol, name: profile.nombre, email: profile.correo, subjects: tutorSubjectNames.get(profile.id) || []
                });
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

    async function hydrate(options = {}) {
        if (!isEnabled() || hydrating) return false;
        hydrating = true;
        try {
            await fetchAll();
            if (options.refreshUi !== false && document.readyState !== 'loading') notifyUi();
            return true;
        } catch (error) {
            console.error('Supabase hydrate error:', error);
            window.showToast?.(getFriendlyError(error, 'No se pudieron sincronizar los datos con Supabase.'), 'error');
            return false;
        } finally {
            hydrating = false;
        }
    }

    async function syncSubjects(subjects) {
        if (!isEnabled()) return;
        const rows = (subjects || []).map(s => ({
            id: Number(s.id),
            nombre: s.name,
            categoria: s.category || 'General',
            descripcion: s.description || null
        }));
        if (!rows.length) return;
        const { error } = await client.from('materias').upsert(rows, { onConflict: 'id' });
        if (error) throw error;
    }

    async function syncTutorMappings(tutorId) {
        if (!isEnabled() || !tutorId) return;
        const users = getStoredData(STORAGE_KEYS.USERS, []);
        const tutor = users.find(u => u.id === tutorId);
        if (!tutor) return;
        const subjects = getStoredData(STORAGE_KEYS.SUBJECTS, []);
        const subjectByName = new Map(subjects.map(s => [s.name, s.id]));
        const desired = (tutor.subjects || []).map(name => subjectByName.get(name)).filter(Boolean);
        const del = await client.from('tutor_materias').delete().eq('tutor_id', tutorId);
        if (del.error) throw del.error;
        if (desired.length) {
            const rows = [...new Set(desired)].map(materia_id => ({ tutor_id: tutorId, materia_id }));
            const ins = await client.from('tutor_materias').insert(rows);
            if (ins.error) throw ins.error;
        }
    }

    async function syncOneRequest(request) {
        if (!isEnabled() || !request) return;
        const users = getStoredData(STORAGE_KEYS.USERS, []);
        const subjects = getStoredData(STORAGE_KEYS.SUBJECTS, []);
        const subject = subjects.find(s => s.name === request.subject);
        if (!subject || !request.studentId) return;

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
        const existing = await client.from('solicitudes_tutoria').select('id').eq('id', Number(request.id)).maybeSingle();
        if (existing.error) throw existing.error;

        if (existing.data) {
            const updated = await client.from('solicitudes_tutoria').update(row).eq('id', Number(request.id));
            if (updated.error) throw updated.error;
        } else {
            const inserted = await client.from('solicitudes_tutoria').insert(row);
            if (inserted.error) throw inserted.error;
        }

        const delHist = await client.from('historial_solicitud').delete().eq('solicitud_id', Number(request.id));
        if (delHist.error) throw delHist.error;
        const hist = Array.isArray(request.history) ? request.history : [];
        if (hist.length) {
            const histRows = hist.map(ev => ({
                solicitud_id: Number(request.id),
                tipo: ev.type || 'evento',
                fecha_evento: localTimestampToDate(ev.at || request.createdAt).toISOString(),
                detalles: Object.fromEntries(Object.entries(ev).filter(([k]) => !['type','at'].includes(k)))
            }));
            const hi = await client.from('historial_solicitud').insert(histRows);
            if (hi.error) throw hi.error;
        }

        if (request.rating == null) {
            const delRating = await client.from('calificaciones').delete().eq('solicitud_id', Number(request.id));
            if (delRating.error) throw delRating.error;
        } else {
            const tutorId = request.tutorId || null;
            const ratingRow = {
                solicitud_id: Number(request.id),
                estudiante_id: request.studentId,
                tutor_id: tutorId,
                puntuacion: Number(request.rating),
                comentario: request.ratingComment || null
            };
            const ratingUp = await client.from('calificaciones').upsert(ratingRow, { onConflict: 'solicitud_id' });
            if (ratingUp.error) throw ratingUp.error;
        }
    }

    async function syncRequests(requests) {
        if (!isEnabled()) return;
        for (const req of requests || []) await syncOneRequest(req);
    }

    async function deactivateProfile(id) {
        if (!isEnabled() || !id) return;
        const { error } = await client.from('perfiles').update({ activo: false }).eq('id', id);
        if (error) throw error;
        await syncTutorMappings(id);
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
                .on('postgres_changes', { event: '*', schema: 'public', table: 'perfiles' }, () => hydrate())
                .on('postgres_changes', { event: '*', schema: 'public', table: 'materias' }, () => hydrate())
                .on('postgres_changes', { event: '*', schema: 'public', table: 'tutor_materias' }, () => hydrate())
                .on('postgres_changes', { event: '*', schema: 'public', table: 'solicitudes_tutoria' }, () => hydrate())
                .on('postgres_changes', { event: '*', schema: 'public', table: 'historial_solicitud' }, () => hydrate())
                .on('postgres_changes', { event: '*', schema: 'public', table: 'calificaciones' }, () => hydrate())
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
            if (error) throw error;
            await hydrate();
            return data;
        },
        async signOut() {
            if (!isEnabled()) return;
            const { error } = await client.auth.signOut();
            if (error) throw error;
            localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
        },
        async onLocalDataSaved(key, value) {
            if (!isEnabled() || !hydrated) return;
            try {
                if (key === STORAGE_KEYS.SUBJECTS) await syncSubjects(value);
                if (key === STORAGE_KEYS.REQUESTS) await syncRequests(value);
            } catch (error) {
                console.error(`Supabase sync error (${key}):`, error);
                window.showToast?.(`Cambios guardados localmente. ${getFriendlyError(error, 'No se pudo sincronizar con Supabase.')}`, 'error');
            }
        },
        async syncTutorSubjects(tutorId) {
            try { await syncTutorMappings(tutorId); await hydrate(); }
            catch (error) { console.error(error); window.showToast?.(getFriendlyError(error, 'No se pudieron guardar las materias del tutor.'), 'error'); }
        },
        deactivateProfile,
        async syncRequest(request) {
            try { await syncOneRequest(request); await hydrate(); }
            catch (error) { console.error(error); window.showToast?.(getFriendlyError(error, 'No se pudo sincronizar la solicitud.'), 'error'); }
        }
    };
})();

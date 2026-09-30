// app.js — Lógica de negocio: materias, tutores, solicitudes y valoraciones.
// Las validaciones de rol en la interfaz complementan las políticas RLS del backend.

// ---------- Materias: catálogo compartido ----------
// Eliminación de perfil de tutor "con deshacer": desaparece de la vista de
// inmediato pero el borrado real en localStorage no se confirma hasta que pasa
// el margen de tiempo del toast, sin usar window.confirm() (se ve como un
// aviso nativo del navegador, fuera de estilo con el resto de la interfaz).
let pendingTutorDeletion = null; // { tutorId }

// APP-03: Consulta de materias (catálogo + búsqueda en renderSubjects/filterSubjects).
function getSubjects() {
    return getStoredData(STORAGE_KEYS.SUBJECTS, initialSubjects);
}

function findSubjectByName(name) {
    return getSubjects().find(s => s.name.toLowerCase() === name.toLowerCase());
}

function renderSubjects(filterText = '') {
    const subjects = getSubjects();
    const grid = document.getElementById('subjectsGrid');
    const select = document.getElementById('selectSubject');
    const previousValue = select.value;

    grid.innerHTML = '';
    select.innerHTML = '<option value="">Selecciona una materia...</option>';

    const filtered = subjects.filter(s =>
        s.name.toLowerCase().includes(filterText.toLowerCase()) ||
        s.category.toLowerCase().includes(filterText.toLowerCase())
    );

    grid.innerHTML = filtered.length === 0
        ? `<p class="empty-state">No se encontraron materias que coincidan con "${escapeHtml(filterText)}".</p>`
        : filtered.map(subject => `
            <div class="card subject-card">
                <div>
                    <div class="subject-card-header">
                        <h3>${escapeHtml(subject.name)}</h3>
                        <span class="badge">${escapeHtml(subject.category)}</span>
                    </div>
                    <p>${escapeHtml(subject.description)}</p>
                </div>
                <button type="button" class="btn-secondary btn-block" data-action="request-subject" data-subject="${escapeHtml(subject.name)}">
                    Solicitar Tutoría
                </button>
            </div>`).join('');

    subjects.forEach(subject => {
        const option = document.createElement('option');
        option.value = subject.name;
        option.textContent = subject.name;
        select.appendChild(option);
    });
    if ([...select.options].some(o => o.value === previousValue)) select.value = previousValue;
}

function filterSubjects() {
    renderSubjects(document.getElementById('searchSubject').value);
}

function quickSelectSubject(subjectName) {
    switchTab('request');
    document.getElementById('selectSubject').value = subjectName;
    // Cambiar la materia puede invalidar al tutor que ya estuviera elegido,
    // así que se vuelve a filtrar/revalidar el select de tutor.
    updateTutorSelectForSubject();
}

/** Lista de checkboxes de materias usada al registrarse como tutor. */
function renderSubjectCheckboxList(preselected = []) {
    const container = document.getElementById('regSubjectsList');
    if (!container) return;
    const subjects = getSubjects();
    container.innerHTML = subjects.map(s => `
        <label class="subject-checkbox">
            <input type="checkbox" value="${escapeHtml(s.name)}" ${preselected.includes(s.name) ? 'checked' : ''}>
            ${escapeHtml(s.name)}
        </label>`).join('');
}

/**
 * Permite a un TUTOR crear una materia nueva en el catálogo compartido.
 * Solo la crea: para ofrecerla, el propio tutor la asigna después con el
 * flujo ya existente (select "Agregar materia existente" -> assignSubjectToTutor),
 * igual que con cualquier materia predefinida.
 */
function createSubject(tutorId, rawName, rawDescription) {
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.TUTOR || currentUser.id !== tutorId) {
        showToast('Solo un tutor puede crear materias nuevas.', 'error');
        return;
    }

    // Normaliza espacios (colapsa múltiples espacios y recorta extremos) antes de validar.
    const name = (rawName || '').trim().replace(/\s+/g, ' ');
    if (!name) {
        showToast('Escribe un nombre para la nueva materia.', 'error');
        return;
    }
    if (findSubjectByName(name)) {
        showToast('Ya existe una materia con ese nombre.', 'error');
        return;
    }

    const description = (rawDescription || '').trim().replace(/\s+/g, ' ') || 'Materia agregada por un tutor.';

    const subjects = getSubjects();
    const newId = subjects.reduce((max, s) => Math.max(max, s.id), 0) + 1;
    subjects.push({ id: newId, name, category: 'Personalizada', description });
    saveData(STORAGE_KEYS.SUBJECTS, subjects);

    showToast(`Materia "${name}" creada. Ahora puedes asignártela desde tu tarjeta.`, 'success');

    // Refresca todo lo que depende del catálogo: grid de materias, selects del
    // formulario de solicitud, y el select "Agregar materia existente" del tutor.
    filterSubjects();
    renderTutors();
    updateStats();
}

// ---------- Tutores ----------
// APP-05: Consulta de tutores disponibles (getTutors/renderTutors/renderTutorCard).
function getTutors() {
    return getStoredData(STORAGE_KEYS.USERS, [])
        .filter(u => u.role === ROLES.TUTOR && u.id !== (pendingTutorDeletion && pendingTutorDeletion.tutorId));
}

function renderTutors() {
    const tutors = getTutors();
    const grid = document.getElementById('tutorsGrid');
    if (!grid) return;

    const currentUser = getCurrentUser();

    // El propio tutor va primero: su tarjeta (con la gestión de materias) ocupa
    // todo el ancho y así no estira ni deforma las tarjetas de los demás.
    const isOwn = t => !!(currentUser && currentUser.role === ROLES.TUTOR && currentUser.id === t.id);
    const ordered = tutors.slice().sort((a, b) => Number(isOwn(b)) - Number(isOwn(a)));

    grid.innerHTML = ordered.length === 0
        ? `<p class="empty-state">Todavía no hay tutores registrados. ¡Sé el primero en registrarte como tutor!</p>`
        : ordered.map(tutor => renderTutorCard(tutor, currentUser)).join('');

    // El select de "Tutor preferido" del formulario de solicitud depende de la
    // materia elegida (relación válida TUTOR + MATERIA), así que se delega su
    // construcción a updateTutorSelectForSubject en vez de listar aquí a todos
    // los tutores sin filtrar.
    updateTutorSelectForSubject();
}

/**
 * Reconstruye el select "Tutor preferido" mostrando SOLO tutores que tengan
 * asignada la materia actualmente elegida en el formulario (relación válida
 * TUTOR + MATERIA, ver auditoría de bug crítico). Si no hay materia elegida
 * todavía, se listan todos los tutores (aún no hay nada que filtrar).
 * Si el tutor que estaba seleccionado deja de ser compatible (porque cambió
 * la materia o el tutor perdió esa materia), se revalida y se limpia con aviso.
 */
function updateTutorSelectForSubject() {
    const subjectSelect = document.getElementById('selectSubject');
    const tutorSelect = document.getElementById('selectTutor');
    if (!subjectSelect || !tutorSelect) return;

    const subjectName = subjectSelect.value;
    const previousValue = tutorSelect.value;
    const allTutors = getTutors();
    const compatibleTutors = subjectName
        ? allTutors.filter(t => (t.subjects || []).includes(subjectName))
        : allTutors;

    tutorSelect.innerHTML = '<option value="">Sin preferencia (automático)</option>';
    compatibleTutors.forEach(tutor => {
        const option = document.createElement('option');
        option.value = tutor.name;
        option.textContent = tutor.subjects && tutor.subjects.length ? `${tutor.name} — ${tutor.subjects.join(', ')}` : tutor.name;
        tutorSelect.appendChild(option);
    });

    const stillValid = compatibleTutors.some(t => t.name === previousValue);
    if (previousValue && stillValid) {
        tutorSelect.value = previousValue;
    } else if (previousValue && !stillValid) {
        tutorSelect.value = '';
        if (subjectName) {
            showToast('El tutor seleccionado no tiene esta materia asignada. Selecciona otro tutor que sí la dicte.', 'error');
        }
    }

    renderTutorAvailabilityHint(subjectName, compatibleTutors.length);
}

/** Mensaje bajo el select cuando la materia elegida no tiene tutores compatibles. */
function renderTutorAvailabilityHint(subjectName, compatibleCount) {
    const hint = document.getElementById('tutorAvailabilityHint');
    if (!hint) return;
    if (subjectName && compatibleCount === 0) {
        hint.textContent = 'No hay tutores disponibles para esta materia actualmente.';
        hint.style.display = 'block';
    } else {
        hint.textContent = '';
        hint.style.display = 'none';
    }
}

/** Tarjeta de tutor. TODAS las tarjetas comparten la misma estructura:
 *   .tutor-card__body    -> nombre + etiqueta, correo, materias
 *   .tutor-card__actions -> botón(es), siempre anclados al fondo de la tarjeta
 * La tarjeta del propio tutor añade además .tutor-card__manage (gestión de
 * materias y perfil) y es la única variante (.tutor-card--own). */
function renderTutorCard(tutor, currentUser) {
    const isOwner = !!(currentUser && currentUser.role === ROLES.TUTOR && currentUser.id === tutor.id);
    const subjects = tutor.subjects || [];
    const unassigned = getSubjects().filter(s => !subjects.includes(s.name));

    const tags = subjects.length
        ? subjects.map(s => `
            <span class="badge tutor-tag">
                <span class="tutor-tag__text">${escapeHtml(s)}</span>
                ${isOwner ? `<button type="button" class="tag-remove" data-action="remove-tutor-subject" data-tutor-id="${tutor.id}" data-subject="${escapeHtml(s)}" title="Quitar materia" aria-label="Quitar ${escapeHtml(s)}">&times;</button>` : ''}
            </span>`).join('')
        : `<span class="tutor-card__empty">Sin materias asignadas todavía.</span>`;

    const manage = isOwner ? `
        <div class="tutor-card__manage">
            <div class="tutor-manage-group">
                <select id="addSubjectSelect-${tutor.id}" aria-label="Materia existente para agregar">
                    <option value="">Agregar materia existente...</option>
                    ${unassigned.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('')}
                </select>
                <button type="button" class="btn-secondary btn-block" data-action="assign-tutor-subject" data-tutor-id="${tutor.id}">Agregar materia</button>
            </div>

            <div class="tutor-manage-group">
                <p class="tutor-manage-label">¿No encuentras tu materia? Crea una nueva y luego agrégala arriba.</p>
                <input type="text" id="newSubjectName-${tutor.id}" placeholder="Nombre de la nueva materia">
                <textarea id="newSubjectDesc-${tutor.id}" rows="2" placeholder="Descripción (opcional)"></textarea>
                <button type="button" class="btn-secondary btn-block" data-action="create-subject" data-tutor-id="${tutor.id}">Agregar nueva materia</button>
            </div>

            <button type="button" class="btn-danger btn-block" data-action="delete-tutor" data-tutor-id="${tutor.id}">Eliminar mi perfil de tutor</button>
        </div>` : '';

    const actions = !isOwner ? `
        <div class="tutor-card__actions">
            <button type="button" class="btn-secondary btn-block" data-action="select-tutor" data-tutor="${escapeHtml(tutor.name)}">Solicitar con este tutor</button>
        </div>` : '';

    return `
        <article class="card tutor-card${isOwner ? ' tutor-card--own' : ''}" data-tutor-id="${tutor.id}">
            <div class="tutor-card__body">
                <header class="tutor-card__header">
                    <h3 class="tutor-card__name" title="${escapeHtml(tutor.name)}">${escapeHtml(tutor.name)}</h3>
                    <span class="badge tutor-card__badge">Tutor</span>
                </header>
                <p class="tutor-card__email" title="${escapeHtml(tutor.email)}">${escapeHtml(tutor.email)}</p>
                <div class="tutor-card__tags">${tags}</div>
            </div>
            ${actions}
            ${manage}
        </article>`;
}

function assignSubjectToTutor(tutorId, subjectName) {
    if (!subjectName) {
        showToast('Selecciona una materia para agregar.', 'error');
        return;
    }
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.TUTOR || currentUser.id !== tutorId) {
        showToast('Solo el propio tutor puede gestionar sus materias.', 'error');
        return;
    }
    if (!findSubjectByName(subjectName)) {
        showToast('Esa materia no existe en el catálogo.', 'error');
        return;
    }

    const users = getStoredData(STORAGE_KEYS.USERS, []);
    const tutor = users.find(u => u.id === tutorId);
    if (!tutor) return;

    tutor.subjects = tutor.subjects || [];
    if (tutor.subjects.includes(subjectName)) {
        showToast('Ya tienes esa materia asignada.', 'error');
        return;
    }
    tutor.subjects.push(subjectName);
    saveData(STORAGE_KEYS.USERS, users);
    setCurrentUser(tutor);
    window.EduMatchBackend?.syncTutorSubjects(tutorId);

    showToast('Materia agregada a tu perfil.', 'success');
    renderTutors();
    // Agregar una materia puede volver válida una solicitud que antes estaba
    // bloqueada por desajuste tutor+materia: refrescar Mis Solicitudes también.
    renderRequests();
}

/** Quita una materia del perfil del tutor. Cualquier solicitud suya (activa)
 * para esa materia queda igual de "sin tutor válido" que si hubiera
 * eliminado el perfil entero, así que se resuelve con el MISMO resolvedor
 * (reassignOrCancel, ver rejectRequest/finalizeTutorDeletion): busca otro
 * tutor que la dicte y reasigna, o cancela si no queda ninguno. Nunca se deja
 * la solicitud abierta esperando que el estudiante elija manualmente. */
function removeSubjectFromTutor(tutorId, subjectName) {
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.TUTOR || currentUser.id !== tutorId) {
        showToast('Solo el propio tutor puede gestionar sus materias.', 'error');
        return;
    }

    const users = getStoredData(STORAGE_KEYS.USERS, []);
    const tutor = users.find(u => u.id === tutorId);
    if (!tutor) return;

    if (!(tutor.subjects || []).includes(subjectName)) {
        showToast('Esa materia no está asignada a tu perfil.', 'error');
        return;
    }

    tutor.subjects = (tutor.subjects || []).filter(s => s !== subjectName);
    saveData(STORAGE_KEYS.USERS, users);
    setCurrentUser(tutor);
    window.EduMatchBackend?.syncTutorSubjects(tutorId);

    // El tutor ya quedó guardado sin esta materia, así que getEligibleReplacementTutors
    // (que lee de storage) nunca vuelve a proponerlo a él mismo como reemplazo.
    const ACTIVE = [REQUEST_STATUS.PENDING, REQUEST_STATUS.PROPOSED, REQUEST_STATUS.ACCEPTED];
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    let requestsChanged = false;
    requests.forEach(r => {
        if (r.tutorId !== tutorId || r.subject !== subjectName || !ACTIVE.includes(r.status)) return;
        requestsChanged = true;
        logRequestEvent(r, 'tutor_removed', { tutorName: r.tutorName, reasonKind: 'subject_removed' });
        r.proposedDate = null;
        r.proposedTime = null;
        r.proposedMessage = null;
        r.tutorId = null; // deja de apuntar al tutor antes de buscar reemplazo
        reassignOrCancel(r, 'tutor_removed');
    });
    if (requestsChanged) saveData(STORAGE_KEYS.REQUESTS, requests);

    showToast('Materia eliminada de tu perfil.', 'success');
    renderTutors();
    // Si esta materia estaba asociada a alguna solicitud, ese vínculo tutor+materia
    // deja de ser válido: refrescar Mis Solicitudes para reflejarlo de inmediato.
    renderRequests();
    updateStats();
}

/** Elimina el perfil de tutor y desvincula limpiamente sus solicitudes activas.
 * El tutor desaparece de la vista de inmediato; el borrado real (y el cierre
 * de sesión) solo se confirma en localStorage si no se pulsa "Deshacer" a
 * tiempo, en vez de bloquear con un window.confirm() nativo. */
function deleteTutorProfile(tutorId) {
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.TUTOR || currentUser.id !== tutorId) {
        showToast('Solo el propio tutor puede eliminar su perfil.', 'error');
        return;
    }
    if (pendingTutorDeletion) return;

    pendingTutorDeletion = { tutorId };
    renderTutors();

    showToast('Se eliminará tu perfil de tutor.', 'info', {
        actionLabel: 'Deshacer',
        onAction: () => {
            pendingTutorDeletion = null;
            renderTutors();
            showToast('Eliminación cancelada.', 'success');
        },
        onExpire: () => finalizeTutorDeletion(tutorId)
    });
}

function finalizeTutorDeletion(tutorId) {
    pendingTutorDeletion = null;

    const users = getStoredData(STORAGE_KEYS.USERS, []).filter(u => u.id !== tutorId);
    saveData(STORAGE_KEYS.USERS, users);
    if (window.EduMatchBackend?.isEnabled()) {
        window.EduMatchBackend.deactivateProfile(tutorId).catch(error => console.error('No se pudo desactivar el perfil remoto:', error));
    }

    // Ninguna solicitud puede quedar apuntando a un tutor que ya no existe ni
    // "abierta" sin tutor:
    //   - activas (Pendiente / Propuesta / Aceptada): se reasignan solas a otro
    //     tutor que dicte la materia (quedan Pendientes de su respuesta, y se
    //     descarta cualquier horario ya propuesto) o se cancelan si no hay nadie;
    //   - terminadas (Realizada / Cancelada / Rechazada): solo se desvincula el id.
    // Los usuarios ya se guardaron sin este tutor, así que nunca se elige a él.
    const ACTIVE = [REQUEST_STATUS.PENDING, REQUEST_STATUS.PROPOSED, REQUEST_STATUS.ACCEPTED];
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    requests.forEach(r => {
        if (r.tutorId !== tutorId) return;
        if (ACTIVE.includes(r.status)) {
            logRequestEvent(r, 'tutor_removed', { tutorName: r.tutorName, reasonKind: 'profile_deleted' });
            r.proposedDate = null;
            r.proposedTime = null;
            r.proposedMessage = null;
            r.tutorId = null; // deja de apuntar al tutor eliminado antes de buscar reemplazo
            reassignOrCancel(r, 'tutor_removed');
        } else {
            r.tutorId = null;
            r.tutorName = null;
        }
    });
    saveData(STORAGE_KEYS.REQUESTS, requests);

    // Solo cierra la sesión si quien sigue conectado es justamente ese tutor
    // (pudo cerrar sesión o cambiar de cuenta durante el margen de "Deshacer").
    const stillCurrent = getCurrentUser();
    if (stillCurrent && stillCurrent.id === tutorId) {
        setCurrentUser(null);
    }
    refreshAfterAuthChange();
}

function selectTutorForRequest(tutorName) {
    switchTab('request');

    const subjectSelect = document.getElementById('selectSubject');
    const currentSubject = subjectSelect ? subjectSelect.value : '';
    const tutor = getTutors().find(t => t.name === tutorName);

    // Si ya había una materia elegida y ese tutor no la dicta, se bloquea la
    // preselección en vez de aceptar una combinación tutor+materia inválida.
    if (currentSubject && tutor && !(tutor.subjects || []).includes(currentSubject)) {
        showToast('Este tutor no ofrece esta materia actualmente.', 'error');
        updateTutorSelectForSubject();
        return;
    }

    updateTutorSelectForSubject();
    const select = document.getElementById('selectTutor');
    if (select && [...select.options].some(o => o.value === tutorName)) {
        select.value = tutorName;
    }
}

// ---------- Solicitudes de tutoría ----------
// APP-04: Solicitud de tutoría. También cubre la primera parte de APP-06
// (Selección de fecha y hora para agendar): el estudiante indica fecha/hora
// preferida al crear la solicitud.
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^\d{2}:\d{2}$/;

function handleTutorRequest(event) {
    event.preventDefault();

    // Capa de lógica: aunque el formulario esté oculto para quien no debe
    // usarlo, esta validación es la que realmente impide crear la solicitud
    // (por ejemplo, si alguien llama a handleTutorRequest() desde la consola).
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.STUDENT) {
        showToast('Debes iniciar sesión como estudiante para solicitar una tutoría.', 'error');
        return;
    }

    const subject = document.getElementById('selectSubject').value;
    const tutorName = document.getElementById('selectTutor').value;
    const preferredDate = document.getElementById('preferredDate').value;
    const preferredTime = document.getElementById('preferredTime').value;
    // El tema es opcional; fecha y hora son obligatorias.
    const topic = document.getElementById('requestTopic').value.trim();

    if (!subject) {
        showToast('Selecciona una materia para tu solicitud.', 'error');
        return;
    }
    if (!findSubjectByName(subject)) {
        showToast('La materia seleccionada no existe en el catálogo.', 'error');
        return;
    }
    // APP-06: fecha y hora son obligatorias (solo el "Tema específico" es opcional).
    if (!preferredDate) {
        showToast('Elige la fecha de la tutoría.', 'error');
        return;
    }
    if (!ISO_DATE_REGEX.test(preferredDate)) {
        showToast('La fecha preferida no es válida.', 'error');
        return;
    }
    if (preferredDate < todayIsoDate()) {
        showToast('La fecha preferida no puede ser en el pasado.', 'error');
        return;
    }
    if (!preferredTime) {
        showToast('Elige la hora de la tutoría.', 'error');
        return;
    }
    if (!TIME_REGEX.test(preferredTime)) {
        showToast('La hora preferida no es válida.', 'error');
        return;
    }
    if (preferredDate === todayIsoDate()) {
        const now = new Date();
        const nowHm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (preferredTime < nowHm) {
            showToast('Esa hora ya pasó. Elige una hora posterior.', 'error');
            return;
        }
    }

    let tutor = null;
    let autoAssigned = false;
    if (!tutorName) {
        // Sin preferencia: el sistema asigna el primer tutor que dicte la materia.
        // Una solicitud nunca se crea "abierta" y sin tutor: si no hay ninguno
        // disponible, no se crea (el estudiante lo ve al instante y puede elegir otra materia).
        tutor = getEligibleReplacementTutors({ subject, rejectedTutorIds: [], studentId: currentUser.id })[0] || null;
        if (!tutor) {
            showToast('Actualmente no hay tutores disponibles para esta materia.', 'error');
            return;
        }
        autoAssigned = true;
    } else {
        tutor = getTutors().find(t => t.name === tutorName);
        if (!tutor) {
            showToast('El tutor seleccionado no existe.', 'error');
            return;
        }
        // Relación válida obligatoria TUTOR + MATERIA: no basta con filtrar el
        // select en la UI, esta es la comprobación real que impide guardar una
        // solicitud inválida (por ejemplo, si se llama a esta función desde la
        // consola saltándose el formulario).
        if (!(tutor.subjects || []).includes(subject)) {
            showToast('Este tutor no ofrece esta materia actualmente.', 'error');
            return;
        }
    }

    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);

    // Evita duplicar una solicitud equivalente que ya está pendiente para el mismo estudiante.
    const isDuplicate = requests.some(r =>
        r.studentId === currentUser.id &&
        r.status === REQUEST_STATUS.PENDING &&
        r.subject === subject &&
        (r.tutorId || null) === (tutor ? tutor.id : null)
    );
    if (isDuplicate) {
        showToast('Ya tienes una solicitud pendiente equivalente para esta materia.', 'error');
        return;
    }

    requests.push({
        id: Date.now(),
        studentId: currentUser.id,
        studentName: currentUser.name,
        subject,
        tutorId: tutor ? tutor.id : null,
        tutorName: tutor ? tutor.name : null,
        preferredDate: preferredDate || null,
        preferredTime: preferredTime || null,
        topic: topic || null,
        status: REQUEST_STATUS.PENDING,
        rating: null,
        ratingComment: null,
        proposedDate: null,
        proposedTime: null,
        proposedMessage: null,
        // Tutores que rechazaron esta solicitud: nunca se vuelven a ofrecer en
        // "Buscar otro tutor" para esta misma solicitud (ver rejectRequest).
        rejectedTutorIds: [],
        // Origen del estado RECHAZADA: 'tutor' (el tutor rechazó la solicitud) o
        // 'schedule' (el estudiante rechazó la propuesta de horario).
        rejectionSource: null,
        rejectedProposalDate: null,
        rejectedProposalTime: null,
        // Motivo del estado CANCELADA cuando no fue una cancelación directa del
        // estudiante (p. ej. 'no_tutors': no había más tutores para la materia).
        cancellationReason: null,
        // Solo para la desvinculación por materia quitada (ver clearRequestTutor).
        openForReassignment: false,
        // Bitácora de eventos que muestra el historial de cada tarjeta.
        history: autoAssigned
            ? [{ type: 'created', at: nowLocalTimestamp() }, { type: 'tutor_assigned', at: nowLocalTimestamp(), tutorId: tutor.id, tutorName: tutor.name }]
            : [{ type: 'created', at: nowLocalTimestamp() }],
        createdAt: nowLocalTimestamp(),
        respondedAt: null,
        completedAt: null
    });
    saveData(STORAGE_KEYS.REQUESTS, requests);

    showToast(autoAssigned
        ? `Solicitud registrada y asignada automáticamente a ${tutor.name}.`
        : 'Solicitud de tutoría registrada con éxito.', 'success');
    document.getElementById('tutorRequestForm').reset();
    setDefaultPreferredDate();

    renderRequests();
    updateStats();
    switchTab('history');
}

// ---------- Flujo de estados de una solicitud ----------
// Significado de cada estado (única fuente de verdad; nunca se retrocede a
// PENDIENTE por cancelar un diálogo ni por rechazar una propuesta):
//   Pendiente  -> espera la respuesta del tutor asignado (también el tutor que
//                 el sistema asignó automáticamente tras el rechazo de otro).
//   Propuesta  -> el tutor propuso otro horario; espera al estudiante.
//   Aceptada   -> tutor/horario confirmados.
//   Rechazada  -> SOLO cuando el estudiante rechazó el horario propuesto.
//                 Decisión final: no se busca otro tutor.
//   Cancelada  -> el proceso terminó sin poder continuar (el estudiante la
//                 canceló, o un tutor la rechazó y no quedaban más tutores).
//
// El rechazo de un TUTOR nunca deja una solicitud abierta ni "Rechazada"
// esperando una acción manual: reassignOrCancel() lo resuelve al instante,
// reasignando al siguiente tutor disponible o cancelando la solicitud.
const NO_MORE_TUTORS_MESSAGE = 'Lo sentimos, no hay más tutores que den esta materia disponibles en este momento.';

/** Registra un evento en la bitácora de la solicitud (lo pinta el historial de la tarjeta). */
function logRequestEvent(request, type, detail = {}) {
    if (!Array.isArray(request.history)) request.history = [];
    request.history.push({ type, at: nowLocalTimestamp(), ...detail });
}

/** Devuelve la solicitud y valida que el usuario activo sea quien puede actuar sobre ella. */
function getRequestForAction(id, { as, errorMessage }) {
    const currentUser = getCurrentUser();
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    const request = requests.find(r => r.id === id);
    if (!request) return null;

    const allowed = as === 'tutor'
        ? currentUser && currentUser.role === ROLES.TUTOR && currentUser.id === request.tutorId
        : currentUser && currentUser.id === request.studentId;
    if (!allowed) {
        showToast(errorMessage, 'error');
        return null;
    }
    return { request, requests, currentUser };
}

function acceptRequest(id) {
    const ctx = getRequestForAction(id, { as: 'tutor', errorMessage: 'Solo el tutor asignado puede aceptar esta solicitud.' });
    if (!ctx) return;
    const { request, requests, currentUser } = ctx;

    if (request.status !== REQUEST_STATUS.PENDING) return;
    // Si el tutor quitó esa materia de su perfil después de recibir la
    // solicitud, la relación tutor+materia ya no es válida: se bloquea.
    if (!(currentUser.subjects || []).includes(request.subject)) {
        showToast('Ya no tienes esta materia asignada: no puedes aceptar esta solicitud.', 'error');
        return;
    }

    request.status = REQUEST_STATUS.ACCEPTED;
    request.respondedAt = nowLocalTimestamp();
    logRequestEvent(request, 'accepted', { tutorName: request.tutorName });
    saveData(STORAGE_KEYS.REQUESTS, requests);
    showToast('Solicitud aceptada.', 'success');
    renderRequests();
}

/** El TUTOR rechaza la solicitud. Todo el flujo es automático y atómico:
 *   1) el tutor se excluye (rejectedTutorIds) y se registra el rechazo;
 *   2) reassignOrCancel() busca a otro tutor que dicte la materia;
 *   3) hay otro -> queda asignado a él; no hay -> la solicitud se cancela.
 * Todo se guarda en una sola escritura, así que una recarga nunca ve un estado
 * intermedio. Esta ruta NO se usa cuando el estudiante rechaza un horario. */
function rejectRequest(id) {
    const ctx = getRequestForAction(id, { as: 'tutor', errorMessage: 'Solo el tutor asignado puede rechazar esta solicitud.' });
    if (!ctx) return;
    const { request, requests } = ctx;

    if (request.status !== REQUEST_STATUS.PENDING) return;

    if (!Array.isArray(request.rejectedTutorIds)) request.rejectedTutorIds = [];
    if (request.tutorId != null && !request.rejectedTutorIds.includes(request.tutorId)) {
        request.rejectedTutorIds.push(request.tutorId);
    }
    request.respondedAt = nowLocalTimestamp();
    logRequestEvent(request, 'tutor_rejected', { tutorName: request.tutorName });

    const newTutor = reassignOrCancel(request, 'rejected');
    saveData(STORAGE_KEYS.REQUESTS, requests);

    showToast(newTutor
        ? `Solicitud rechazada. Se reasignó automáticamente a ${newTutor.name}.`
        : 'Solicitud rechazada. No había otros tutores disponibles: la solicitud se canceló.', 'success');
    renderRequests();
    updateStats();
}

/** Resuelve una solicitud cuyo tutor dejó de estar disponible. Muta la solicitud
 * sin guardar (guarda quien la llama) y devuelve el tutor nuevo, o null:
 *   - Hay tutor elegible -> PENDIENTE con el tutor nuevo (debe responder él).
 *   - No hay ninguno     -> CANCELADA (cancellationReason 'no_tutors').
 * `reason` queda en la bitácora: 'rejected' (el tutor la rechazó; ya está en
 * rejectedTutorIds) o 'tutor_removed' (el tutor eliminó su perfil).
 * Nunca deja la solicitud abierta ni sin tutor. */
function reassignOrCancel(request, reason) {
    const next = getEligibleReplacementTutors(request)[0] || null;

    if (next) {
        const fromTutorName = request.tutorName;
        request.tutorId = next.id;
        request.tutorName = next.name;
        request.status = REQUEST_STATUS.PENDING;
        request.rejectionSource = null;
        request.cancellationReason = null;
        request.openForReassignment = false;
        request.respondedAt = null; // el tutor nuevo todavía no ha respondido
        logRequestEvent(request, 'tutor_reassigned', { tutorId: next.id, tutorName: next.name, fromTutorName, reason, resultingStatus: request.status });
        return next;
    }

    request.status = REQUEST_STATUS.CANCELLED;
    request.cancellationReason = 'no_tutors';
    request.rejectionSource = null;
    request.openForReassignment = false;
    request.respondedAt = nowLocalTimestamp();
    logRequestEvent(request, 'no_more_tutors');
    return null;
}

/** Estado, en memoria, de qué solicitudes tienen abierto el mini-formulario
 * de "Proponer otro horario" (no se persiste: es solo estado de UI). */
const openProposalForms = new Set();

function toggleProposalForm(id) {
    if (openProposalForms.has(id)) {
        openProposalForms.delete(id);
    } else {
        openProposalForms.add(id);
    }
    renderRequests();
}

/** APP-06 (Selección de fecha y hora para agendar): negociación de horario.
 * Tutor propone una nueva fecha/hora para una solicitud pendiente; el
 * estudiante la acepta (acceptProposedSchedule) o la rechaza
 * (rejectProposedSchedule) para dejar la tutoría agendada. */
function proposeSchedule(id) {
    const ctx = getRequestForAction(id, { as: 'tutor', errorMessage: 'Solo el tutor asignado puede proponer un horario.' });
    if (!ctx) return;
    const { request, requests, currentUser } = ctx;

    if (request.status !== REQUEST_STATUS.PENDING) return;
    if (!(currentUser.subjects || []).includes(request.subject)) {
        showToast('Ya no tienes esta materia asignada: no puedes proponer horario para esta solicitud.', 'error');
        return;
    }

    const dateInput = document.getElementById(`proposeDate-${id}`);
    const timeInput = document.getElementById(`proposeTime-${id}`);
    const msgInput = document.getElementById(`proposeMsg-${id}`);
    const proposedDate = dateInput ? dateInput.value : '';
    const proposedTime = timeInput ? timeInput.value : '';
    const proposedMessage = msgInput ? msgInput.value.trim() : '';

    if (!proposedDate || !ISO_DATE_REGEX.test(proposedDate)) {
        showToast('Indica una fecha válida para la propuesta.', 'error');
        return;
    }
    if (proposedDate < todayIsoDate()) {
        showToast('La fecha propuesta no puede ser en el pasado.', 'error');
        return;
    }
    if (!proposedTime || !TIME_REGEX.test(proposedTime)) {
        showToast('Indica una hora válida para la propuesta.', 'error');
        return;
    }

    request.status = REQUEST_STATUS.PROPOSED;
    request.proposedDate = proposedDate;
    request.proposedTime = proposedTime;
    request.proposedMessage = proposedMessage || null;
    request.respondedAt = nowLocalTimestamp();
    logRequestEvent(request, 'schedule_proposed', { tutorName: request.tutorName, date: proposedDate, time: proposedTime });
    saveData(STORAGE_KEYS.REQUESTS, requests);

    openProposalForms.delete(id);
    showToast('Propuesta de horario enviada al estudiante.', 'success');
    renderRequests();
}

/** El estudiante acepta el horario propuesto por el tutor: pasa a ACEPTADA
 * con la nueva fecha/hora como definitiva. */
function acceptProposedSchedule(id) {
    const ctx = getRequestForAction(id, { as: 'student', errorMessage: 'Solo el estudiante que creó la solicitud puede responder a la propuesta.' });
    if (!ctx) return;
    const { request, requests } = ctx;

    if (request.status !== REQUEST_STATUS.PROPOSED) return;

    logRequestEvent(request, 'schedule_accepted', { date: request.proposedDate, time: request.proposedTime });
    request.preferredDate = request.proposedDate;
    request.preferredTime = request.proposedTime;
    request.proposedDate = null;
    request.proposedTime = null;
    request.proposedMessage = null;
    request.status = REQUEST_STATUS.ACCEPTED;
    request.respondedAt = nowLocalTimestamp();
    saveData(STORAGE_KEYS.REQUESTS, requests);

    showToast('Horario aceptado. La tutoría queda agendada.', 'success');
    renderRequests();
}

/** El ESTUDIANTE rechaza la propuesta de horario: la solicitud queda
 * RECHAZADA de forma definitiva (se conserva tras recargar). No reabre la
 * solicitud, no genera otra propuesta ni busca otro tutor automáticamente.
 * Se guarda qué horario se rechazó para mostrarlo en el historial. */
function rejectProposedSchedule(id) {
    const ctx = getRequestForAction(id, { as: 'student', errorMessage: 'Solo el estudiante que creó la solicitud puede responder a la propuesta.' });
    if (!ctx) return;
    const { request, requests } = ctx;

    if (request.status !== REQUEST_STATUS.PROPOSED) return;

    logRequestEvent(request, 'schedule_rejected', { tutorName: request.tutorName, date: request.proposedDate, time: request.proposedTime });
    request.status = REQUEST_STATUS.REJECTED;
    request.rejectionSource = 'schedule';
    request.rejectedProposalDate = request.proposedDate;
    request.rejectedProposalTime = request.proposedTime;
    request.proposedDate = null;
    request.proposedTime = null;
    request.proposedMessage = null;
    request.respondedAt = nowLocalTimestamp();
    saveData(STORAGE_KEYS.REQUESTS, requests);

    showToast('Has rechazado la propuesta de horario. La solicitud quedó Rechazada.', 'info');
    renderRequests();
}

/** Tutores a los que el estudiante puede reasignar la solicitud: dictan la
 * materia, existen y NO están en rejectedTutorIds de esta solicitud. */
function getEligibleReplacementTutors(request) {
    const excluded = request.rejectedTutorIds || [];
    return getTutors().filter(t =>
        (t.subjects || []).includes(request.subject) &&
        !excluded.includes(t.id) &&
        t.id !== request.studentId
    );
}

/** Quita el tutor de una solicitud cuando ya no ofrece la materia (por
 * ejemplo, el tutor la quitó de su perfil después de recibir la solicitud).
 * A diferencia de un rechazo, no es "culpa" de ese tutor, así que sí se
 * reinicia rejectedTutorIds. Deja la solicitud abierta para elegir un nuevo
 * tutor (aquí la solicitud SÍ debe seguir esperando respuesta: PENDIENTE). */
function clearRequestTutor(id) {
    const ctx = getRequestForAction(id, { as: 'student', errorMessage: 'Solo el estudiante que creó la solicitud puede modificarla.' });
    if (!ctx) return;
    const { request, requests } = ctx;

    request.tutorId = null;
    request.tutorName = null;
    request.status = REQUEST_STATUS.PENDING;
    request.respondedAt = null;
    request.proposedDate = null;
    request.proposedTime = null;
    request.proposedMessage = null;
    request.rejectedTutorIds = [];
    request.rejectionSource = null;
    request.openForReassignment = true;
    logRequestEvent(request, 'tutor_cleared');
    saveData(STORAGE_KEYS.REQUESTS, requests);
    showToast('Tutor quitado de la solicitud. Elige otro para continuar.', 'success');
    renderRequests();
}

/** Reasigna una solicitud SIN tutor (el tutor dejó de ofrecer la materia, ver
 * clearRequestTutor) a un tutor elegido por el estudiante. Queda PENDIENTE,
 * esperando la respuesta del tutor nuevo. No aplica al rechazo de un tutor:
 * ese caso lo resuelve reassignOrCancel() automáticamente. */
function assignNewTutorToRequest(id, tutorId) {
    const ctx = getRequestForAction(id, { as: 'student', errorMessage: 'Solo el estudiante que creó la solicitud puede modificarla.' });
    if (!ctx) return;
    const { request, requests } = ctx;

    const afterTutorCleared = request.status === REQUEST_STATUS.PENDING && !request.tutorId && request.openForReassignment;
    if (!afterTutorCleared) return;

    const tutor = getEligibleReplacementTutors(request).find(t => t.id === tutorId);
    if (!tutor) {
        // Distingue el motivo para dar un mensaje claro (y validar en lógica, no solo en la UI).
        const known = getTutors().find(t => t.id === tutorId);
        const message = known && (request.rejectedTutorIds || []).includes(known.id)
            ? 'Ese tutor ya rechazó esta solicitud.'
            : known && !(known.subjects || []).includes(request.subject)
                ? 'Este tutor no ofrece esta materia actualmente.'
                : 'Selecciona un tutor válido.';
        showToast(message, 'error');
        return;
    }

    request.tutorId = tutor.id;
    request.tutorName = tutor.name;
    request.openForReassignment = false;
    request.rejectionSource = null;
    request.rejectedProposalDate = null;
    request.rejectedProposalTime = null;
    request.respondedAt = null;
    logRequestEvent(request, 'tutor_reassigned', { tutorId: tutor.id, tutorName: tutor.name, resultingStatus: request.status });
    saveData(STORAGE_KEYS.REQUESTS, requests);

    showToast(`Solicitud reasignada a ${tutor.name}.`, 'success');
    renderRequests();
}

function cancelRequest(id) {
    const ctx = getRequestForAction(id, { as: 'student', errorMessage: 'Solo el estudiante que creó la solicitud puede cancelarla.' });
    if (!ctx) return;
    const { request, requests } = ctx;

    if (![REQUEST_STATUS.PENDING, REQUEST_STATUS.PROPOSED, REQUEST_STATUS.ACCEPTED].includes(request.status)) return;

    request.status = REQUEST_STATUS.CANCELLED;
    request.cancellationReason = 'student';
    request.proposedDate = null;
    request.proposedTime = null;
    request.proposedMessage = null;
    logRequestEvent(request, 'cancelled');
    saveData(STORAGE_KEYS.REQUESTS, requests);
    showToast('Solicitud cancelada.', 'success');
    renderRequests();
    updateStats();
}

/** APP-07: Registro de tutoría realizada e historial. Solo el TUTOR asignado
 * puede marcar una tutoría como realizada, y solo cuando ya fue aceptada
 * El estudiante no puede marcar sus propias tutorías como realizadas. */
function completeRequest(id) {
    const currentUser = getCurrentUser();
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    const request = requests.find(r => r.id === id);
    if (!request) return;

    if (!currentUser || currentUser.role !== ROLES.TUTOR || currentUser.id !== request.tutorId) {
        showToast('Solo el tutor asignado puede marcar esta tutoría como realizada.', 'error');
        return;
    }
    if (request.status !== REQUEST_STATUS.ACCEPTED) {
        showToast('Esta solicitud aún no puede marcarse como realizada.', 'error');
        return;
    }

    request.status = REQUEST_STATUS.DONE;
    request.completedAt = nowLocalTimestamp();
    logRequestEvent(request, 'completed');
    saveData(STORAGE_KEYS.REQUESTS, requests);
    showToast('Tutoría marcada como realizada.', 'success');
    renderRequests();
    updateStats();
}

// APP-08: Calificación de tutoría (estrellas 1-5 + comentario opcional).
function saveRating(id, ratingValue) {
    const currentUser = getCurrentUser();
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    const request = requests.find(r => r.id === id);
    if (!request) return;

    if (!currentUser || currentUser.id !== request.studentId) {
        showToast('Solo el estudiante que creó la solicitud puede calificarla.', 'error');
        return;
    }
    if (request.status !== REQUEST_STATUS.DONE) return;

    const commentInput = document.getElementById(`ratingComment-${id}`);
    request.rating = ratingValue;
    request.ratingComment = commentInput ? commentInput.value.trim() : '';
    saveData(STORAGE_KEYS.REQUESTS, requests);

    showToast('¡Gracias por tu valoración!', 'success');
    renderRequests();
}

// ---------- "Eliminar del historial" ----------
// Estados que ya terminaron su ciclo: solo estas solicitudes pueden limpiarse
// del historial. Las activas (Pendiente / Propuesta / Aceptada) nunca.
const HISTORY_REMOVABLE_STATUSES = [REQUEST_STATUS.DONE, REQUEST_STATUS.REJECTED, REQUEST_STATUS.CANCELLED];

function isHiddenFromHistory(request, userId) {
    return Array.isArray(request.hiddenFor) && request.hiddenFor.includes(userId);
}

/** ¿Puede este usuario quitar esta solicitud de SU historial? (Estudiante que la
 * creó o Tutor asignado, y solo si ya terminó: Completada, Rechazada o Cancelada.) */
function canRemoveFromHistory(request, user) {
    if (!user || !HISTORY_REMOVABLE_STATUSES.includes(request.status)) return false;
    const isStudentOwner = user.id === request.studentId;
    const isAssignedTutor = user.role === ROLES.TUTOR && user.id === request.tutorId;
    return isStudentOwner || isAssignedTutor;
}

/** "Eliminar del historial" (Completada, Rechazada o Cancelada; Estudiante o Tutor).
 * NUNCA borra la solicitud ni cambia su estado: solo agrega el id de quien pulsó
 * el botón a `hiddenFor`, así que sigue existiendo íntegra en el sistema y en la
 * vista de la otra parte. Se guarda al instante (una recarga inmediata no la
 * hace reaparecer); "Deshacer" quita ese mismo id de `hiddenFor`. */
function deleteFromHistory(id) {
    const currentUser = getCurrentUser();
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    const request = requests.find(r => r.id === id);
    if (!request || !currentUser) return;

    const isParticipant = currentUser.id === request.studentId ||
        (currentUser.role === ROLES.TUTOR && currentUser.id === request.tutorId);
    if (!isParticipant) {
        showToast('No tienes permiso para modificar el historial de esta solicitud.', 'error');
        return;
    }
    if (!HISTORY_REMOVABLE_STATUSES.includes(request.status)) {
        showToast('Solo puedes eliminar del historial solicitudes terminadas (completadas, rechazadas o canceladas).', 'error');
        return;
    }

    const userId = currentUser.id;
    if (isHiddenFromHistory(request, userId)) return;
    if (!Array.isArray(request.hiddenFor)) request.hiddenFor = [];
    request.hiddenFor.push(userId);
    saveData(STORAGE_KEYS.REQUESTS, requests);
    renderRequests();

    showToast('Solicitud eliminada de tu historial.', 'info', {
        actionLabel: 'Deshacer',
        onAction: () => restoreToHistory(id, userId)
    });
}

function restoreToHistory(id, userId) {
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    const request = requests.find(r => r.id === id);
    if (!request || !Array.isArray(request.hiddenFor)) return;
    request.hiddenFor = request.hiddenFor.filter(uid => uid !== userId);
    saveData(STORAGE_KEYS.REQUESTS, requests);
    renderRequests();
}

// ---------- Historial ----------
function renderRequests() {
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    const container = document.getElementById('requestsList');
    const currentUser = getCurrentUser();

    if (requests.length === 0) {
        container.innerHTML = `
            <div class="card empty-state-card">
                <p class="empty-title">No hay solicitudes registradas todavía</p>
                <p class="section-desc">Inicia sesión como estudiante y pide tu primera tutoría desde "Solicitar Tutoría".</p>
            </div>`;
        return;
    }

    // Un estudiante ve sus propias solicitudes; un tutor ve aquellas donde fue elegido; sin sesión, no se muestra nada sensible.
    // Una solicitud terminada "eliminada del historial" por este usuario
    // (hiddenFor) deja de listarse SOLO para él: no afecta a la otra parte ni
    // borra la solicitud.
    const visible = requests.filter(r => currentUser && (
        r.studentId === currentUser.id || (currentUser.role === ROLES.TUTOR && r.tutorId === currentUser.id)
    ) && !isHiddenFromHistory(r, currentUser.id));

    if (!currentUser) {
        container.innerHTML = `<div class="card empty-state-card"><p class="empty-title">Inicia sesión para ver tus solicitudes</p></div>`;
        return;
    }
    if (visible.length === 0) {
        container.innerHTML = `<div class="card empty-state-card"><p class="empty-title">No tienes solicitudes todavía</p></div>`;
        return;
    }

    // Ordenado por materia (alfabéticamente, sin distinguir mayúsculas/acentos)
    // y, para solicitudes de la misma materia, por fecha/hora preferida y
    // luego por fecha de creación, para que el orden sea estable y predecible.
    const sorted = visible.slice().sort((a, b) => {
        const bySubject = (a.subject || '').localeCompare(b.subject || '', 'es', { sensitivity: 'base' });
        if (bySubject !== 0) return bySubject;
        const byDate = (a.preferredDate || '').localeCompare(b.preferredDate || '');
        if (byDate !== 0) return byDate;
        return (a.createdAt || '').localeCompare(b.createdAt || '');
    });

    container.innerHTML = sorted.map(req => renderRequestCard(req, currentUser)).join('');
}

const STATUS_BADGE_CLASS = {
    [REQUEST_STATUS.PENDING]: 'badge-status-pendiente',
    [REQUEST_STATUS.ACCEPTED]: 'badge-status-aceptada',
    [REQUEST_STATUS.REJECTED]: 'badge-status-rechazada',
    [REQUEST_STATUS.PROPOSED]: 'badge-status-propuesta',
    [REQUEST_STATUS.CANCELLED]: 'badge-status-cancelada',
    [REQUEST_STATUS.DONE]: 'badge-status-realizada'
};

/** Abre el historial de una solicitud en una ventana aparte, para que las
 * tarjetas conserven siempre el mismo tamaño y estructura.
 * Es una línea de tiempo, no una copia de la tarjeta: cada evento responde
 * "¿qué pasó, con quién, cuándo?". La estructura es la misma para estudiante y
 * tutor; solo cambia a quién se nombra en la cabecera (la otra parte). */
function openHistoryModal(id) {
    const req = getStoredData(STORAGE_KEYS.REQUESTS, []).find(r => r.id === id);
    if (!req) return;
    const currentUser = getCurrentUser();
    const viewerIsStudent = currentUser && currentUser.id === req.studentId;

    document.getElementById('historyModalTitle').textContent = req.subject;
    document.getElementById('historyModalMeta').textContent = viewerIsStudent
        ? `Tutor: ${req.tutorName || 'Sin asignar'}`
        : `Estudiante: ${req.studentName}`;
    const statusBadge = document.getElementById('historyModalStatus');
    statusBadge.className = `badge ${STATUS_BADGE_CLASS[req.status] || ''}`;
    statusBadge.textContent = REQUEST_STATUS_LABEL[req.status] || req.status;

    // El orden del arreglo ya es cronológico (cada evento se agrega al final);
    // el sort estable solo protege datos heredados con marcas de tiempo sueltas.
    const events = getRequestHistory(req).map((ev, i) => ({ ev, i }))
        .sort((a, b) => (a.ev.at && b.ev.at && a.ev.at !== b.ev.at) ? a.ev.at.localeCompare(b.ev.at) : a.i - b.i)
        .map(x => x.ev);

    document.getElementById('historyModalList').innerHTML = events.map(ev => {
        const info = describeHistoryEvent(ev);
        const when = splitStoredTimestamp(ev.at);
        if (when.time) when.time = formatTime12(when.time);
        return `
        <li class="history-item history-item--${info.tone}">
            <span class="history-dot" aria-hidden="true"></span>
            <div class="history-body">
                <p class="history-title">${escapeHtml(info.title)}</p>
                ${info.detail ? `<p class="history-detail">${escapeHtml(info.detail)}</p>` : ''}
            </div>
            <time class="history-date">${escapeHtml(when.date || '—')}${when.time ? `<span>${escapeHtml(when.time)}</span>` : ''}</time>
        </li>`;
    }).join('');
    openModal('historyModal');
}

/** Cada evento de la bitácora -> { title, detail, tone }. Un título corto y,
 * como mucho, una línea de detalle. Cada tipo tiene su propio texto para no
 * mezclar (tutor rechazó / estudiante rechazó horario / sin más tutores). */
function describeHistoryEvent(ev) {
    const tutor = ev.tutorName || 'El tutor';
    const slot = ev.date ? `${formatStoredDate(ev.date)}${ev.time ? ' — ' + formatTime12(ev.time) : ''}` : '';
    switch (ev.type) {
        case 'created': return { title: 'Solicitud creada', detail: '', tone: 'neutral' };
        case 'accepted': return { title: 'Solicitud aceptada', detail: `Tutor: ${tutor}`, tone: 'success' };
        case 'tutor_rejected': return { title: 'Solicitud rechazada', detail: `${tutor} rechazó la solicitud`, tone: 'danger' };
        case 'schedule_proposed': return { title: 'Horario propuesto', detail: `${tutor}${slot ? ': ' + slot : ''}`, tone: 'info' };
        case 'schedule_accepted': return { title: 'Horario aceptado', detail: slot, tone: 'success' };
        case 'schedule_rejected': return { title: 'Solicitud rechazada', detail: `El estudiante rechazó el horario propuesto${slot ? ' (' + slot + ')' : ''}`, tone: 'danger' };
        case 'tutor_assigned': return { title: 'Tutor asignado', detail: `Asignado automáticamente: ${tutor}`, tone: 'info' };
        case 'tutor_removed': return {
            title: 'Tutor no disponible',
            detail: ev.reasonKind === 'subject_removed' ? `${tutor} dejó de ofrecer esta materia` : `${tutor} eliminó su perfil de tutor`,
            tone: 'muted'
        };
        case 'tutor_reassigned': return { title: 'Tutor reasignado', detail: `Nuevo tutor: ${tutor}`, tone: 'info' };
        case 'no_more_tutors': return { title: 'Solicitud cancelada', detail: 'No había otros tutores disponibles para esta materia', tone: 'muted' };
        case 'tutor_cleared': return { title: 'Tutor retirado', detail: 'Ya no ofrecía la materia', tone: 'muted' };
        case 'cancelled': return { title: 'Solicitud cancelada', detail: 'Cancelada por el estudiante', tone: 'muted' };
        case 'completed': return { title: 'Tutoría realizada', detail: '', tone: 'success' };
        default: return { title: '', detail: '', tone: 'neutral' };
    }
}

/** Bitácora de la solicitud. Las solicitudes guardadas antes de existir la
 * bitácora se reconstruyen a partir de su estado actual. */
function getRequestHistory(req) {
    if (Array.isArray(req.history) && req.history.length) return req.history;
    const legacy = [{ type: 'created', at: req.createdAt }];
    if (req.status === REQUEST_STATUS.REJECTED) {
        legacy.push(req.rejectionSource === 'schedule'
            ? { type: 'schedule_rejected', at: req.respondedAt, tutorName: req.tutorName, date: req.rejectedProposalDate, time: req.rejectedProposalTime }
            : { type: 'tutor_rejected', at: req.respondedAt, tutorName: req.tutorName });
    }
    if (req.status === REQUEST_STATUS.CANCELLED) legacy.push({ type: req.cancellationReason === 'no_tutors' ? 'no_more_tutors' : 'cancelled', at: req.respondedAt });
    if (req.status === REQUEST_STATUS.DONE) legacy.push({ type: 'completed', at: req.completedAt });
    return legacy;
}

/** Repara solicitudes que versiones anteriores dejaron guardadas tras el
 * rechazo de un tutor, cuando la búsqueda de reemplazo era manual:
 *   - RECHAZADA por el tutor (esperando el botón "Buscar otro tutor");
 *   - PENDIENTE sin tutor con el rechazo ya registrado ("Solicitud abierta").
 * Ninguna de las dos debe existir: se resuelven igual que un rechazo nuevo
 * (reasignar o cancelar). Es idempotente: tras resolverse ya no coinciden. */
function normalizeStoredRequests() {
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    const users = getStoredData(STORAGE_KEYS.USERS, []);
    let changed = false;

    requests.forEach(r => {
        const legacyReopened = r.status === REQUEST_STATUS.PENDING && !r.tutorId && r.openForReassignment &&
            r.rejectionSource && Array.isArray(r.rejectedTutorIds) && r.rejectedTutorIds.length > 0;
        const legacyTutorRejected = r.status === REQUEST_STATUS.REJECTED && r.rejectionSource !== 'schedule';
        // Pendiente sin tutor y sin selector manual: nació "sin preferencia" o su tutor
        // eliminó el perfil. (El caso con openForReassignment es "tutor retirado": no se toca.)
        const legacyUnassigned = r.status === REQUEST_STATUS.PENDING && !r.tutorId && !r.openForReassignment;
        if (legacyUnassigned) {
            r.history = getRequestHistory(r).slice();
            const assigned = reassignOrCancel(r, 'auto');
            if (assigned) r.history[r.history.length - 1] = { type: 'tutor_assigned', at: r.history[r.history.length - 1].at, tutorId: assigned.id, tutorName: assigned.name };
            changed = true;
            return;
        }
        if (!legacyReopened && !legacyTutorRejected) return;

        // Se conserva la bitácora existente (o se reconstruye) antes de añadir el desenlace.
        r.history = getRequestHistory(r).slice();
        if (legacyReopened) {
            const lastRejectedId = r.rejectedTutorIds[r.rejectedTutorIds.length - 1];
            const lastTutor = users.find(u => u.id === lastRejectedId);
            r.tutorId = lastRejectedId;
            r.tutorName = lastTutor ? lastTutor.name : null;
        }
        if (!Array.isArray(r.rejectedTutorIds)) r.rejectedTutorIds = [];
        if (r.tutorId != null && !r.rejectedTutorIds.includes(r.tutorId)) r.rejectedTutorIds.push(r.tutorId);
        if (!r.history.some(ev => ev.type === 'tutor_rejected')) {
            r.history.push({ type: 'tutor_rejected', at: r.respondedAt || r.createdAt, tutorName: r.tutorName });
        }
        // Un "tutor_reassigned" previo no aplica: el desenlace se recalcula desde cero.
        reassignOrCancel(r, 'rejected');
        changed = true;
    });

    if (changed) saveData(STORAGE_KEYS.REQUESTS, requests);
}

/** Si la solicitud está en manos de un tutor porque el sistema se la reasignó
 * (el anterior la rechazó o eliminó su perfil), devuelve ese evento de la
 * bitácora (con el tutor anterior y el motivo); si no, null. */
function getAutoReassignment(req) {
    const events = getRequestHistory(req);
    const last = events[events.length - 1];
    if (!last || last.type !== 'tutor_reassigned' || !last.fromTutorName) return null;
    return last.tutorId === req.tutorId ? last : null;
}

/** Mensaje de estado por defecto: la zona de información de la tarjeta
 * siempre muestra algo, así ninguna tarjeta queda con un hueco distinto. */
function defaultStatusNote(req, isStudentOwner) {
    const tutor = escapeHtml(req.tutorName || 'el tutor');
    switch (req.status) {
        case REQUEST_STATUS.PENDING:
            if (!isStudentOwner) return 'Esta solicitud espera tu respuesta.';
            return req.tutorName ? `Esperando la respuesta de ${tutor}.` : 'Solicitud abierta: esperando que un tutor la atienda.';
        case REQUEST_STATUS.ACCEPTED:
            return isStudentOwner ? `Tutoría aceptada. Coordina con ${tutor} el día acordado.` : 'Aceptaste esta solicitud. Márcala como realizada al terminar la tutoría.';
        case REQUEST_STATUS.DONE:
            return 'Tutoría realizada.';
        case REQUEST_STATUS.CANCELLED:
            return 'Solicitud cancelada por el estudiante.';
        default:
            return '';
    }
}

/** Botón de acción de tarjeta: todos comparten la misma estructura y el CSS
 * (.request-actions) les da el mismo alto, padding y tamaño. */
function requestActionButton(kind, action, label, id) {
    return `<button type="button" class="btn-${kind}" data-action="${action}" data-id="${id}">${label}</button>`;
}

/** Bloque "elige un nuevo tutor" (select con los candidatos elegibles). */
function renderTutorPicker(req, tutors) {
    return `
        <div class="request-panel">
            <div class="form-group">
                <label for="newTutorSelect-${req.id}">Elige un nuevo tutor</label>
                <select id="newTutorSelect-${req.id}">
                    ${tutors.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}
                </select>
            </div>
        </div>`;
}

/** Fila de fechas del pie de la tarjeta: "Creada" a la izquierda y, si la
 * solicitud ya terminó, la fecha de cierre a la derecha (Realizada / Rechazada
 * / Cancelada). Siempre dd/mm/aaaa, en una sola línea, en el mismo orden. */
function renderRequestDates(req) {
    const created = splitStoredTimestamp(req.createdAt).date;
    const closing = { [REQUEST_STATUS.DONE]: 'Realizada', [REQUEST_STATUS.REJECTED]: 'Rechazada', [REQUEST_STATUS.CANCELLED]: 'Cancelada' }[req.status];
    let closingHtml = '';
    if (closing) {
        const events = getRequestHistory(req);
        const closedAt = (req.status === REQUEST_STATUS.DONE && req.completedAt) || (events[events.length - 1] || {}).at || req.respondedAt;
        const closedDate = splitStoredTimestamp(closedAt).date;
        if (closedDate) closingHtml = `<span class="request-date-item"><span class="request-date-label">${closing}</span> ${escapeHtml(closedDate)}</span>`;
    }
    return `<span class="request-date-item"><span class="request-date-label">Creada</span> ${escapeHtml(created)}</span>${closingHtml}`;
}

function renderRequestCard(req, currentUser) {
    const isStudentOwner = currentUser.id === req.studentId;
    const isAssignedTutor = currentUser.role === ROLES.TUTOR && currentUser.id === req.tutorId;

    // Si el tutor asignado ya no tiene esta materia en su perfil, la relación
    // tutor+materia quedó inválida: se bloquean las acciones del tutor.
    let tutorSubjectMismatch = false;
    if (req.tutorId) {
        const tutorUser = getStoredData(STORAGE_KEYS.USERS, []).find(u => u.id === req.tutorId);
        tutorSubjectMismatch = !tutorUser || !(tutorUser.subjects || []).includes(req.subject);
    }

    const dateInfo = req.preferredDate
        ? `${formatStoredDate(req.preferredDate)}${req.preferredTime ? ' — ' + formatTime12(req.preferredTime) : ''}`
        : 'Por coordinar';

    // Cada tarjeta se arma con las mismas tres piezas, sin importar el estado:
    //   notices -> mensajes de estado / info adicional (van en el cuerpo)
    //   panels  -> formularios y selectores (van en el cuerpo)
    //   actions -> botones (siempre anclados al fondo de la tarjeta)
    const notices = [];
    const panels = [];
    const actions = [];
    const note = text => notices.push(`<p class="request-notice"><span>${text}</span></p>`);

    // --- Tutor asignado ---
    if (req.status === REQUEST_STATUS.PENDING && req.tutorId && isAssignedTutor) {
        if (tutorSubjectMismatch) {
            note(`⚠️ Ya no tienes "${escapeHtml(req.subject)}" asignada. No puedes actuar sobre esta solicitud.`);
        } else {
            const formOpen = openProposalForms.has(req.id);
            actions.push(requestActionButton('primary', 'accept-request', 'Aceptar', req.id));
            actions.push(requestActionButton('danger', 'reject-request', 'Rechazar', req.id));
            actions.push(requestActionButton('secondary', 'toggle-propose', formOpen ? 'Cancelar propuesta' : 'Proponer otro horario', req.id));
            if (formOpen) {
                panels.push(`
                    <div class="request-panel">
                        <div class="form-row">
                            <div class="form-group">
                                <label for="proposeDate-${req.id}">Nueva fecha</label>
                                <input type="date" id="proposeDate-${req.id}" min="${todayIsoDate()}">
                            </div>
                            <div class="form-group">
                                <label for="proposeTime-${req.id}">Nueva hora</label>
                                <input type="time" id="proposeTime-${req.id}">
                            </div>
                        </div>
                        <div class="form-group">
                            <label for="proposeMsg-${req.id}">Mensaje (opcional)</label>
                            <textarea id="proposeMsg-${req.id}" rows="2" placeholder="Ej: ¿Te sirve este otro horario?"></textarea>
                        </div>
                        <button type="button" class="btn-primary btn-block" data-action="submit-propose" data-id="${req.id}">Enviar propuesta</button>
                    </div>`);
            }
        }
    }
    if (req.status === REQUEST_STATUS.ACCEPTED && isAssignedTutor) {
        actions.push(requestActionButton('secondary', 'complete-request', 'Marcar como realizada', req.id));
    }

    // --- Propuesta de horario pendiente de respuesta del estudiante ---
    if (req.status === REQUEST_STATUS.PROPOSED) {
        const proposalInfo = `${formatStoredDate(req.proposedDate)} — ${formatTime12(req.proposedTime)}`;
        if (isStudentOwner) {
            notices.push(`
                <div class="schedule-proposal">
                    <p class="schedule-proposal-text">${escapeHtml(req.tutorName || 'El tutor')} propone: <span class="schedule-proposal-datetime">${escapeHtml(proposalInfo)}</span></p>
                    ${req.proposedMessage ? `<p class="section-desc">"${escapeHtml(req.proposedMessage)}"</p>` : ''}
                </div>`);
            actions.push(requestActionButton('primary', 'accept-proposal', 'Aceptar horario', req.id));
            actions.push(requestActionButton('danger', 'reject-proposal', 'Rechazar propuesta', req.id));
        } else if (isAssignedTutor) {
            note(`Propusiste ${escapeHtml(proposalInfo)}. Esperando respuesta del estudiante.`);
        }
    }

    // --- Solicitud RECHAZADA ---
    // Hoy solo la produce el estudiante al rechazar un horario propuesto. El
    // rechazo de un TUTOR no llega aquí: se resuelve al instante (reasignada o
    // cancelada), por lo que no se ofrece selección manual en este estado.
    if (req.status === REQUEST_STATUS.REJECTED) {
        const rejectedByTutor = req.rejectionSource !== 'schedule';
        const rejectedSlot = req.rejectedProposalDate
            ? ` (${escapeHtml(formatStoredDate(req.rejectedProposalDate))}${req.rejectedProposalTime ? ' — ' + escapeHtml(formatTime12(req.rejectedProposalTime)) : ''})`
            : '';

        if (isStudentOwner) {
            note(rejectedByTutor
                ? `<strong>Solicitud rechazada.</strong> ${escapeHtml(req.tutorName || 'El tutor')} rechazó tu solicitud para esta materia.`
                : `<strong>Solicitud rechazada.</strong> Rechazaste el horario que propuso ${escapeHtml(req.tutorName || 'el tutor')}${rejectedSlot}.`);
        } else if (isAssignedTutor) {
            note(rejectedByTutor
                ? 'Rechazaste esta solicitud.'
                : `El estudiante rechazó el horario que propusiste${rejectedSlot}.`);
        }
    }

    // --- Solicitud reasignada automáticamente tras el rechazo de otro tutor ---
    const reassignment = req.status === REQUEST_STATUS.PENDING ? getAutoReassignment(req) : null;
    if (reassignment) {
        const previous = escapeHtml(reassignment.fromTutorName || 'El tutor anterior');
        const current = escapeHtml(req.tutorName);
        const removed = reassignment.reason === 'tutor_removed';
        if (isStudentOwner) {
            note(`<strong>Nuevo tutor asignado: ${current}.</strong> ${previous} ${removed ? 'ya no está disponible' : 'rechazó tu solicitud'}. Esperando la respuesta de ${current}.`);
        } else if (isAssignedTutor) {
            note(`Esta solicitud te fue asignada automáticamente porque ${previous} ${removed ? 'ya no está disponible' : 'la rechazó'}. Espera tu respuesta.`);
        }
    }

    // --- Solicitud CANCELADA porque no había más tutores ---
    if (req.status === REQUEST_STATUS.CANCELLED && req.cancellationReason === 'no_tutors') {
        note(isStudentOwner
            ? `<strong>Solicitud cancelada.</strong> ${NO_MORE_TUTORS_MESSAGE}`
            : 'Solicitud cancelada: la rechazaste y no había otros tutores disponibles para esta materia.');
    }

    // --- Tutor quitado por dejar de ofrecer la materia: la solicitud sigue PENDIENTE ---
    if (req.status === REQUEST_STATUS.PENDING && !req.tutorId && req.openForReassignment && isStudentOwner) {
        const candidates = getEligibleReplacementTutors(req);
        if (candidates.length === 0) {
            note(NO_MORE_TUTORS_MESSAGE);
        } else {
            panels.push(renderTutorPicker(req, candidates));
            actions.push(requestActionButton('primary', 'assign-new-tutor', 'Elegir este tutor', req.id));
        }
    }
    if (req.status === REQUEST_STATUS.PENDING && isStudentOwner && tutorSubjectMismatch) {
        note('⚠️ El tutor asignado ya no ofrece esta materia.');
        actions.push(requestActionButton('secondary', 'clear-tutor', 'Elegir otro tutor', req.id));
    }

    // --- Acciones generales del estudiante ---
    if ([REQUEST_STATUS.PENDING, REQUEST_STATUS.PROPOSED, REQUEST_STATUS.ACCEPTED].includes(req.status) && isStudentOwner) {
        actions.push(requestActionButton('danger', 'cancel-request', 'Cancelar', req.id));
    }
    // Completada / Rechazada / Cancelada: "Eliminar del historial" para Estudiante
    // Y Tutor (cada uno oculta solo su propia vista, ver deleteFromHistory).
    if (canRemoveFromHistory(req, currentUser)) {
        actions.push(requestActionButton('secondary', 'delete-history', 'Eliminar del historial', req.id));
    }

    // --- Valoración ---
    if (req.status === REQUEST_STATUS.DONE && req.rating == null && isStudentOwner) {
        panels.push(`
            <div class="rating-box">
                <p class="rating-label">Califica esta tutoría:</p>
                <div class="rating-stars">
                    ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="star-btn" data-action="set-rating" data-id="${req.id}" data-value="${n}">★</button>`).join('')}
                </div>
                <textarea id="ratingComment-${req.id}" rows="2" placeholder="Comentario opcional..."></textarea>
            </div>`);
    } else if (req.rating != null) {
        notices.push(`
            <p class="rating-display">
                ${'★'.repeat(req.rating)}${'☆'.repeat(5 - req.rating)}
                ${req.ratingComment ? `— "${escapeHtml(req.ratingComment)}"` : ''}
            </p>`);
    }

    // Si no hay ningún aviso propio del estado, se muestra el resumen por defecto.
    if (!notices.length) {
        const text = defaultStatusNote(req, isStudentOwner);
        if (text) note(text);
    }

    const topicText = req.topic || 'No especificado';
    const tutorText = req.tutorName || 'Sin asignar';
    const historyCount = getRequestHistory(req).length;

    return `
        <div class="card request-card" data-request-id="${req.id}" data-status="${escapeHtml(req.status)}">
            <div class="request-card-header">
                <h3 title="${escapeHtml(req.subject)}">${escapeHtml(req.subject)}</h3>
                <span class="badge ${STATUS_BADGE_CLASS[req.status] || ''}">${escapeHtml(REQUEST_STATUS_LABEL[req.status] || req.status)}</span>
            </div>
            <div class="request-details">
                <p class="request-line" title="${escapeHtml(req.studentName)}"><strong>Estudiante:</strong> ${escapeHtml(req.studentName)}</p>
                <p class="request-line" title="${escapeHtml(tutorText)}"><strong>Tutor:</strong> ${escapeHtml(tutorText)}</p>
                <p class="request-line" title="${escapeHtml(topicText)}"><strong>Tema:</strong> ${escapeHtml(topicText)}</p>
                <p class="request-line request-date">📅 <strong>Fecha:</strong> ${escapeHtml(dateInfo)}</p>
            </div>
            <div class="request-info">
                ${notices.join('')}
                ${panels.join('')}
            </div>
            <div class="request-meta">
                <div class="request-dates">${renderRequestDates(req)}</div>
                <button type="button" class="link-btn" data-action="open-history" data-id="${req.id}">Ver historial (${historyCount})</button>
            </div>
            <div class="request-actions">${actions.join('')}</div>
        </div>`;
}

// ---------- Utilidades ----------
function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

let pendingTutorDeletion = null;
let pendingSubjectDeletion = null;

function getSubjects() {
    return getStoredData(STORAGE_KEYS.SUBJECTS, initialSubjects);
}

function isSubjectPendingDeletion(name) {
    return !!(pendingSubjectDeletion && name && pendingSubjectDeletion.subjectName.toLowerCase() === name.toLowerCase());
}

function findSubjectByName(name) {
    return getSubjects().find(s => s.name.toLowerCase() === name.toLowerCase());
}

function renderSubjects(filterText = '') {
    const allSubjects = getSubjects().filter(subject => !isSubjectPendingDeletion(subject.name));
    const currentUser = getCurrentUser();
    const subjects = currentUser?.role === ROLES.TUTOR
        ? allSubjects.filter(subject => (currentUser.subjects || []).includes(subject.name))
        : allSubjects;
    const grid = document.getElementById('subjectsGrid');
    const select = document.getElementById('selectSubject');
    const previousValue = select.value;

    grid.innerHTML = '';
    select.innerHTML = '<option value="">Selecciona una materia...</option>';

    const filtered = subjects.filter(s =>
        s.name.toLowerCase().includes(filterText.toLowerCase()) ||
        s.category.toLowerCase().includes(filterText.toLowerCase())
    );

    const emptyMessage = currentUser?.role === ROLES.TUTOR && subjects.length === 0
        ? 'Aún no tienes materias asignadas. Agrégalas desde tu perfil de tutor.'
        : `No se encontraron materias que coincidan con "${escapeHtml(filterText)}".`;

    grid.innerHTML = filtered.length === 0
        ? `<p class="empty-state">${emptyMessage}</p>`
        : filtered.map(subject => `
            <div class="card subject-card">
                <div>
                    <div class="subject-card-header">
                        <h3>${escapeHtml(subject.name)}</h3>
                        <span class="badge">${escapeHtml(subject.category)}</span>
                    </div>
                    <p>${escapeHtml(subject.description)}</p>
                </div>
                ${currentUser?.role === ROLES.TUTOR
                    ? `<button type="button" class="btn-secondary btn-block" data-action="view-tutor-subject-requests" data-subject="${escapeHtml(subject.name)}">
                    Ver tutorías
                </button>`
                    : `<button type="button" class="btn-secondary btn-block" data-action="request-subject" data-subject="${escapeHtml(subject.name)}">
                    Solicitar Tutoría
                </button>`}
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
    updateTutorSelectForSubject();
}

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

async function createSubject(tutorId, rawName, rawDescription) {
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.TUTOR || currentUser.id !== tutorId) {
        showToast('Solo un tutor puede crear materias nuevas.', 'error');
        return false;
    }

    const name = (rawName || '').trim().replace(/\s+/g, ' ');
    if (!name) {
        showToast('Escribe un nombre para la nueva materia.', 'error');
        return false;
    }

    const existingLocal = findSubjectByName(name);
    if (existingLocal && (currentUser.subjects || []).some(s => s.toLowerCase() === existingLocal.name.toLowerCase())) {
        showToast('Ya tienes esa materia asignada.', 'error');
        return false;
    }

    const description = (rawDescription || '').trim().replace(/\s+/g, ' ') || 'Materia agregada por un tutor.';
    let createdSubject = null;

    try {
        if (window.EduMatchBackend?.isEnabled?.() && window.EduMatchBackend?.createTutorSubject) {
            createdSubject = await window.EduMatchBackend.createTutorSubject(tutorId, {
                name,
                description,
                category: 'Personalizada'
            });
        } else {
            const subjects = getSubjects();
            const newId = subjects.reduce((max, subject) => Math.max(max, Number(subject.id) || 0), 0) + 1;
            createdSubject = { id: newId, name, category: 'Personalizada', description, createdBy: currentUser.id };
        }
    } catch (error) {
        console.error('Error creando materia:', error);
        showToast(error?.message || 'No se pudo guardar la materia. Comprueba la conexión e inténtalo nuevamente.', 'error');
        return false;
    }

    if (!createdSubject) {
        showToast('No se pudo crear la materia.', 'error');
        return false;
    }

    const subjects = getSubjects().filter(subject => subject.name.toLowerCase() !== createdSubject.name.toLowerCase());
    subjects.push({
        id: Number(createdSubject.id),
        name: createdSubject.name,
        category: createdSubject.category || 'Personalizada',
        description: createdSubject.description || description,
        createdBy: createdSubject.createdBy || currentUser.id
    });

    currentUser.subjects = [...new Set([...(currentUser.subjects || []), createdSubject.name])];
    const users = getStoredData(STORAGE_KEYS.USERS, []);
    const owner = users.find(u => u.id === currentUser.id);
    if (owner) owner.subjects = currentUser.subjects.slice();

    try {
        localStorage.setItem(STORAGE_KEYS.SUBJECTS, JSON.stringify(subjects));
        localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
        setCurrentUser(currentUser);
    } catch (error) {
        console.error('Error actualizando el estado local después de crear la materia:', error);
        showToast('La materia se guardó en Supabase, pero no se pudo actualizar la vista local.', 'error');
        return false;
    }

    showToast(createdSubject.alreadyExisted
        ? `La materia "${createdSubject.name}" ya existía en el catálogo y se asignó a tu perfil.`
        : `Materia "${createdSubject.name}" creada y asignada a tu perfil.`, 'success');
    filterSubjects();
    renderTutors();
    updateStats();
    return true;
}

function getTutors() {
    return getStoredData(STORAGE_KEYS.USERS, [])
        .filter(u => u.role === ROLES.TUTOR && u.id !== (pendingTutorDeletion && pendingTutorDeletion.tutorId));
}

function renderTutors() {
    const grid = document.getElementById('tutorsGrid');
    if (!grid) return;

    const currentUser = getCurrentUser();
    const isTutor = currentUser?.role === ROLES.TUTOR;

    const tutors = isTutor
        ? getTutors().filter(t => t.id === currentUser.id)
        : getTutors();

    grid.innerHTML = tutors.length === 0
        ? `<p class="empty-state">Todavía no hay tutores registrados.</p>`
        : tutors.map(tutor => renderTutorCard(tutor, currentUser)).join('');

    updateTutorSelectForSubject();
}

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

function renderTutorCard(tutor, currentUser) {
    const isOwner = !!(currentUser && currentUser.role === ROLES.TUTOR && currentUser.id === tutor.id);
    const isStudentView = currentUser?.role === ROLES.STUDENT;
    const subjects = (tutor.subjects || []).filter(name => !isSubjectPendingDeletion(name));
    const unassigned = getSubjects().filter(s => !isSubjectPendingDeletion(s.name)).filter(s => !subjects.some(name => name.toLowerCase() === s.name.toLowerCase()));

    const tags = subjects.length
        ? subjects.map(subjectName => `
            <span class="badge tutor-tag">
                <span class="tutor-tag__text">${escapeHtml(subjectName)}</span>
                ${isOwner ? `<button type="button" class="tag-remove" data-action="remove-tutor-subject" data-tutor-id="${tutor.id}" data-subject="${escapeHtml(subjectName)}" title="Quitar materia de mi perfil" aria-label="Quitar ${escapeHtml(subjectName)}">&times;</button>` : ''}
                ${isOwner && getSubjects().some(s => s.name.toLowerCase() === subjectName.toLowerCase() && s.createdBy === tutor.id) ? `<button type="button" class="tag-remove" data-action="delete-custom-subject" data-tutor-id="${tutor.id}" data-subject="${escapeHtml(subjectName)}" title="Eliminar materia personalizada" aria-label="Eliminar ${escapeHtml(subjectName)} de la base de datos">🗑</button>` : ''}
            </span>`).join('')
        : `<span class="tutor-card__empty">Sin materias asignadas todavía.</span>`;

    const manage = isOwner ? `
        <div class="tutor-card__manage">
            <div class="tutor-manage-group">
                <select id="addSubjectSelect-${tutor.id}" aria-label="Materia existente para agregar">
                    <option value="">Agregar materia existente...</option>
                    ${unassigned.map(subject => `<option value="${escapeHtml(subject.name)}">${escapeHtml(subject.name)}</option>`).join('')}
                </select>
                <button type="button" class="btn-secondary btn-block" data-action="assign-tutor-subject" data-tutor-id="${tutor.id}">Agregar materia</button>
            </div>

            <div class="tutor-manage-group">
                <p class="tutor-manage-label">¿No encuentras tu materia? Crea una nueva y quedará asignada a tu perfil.</p>
                <input type="text" id="newSubjectName-${tutor.id}" placeholder="Nombre de la nueva materia">
                <textarea id="newSubjectDesc-${tutor.id}" rows="2" placeholder="Descripción (opcional)"></textarea>
                <button type="button" class="btn-secondary btn-block" data-action="create-subject" data-tutor-id="${tutor.id}">Agregar nueva materia</button>
            </div>

            <button type="button" class="btn-danger btn-block" data-action="delete-tutor" data-tutor-id="${tutor.id}">Eliminar mi perfil de tutor</button>
        </div>` : '';

    const actions = isStudentView ? `
        <div class="tutor-card__actions">
            <button type="button" class="btn-secondary btn-block" data-action="select-tutor" data-tutor="${escapeHtml(tutor.name)}">Solicitar con este tutor</button>
        </div>` : '';

    return `
        <article class="card tutor-card${isOwner ? ' tutor-card--own' : ''}" data-tutor-id="${tutor.id}">
            <div class="tutor-card__body">
                <header class="tutor-card__header">
                    <h3 class="tutor-card__name" title="${escapeHtml(tutor.name)}">${escapeHtml(tutor.name)}</h3>
                    ${!isOwner || isStudentView ? '<span class="badge tutor-card__badge">Tutor</span>' : ''}
                </header>
                <div class="tutor-card__tags">${tags}</div>
            </div>
            ${actions}
            ${manage}
        </article>`;
}

function viewTutorSubjectRequests(subjectName) {
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.TUTOR) {
        showToast('Esta función es exclusiva para tutores.', 'error');
        return;
    }
    const activeStatuses = [REQUEST_STATUS.PENDING, REQUEST_STATUS.PROPOSED, REQUEST_STATUS.ACCEPTED];
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []).filter(r =>
        r && r.tutorId === currentUser.id && r.subject === subjectName && activeStatuses.includes(r.status)
    );
    if (!requests.length) {
        showToast(`No hay tutorías para \"${subjectName}\" en este momento.`, 'info');
        return;
    }
    switchTab('history');
    renderRequests(subjectName);
}

async function assignSubjectToTutor(tutorId, subjectName) {
    if (!subjectName) {
        showToast('Selecciona una materia para agregar.', 'error');
        return false;
    }
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.TUTOR || currentUser.id !== tutorId) {
        showToast('Solo el propio tutor puede gestionar sus materias.', 'error');
        return false;
    }
    const subject = findSubjectByName(subjectName);
    if (!subject) {
        showToast('Esa materia no existe en el catálogo.', 'error');
        return false;
    }

    const users = getStoredData(STORAGE_KEYS.USERS, []);
    const tutor = users.find(u => u.id === tutorId);
    if (!tutor) return false;

    tutor.subjects = tutor.subjects || [];
    if (tutor.subjects.some(name => name.toLowerCase() === subject.name.toLowerCase())) {
        showToast('Ya tienes esa materia asignada.', 'error');
        return false;
    }
    tutor.subjects.push(subject.name);

    const previousUsers = getStoredData(STORAGE_KEYS.USERS, []);
    try {
        localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
        setCurrentUser(tutor);
        if (window.EduMatchBackend?.isEnabled?.()) {
            const result = await window.EduMatchBackend.assignTutorSubject(tutorId, subject.name);
            if (result && result.ok === false) {
                localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(previousUsers));
                const previousUser = previousUsers.find(u => u.id === tutorId);
                if (previousUser) setCurrentUser(previousUser);
                renderTutors();
                return false;
            }
        }
    } catch (error) {
        console.error('Error asignando materia al tutor:', error);
        localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(previousUsers));
        const previousUser = previousUsers.find(u => u.id === tutorId);
        if (previousUser) setCurrentUser(previousUser);
        showToast(error?.message || 'No se pudo guardar la materia del tutor.', 'error');
        return false;
    }

    showToast('Materia agregada a tu perfil.', 'success');
    renderSubjects();
    renderTutors();
    renderRequests();
    updateStats();
    return true;
}

function getCustomSubjectDeletionBlocker(tutorId, subjectName) {
    const key = subjectName.toLowerCase();
    const otherTutor = getStoredData(STORAGE_KEYS.USERS, []).some(u =>
        u.id !== tutorId && u.role === ROLES.TUTOR && (u.subjects || []).some(s => s.toLowerCase() === key));
    if (otherTutor) return 'No puedes eliminar esta materia porque otro tutor todavía la tiene asignada.';
    const hasRequests = getStoredData(STORAGE_KEYS.REQUESTS, []).some(r => r && (r.subject || '').toLowerCase() === key);
    if (hasRequests) return 'No puedes eliminar esta materia porque existen solicitudes o tutorías asociadas a ella.';
    return null;
}

function refreshSubjectViews() {
    renderSubjects();
    renderTutors();
    renderRequests();
    updateStats();
}

function scheduleCustomSubjectDeletion(tutorId, subjectName) {
    if (pendingSubjectDeletion) {
        showToast('Ya hay una eliminación en curso. Espera unos segundos.', 'info');
        return;
    }
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.TUTOR || currentUser.id !== tutorId) {
        showToast('Solo el propio tutor puede eliminar materias personalizadas.', 'error');
        return;
    }
    const subject = findSubjectByName(subjectName);
    if (!subject || subject.createdBy !== tutorId) {
        showToast('Solo puedes eliminar materias creadas por ti.', 'error');
        return;
    }
    const blocker = getCustomSubjectDeletionBlocker(tutorId, subjectName);
    if (blocker) {
        showToast(blocker, 'error');
        return;
    }
    pendingSubjectDeletion = { tutorId, subjectName };
    refreshSubjectViews();
    showToast(`"${subjectName}" se eliminará en 5 segundos.`, 'info', {
        actionLabel: 'Deshacer',
        duration: 5000,
        onAction: () => {
            pendingSubjectDeletion = null;
            refreshSubjectViews();
            showToast('Eliminación cancelada.', 'success');
        },
        onExpire: () => finalizeCustomSubjectDeletion(tutorId, subjectName)
    });
}

async function finalizeCustomSubjectDeletion(tutorId, subjectName) {
    const deleted = await deleteCustomSubject(tutorId, subjectName);
    pendingSubjectDeletion = null;
    if (!deleted) refreshSubjectViews();
}

async function deleteCustomSubject(tutorId, subjectName) {
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.TUTOR || currentUser.id !== tutorId) {
        showToast('Solo el propio tutor puede eliminar materias personalizadas.', 'error');
        return false;
    }
    const subject = findSubjectByName(subjectName);
    if (!subject || subject.createdBy !== tutorId) {
        showToast('Solo puedes eliminar materias creadas por ti.', 'error');
        return false;
    }
    if (!window.EduMatchBackend?.isEnabled?.() || !window.EduMatchBackend.deleteCustomSubject) {
        showToast('No se puede eliminar la materia sin una conexión activa con Supabase.', 'error');
        return false;
    }
    const result = await window.EduMatchBackend.deleteCustomSubject(tutorId, subjectName);
    if (!result || result.ok === false) return false;

    const subjects = getSubjects().filter(s => s.name.toLowerCase() !== subjectName.toLowerCase());
    const users = getStoredData(STORAGE_KEYS.USERS, []);
    const tutor = users.find(u => u.id === tutorId);
    if (tutor) tutor.subjects = (tutor.subjects || []).filter(s => s.toLowerCase() !== subjectName.toLowerCase());
    currentUser.subjects = (currentUser.subjects || []).filter(s => s.toLowerCase() !== subjectName.toLowerCase());
    localStorage.setItem(STORAGE_KEYS.SUBJECTS, JSON.stringify(subjects));
    localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
    setCurrentUser(currentUser);
    pendingSubjectDeletion = null;
    showToast(`Materia personalizada "${subjectName}" eliminada.`, 'success');
    refreshSubjectViews();
    return true;
}

async function removeSubjectFromTutor(tutorId, subjectName) {
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

    const previousUsers = getStoredData(STORAGE_KEYS.USERS, []);
    tutor.subjects = (tutor.subjects || []).filter(s => s !== subjectName);
    localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
    setCurrentUser(tutor);

    if (window.EduMatchBackend?.isEnabled?.()) {
        const result = await window.EduMatchBackend.removeTutorSubject(tutorId, subjectName);
        if (result && result.ok === false) {
            localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(previousUsers));
            const previousUser = previousUsers.find(u => u.id === tutorId);
            if (previousUser) setCurrentUser(previousUser);
            renderTutors();
            return;
        }
    }

    const affectedIds = getStoredData(STORAGE_KEYS.REQUESTS, [])
        .filter(r => r.tutorId === tutorId && r.subject === subjectName && ACTIVE_REQUEST_STATUSES.includes(r.status))
        .map(r => r.id);
    const remoteIdsByRequest = new Map();
    try {
        for (const id of affectedIds) remoteIdsByRequest.set(id, await fetchRemoteEligibleTutorIds(id));
    } catch (error) {
        // La materia ya se quitó del perfil, pero las solicitudes no se tocan sin la
        // lista autorizada por Supabase (se muestra el error en lugar de adivinar).
        showToast(error.userMessage || 'No se pudieron reasignar las solicitudes de esa materia. Inténtalo nuevamente.', 'error');
        renderTutors();
        renderRequests();
        return;
    }

    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    let requestsChanged = false;
    requests.forEach(r => {
        if (!affectedIds.includes(r.id) || r.tutorId !== tutorId || !ACTIVE_REQUEST_STATUSES.includes(r.status)) return;
        requestsChanged = true;
        if (!Array.isArray(r.rejectedTutorIds)) r.rejectedTutorIds = [];
        if (!r.rejectedTutorIds.includes(r.tutorId)) r.rejectedTutorIds.push(r.tutorId);
        logRequestEvent(r, 'tutor_removed', { tutorId: r.tutorId, tutorName: r.tutorName, reasonKind: 'subject_removed' });
        r.proposedDate = null;
        r.proposedTime = null;
        r.proposedMessage = null;
        r.tutorId = null;
        reassignOrCancel(r, 'tutor_removed', remoteIdsByRequest.get(r.id));
    });
    if (requestsChanged) {
        const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
        if (!synced) return;
    }

    showToast('Materia eliminada de tu perfil.', 'success');
    renderTutors();
    renderRequests();
    updateStats();
}

async function deleteTutorProfile(tutorId) {
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.TUTOR || currentUser.id !== tutorId) {
        showToast('Solo el propio tutor puede eliminar su perfil.', 'error');
        return;
    }
    if (pendingTutorDeletion) return;

    let activeCount = getStoredData(STORAGE_KEYS.REQUESTS, []).filter(request =>
        request && request.tutorId === tutorId && [REQUEST_STATUS.PENDING, REQUEST_STATUS.PROPOSED, REQUEST_STATUS.ACCEPTED].includes(request.status)
    ).length;

    if (window.EduMatchBackend?.isEnabled?.() && window.EduMatchBackend.getTutorActiveRequestCount) {
        const remoteCount = await window.EduMatchBackend.getTutorActiveRequestCount(tutorId);
        if (remoteCount >= 0) activeCount = remoteCount;
    }

    if (activeCount > 0) {
        showToast('No se puede eliminar en este momento: tienes tutorías a tu cargo.', 'error');
        return;
    }

    openConfirmModal({
        title: '¿Deseas eliminar tu perfil de tutor definitivamente?',
        message: 'Se eliminará tu perfil de tutor, sus materias asignadas y el acceso a la cuenta. Después de confirmar tendrás 5 segundos para deshacer.',
        confirmLabel: 'Sí, eliminar',
        cancelLabel: 'No, conservar',
        onConfirm: () => scheduleTutorDeletion(tutorId),
        onCancel: () => showToast('No se eliminó el perfil.', 'info')
    });
}

function scheduleTutorDeletion(tutorId) {
    if (pendingTutorDeletion) return;
    pendingTutorDeletion = { tutorId };
    showToast('La eliminación de tu perfil se ejecutará en 5 segundos.', 'info', {
        actionLabel: 'Deshacer',
        duration: 5000,
        onAction: () => {
            pendingTutorDeletion = null;
            showToast('Eliminación cancelada.', 'success');
        },
        onExpire: () => finalizeTutorDeletion(tutorId)
    });
}

async function finalizeTutorDeletion(tutorId) {
    pendingTutorDeletion = null;
    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.id !== tutorId || currentUser.role !== ROLES.TUTOR) return;

    const activeCount = window.EduMatchBackend?.getTutorActiveRequestCount
        ? await window.EduMatchBackend.getTutorActiveRequestCount(tutorId)
        : getStoredData(STORAGE_KEYS.REQUESTS, []).filter(request =>
            request && request.tutorId === tutorId && [REQUEST_STATUS.PENDING, REQUEST_STATUS.PROPOSED, REQUEST_STATUS.ACCEPTED].includes(request.status)
        ).length;

    if (activeCount > 0) {
        showToast('No se puede eliminar en este momento: tienes tutorías a tu cargo.', 'error');
        return;
    }

    if (!window.EduMatchBackend?.isEnabled?.() || !window.EduMatchBackend.deleteTutorAccount) {
        showToast('No se puede eliminar la cuenta sin conexión con Supabase.', 'error');
        return;
    }

    const result = await window.EduMatchBackend.deleteTutorAccount(tutorId);
    if (!result || result.ok === false) return;

    const users = getStoredData(STORAGE_KEYS.USERS, []).filter(user => user.id !== tutorId);
    localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
    localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
    showToast('Tu cuenta de tutor fue eliminada correctamente.', 'success');
    refreshAfterAuthChange();
}

function selectTutorForRequest(tutorName) {
    switchTab('request');

    const subjectSelect = document.getElementById('selectSubject');
    const currentSubject = subjectSelect ? subjectSelect.value : '';
    const tutor = getTutors().find(t => t.name === tutorName);

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

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^\d{2}:\d{2}$/;

async function handleTutorRequest(event) {
    event.preventDefault();

    const currentUser = getCurrentUser();
    if (!currentUser || currentUser.role !== ROLES.STUDENT) {
        showToast('Debes iniciar sesión como estudiante para solicitar una tutoría.', 'error');
        return;
    }

    const subject = document.getElementById('selectSubject').value;
    const tutorName = document.getElementById('selectTutor').value;
    const preferredDate = document.getElementById('preferredDate').value;
    const preferredTime = document.getElementById('preferredTime').value;
    const topic = document.getElementById('requestTopic').value.trim();

    if (!subject) {
        showToast('Selecciona una materia para tu solicitud.', 'error');
        return;
    }
    if (!findSubjectByName(subject)) {
        showToast('La materia seleccionada no existe en el catálogo.', 'error');
        return;
    }
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
        if (!(tutor.subjects || []).includes(subject)) {
            showToast('Este tutor no ofrece esta materia actualmente.', 'error');
            return;
        }
    }

    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);

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
        rejectedTutorIds: [],
        rejectionSource: null,
        rejectedProposalDate: null,
        rejectedProposalTime: null,
        cancellationReason: null,
        openForReassignment: false,
        history: autoAssigned
            ? [{ type: 'created', at: nowLocalTimestamp() }, { type: 'tutor_assigned', at: nowLocalTimestamp(), tutorId: tutor.id, tutorName: tutor.name }]
            : [{ type: 'created', at: nowLocalTimestamp() }],
        createdAt: nowLocalTimestamp(),
        respondedAt: null,
        completedAt: null
    });
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }

    showToast(autoAssigned
        ? `Solicitud registrada y asignada automáticamente a ${tutor.name}.`
        : 'Solicitud de tutoría registrada con éxito.', 'success');
    document.getElementById('tutorRequestForm').reset();
    setDefaultPreferredDate();

    renderRequests();
    updateStats();
    switchTab('history');
}

const NO_MORE_TUTORS_MESSAGE = 'Lo sentimos, no hay más tutores que den esta materia disponibles en este momento.';

function logRequestEvent(request, type, detail = {}) {
    if (!Array.isArray(request.history)) request.history = [];
    request.history.push({ type, at: nowLocalTimestamp(), ...detail });
}

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

// Horario que ya ocupa una solicitud del tutor: el de una tutoría aceptada o el
// que propuso y aún espera respuesta del estudiante.
function getTutorBusySlot(request) {
    if (request.status === REQUEST_STATUS.ACCEPTED) return { date: request.preferredDate, time: request.preferredTime };
    if (request.status === REQUEST_STATUS.PROPOSED) return { date: request.proposedDate, time: request.proposedTime };
    return null;
}

function isTutorScheduleTaken(requests, tutorId, date, time, exceptId) {
    return requests.some(r => {
        if (r.id === exceptId || r.tutorId !== tutorId) return false;
        const slot = getTutorBusySlot(r);
        return !!slot && slot.date === date && slot.time === time;
    });
}

async function acceptRequest(id) {
    const ctx = getRequestForAction(id, { as: 'tutor', errorMessage: 'Solo el tutor asignado puede aceptar esta solicitud.' });
    if (!ctx) return;
    const { request, requests, currentUser } = ctx;

    if (request.status !== REQUEST_STATUS.PENDING) return;
    if (!(currentUser.subjects || []).includes(request.subject)) {
        showToast('Ya no tienes esta materia asignada: no puedes aceptar esta solicitud.', 'error');
        return;
    }
    if (isTutorScheduleTaken(requests, currentUser.id, request.preferredDate, request.preferredTime, request.id)) {
        showToast('Horario no disponible: ya tienes una tutoría en esa fecha y hora. Propón otro horario al estudiante.', 'error');
        return;
    }

    request.status = REQUEST_STATUS.ACCEPTED;
    request.respondedAt = nowLocalTimestamp();
    logRequestEvent(request, 'accepted', { tutorName: request.tutorName });
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }
    showToast('Solicitud aceptada.', 'success');
    renderRequests();
}

const rejectionsInProgress = new Set();

async function rejectRequest(id) {
    if (rejectionsInProgress.has(id)) return;
    rejectionsInProgress.add(id);
    try {
        await performRejection(id);
    } finally {
        rejectionsInProgress.delete(id);
    }
}

async function performRejection(id) {
    const precheck = getRequestForAction(id, { as: 'tutor', errorMessage: 'Solo el tutor asignado puede rechazar esta solicitud.' });
    if (!precheck || precheck.request.status !== REQUEST_STATUS.PENDING) return;

    // Con Supabase el rechazo y la reasignación los hace el servidor en una sola
    // operación; el éxito solo se muestra si Supabase lo confirma.
    const backend = window.EduMatchBackend;
    if (backend?.isEnabled?.() && typeof backend.rejectRequest === 'function') {
        const result = await backend.rejectRequest(id);
        if (!result.ok) {
            showToast(result.message, 'error');
        } else {
            showToast(result.reassigned
                ? `Solicitud rechazada. Se reasignó automáticamente a ${result.tutorName}.`
                : 'Solicitud rechazada. No había otros tutores disponibles: la solicitud se canceló.', 'success');
        }
        renderRequests();
        updateStats();
        return;
    }

    // Modo local (sin Supabase).
    const { request, requests } = precheck;
    if (!Array.isArray(request.rejectedTutorIds)) request.rejectedTutorIds = [];
    if (request.tutorId != null && !request.rejectedTutorIds.includes(request.tutorId)) {
        request.rejectedTutorIds.push(request.tutorId);
    }
    request.respondedAt = nowLocalTimestamp();
    logRequestEvent(request, 'tutor_rejected', { tutorId: request.tutorId, tutorName: request.tutorName });

    const newTutor = reassignOrCancel(request, 'rejected');
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }

    showToast(newTutor
        ? `Solicitud rechazada. Se reasignó automáticamente a ${newTutor.name}.`
        : 'Solicitud rechazada. No había otros tutores disponibles: la solicitud se canceló.', 'success');
    renderRequests();
    updateStats();
}

function reassignOrCancel(request, reason, remoteIds = null) {
    const next = getReassignmentCandidates(request, remoteIds)[0] || null;

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

const openProposalForms = new Set();

function toggleProposalForm(id) {
    if (openProposalForms.has(id)) {
        openProposalForms.delete(id);
    } else {
        openProposalForms.add(id);
    }
    renderRequests();
}

async function proposeSchedule(id) {
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
    if (isTutorScheduleTaken(requests, currentUser.id, proposedDate, proposedTime, request.id)) {
        showToast('Horario no disponible: ya tienes una tutoría en esa fecha y hora. Elige otro horario.', 'error');
        return;
    }

    request.status = REQUEST_STATUS.PROPOSED;
    request.proposedDate = proposedDate;
    request.proposedTime = proposedTime;
    request.proposedMessage = proposedMessage || null;
    request.respondedAt = nowLocalTimestamp();
    logRequestEvent(request, 'schedule_proposed', { tutorName: request.tutorName, date: proposedDate, time: proposedTime });
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }

    openProposalForms.delete(id);
    showToast('Propuesta de horario enviada al estudiante.', 'success');
    renderRequests();
}

async function acceptProposedSchedule(id) {
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
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }

    showToast('Horario aceptado. La tutoría queda agendada.', 'success');
    renderRequests();
}

async function rejectProposedSchedule(id) {
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
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }

    showToast('Has rechazado la propuesta de horario. La solicitud quedó Rechazada.', 'info');
    renderRequests();
}

function getEligibleReplacementTutors(request) {
    const excluded = request.rejectedTutorIds || [];
    return getTutors().filter(t =>
        (t.subjects || []).includes(request.subject) &&
        !excluded.includes(t.id) &&
        t.id !== request.studentId
    );
}

const ACTIVE_REQUEST_STATUSES = [REQUEST_STATUS.PENDING, REQUEST_STATUS.PROPOSED, REQUEST_STATUS.ACCEPTED];

// Tutores a los que puede pasar automáticamente una solicitud rechazada.
// remoteIds (calculado en Supabase) es la fuente autorizada cuando existe;
// si no, se filtra con los datos locales.
function getReassignmentCandidates(request, remoteIds = null) {
    const tutors = getTutors().filter(t => t.id !== request.studentId && t.id !== request.tutorId);
    if (Array.isArray(remoteIds)) {
        return remoteIds.map(id => tutors.find(t => t.id === id)).filter(Boolean);
    }
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    const hasActiveDuplicate = tutorId => requests.some(r =>
        r.id !== request.id &&
        r.studentId === request.studentId &&
        r.subject === request.subject &&
        r.tutorId === tutorId &&
        ACTIVE_REQUEST_STATUSES.includes(r.status)
    );
    return getEligibleReplacementTutors(request).filter(t => t.id !== request.tutorId && !hasActiveDuplicate(t.id));
}

async function fetchRemoteEligibleTutorIds(requestId) {
    if (!window.EduMatchBackend?.isEnabled?.() || !window.EduMatchBackend.getEligibleTutorIds) return null;
    return window.EduMatchBackend.getEligibleTutorIds(requestId);
}

async function clearRequestTutor(id) {
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
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }
    showToast('Tutor quitado de la solicitud. Elige otro para continuar.', 'success');
    renderRequests();
}

async function assignNewTutorToRequest(id, tutorId) {
    const ctx = getRequestForAction(id, { as: 'student', errorMessage: 'Solo el estudiante que creó la solicitud puede modificarla.' });
    if (!ctx) return;
    const { request, requests } = ctx;

    const afterTutorCleared = request.status === REQUEST_STATUS.PENDING && !request.tutorId && request.openForReassignment;
    if (!afterTutorCleared) return;

    const tutor = getEligibleReplacementTutors(request).find(t => t.id === tutorId);
    if (!tutor) {
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
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }

    showToast(`Solicitud reasignada a ${tutor.name}.`, 'success');
    renderRequests();
}

async function cancelRequest(id) {
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
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }
    showToast('Solicitud cancelada.', 'success');
    renderRequests();
    updateStats();
}

async function completeRequest(id) {
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
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }
    showToast('Tutoría marcada como realizada.', 'success');
    renderRequests();
    updateStats();
}

async function saveRating(id, ratingValue) {
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
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }

    showToast('¡Gracias por tu valoración!', 'success');
    renderRequests();
}

const HISTORY_REMOVABLE_STATUSES = [REQUEST_STATUS.DONE, REQUEST_STATUS.REJECTED, REQUEST_STATUS.CANCELLED];

function isHiddenFromHistory(request, userId) {
    return Array.isArray(request.hiddenFor) && request.hiddenFor.includes(userId);
}

function canRemoveFromHistory(request, user) {
    if (!user || !HISTORY_REMOVABLE_STATUSES.includes(request.status)) return false;
    const isStudentOwner = user.id === request.studentId;
    const isAssignedTutor = user.role === ROLES.TUTOR && user.id === request.tutorId;
    return isStudentOwner || isAssignedTutor;
}

async function deleteFromHistory(id) {
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
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }
    renderRequests();

    showToast('Solicitud eliminada de tu historial.', 'info', {
        actionLabel: 'Deshacer',
        onAction: () => restoreToHistory(id, userId)
    });
}

async function restoreToHistory(id, userId) {
    const requests = getStoredData(STORAGE_KEYS.REQUESTS, []);
    const request = requests.find(r => r.id === id);
    if (!request || !Array.isArray(request.hiddenFor)) return;
    request.hiddenFor = request.hiddenFor.filter(uid => uid !== userId);
    const synced = await saveData(STORAGE_KEYS.REQUESTS, requests);
    if (!synced) {
        renderRequests();
        return;
    }
    renderRequests();
}

function renderRequests(subjectFilter = '') {
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

    const visible = requests.filter(r => currentUser && (
        r.studentId === currentUser.id || (currentUser.role === ROLES.TUTOR && r.tutorId === currentUser.id)
    ) && !isHiddenFromHistory(r, currentUser.id)
        && (!subjectFilter || (currentUser.role === ROLES.TUTOR && r.subject === subjectFilter)));

    if (!currentUser) {
        container.innerHTML = `<div class="card empty-state-card"><p class="empty-title">Inicia sesión para ver tus solicitudes</p></div>`;
        return;
    }
    if (visible.length === 0) {
        container.innerHTML = `<div class="card empty-state-card"><p class="empty-title">No tienes solicitudes todavía</p></div>`;
        return;
    }

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

function getAutoReassignment(req) {
    const events = getRequestHistory(req);
    const last = events[events.length - 1];
    if (!last || last.type !== 'tutor_reassigned' || !last.fromTutorName) return null;
    return last.tutorId === req.tutorId ? last : null;
}

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

function requestActionButton(kind, action, label, id) {
    return `<button type="button" class="btn-${kind}" data-action="${action}" data-id="${id}">${label}</button>`;
}

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

    let tutorSubjectMismatch = false;
    if (req.tutorId) {
        const tutorUser = getStoredData(STORAGE_KEYS.USERS, []).find(u => u.id === req.tutorId);
        tutorSubjectMismatch = !tutorUser || !(tutorUser.subjects || []).includes(req.subject);
    }

    const dateInfo = req.preferredDate
        ? `${formatStoredDate(req.preferredDate)}${req.preferredTime ? ' — ' + formatTime12(req.preferredTime) : ''}`
        : 'Por coordinar';

    const notices = [];
    const panels = [];
    const actions = [];
    const note = text => notices.push(`<p class="request-notice"><span>${text}</span></p>`);

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

    if (req.status === REQUEST_STATUS.CANCELLED && req.cancellationReason === 'no_tutors') {
        note(isStudentOwner
            ? `<strong>Solicitud cancelada.</strong> ${NO_MORE_TUTORS_MESSAGE}`
            : 'Solicitud cancelada: la rechazaste y no había otros tutores disponibles para esta materia.');
    }

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

    if ([REQUEST_STATUS.PENDING, REQUEST_STATUS.PROPOSED, REQUEST_STATUS.ACCEPTED].includes(req.status) && isStudentOwner) {
        actions.push(requestActionButton('danger', 'cancel-request', 'Cancelar', req.id));
    }
    if (canRemoveFromHistory(req, currentUser)) {
        actions.push(requestActionButton('secondary', 'delete-history', 'Eliminar del historial', req.id));
    }

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

function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

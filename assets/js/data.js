
const STORAGE_KEYS = {
    SUBJECTS: 'edumatch_subjects',
    USERS: 'edumatch_users',
    REQUESTS: 'edumatch_requests',
    CURRENT_USER: 'edumatch_current_user',
    THEME: 'edumatch_theme'
};

const ROLES = { STUDENT: 'Estudiante', TUTOR: 'Tutor' };

const REQUEST_STATUS = {
    PENDING: 'Pendiente',
    ACCEPTED: 'Aceptada',
    REJECTED: 'Rechazada',
    PROPOSED: 'Propuesta_Horario',
    CANCELLED: 'Cancelada',
    DONE: 'Realizada'
};

const REQUEST_STATUS_LABEL = {
    [REQUEST_STATUS.PENDING]: 'Pendiente',
    [REQUEST_STATUS.ACCEPTED]: 'Aceptada',
    [REQUEST_STATUS.REJECTED]: 'Rechazada',
    [REQUEST_STATUS.PROPOSED]: 'Propuesta de horario',
    [REQUEST_STATUS.CANCELLED]: 'Cancelada',
    [REQUEST_STATUS.DONE]: 'Realizada'
};

const initialSubjects = [
    { id: 1, name: "Cálculo Diferencial", category: "Matemáticas", description: "Límites, derivadas, optimización y sus aplicaciones en ingeniería." },
    { id: 2, name: "Programación Orientada a Objetos", category: "Sistemas", description: "Clases, objetos, herencia, polimorfismo y patrones de diseño." },
    { id: 3, name: "Física Mecánica", category: "Física", description: "Leyes de Newton, conservación de la energía, momento y cinemática." },
    { id: 4, name: "Estructuras de Datos", category: "Sistemas", description: "Listas enlazadas, árboles binarios, grafos y análisis de algoritmos." },
    { id: 5, name: "Álgebra Lineal", category: "Matemáticas", description: "Vectores, matrices, espacios vectoriales y transformaciones lineales." },
    { id: 6, name: "Bases de Datos", category: "Sistemas", description: "Modelado relacional, SQL, normalización y gestión de datos." }
];

function getStoredData(key, fallback) {
    try {
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : fallback;
    } catch (e) {
        console.error(`Error leyendo "${key}" de localStorage`, e);
        return fallback;
    }
}

function saveData(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
        console.error(`Error guardando "${key}" en localStorage`, e);
        return Promise.resolve(false);
    }

    if (window.EduMatchBackend && typeof window.EduMatchBackend.onLocalDataSaved === 'function') {
        return Promise.resolve(window.EduMatchBackend.onLocalDataSaved(key, data))
            .then(result => {
                if (result && result.ok === false) {
                    window.showToast?.(result.message || 'No se pudo sincronizar con Supabase.', 'error');
                    return false;
                }
                return true;
            })
            .catch(error => {
                console.error('Error sincronizando con Supabase:', error);
                window.showToast?.('No se pudo sincronizar con Supabase. Comprueba tu conexión e inténtalo nuevamente.', 'error');
                return false;
            });
    }

    return Promise.resolve(true);
}

function formatStoredDate(isoDateStr) {
    if (!isoDateStr) return null;
    const [year, month, day] = isoDateStr.split('-');
    if (!year || !month || !day) return isoDateStr;
    return `${day}/${month}/${year}`;
}

function formatTime12(hhmm) {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return hhmm || '';
    const h24 = Number(m[1]);
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const period = h24 < 12 ? 'a. m.' : 'p. m.';
    return `${h12}:${m[2]} ${period}`;
}

function splitStoredTimestamp(ts) {
    if (!ts) return { date: '', time: '' };
    const [datePart, timePart] = String(ts).split(' ');
    return { date: formatStoredDate(datePart) || '', time: timePart || '' };
}

function nowLocalTimestamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function todayIsoDate() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

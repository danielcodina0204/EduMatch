// data.js — Datos base, acceso a almacenamiento y utilidades de fecha/hora
// Responsabilidad única: persistencia (localStorage), semillas y formato.

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

// Catálogo inicial de materias (compartido por todo el sistema)
const initialSubjects = [
    { id: 1, name: "Cálculo Diferencial", category: "Matemáticas", description: "Límites, derivadas, optimización y sus aplicaciones en ingeniería." },
    { id: 2, name: "Programación Orientada a Objetos", category: "Sistemas", description: "Clases, objetos, herencia, polimorfismo y patrones de diseño." },
    { id: 3, name: "Física Mecánica", category: "Física", description: "Leyes de Newton, conservación de la energía, momento y cinemática." },
    { id: 4, name: "Estructuras de Datos", category: "Sistemas", description: "Listas enlazadas, árboles binarios, grafos y análisis de algoritmos." },
    { id: 5, name: "Álgebra Lineal", category: "Matemáticas", description: "Vectores, matrices, espacios vectoriales y transformaciones lineales." },
    { id: 6, name: "Bases de Datos", category: "Sistemas", description: "Modelado relacional, SQL, normalización y gestión de datos." }
];

/** Lee datos de localStorage de forma segura. */
function getStoredData(key, fallback) {
    try {
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : fallback;
    } catch (e) {
        console.error(`Error leyendo "${key}" de localStorage`, e);
        return fallback;
    }
}

/** Guarda datos en localStorage de forma segura. */
function saveData(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify(data));
        if (window.EduMatchBackend && typeof window.EduMatchBackend.onLocalDataSaved === 'function') {
            Promise.resolve(window.EduMatchBackend.onLocalDataSaved(key, data)).catch(err => console.error('Error sincronizando con Supabase:', err));
        }
        return true;
    } catch (e) {
        console.error(`Error guardando "${key}" en localStorage`, e);
        return false;
    }
}

/**
 * Único punto de la app que "conoce" cómo se guarda una fecha/hora,
 * para evitar estrategias distintas en distintos módulos.
 * Se guarda siempre como fecha LOCAL en formato "YYYY-MM-DD" (input type=date)
 * y hora local "HH:MM" (input type=time), sin construir objetos Date que
 * reinterpreten la cadena como UTC (fuente típica del bug de "un día menos").
 */
function formatStoredDate(isoDateStr) {
    if (!isoDateStr) return null;
    const [year, month, day] = isoDateStr.split('-');
    if (!year || !month || !day) return isoDateStr;
    return `${day}/${month}/${year}`;
}

/** "HH:MM" (24 h, como se guarda) -> "1:00 p. m." (12 h con a. m./p. m., formato
 * Colombia). Es solo un cambio de FORMATO de visualización: no es la hora real del
 * dispositivo ni pasa por Date/zona horaria, para no reinterpretar la hora guardada. */
function formatTime12(hhmm) {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return hhmm || '';
    const h24 = Number(m[1]);
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const period = h24 < 12 ? 'a. m.' : 'p. m.';
    return `${h12}:${m[2]} ${period}`;
}

/** Timestamp local "YYYY-MM-DD HH:MM" -> { date: "DD/MM/YYYY", time: "HH:MM" }.
 * Mismo criterio que formatStoredDate: se parte la cadena, sin pasar por Date. */
function splitStoredTimestamp(ts) {
    if (!ts) return { date: '', time: '' };
    const [datePart, timePart] = String(ts).split(' ');
    return { date: formatStoredDate(datePart) || '', time: timePart || '' };
}

function nowLocalTimestamp() {
    // Timestamp local legible y también ordenable (formato local, sin Z de UTC).
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function todayIsoDate() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

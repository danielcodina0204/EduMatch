// Pruebas end-to-end de EduMatch (Playwright + Chromium real).
// Uso:   npm i -D playwright && npx playwright install chromium && node tests/e2e.js
// Levanta un servidor estático local, recorre los flujos de solicitudes y
// termina con código 1 si alguna comprobación falla.
const http = require('http');
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(path.join(process.env.NODE_PATH || '', 'playwright'))); }

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const NO_MORE = 'Lo sentimos, no hay más tutores que den esta materia disponibles en este momento.';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  ✔ ${name}`); }
    else { failed++; failures.push(name); console.log(`  ✘ ${name} ${extra}`); }
}
const section = t => console.log(`\n${t}`);

const server = http.createServer((req, res) => {
    const file = path.join(ROOT, req.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
        res.end(data);
    });
});

(async () => {
    await new Promise(r => server.listen(0, r));
    const url = `http://localhost:${server.address().port}/`;
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    // ---------- helpers ----------
    const goHistory = async () => { await page.click('.nav-btn[data-tab="history"]'); };
    const reload = async () => { await page.reload(); await page.waitForSelector('#requestsList', { state: 'attached' }); if (await page.locator('.nav-btn[data-tab="history"]').isVisible()) await goHistory(); };
    const card = topic => page.locator('.request-card', { hasText: topic });
    const statusOf = async topic => (await card(topic).locator('.request-card-header .badge').textContent()).trim();
    const btnTexts = async topic => (await card(topic).locator('.request-actions > button').allInnerTexts()).map(t => t.trim());
    const store = key => page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), key);
    const storedRequest = async topic => (await store('edumatch_requests')).find(r => r.topic === topic);
    const lastToast = async () => (await page.locator('#toastContainer .toast-msg').last().innerText()).trim();

    async function register(role, name, email, subjects = []) {
        await page.click('#authButton');
        await page.click('#authTabRegister');
        await page.click(role === 'Tutor' ? '#roleTutor' : '#roleEstudiante');
        await page.fill('#regName', name);
        await page.fill('#regEmail', email);
        await page.fill('#regPassword', 'Secreto1!');
        await page.fill('#regPasswordConfirm', 'Secreto1!');
        for (const s of subjects) await page.check(`#regSubjectsList input[value="${s}"]`);
        await page.click('#registerForm button[type="submit"]');
        await page.fill('#loginPassword', 'Secreto1!');
        await page.click('#loginForm button[type="submit"]');
        await page.waitForSelector('#userInfo', { state: 'visible' });
    }
    async function login(email) {
        await page.click('#authButton');
        await page.click('#authTabLogin');
        await page.fill('#loginEmail', email);
        await page.fill('#loginPassword', 'Secreto1!');
        await page.click('#loginForm button[type="submit"]');
        await page.waitForSelector('#userInfo', { state: 'visible' });
        await goHistory();
    }
    const logout = async () => { await page.click('[data-action="logout"]'); await page.waitForSelector('#authButton', { state: 'visible' }); };
    async function requestTutor(subject, tutorName, topic) {
        await page.click('.nav-btn[data-tab="request"]');
        await page.selectOption('#selectSubject', subject);
        if (tutorName) await page.selectOption('#selectTutor', { label: (await page.locator('#selectTutor option').allInnerTexts()).find(t => t.startsWith(tutorName)) });
        await page.fill('#preferredTime', '10:00'); // APP-06: hora obligatoria (la fecha ya viene con mañana)
        await page.fill('#requestTopic', topic);
        await page.click('#tutorRequestForm button[type="submit"]');
        await page.waitForSelector('#history-tab.active');
    }
    // Lee el modal de historial tal como lo ve el usuario (estructura + geometría) y lo cierra.
    async function historyData(topic) {
        await card(topic).locator('[data-action="open-history"]').click();
        const d = await page.evaluate(() => {
            const box = document.querySelector('#historyModal .modal-content').getBoundingClientRect();
            const rect = (li, sel) => li.querySelector(sel).getBoundingClientRect();
            const items = [...document.querySelectorAll('#historyModalList .history-item')].map(li => ({
                title: li.querySelector('.history-title').innerText.trim(),
                detail: li.querySelector('.history-detail') ? li.querySelector('.history-detail').innerText.trim() : '',
                date: li.querySelector('.history-date').innerText.trim().replace(/\s+/g, ' '),
                dotX: Math.round(rect(li, '.history-dot').left),
                titleX: Math.round(rect(li, '.history-title').left),
                dateRight: Math.round(rect(li, '.history-date').right)
            }));
            return {
                width: Math.round(box.width), height: Math.round(box.height),
                title: document.getElementById('historyModalTitle').innerText.trim(),
                meta: document.getElementById('historyModalMeta').innerText.trim(),
                status: document.getElementById('historyModalStatus').textContent.trim(),
                buttons: document.querySelectorAll('#historyModal button:not(.close-btn)').length,
                text: document.querySelector('#historyModal .modal-content').innerText, items
            };
        });
        await page.click('#historyModal .close-btn');
        return d;
    }
    // Comprobaciones comunes de "historial limpio y compacto".
    function checkCompactHistory(label, h, expectedTitles) {
        check(`${label}: eventos en orden = ${expectedTitles.join(' → ')}`, JSON.stringify(h.items.map(i => i.title)) === JSON.stringify(expectedTitles), JSON.stringify(h.items.map(i => i.title)));
        check(`${label}: compacto (ancho ≤ 440px, alto ≤ ${140 + 62 * h.items.length}px)`, h.width <= 440 && h.height <= 140 + 62 * h.items.length, `${h.width}x${h.height}`);
        check(`${label}: sin botones dentro del historial`, h.buttons === 0);
        check(`${label}: puntos alineados en una misma columna`, new Set(h.items.map(i => i.dotX)).size === 1);
        check(`${label}: textos alineados en una misma columna`, new Set(h.items.map(i => i.titleX)).size === 1);
        check(`${label}: fechas alineadas al mismo borde derecho`, new Set(h.items.map(i => i.dateRight)).size === 1);
        check(`${label}: fechas con formato dd/mm/aaaa h:mm a. m./p. m. (sin timestamp crudo)`, h.items.every(i => /^\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (a\. m\.|p\. m\.)$/.test(i.date)) && !/\d{4}-\d{2}-\d{2}/.test(h.text), JSON.stringify(h.items.map(i => i.date)));
        const key = d => {
            const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) (a\. m\.|p\. m\.)$/.exec(d);
            let h = Number(m[4]) % 12;
            if (m[6] === 'p. m.') h += 12;
            return `${m[3]}${m[2]}${m[1]}${String(h).padStart(2, '0')}${m[5]}`;
        };
        check(`${label}: fechas en orden cronológico (no decrecientes)`, h.items.every((it, k) => k === 0 || key(h.items[k - 1].date) <= key(it.date)), JSON.stringify(h.items.map(x => x.date)));
    }
    const dismissConfirm = () => page.click('#confirmModalCancel');
    const acceptConfirm = () => page.click('#confirmModalAccept');

    await page.goto(url);
    await page.waitForSelector('#subjectsGrid .subject-card');

    // ================= 1. Registro =================
    section('1. Registro');
    await register('Estudiante', 'Ana Estudiante', 'ana@test.co');
    check('Estudiante registrado e ingresó', (await page.locator('#userNameDisplay').innerText()) === 'Ana Estudiante');
    await logout();
    await register('Tutor', 'Tutor Alfa', 'alfa@test.co', ['Cálculo Diferencial', 'Álgebra Lineal']);
    await logout();
    await register('Tutor', 'Tutor Beta', 'beta@test.co', ['Cálculo Diferencial', 'Álgebra Lineal']);
    await logout();
    await register('Tutor', 'Tutor Gamma', 'gamma@test.co', ['Física Mecánica']);
    await logout();
    const users = await store('edumatch_users');
    check('4 cuentas creadas (1 estudiante + 3 tutores)', users.length === 4);

    const alfa = users.find(u => u.email === 'alfa@test.co');
    const beta = users.find(u => u.email === 'beta@test.co');
    const gamma = users.find(u => u.email === 'gamma@test.co');
    const noOpenText = t => !/Solicitud abierta|esperando que un tutor la atienda|Buscar otro tutor/i.test(t);

    // ================= PRUEBA 1: reasignación automática =================
    section('PRUEBA 1. Tutor A rechaza → A excluido → el sistema asigna a Tutor B automáticamente');
    await login('ana@test.co');
    await requestTutor('Cálculo Diferencial', 'Tutor Alfa', 'S1-rechazo-tutor');
    check('Solicitud creada como Pendiente', (await statusOf('S1-rechazo-tutor')) === 'Pendiente');
    await logout();

    await login('alfa@test.co');
    check('Tutor A ve Aceptar / Rechazar / Proponer', JSON.stringify(await btnTexts('S1-rechazo-tutor')) === JSON.stringify(['Aceptar', 'Rechazar', 'Proponer otro horario']));
    await card('S1-rechazo-tutor').locator('[data-action="reject-request"]').click();
    check('Aparece modal de confirmación', await page.locator('#confirmModal.active').count() === 1);
    check('El modal explica la búsqueda automática (ya no promete "buscar otro tutor" manual)', (await page.locator('#confirmModalMessage').innerText()).includes('automáticamente'));
    await dismissConfirm();
    check('Cancelar el modal cierra el modal', await page.locator('#confirmModal.active').count() === 0);
    check('…y la solicitud sigue Pendiente, sin tutor excluido', (await statusOf('S1-rechazo-tutor')) === 'Pendiente' && (await storedRequest('S1-rechazo-tutor')).rejectedTutorIds.length === 0);
    await reload();
    check('…y tras recargar sigue Pendiente con Tutor A', (await statusOf('S1-rechazo-tutor')) === 'Pendiente' && (await storedRequest('S1-rechazo-tutor')).tutorId === alfa.id);

    await card('S1-rechazo-tutor').locator('[data-action="reject-request"]').click();
    await acceptConfirm();
    check('Toast del tutor: rechazada y reasignada a Tutor Beta', (await lastToast()).includes('reasignó automáticamente a Tutor Beta'), await lastToast());
    check('Tutor A ya no ve la solicitud (pasó a Tutor B)', await card('S1-rechazo-tutor').count() === 0);
    let s1 = await storedRequest('S1-rechazo-tutor');
    check('Tutor A queda excluido (rejectedTutorIds)', s1.rejectedTutorIds.includes(alfa.id));
    check('Tutor B queda asignado (tutorId y tutorName)', s1.tutorId === beta.id && s1.tutorName === 'Tutor Beta');
    check('Tutor B NO queda excluido', !s1.rejectedTutorIds.includes(beta.id));
    check('Estado = Pendiente de la respuesta de B (no Rechazada, no abierta)', s1.status === 'Pendiente' && s1.tutorId != null && s1.openForReassignment === false);
    check('Bitácora sin duplicados: creada → rechazada → reasignada', JSON.stringify(s1.history.map(e => e.type)) === '["created","tutor_rejected","tutor_reassigned"]', JSON.stringify(s1.history.map(e => e.type)));
    await reload();
    check('Tras recargar (como A) la solicitud sigue asignada a B en storage', (await storedRequest('S1-rechazo-tutor')).tutorId === beta.id);
    await logout();

    await login('ana@test.co');
    const s1Text = await card('S1-rechazo-tutor').innerText();
    check('Estudiante ve al nuevo tutor asignado', s1Text.includes('Tutor: Tutor Beta') && s1Text.includes('Nuevo tutor asignado: Tutor Beta'));
    check('Estudiante ve quién rechazó antes', s1Text.includes('Tutor Alfa rechazó tu solicitud'));
    check('NO aparece "Solicitud abierta" / "esperando que un tutor la atienda" / "Buscar otro tutor"', noOpenText(s1Text));
    check('No hay botón manual de búsqueda: solo Cancelar', JSON.stringify(await btnTexts('S1-rechazo-tutor')) === JSON.stringify(['Cancelar']));
    await reload();
    check('Tras recargar (estudiante) sigue con Tutor Beta y sin "abierta"', (await card('S1-rechazo-tutor').innerText()).includes('Nuevo tutor asignado: Tutor Beta') && noOpenText(await card('S1-rechazo-tutor').innerText()));
    await logout();

    await login('beta@test.co');
    check('Tutor B ve la solicitud como Pendiente', (await statusOf('S1-rechazo-tutor')) === 'Pendiente');
    check('Tutor B ve Aceptar / Rechazar / Proponer', JSON.stringify(await btnTexts('S1-rechazo-tutor')) === JSON.stringify(['Aceptar', 'Rechazar', 'Proponer otro horario']));
    check('Tutor B ve que le fue asignada por el rechazo de A', (await card('S1-rechazo-tutor').innerText()).includes('asignada automáticamente porque Tutor Alfa la rechazó'));
    await card('S1-rechazo-tutor').locator('[data-action="accept-request"]').click();
    check('Tutor B acepta → Aceptada (el flujo sigue funcionando)', (await statusOf('S1-rechazo-tutor')) === 'Aceptada');
    await logout();

    // ================= PRUEBA 2: no hay otro tutor → Cancelada =================
    section('PRUEBA 2. Tutor rechaza → no existe otro tutor → Cancelada automáticamente');
    await login('ana@test.co');
    await requestTutor('Física Mecánica', 'Tutor Gamma', 'S2-sin-tutores');
    const before2 = (await store('edumatch_requests')).length;
    await logout();
    await login('gamma@test.co');
    await card('S2-sin-tutores').locator('[data-action="reject-request"]').click();
    await acceptConfirm();
    check('Toast del tutor: no había otros tutores y se canceló', (await lastToast()).includes('la solicitud se canceló'), await lastToast());
    check('Tutor rechazante ve la solicitud Cancelada (no Abierta/Pendiente)', (await statusOf('S2-sin-tutores')) === 'Cancelada');
    check('Tutor rechazante ve por qué', (await card('S2-sin-tutores').locator('.request-notice').first().innerText()).includes('no había otros tutores disponibles'));
    check('Tutor rechazante: solo puede "Eliminar del historial" (nada que reactivar)', JSON.stringify(await btnTexts('S2-sin-tutores')) === JSON.stringify(['Eliminar del historial']));
    const s2 = await storedRequest('S2-sin-tutores');
    check('Storage: Cancelada / no_tutors', s2.status === 'Cancelada' && s2.cancellationReason === 'no_tutors');
    check('Storage: el tutor rechazante queda excluido', s2.rejectedTutorIds.includes(gamma.id));
    check('Storage: no quedó abierta ni esperando reasignación', s2.openForReassignment === false && s2.tutorId === gamma.id);
    check('Storage: no se generó otra propuesta', s2.proposedDate === null && s2.proposedTime === null);
    check('Storage: no se generó otra solicitud', (await store('edumatch_requests')).length === before2);
    check('Bitácora sin duplicados: creada → rechazada → cancelada', JSON.stringify(s2.history.map(e => e.type)) === '["created","tutor_rejected","no_more_tutors"]', JSON.stringify(s2.history.map(e => e.type)));
    await reload();
    check('PRUEBA 3. Tras recargar (tutor) sigue Cancelada', (await statusOf('S2-sin-tutores')) === 'Cancelada');
    await logout();

    await login('ana@test.co');
    const s2Card = card('S2-sin-tutores');
    const s2Text = await s2Card.innerText();
    check('Estudiante ve la tarjeta "Cancelada"', (await statusOf('S2-sin-tutores')) === 'Cancelada');
    check('Estudiante ve "Solicitud cancelada" + mensaje de que no hay más tutores', (await s2Card.locator('.request-notice').first().innerText()).includes('Solicitud cancelada') && s2Text.includes(NO_MORE));
    check('NO aparece Solicitud abierta / esperando tutor / Buscar otro tutor / Pendiente', noOpenText(s2Text) && !/Pendiente|Esperando/i.test(s2Text));
    check('Solo queda "Eliminar del historial" (nada que reactivar)', JSON.stringify(await btnTexts('S2-sin-tutores')) === JSON.stringify(['Eliminar del historial']));
    await reload();
    check('PRUEBA 3. Tras recargar (estudiante) sigue Cancelada con el mensaje', (await statusOf('S2-sin-tutores')) === 'Cancelada' && (await card('S2-sin-tutores').innerText()).includes(NO_MORE));
    check('PRUEBA 3. Tras recargar S1 sigue con Tutor Beta (Aceptada)', (await statusOf('S1-rechazo-tutor')) === 'Aceptada' && (await card('S1-rechazo-tutor').innerText()).includes('Tutor Beta'));

    // ================= 11-13. Propuesta de horario rechazada (caso B) =================
    section('11-13. Propuesta de horario → estudiante rechaza → Rechazada (caso B)');
    await requestTutor('Álgebra Lineal', 'Tutor Beta', 'S3-rechazo-horario');
    await logout();
    await login('beta@test.co');
    await card('S3-rechazo-horario').locator('[data-action="toggle-propose"]').click();
    const rid = (await storedRequest('S3-rechazo-horario')).id;
    const future = new Date(Date.now() + 5 * 86400000);
    const iso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    await page.fill(`#proposeDate-${rid}`, iso);
    await page.fill(`#proposeTime-${rid}`, '15:30');
    await card('S3-rechazo-horario').locator('[data-action="submit-propose"]').click();
    check('Tutor propone horario → Propuesta de horario', (await statusOf('S3-rechazo-horario')) === 'Propuesta de horario');
    await logout();
    await login('ana@test.co');
    check('11. Estudiante ve Aceptar horario / Rechazar propuesta', (await btnTexts('S3-rechazo-horario')).slice(0, 2).join('|') === 'Aceptar horario|Rechazar propuesta');
    await card('S3-rechazo-horario').locator('[data-action="reject-proposal"]').click();
    check('Aparece modal de confirmación de rechazo', await page.locator('#confirmModal.active').count() === 1);
    await dismissConfirm();
    check('14c. Cancelar el modal NO cambia el estado (Propuesta de horario)', (await statusOf('S3-rechazo-horario')) === 'Propuesta de horario');
    await reload();
    check('14c. Tras recargar sigue Propuesta de horario (no Pendiente)', (await statusOf('S3-rechazo-horario')) === 'Propuesta de horario');
    // Escape y clic en el fondo también son "cancelar"
    await card('S3-rechazo-horario').locator('[data-action="reject-proposal"]').click();
    await page.keyboard.press('Escape');
    check('14d. Escape cierra el modal sin cambiar el estado', await page.locator('#confirmModal.active').count() === 0 && (await statusOf('S3-rechazo-horario')) === 'Propuesta de horario');
    await card('S3-rechazo-horario').locator('[data-action="reject-proposal"]').click();
    await page.mouse.click(5, 5);
    check('14d. Clic en el fondo cierra el modal sin cambiar el estado', await page.locator('#confirmModal.active').count() === 0 && (await statusOf('S3-rechazo-horario')) === 'Propuesta de horario');

    await card('S3-rechazo-horario').locator('[data-action="reject-proposal"]').click();
    await acceptConfirm();
    check('12/13. Estudiante rechaza propuesta → Rechazada', (await statusOf('S3-rechazo-horario')) === 'Rechazada');
    await reload();
    check('B. Tras recargar sigue Rechazada', (await statusOf('S3-rechazo-horario')) === 'Rechazada');
    const s3 = await storedRequest('S3-rechazo-horario');
    check('B. No se reabrió: sin propuesta activa y mismo tutor', s3.proposedDate === null && s3.tutorName === 'Tutor Beta');
    check('B. No se generó búsqueda automática de otro tutor', s3.status === 'Rechazada' && (s3.history || []).every(e => e.type !== 'tutor_reassigned' && e.type !== 'no_more_tutors'));
    check('B. No ofrece "Buscar otro tutor" tras rechazar un horario', !(await btnTexts('S3-rechazo-horario')).includes('Buscar otro tutor'));
    check('B. Mensaje de rechazo de horario visible', (await card('S3-rechazo-horario').locator('.request-notice').first().innerText()).includes('Rechazaste el horario'));

    // ================= PRUEBA 4: Historial =================
    section('PRUEBA 4. Historial compacto (estudiante)');
    const hS1 = await historyData('S1-rechazo-tutor');
    checkCompactHistory('Estudiante · reasignación', hS1, ['Solicitud creada', 'Solicitud rechazada', 'Tutor reasignado', 'Solicitud aceptada']);
    check('Estudiante · reasignación: detalle "Tutor Alfa rechazó la solicitud"', hS1.items[1].detail === 'Tutor Alfa rechazó la solicitud');
    check('Estudiante · reasignación: detalle "Nuevo tutor: Tutor Beta"', hS1.items[2].detail === 'Nuevo tutor: Tutor Beta');
    check('Estudiante · cabecera: materia, estado actual y el tutor', hS1.title === 'Cálculo Diferencial' && hS1.status === 'Aceptada' && hS1.meta === 'Tutor: Tutor Beta');
    check('Estudiante · no repite datos de la tarjeta (tema, correo, estudiante)', !hS1.text.includes('S1-rechazo-tutor') && !hS1.text.includes('Estudiante:'));

    const hS2 = await historyData('S2-sin-tutores');
    checkCompactHistory('Estudiante · cancelada', hS2, ['Solicitud creada', 'Solicitud rechazada', 'Solicitud cancelada']);
    check('Estudiante · cancelada: registra que el tutor rechazó', hS2.items[1].detail === 'Tutor Gamma rechazó la solicitud');
    check('Estudiante · cancelada: registra que no había otros tutores', hS2.items[2].detail === 'No había otros tutores disponibles para esta materia');
    check('Estudiante · cancelada: cabecera con estado Cancelada', hS2.title === 'Física Mecánica' && hS2.status === 'Cancelada');
    check('Estudiante · cancelada: NO menciona rechazo de horario', !hS2.text.includes('horario'));

    const hS3 = await historyData('S3-rechazo-horario');
    checkCompactHistory('Estudiante · horario rechazado', hS3, ['Solicitud creada', 'Horario propuesto', 'Solicitud rechazada']);
    check('Estudiante · horario rechazado: dice que RECHAZÓ EL ESTUDIANTE el horario', hS3.items[2].detail.startsWith('El estudiante rechazó el horario propuesto'));
    check('Estudiante · horario rechazado: NO dice que el tutor rechazó la solicitud', !hS3.text.includes('rechazó la solicitud'));

    section('PRUEBA 4. Historial compacto (tutor)');
    await logout();
    await login('beta@test.co');
    const hT1 = await historyData('S1-rechazo-tutor');
    checkCompactHistory('Tutor · reasignación', hT1, ['Solicitud creada', 'Solicitud rechazada', 'Tutor reasignado', 'Solicitud aceptada']);
    check('Tutor · cabecera: materia, estado actual y el estudiante', hT1.title === 'Cálculo Diferencial' && hT1.status === 'Aceptada' && hT1.meta === 'Estudiante: Ana Estudiante');
    check('Tutor · misma estructura visual que el estudiante (mismo ancho y mismos eventos)', hT1.width === hS1.width && JSON.stringify(hT1.items.map(i => [i.title, i.detail])) === JSON.stringify(hS1.items.map(i => [i.title, i.detail])));
    const hT3 = await historyData('S3-rechazo-horario');
    checkCompactHistory('Tutor · horario rechazado', hT3, ['Solicitud creada', 'Horario propuesto', 'Solicitud rechazada']);
    await logout();
    await login('gamma@test.co');
    const hT2 = await historyData('S2-sin-tutores');
    checkCompactHistory('Tutor (rechazó) · cancelada', hT2, ['Solicitud creada', 'Solicitud rechazada', 'Solicitud cancelada']);
    check('Tutor (rechazó) · cabecera con estado Cancelada y el estudiante', hT2.status === 'Cancelada' && hT2.meta === 'Estudiante: Ana Estudiante');
    await logout();
    await login('ana@test.co');

    // ================= Estados finales globales tras recarga =================
    section('15. Recarga conserva todos los estados');
    await reload();
    check('S1 Aceptada · S2 Cancelada · S3 Rechazada',
        (await statusOf('S1-rechazo-tutor')) === 'Aceptada' && (await statusOf('S2-sin-tutores')) === 'Cancelada' && (await statusOf('S3-rechazo-horario')) === 'Rechazada');
    const all = await store('edumatch_requests');
    check('Ninguna solicitud quedó Pendiente sin tutor (abierta)', all.every(r => r.status !== 'Pendiente' || r.tutorId != null));
    check('Ningún rechazo de tutor quedó como "Rechazada" esperando acción manual', all.every(r => !(r.status === 'Rechazada' && r.rejectionSource !== 'schedule')));

    // ================= Varias rondas =================
    section('Extra: varias rondas encadenan a los tutores restantes y cancelan al agotarse');
    await logout();
    await register('Tutor', 'Tutor Delta', 'delta@test.co', ['Cálculo Diferencial']);
    await logout();
    const delta = (await store('edumatch_users')).find(u => u.email === 'delta@test.co');
    await login('ana@test.co');
    await requestTutor('Cálculo Diferencial', 'Tutor Alfa', 'S4-rondas');
    await logout();
    await login('alfa@test.co');
    await card('S4-rondas').locator('[data-action="reject-request"]').click(); await acceptConfirm();
    let s4 = await storedRequest('S4-rondas');
    check('Ronda 1: Alfa rechaza → pasa a Tutor Beta (Alfa excluido)', s4.tutorId === beta.id && s4.status === 'Pendiente' && JSON.stringify(s4.rejectedTutorIds) === JSON.stringify([alfa.id]));
    await logout();
    await login('beta@test.co');
    await card('S4-rondas').locator('[data-action="reject-request"]').click(); await acceptConfirm();
    s4 = await storedRequest('S4-rondas');
    check('Ronda 2: Beta rechaza → pasa a Tutor Delta (Alfa y Beta excluidos)', s4.tutorId === delta.id && s4.status === 'Pendiente' && JSON.stringify(s4.rejectedTutorIds) === JSON.stringify([alfa.id, beta.id]));
    await logout();
    await login('delta@test.co');
    await card('S4-rondas').locator('[data-action="reject-request"]').click(); await acceptConfirm();
    s4 = await storedRequest('S4-rondas');
    check('Ronda 3: Delta rechaza → no queda nadie → Cancelada', s4.status === 'Cancelada' && s4.cancellationReason === 'no_tutors' && s4.rejectedTutorIds.length === 3);
    check('Bitácora de 3 rondas sin duplicados', JSON.stringify(s4.history.map(e => e.type)) === '["created","tutor_rejected","tutor_reassigned","tutor_rejected","tutor_reassigned","tutor_rejected","no_more_tutors"]', JSON.stringify(s4.history.map(e => e.type)));
    await logout();
    await login('ana@test.co');
    const h4 = await historyData('S4-rondas');
    check('Historial de 3 rondas: 7 eventos, compacto y alineado', h4.items.length === 7 && new Set(h4.items.map(i => i.dateRight)).size === 1 && h4.buttons === 0);

    // ================= 16. Uniformidad visual =================
    section('16. Tarjetas uniformes (modo estudiante y tutor)');
    // Más solicitudes para variar contenido/estados/cantidad de botones
    await logout();
    await register('Tutor', 'Tutor Épsilon', 'epsilon@test.co', ['Programación Orientada a Objetos']);
    await logout();
    await login('ana@test.co');
    await requestTutor('Cálculo Diferencial', 'Tutor Beta', 'V1-pendiente corto');
    await requestTutor('Álgebra Lineal', 'Tutor Alfa', 'V2-pendiente con un tema muy largo '.repeat(6));
    await requestTutor('Álgebra Lineal', 'Tutor Beta', 'V3-para propuesta');
    await requestTutor('Física Mecánica', 'Tutor Gamma', 'V4-rechazo tutor');
    await requestTutor('Programación Orientada a Objetos', null, 'V5-titulo largo sin tutor');
    await logout();
    await login('gamma@test.co');
    await card('V4-rechazo tutor').locator('[data-action="reject-request"]').click(); await acceptConfirm();
    await logout();
    await login('beta@test.co');
    const v3id = (await storedRequest('V3-para propuesta')).id;
    await card('V3-para propuesta').locator('[data-action="toggle-propose"]').click();
    await page.fill(`#proposeDate-${v3id}`, iso); await page.fill(`#proposeTime-${v3id}`, '10:00');
    await card('V3-para propuesta').locator('[data-action="submit-propose"]').click();
    await logout();

    async function measure(label) {
        const data = await page.evaluate(() => {
            const cards = [...document.querySelectorAll('.request-card')].map(c => {
                const r = c.getBoundingClientRect();
                const actions = c.querySelector('.request-actions');
                const buttons = actions ? [...actions.querySelectorAll(':scope > button')].map(b => { const br = b.getBoundingClientRect(); return { h: Math.round(br.height), w: Math.round(br.width), bottom: Math.round(br.bottom) }; }) : [];
                const ab = actions ? actions.getBoundingClientRect().bottom : null;
                const rel = sel => { const e = c.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().top - r.top) : null; };
                const metaH = Math.round(c.querySelector('.request-meta').getBoundingClientRect().height);
                const datesH = Math.round(c.querySelector('.request-dates').getBoundingClientRect().height);
                const overflow = [...c.querySelectorAll('*')].some(e => e.getBoundingClientRect().right > r.right + 0.5);
                return { overflow, metaH, datesH, detailsOffset: rel('.request-details'), infoOffset: rel('.request-info'), headerH: Math.round(c.querySelector('.request-card-header').getBoundingClientRect().height),
                    lineHs: [...c.querySelectorAll('.request-line')].map(l => Math.round(l.getBoundingClientRect().height)).join(','),
                    top: Math.round(r.top + scrollY), height: Math.round(r.height), bottom: Math.round(r.bottom), actionsGap: ab == null ? null : Math.round(r.bottom - ab), buttons, status: c.dataset.status };
            });
            return cards;
        });
        const withButtons = data.filter(c => c.buttons.length);
        const allHeights = new Set(withButtons.flatMap(c => c.buttons.map(b => b.h)));
        check(`${label}: todos los botones miden lo mismo de alto (${[...allHeights].join(',')}px)`, allHeights.size === 1);
        check(`${label}: distancia botones→borde inferior idéntica en todas las tarjetas`, new Set(withButtons.map(c => c.actionsGap)).size === 1, JSON.stringify(withButtons.map(c => c.actionsGap)));
        check(`${label}: nada se sale del borde de la tarjeta`, data.every(c => !c.overflow));
        check(`${label}: el encabezado mide igual en todas (título de 1 línea)`, new Set(data.map(c => c.headerH)).size === 1, JSON.stringify(data.map(c => c.headerH)));
        check(`${label}: las 4 líneas de datos empiezan a la misma altura en todas las tarjetas`, new Set(data.map(c => c.detailsOffset)).size === 1, JSON.stringify(data.map(c => c.detailsOffset)));
        check(`${label}: cada línea de datos mide igual (sin saltos de línea)`, new Set(data.map(c => c.lineHs)).size === 1, JSON.stringify(data.map(c => c.lineHs)));
        check(`${label}: la zona de aviso empieza a la misma altura en todas`, new Set(data.map(c => c.infoOffset)).size === 1, JSON.stringify(data.map(c => c.infoOffset)));
        check(`${label}: el pie (fechas + "Ver historial") mide igual en todas las tarjetas`, new Set(data.map(c => c.metaH)).size === 1, JSON.stringify(data.map(c => c.metaH)));
        check(`${label}: la fila de fechas es de una sola línea en todas`, new Set(data.map(c => c.datesH)).size === 1, JSON.stringify(data.map(c => c.datesH)));
        const rows = {};
        data.forEach(c => { (rows[c.top] = rows[c.top] || []).push(c); });
        const rowsOk = Object.values(rows).every(r => new Set(r.map(c => c.height)).size === 1);
        check(`${label}: tarjetas de una misma fila tienen la misma altura`, rowsOk, JSON.stringify(rows));
        const bottomsOk = Object.values(rows).every(r => new Set(r.filter(c => c.buttons.length).map(c => c.buttons[c.buttons.length - 1].bottom)).size <= 1);
        check(`${label}: el último botón queda a la misma altura dentro de cada fila`, bottomsOk);
        return data;
    }

    await login('ana@test.co');
    const studentData = await measure('Estudiante');
    const statuses = new Set(studentData.map(c => c.status));
    check('Estudiante: incluye tarjeta con título largo (sin preferencia → tutor asignado solo)', (await card('V5-titulo largo').locator('h3').textContent()).includes('Programación Orientada a Objetos'));
    check(`Estudiante: se comparan estados variados (${[...statuses].join(', ')})`, statuses.size >= 4);
    await page.evaluate(() => { document.getElementById('toastContainer').innerHTML = ''; });
    await page.screenshot({ path: path.join(__dirname, 'screenshot-estudiante.png'), fullPage: true });
    await logout();
    await login('beta@test.co');
    const tutorData = await measure('Tutor');
    await page.evaluate(() => { document.getElementById('toastContainer').innerHTML = ''; });
    await page.screenshot({ path: path.join(__dirname, 'screenshot-tutor.png'), fullPage: true });
    await logout();

    // ================= Migración de datos antiguos =================
    section('Migración: datos guardados por versiones anteriores (rechazo manual / "Solicitud abierta")');
    await page.evaluate(({ alfaId, gammaId }) => {
        const reqs = JSON.parse(localStorage.getItem('edumatch_requests'));
        const base = { studentId: reqs[0].studentId, studentName: 'Ana Estudiante', preferredDate: null, preferredTime: null, rating: null, ratingComment: null,
            proposedDate: null, proposedTime: null, proposedMessage: null, createdAt: '2026-01-01 10:00', respondedAt: null, completedAt: null };
        // v2: Pendiente sin tutor con el rechazo ya registrado (mostraba "Solicitud abierta")
        reqs.push({ ...base, id: 999001, subject: 'Cálculo Diferencial', tutorId: null, tutorName: null, topic: 'LEGACY-ABIERTA', status: 'Pendiente',
            rejectedTutorIds: [alfaId], rejectionSource: 'tutor', openForReassignment: true });
        // v3: Rechazada por el tutor, esperando el botón "Buscar otro tutor"; materia sin otros tutores
        reqs.push({ ...base, id: 999002, subject: 'Física Mecánica', tutorId: gammaId, tutorName: 'Tutor Gamma', topic: 'LEGACY-RECHAZADA', status: 'Rechazada',
            rejectedTutorIds: [gammaId], rejectionSource: 'tutor', openForReassignment: false, respondedAt: '2026-01-01 11:00' });
        // Nació "sin preferencia" (o su tutor eliminó el perfil): Pendiente sin tutor, con y sin tutores para la materia
        reqs.push({ ...base, id: 999003, subject: 'Cálculo Diferencial', tutorId: null, tutorName: null, topic: 'LEGACY-SINTUTOR', status: 'Pendiente',
            rejectedTutorIds: [], rejectionSource: null, openForReassignment: false });
        reqs.push({ ...base, id: 999004, subject: 'Bases de Datos', tutorId: null, tutorName: null, topic: 'LEGACY-VACIA', status: 'Pendiente',
            rejectedTutorIds: [], rejectionSource: null, openForReassignment: false });
        // "Tutor retirado" (dejó de ofrecer la materia): flujo con selector del estudiante, NO se toca
        reqs.push({ ...base, id: 999005, subject: 'Cálculo Diferencial', tutorId: null, tutorName: null, topic: 'LEGACY-RETIRADO', status: 'Pendiente',
            rejectedTutorIds: [], rejectionSource: null, openForReassignment: true });
        localStorage.setItem('edumatch_requests', JSON.stringify(reqs));
    }, { alfaId: alfa.id, gammaId: gamma.id });
    await reload();
    await login('ana@test.co');
    const legA = await storedRequest('LEGACY-ABIERTA');
    check('"Abierta" heredada: se resuelve sola → asignada a un tutor elegible (no a Alfa)', legA.status === 'Pendiente' && legA.tutorId != null && legA.tutorId !== alfa.id && legA.openForReassignment === false);
    check('"Abierta" heredada: ya no muestra "Solicitud abierta" ni botón manual', noOpenText(await card('LEGACY-ABIERTA').innerText()));
    check('"Abierta" heredada: su historial queda con rechazo + reasignación', JSON.stringify(legA.history.map(e => e.type)) === '["created","tutor_rejected","tutor_reassigned"]', JSON.stringify(legA.history.map(e => e.type)));
    const legR = await storedRequest('LEGACY-RECHAZADA');
    check('"Rechazada" heredada sin otros tutores → Cancelada', legR.status === 'Cancelada' && legR.cancellationReason === 'no_tutors');
    check('"Rechazada" heredada: muestra cancelada y no el botón manual', (await statusOf('LEGACY-RECHAZADA')) === 'Cancelada' && noOpenText(await card('LEGACY-RECHAZADA').innerText()));
    check('"Rechazada" heredada: historial sin duplicar el rechazo', legR.history.filter(e => e.type === 'tutor_rejected').length === 1);
    const legS = await storedRequest('LEGACY-SINTUTOR');
    check('Pendiente sin tutor heredada → asignada a un tutor de la materia', legS.status === 'Pendiente' && legS.tutorId === alfa.id && JSON.stringify(legS.history.map(e => e.type)) === '["created","tutor_assigned"]', JSON.stringify(legS));
    check('…y ya no dice "Solicitud abierta"', noOpenText(await card('LEGACY-SINTUTOR').innerText()));
    const legV = await storedRequest('LEGACY-VACIA');
    check('Pendiente sin tutor heredada y sin tutores de la materia → Cancelada', legV.status === 'Cancelada' && legV.cancellationReason === 'no_tutors');
    const legT = await storedRequest('LEGACY-RETIRADO');
    check('"Tutor retirado" (selector manual del estudiante) NO se toca', legT.status === 'Pendiente' && legT.tutorId === null && legT.openForReassignment === true);
    const before = JSON.stringify(await store('edumatch_requests'));
    await reload();
    check('La migración es idempotente (otra recarga no cambia nada)', JSON.stringify(await store('edumatch_requests')) === before);

    // ================= PRUEBA 5: "Sin preferencia" =================
    section('PRUEBA 5. "Sin preferencia": se asigna un tutor automáticamente al crear');
    // Duplicado: V2 ya es una solicitud Pendiente de Álgebra con Tutor Alfa, que es justo a quien se autoasignaría
    const beforeDup = (await store('edumatch_requests')).length;
    await page.click('.nav-btn[data-tab="request"]');
    await page.selectOption('#selectSubject', 'Álgebra Lineal');
    await page.fill('#preferredTime', '10:00');
    await page.fill('#requestTopic', 'N0-duplicada');
    await page.click('#tutorRequestForm button[type="submit"]');
    check('El tutor autoasignado cuenta para el control de duplicados (no se crea otra igual)', (await lastToast()).includes('solicitud pendiente equivalente') && (await store('edumatch_requests')).length === beforeDup, await lastToast());
    await goHistory();

    await requestTutor('Física Mecánica', null, 'N1-sin-preferencia');
    check('Toast: registrada y asignada automáticamente a Tutor Gamma (único tutor de la materia)', (await lastToast()).includes('asignada automáticamente a Tutor Gamma'), await lastToast());
    let n1 = await storedRequest('N1-sin-preferencia');
    check('Storage: Pendiente con Tutor Gamma (no queda sin tutor)', n1.status === 'Pendiente' && n1.tutorId === gamma.id && n1.tutorName === 'Tutor Gamma');
    check('Bitácora: creada → tutor asignado', JSON.stringify(n1.history.map(e => e.type)) === '["created","tutor_assigned"]', JSON.stringify(n1.history.map(e => e.type)));
    const n1Text = await card('N1-sin-preferencia').innerText();
    check('Estudiante ve al tutor asignado y NO ve "Solicitud abierta"', n1Text.includes('Tutor: Tutor Gamma') && noOpenText(n1Text) && n1Text.includes('Esperando la respuesta de Tutor Gamma'));
    const hN1 = await historyData('N1-sin-preferencia');
    check('Historial: "Tutor asignado · Asignado automáticamente: Tutor Gamma"', JSON.stringify(hN1.items.map(i => [i.title, i.detail])) === JSON.stringify([['Solicitud creada', ''], ['Tutor asignado', 'Asignado automáticamente: Tutor Gamma']]), JSON.stringify(hN1.items));
    await reload();
    check('Tras recargar sigue asignada a Tutor Gamma', (await card('N1-sin-preferencia').innerText()).includes('Tutor: Tutor Gamma'));
    await logout();
    await login('gamma@test.co');
    check('Tutor Gamma ve la solicitud y puede Aceptar / Rechazar / Proponer', (await statusOf('N1-sin-preferencia')) === 'Pendiente' && JSON.stringify(await btnTexts('N1-sin-preferencia')) === JSON.stringify(['Aceptar', 'Rechazar', 'Proponer otro horario']));
    await card('N1-sin-preferencia').locator('[data-action="reject-request"]').click(); await acceptConfirm();
    n1 = await storedRequest('N1-sin-preferencia');
    check('Si ese tutor rechaza, aplica la regla de siempre (no hay otro → Cancelada)', n1.status === 'Cancelada' && n1.rejectedTutorIds.includes(gamma.id));
    await logout();

    section('PRUEBA 5b. "Sin preferencia" y ningún tutor para la materia → no se crea la solicitud');
    await login('ana@test.co');
    const beforeN2 = (await store('edumatch_requests')).length;
    await page.click('.nav-btn[data-tab="request"]');
    await page.selectOption('#selectSubject', 'Bases de Datos');
    check('El formulario avisa que no hay tutores para la materia', (await page.locator('#tutorAvailabilityHint').innerText()).includes('No hay tutores disponibles'));
    await page.fill('#preferredTime', '10:00');
    await page.fill('#requestTopic', 'N2-sin-tutores');
    await page.click('#tutorRequestForm button[type="submit"]');
    check('Toast: "Actualmente no hay tutores disponibles para esta materia."', (await lastToast()) === 'Actualmente no hay tutores disponibles para esta materia.', await lastToast());
    check('No se crea ninguna solicitud (ni abierta ni cancelada)', (await store('edumatch_requests')).length === beforeN2 && !(await store('edumatch_requests')).some(r => r.topic === 'N2-sin-tutores'));
    check('El estudiante se queda en el formulario', await page.locator('#request-tab.active').count() === 1);
    await goHistory();

    // ================= PRUEBA 6: el tutor elimina su perfil =================
    section('PRUEBA 6. Tutor elimina su perfil → sus solicitudes se reasignan o se cancelan');
    await logout();
    await register('Tutor', 'Tutor Omega', 'omega@test.co', ['Cálculo Diferencial', 'Álgebra Lineal', 'Estructuras de Datos']);
    await logout();
    const omega = (await store('edumatch_users')).find(u => u.email === 'omega@test.co');
    await login('ana@test.co');
    await requestTutor('Cálculo Diferencial', 'Tutor Omega', 'D1-pendiente');
    await requestTutor('Álgebra Lineal', 'Tutor Omega', 'D2-aceptada');
    await requestTutor('Estructuras de Datos', 'Tutor Omega', 'D3-propuesta');
    await logout();
    await login('omega@test.co');
    await card('D2-aceptada').locator('[data-action="accept-request"]').click();
    const d3id = (await storedRequest('D3-propuesta')).id;
    await card('D3-propuesta').locator('[data-action="toggle-propose"]').click();
    await page.fill(`#proposeDate-${d3id}`, iso); await page.fill(`#proposeTime-${d3id}`, '09:00');
    await card('D3-propuesta').locator('[data-action="submit-propose"]').click();
    check('Preparación: D1 Pendiente, D2 Aceptada, D3 Propuesta de horario, todas de Omega',
        (await statusOf('D1-pendiente')) === 'Pendiente' && (await statusOf('D2-aceptada')) === 'Aceptada' && (await statusOf('D3-propuesta')) === 'Propuesta de horario');

    await page.click('.nav-btn[data-tab="tutors"]');
    await page.locator('[data-action="delete-tutor"]').click();
    await page.locator('.toast-action').click(); // Deshacer
    const afterUndo = await store('edumatch_requests');
    check('"Deshacer" cancela la eliminación: nada cambia', afterUndo.filter(r => /^D\d/.test(r.topic || '')).every(r => r.tutorId === omega.id) && (await store('edumatch_users')).some(u => u.id === omega.id));

    await page.locator('[data-action="delete-tutor"]').click();
    await page.waitForSelector('#authButton', { state: 'visible', timeout: 12000 }); // vence el margen de Deshacer → se elimina y se cierra sesión
    check('El perfil de Omega ya no existe', !(await store('edumatch_users')).some(u => u.id === omega.id));
    const d1 = await storedRequest('D1-pendiente'), d2 = await storedRequest('D2-aceptada'), d3 = await storedRequest('D3-propuesta');
    check('D1 (Pendiente) → reasignada al primer tutor de Cálculo (Alfa), Pendiente de su respuesta', d1.status === 'Pendiente' && d1.tutorId === alfa.id);
    check('D2 (Aceptada) → reasignada a Alfa y vuelve a Pendiente (el tutor nuevo debe confirmar)', d2.status === 'Pendiente' && d2.tutorId === alfa.id);
    check('D3 (Propuesta) sin otro tutor de la materia → Cancelada, propuesta descartada', d3.status === 'Cancelada' && d3.cancellationReason === 'no_tutors' && d3.proposedDate === null && d3.proposedTime === null && d3.tutorId === null);
    check('Ninguna solicitud apunta ya a Omega ni queda Pendiente sin tutor', (await store('edumatch_requests')).every(r => r.tutorId !== omega.id && (r.status !== 'Pendiente' || r.tutorId != null || r.openForReassignment)));
    check('Bitácora D1: creada → tutor no disponible → reasignada', JSON.stringify(d1.history.map(e => e.type)) === '["created","tutor_removed","tutor_reassigned"]', JSON.stringify(d1.history.map(e => e.type)));
    check('Bitácora D3: … tutor no disponible → cancelada', JSON.stringify(d3.history.map(e => e.type)) === '["created","schedule_proposed","tutor_removed","no_more_tutors"]', JSON.stringify(d3.history.map(e => e.type)));

    await login('ana@test.co');
    const d1Text = await card('D1-pendiente').innerText();
    check('Estudiante ve el nuevo tutor y por qué (no dice "rechazó")', d1Text.includes('Nuevo tutor asignado: Tutor Alfa') && d1Text.includes('Tutor Omega ya no está disponible') && !d1Text.includes('rechazó') && noOpenText(d1Text));
    check('Estudiante: D2 vuelve a Pendiente con Alfa', (await statusOf('D2-aceptada')) === 'Pendiente' && (await card('D2-aceptada').innerText()).includes('Tutor: Tutor Alfa'));
    const d3Text = await card('D3-propuesta').innerText();
    check('Estudiante: D3 Cancelada con el mensaje de que no hay tutores', (await statusOf('D3-propuesta')) === 'Cancelada' && d3Text.includes(NO_MORE) && noOpenText(d3Text) && !d3Text.includes('propone'));
    const hD1 = await historyData('D1-pendiente');
    checkCompactHistory('Historial D1', hD1, ['Solicitud creada', 'Tutor no disponible', 'Tutor reasignado']);
    check('Historial D1: "Tutor Omega eliminó su perfil de tutor" y "Nuevo tutor: Tutor Alfa"', hD1.items[1].detail === 'Tutor Omega eliminó su perfil de tutor' && hD1.items[2].detail === 'Nuevo tutor: Tutor Alfa');
    await reload();
    check('Tras recargar se conservan D1/D2 Pendiente con Alfa y D3 Cancelada', (await statusOf('D1-pendiente')) === 'Pendiente' && (await statusOf('D2-aceptada')) === 'Pendiente' && (await statusOf('D3-propuesta')) === 'Cancelada');
    await logout();
    await login('alfa@test.co');
    check('Tutor Alfa ve D1 y D2 con Aceptar / Rechazar / Proponer', JSON.stringify(await btnTexts('D1-pendiente')) === JSON.stringify(['Aceptar', 'Rechazar', 'Proponer otro horario']) && (await card('D2-aceptada').innerText()).includes('te fue asignada automáticamente porque Tutor Omega ya no está disponible'));
    await logout();

    // "Eliminar del historial" ahora se guarda al instante (ya no hay que esperar
    // los 6 s del "Deshacer"); este helper solo comprueba que así sea.
    async function forceHideFromHistory(id) {
        const cu = await store('edumatch_current_user');
        const r = (await store('edumatch_requests')).find(x => x.id === id);
        check('Storage: la eliminación del historial se guardó al instante (sin esperar el "Deshacer")', !!r && Array.isArray(r.hiddenFor) && r.hiddenFor.includes(cu.id));
    }

    // ================= PRUEBA 7: tutor retira UNA materia (no todo el perfil) =================
    section('PRUEBA 7. Tutor retira una materia de su perfil (sin eliminarlo) → reasignación automática');
    await register('Tutor', 'Tutor Zeta', 'zeta@test.co', ['Bases de Datos']);
    await logout();
    await register('Tutor', 'Tutor Eta', 'eta@test.co', ['Bases de Datos']);
    await logout();
    const zeta = (await store('edumatch_users')).find(u => u.email === 'zeta@test.co');
    const eta = (await store('edumatch_users')).find(u => u.email === 'eta@test.co');

    await login('ana@test.co');
    await requestTutor('Bases de Datos', 'Tutor Zeta', 'R1-materia-retirada');
    check('R1 creada como Pendiente con Tutor Zeta', (await statusOf('R1-materia-retirada')) === 'Pendiente' && (await storedRequest('R1-materia-retirada')).tutorId === zeta.id);
    await logout();

    await login('zeta@test.co');
    check('Zeta ve Aceptar/Rechazar/Proponer antes de retirar la materia', JSON.stringify(await btnTexts('R1-materia-retirada')) === JSON.stringify(['Aceptar', 'Rechazar', 'Proponer otro horario']));
    await page.click('.nav-btn[data-tab="tutors"]');
    await page.locator('.tutor-card', { hasText: 'Tutor Zeta' }).locator('[data-action="remove-tutor-subject"][data-subject="Bases de Datos"]').click();
    check('Toast: materia eliminada de su perfil', (await lastToast()) === 'Materia eliminada de tu perfil.', await lastToast());
    await goHistory();
    check('Zeta ya no ve la solicitud (se reasignó automáticamente a otro tutor)', await card('R1-materia-retirada').count() === 0);
    let r1 = await storedRequest('R1-materia-retirada');
    check('Storage: reasignada automáticamente a Tutor Eta, Pendiente de su respuesta', r1.status === 'Pendiente' && r1.tutorId === eta.id && r1.tutorName === 'Tutor Eta');
    check('Bitácora sin duplicados: creada → tutor no disponible → reasignada', JSON.stringify(r1.history.map(e => e.type)) === '["created","tutor_removed","tutor_reassigned"]', JSON.stringify(r1.history.map(e => e.type)));
    await logout();

    await login('ana@test.co');
    const r1Text = await card('R1-materia-retirada').innerText();
    check('Estudiante ve el nuevo tutor y el motivo correcto (no "rechazó")', r1Text.includes('Nuevo tutor asignado: Tutor Eta') && r1Text.includes('Tutor Zeta ya no está disponible') && !r1Text.includes('rechazó'));
    check('NO aparece ningún selector manual ni "Solicitud abierta"', noOpenText(r1Text) && await card('R1-materia-retirada').locator('select').count() === 0);
    check('No hay botón "Elegir otro tutor" / "Elegir este tutor" (selector manual eliminado de este flujo)', !(await btnTexts('R1-materia-retirada')).some(t => /elegir/i.test(t)));
    const hR1 = await historyData('R1-materia-retirada');
    check('Historial: motivo correcto "Tutor Zeta dejó de ofrecer esta materia" (no "eliminó su perfil")', hR1.items[1].detail === 'Tutor Zeta dejó de ofrecer esta materia', JSON.stringify(hR1.items));
    await reload();
    check('Caso A de recarga: sigue asignada correctamente a Tutor Eta', (await statusOf('R1-materia-retirada')) === 'Pendiente' && (await storedRequest('R1-materia-retirada')).tutorId === eta.id);
    await logout();

    // ================= PRUEBA 8: tutor retira una materia y no queda ningún reemplazo =================
    section('PRUEBA 8. Tutor retira una materia sin que quede ningún otro tutor disponible → Cancelada');
    await register('Tutor', 'Tutor Theta', 'theta@test.co', ['Estructuras de Datos']);
    await logout();

    await login('ana@test.co');
    await requestTutor('Estructuras de Datos', 'Tutor Theta', 'R2-sin-reemplazo');
    await logout();

    await login('theta@test.co');
    await page.click('.nav-btn[data-tab="tutors"]');
    await page.locator('.tutor-card', { hasText: 'Tutor Theta' }).locator('[data-action="remove-tutor-subject"][data-subject="Estructuras de Datos"]').click();
    await goHistory();
    let r2 = await storedRequest('R2-sin-reemplazo');
    check('Storage: Cancelada / no_tutors, sin tutor asignado', r2.status === 'Cancelada' && r2.cancellationReason === 'no_tutors' && r2.tutorId === null);
    check('Bitácora sin duplicados: creada → tutor no disponible → cancelada', JSON.stringify(r2.history.map(e => e.type)) === '["created","tutor_removed","no_more_tutors"]', JSON.stringify(r2.history.map(e => e.type)));
    await logout();

    await login('ana@test.co');
    const r2Text = await card('R2-sin-reemplazo').innerText();
    check('Caso B: estudiante ve "Cancelada" con el mensaje de no disponibilidad', (await statusOf('R2-sin-reemplazo')) === 'Cancelada' && r2Text.includes(NO_MORE));
    check('No queda Pendiente / Abierta / esperando selección manual', noOpenText(r2Text) && !/Pendiente|esperando selecci/i.test(r2Text));
    await reload();
    check('Caso B de recarga: sigue Cancelada (no vuelve a Pendiente/Abierta)', (await statusOf('R2-sin-reemplazo')) === 'Cancelada');
    await logout();

    // ================= PRUEBA 9: "Eliminar del historial" en una Completada =================
    section('PRUEBA 9. "Eliminar del historial" (Completada): por usuario, nunca borra globalmente');
    await login('ana@test.co');
    await requestTutor('Álgebra Lineal', 'Tutor Beta', 'R3-completada');
    await logout();
    await login('beta@test.co');
    await card('R3-completada').locator('[data-action="accept-request"]').click();
    await card('R3-completada').locator('[data-action="complete-request"]').click();
    check('R3 marcada como Realizada por el tutor', (await statusOf('R3-completada')) === 'Realizada');
    await logout();

    await login('ana@test.co');
    check('Estudiante ve "Eliminar del historial" en la Completada', (await btnTexts('R3-completada')).includes('Eliminar del historial'));
    const r3id = (await storedRequest('R3-completada')).id;
    await card('R3-completada').locator('[data-action="delete-history"]').click();
    check('Toast: eliminada de SU historial (no dice "eliminada" a secas)', (await lastToast()) === 'Solicitud eliminada de tu historial.', await lastToast());
    check('Desaparece de inmediato de la vista del estudiante', await card('R3-completada').count() === 0);
    await page.locator('.toast-action').click(); // Deshacer
    check('"Deshacer" la trae de vuelta para el estudiante', await card('R3-completada').count() === 1);

    await card('R3-completada').locator('[data-action="delete-history"]').click();
    await forceHideFromHistory(r3id); // vence el margen de "Deshacer"
    check('Sigue oculta para el estudiante tras vencer el margen', await card('R3-completada').count() === 0);
    check('Storage: la solicitud SIGUE existiendo (nunca se borra globalmente)', (await store('edumatch_requests')).some(r => r.id === r3id));
    let r3 = await storedRequest('R3-completada');
    check('Storage: hiddenFor solo contiene al estudiante (no afecta al tutor)', JSON.stringify(r3.hiddenFor) === JSON.stringify([r3.studentId]));
    check('Storage: no se tocó al tutor, la materia ni el estado de la solicitud', r3.tutorId != null && r3.tutorName === 'Tutor Beta' && r3.subject === 'Álgebra Lineal' && r3.status === 'Realizada');
    await reload();
    check('Tras recargar sigue oculta para el estudiante (persistente)', await card('R3-completada').count() === 0);
    await logout();

    await login('beta@test.co');
    check('El tutor SIGUE viendo la Completada en su propio historial (no la afectó el borrado del estudiante)', await card('R3-completada').count() === 1);
    check('El tutor también tiene disponible "Eliminar del historial"', (await btnTexts('R3-completada')).includes('Eliminar del historial'));
    await card('R3-completada').locator('[data-action="delete-history"]').click();
    await forceHideFromHistory(r3id);
    check('El tutor ya no la ve tras eliminarla de SU historial', await card('R3-completada').count() === 0);
    r3 = await storedRequest('R3-completada');
    check('Storage: ahora hiddenFor tiene a ambos usuarios y la solicitud sigue íntegra', r3.hiddenFor.length === 2 && r3.hiddenFor.includes(r3.studentId) && r3.hiddenFor.includes(r3.tutorId) && r3.studentName === 'Ana Estudiante' && r3.tutorName === 'Tutor Beta');
    await reload();
    check('Tras recargar sigue oculta también para el tutor (persistente)', await card('R3-completada').count() === 0);
    await logout();


    // ================= PRUEBA 10: Rechazada → "Eliminar del historial" =================
    section('PRUEBA 10. Solicitud RECHAZADA → "Eliminar del historial" (por usuario, nunca global)');
    await login('ana@test.co');
    await requestTutor('Álgebra Lineal', 'Tutor Beta', 'R4-rechazada');
    await logout();
    await login('beta@test.co');
    const r4id = (await storedRequest('R4-rechazada')).id;
    await card('R4-rechazada').locator('[data-action="toggle-propose"]').click();
    await page.fill(`#proposeDate-${r4id}`, iso); await page.fill(`#proposeTime-${r4id}`, '09:00');
    await card('R4-rechazada').locator('[data-action="submit-propose"]').click();
    await logout();
    await login('ana@test.co');
    await card('R4-rechazada').locator('[data-action="reject-proposal"]').click();
    await acceptConfirm();
    check('R4 quedó Rechazada', (await statusOf('R4-rechazada')) === 'Rechazada');
    check('Estudiante ve "Eliminar del historial" en la Rechazada', JSON.stringify(await btnTexts('R4-rechazada')) === JSON.stringify(['Eliminar del historial']), JSON.stringify(await btnTexts('R4-rechazada')));
    const totalBefore = (await store('edumatch_requests')).length;

    await card('R4-rechazada').locator('[data-action="delete-history"]').click();
    check('Toast: eliminada de SU historial', (await lastToast()) === 'Solicitud eliminada de tu historial.', await lastToast());
    check('Desaparece de inmediato para el estudiante', await card('R4-rechazada').count() === 0);
    await page.locator('.toast-action').click(); // Deshacer
    check('"Deshacer" la trae de vuelta (sigue Rechazada)', await card('R4-rechazada').count() === 1 && (await statusOf('R4-rechazada')) === 'Rechazada');
    check('Storage tras "Deshacer": hiddenFor vacío', ((await storedRequest('R4-rechazada')).hiddenFor || []).length === 0);

    await card('R4-rechazada').locator('[data-action="delete-history"]').click();
    await reload(); // recarga INMEDIATA, sin esperar el margen del "Deshacer"
    check('Tras recargar (inmediatamente) sigue sin aparecer para el estudiante', await card('R4-rechazada').count() === 0);
    let r4 = await storedRequest('R4-rechazada');
    check('Storage: la solicitud SIGUE existiendo y NO se borró globalmente', !!r4 && (await store('edumatch_requests')).length === totalBefore);
    check('Storage: sigue Rechazada (no Cancelada ni Pendiente), mismo tutor y estudiante', r4.status === 'Rechazada' && r4.tutorName === 'Tutor Beta' && r4.studentName === 'Ana Estudiante' && r4.tutorId != null);
    check('Storage: hiddenFor solo contiene al estudiante', JSON.stringify(r4.hiddenFor) === JSON.stringify([r4.studentId]));
    check('Storage: el historial de eventos no se tocó', r4.history.some(e => e.type === 'schedule_rejected'));
    await logout();

    await login('beta@test.co');
    check('PRUEBA 9b. El Tutor SIGUE viendo la Rechazada (no la afectó el borrado del estudiante)', await card('R4-rechazada').count() === 1 && (await statusOf('R4-rechazada')) === 'Rechazada');
    check('El Tutor tiene "Eliminar del historial" en la Rechazada', JSON.stringify(await btnTexts('R4-rechazada')) === JSON.stringify(['Eliminar del historial']));
    await card('R4-rechazada').locator('[data-action="delete-history"]').click();
    await reload();
    check('El Tutor deja de verla tras eliminarla de SU historial (y tras recargar)', await card('R4-rechazada').count() === 0);
    r4 = await storedRequest('R4-rechazada');
    check('Storage: hiddenFor tiene a ambos; la solicitud sigue íntegra y Rechazada', r4.hiddenFor.length === 2 && r4.status === 'Rechazada' && r4.tutorName === 'Tutor Beta' && (await store('edumatch_requests')).length === totalBefore);
    await logout();

    // ================= PRUEBA 11: Cancelada → "Eliminar del historial" =================
    section('PRUEBA 11. Solicitud CANCELADA → "Eliminar del historial"; las activas NO lo tienen');
    await login('ana@test.co');
    await requestTutor('Álgebra Lineal', 'Tutor Beta', 'R5-cancelada');
    await requestTutor('Cálculo Diferencial', 'Tutor Delta', 'R6-activa');
    check('Solicitud activa (Pendiente): NO tiene "Eliminar del historial"', !(await btnTexts('R6-activa')).some(t => /Eliminar/i.test(t)), JSON.stringify(await btnTexts('R6-activa')));
    const r6id = (await storedRequest('R6-activa')).id;
    await page.evaluate(id => deleteFromHistory(id), r6id);
    check('Aunque se invoque la función, una solicitud activa no se puede ocultar', !((await storedRequest('R6-activa')).hiddenFor || []).length && (await statusOf('R6-activa')) === 'Pendiente');
    await card('R5-cancelada').locator('[data-action="cancel-request"]').click();
    check('R5 quedó Cancelada', (await statusOf('R5-cancelada')) === 'Cancelada');
    check('Estudiante ve "Eliminar del historial" en la Cancelada', JSON.stringify(await btnTexts('R5-cancelada')) === JSON.stringify(['Eliminar del historial']));
    const totalBefore2 = (await store('edumatch_requests')).length;
    await card('R5-cancelada').locator('[data-action="delete-history"]').click();
    await reload();
    check('Tras recargar la Cancelada sigue sin aparecer para el estudiante', await card('R5-cancelada').count() === 0);
    const r5 = await storedRequest('R5-cancelada');
    check('Storage: existe, sigue Cancelada y el total de solicitudes no cambió', !!r5 && r5.status === 'Cancelada' && (await store('edumatch_requests')).length === totalBefore2);
    check('La solicitud activa R6 no se vio afectada', (await statusOf('R6-activa')) === 'Pendiente');
    await logout();
    await login('beta@test.co');
    check('El Tutor SIGUE viendo la Cancelada del estudiante y puede eliminarla de su historial', await card('R5-cancelada').count() === 1 && (await btnTexts('R5-cancelada')).includes('Eliminar del historial'));
    await card('R5-cancelada').locator('[data-action="delete-history"]').click();
    await reload();
    check('Tutor: la Cancelada desaparece de SU historial tras recargar', await card('R5-cancelada').count() === 0);
    await logout();

    // Cancelada automáticamente (nadie más da la materia): Tutor que rechazó y Estudiante
    await login('ana@test.co');
    check('Cancelada por falta de tutores (S2): el estudiante la ve con "Eliminar del historial"', JSON.stringify(await btnTexts('S2-sin-tutores')) === JSON.stringify(['Eliminar del historial']));
    await card('S2-sin-tutores').locator('[data-action="delete-history"]').click();
    await logout();
    await login('gamma@test.co');
    check('Cancelada por falta de tutores (S2): el tutor que la rechazó SIGUE viéndola', await card('S2-sin-tutores').count() === 1 && (await btnTexts('S2-sin-tutores')).includes('Eliminar del historial'));
    await logout();

    // ================= PRUEBA 12: Tutores disponibles (estructura y uniformidad) =================
    section('PRUEBA 12. Tutores disponibles: tarjetas y botones uniformes, responsive');
    async function measureTutors(label, viewport) {
        await page.setViewportSize(viewport);
        await page.click('.nav-btn[data-tab="tutors"]');
        await page.waitForSelector('#tutorsGrid .tutor-card');
        const d = await page.evaluate(() => {
            const grid = document.getElementById('tutorsGrid');
            const cards = [...grid.querySelectorAll('.tutor-card')].map(c => {
                const r = c.getBoundingClientRect();
                const btn = c.querySelector('.tutor-card__actions .btn-block');
                const br = btn ? btn.getBoundingClientRect() : null;
                const body = c.querySelector('.tutor-card__body').getBoundingClientRect();
                const cs = getComputedStyle(c);
                const tag = sel => { const e = c.querySelector(sel); return e ? e.tagName + '.' + e.className : null; };
                return {
                    own: c.classList.contains('tutor-card--own'), top: Math.round(r.top + scrollY), height: Math.round(r.height), width: Math.round(r.width), right: r.right,
                    btnH: br ? Math.round(br.height) : null, btnFont: btn ? getComputedStyle(btn).fontSize : null, btnGap: br ? Math.round(r.bottom - br.bottom) : null,
                    padding: cs.paddingTop + '/' + cs.paddingLeft,
                    headerH: Math.round(c.querySelector('.tutor-card__header').getBoundingClientRect().height),
                    nameOff: Math.round(c.querySelector('.tutor-card__name').getBoundingClientRect().top - r.top),
                    emailOff: Math.round(c.querySelector('.tutor-card__email').getBoundingClientRect().top - r.top),
                    emailH: Math.round(c.querySelector('.tutor-card__email').getBoundingClientRect().height),
                    structure: [tag('.tutor-card__header'), tag('.tutor-card__email'), tag('.tutor-card__tags')].join('|'),
                    overflow: [...c.querySelectorAll('*')].some(e => e.getBoundingClientRect().right > r.right + 0.5),
                    gridRight: grid.getBoundingClientRect().right
                };
            });
            return { cards, hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
        });
        const regular = d.cards.filter(c => !c.own);
        check(`${label}: hay ${regular.length} tarjetas de tutor con la misma estructura HTML`, regular.length >= 4 && new Set(d.cards.map(c => c.structure)).size === 1);
        check(`${label}: mismo ancho en todas las tarjetas normales`, new Set(regular.map(c => c.width)).size === 1, JSON.stringify(regular.map(c => c.width)));
        check(`${label}: mismo padding en todas`, new Set(regular.map(c => c.padding)).size === 1);
        const rows = {}; regular.forEach(c => { (rows[c.top] = rows[c.top] || []).push(c); });
        check(`${label}: las tarjetas de una misma fila tienen la misma altura`, Object.values(rows).every(r => new Set(r.map(c => c.height)).size === 1), JSON.stringify(rows));
        check(`${label}: nombre/correo empiezan a la misma altura en todas`, new Set(regular.map(c => c.nameOff)).size === 1 && new Set(regular.map(c => c.emailOff)).size === 1);
        check(`${label}: encabezado y correo de una sola línea (mismo alto) aunque el nombre/correo sean largos`, new Set(regular.map(c => c.headerH)).size === 1 && new Set(regular.map(c => c.emailH)).size === 1, JSON.stringify(regular.map(c => [c.headerH, c.emailH])));
        check(`${label}: todos los botones miden lo mismo de alto y de fuente`, new Set(regular.map(c => c.btnH)).size === 1 && new Set(regular.map(c => c.btnFont)).size === 1, JSON.stringify(regular.map(c => [c.btnH, c.btnFont])));
        check(`${label}: el botón queda a la misma distancia del borde inferior en todas (anclado al fondo)`, new Set(regular.map(c => c.btnGap)).size === 1, JSON.stringify(regular.map(c => c.btnGap)));
        check(`${label}: nada se sale de su tarjeta ni de la página`, d.cards.every(c => !c.overflow && c.right <= c.gridRight + 0.5) && !d.hScroll);
        return d;
    }
    // Tutores con contenido MUY desigual: un nombre/correo larguísimos y 6 materias vs. sin materias
    await register('Tutor', 'Tutor con un nombre larguísimo de Apellido Compuesto Segundo', 'correo.extremadamente.largo.de.tutor@universidad-ejemplo.edu.co', ['Cálculo Diferencial', 'Programación Orientada a Objetos', 'Física Mecánica', 'Estructuras de Datos', 'Álgebra Lineal', 'Bases de Datos']);
    await logout();
    await register('Tutor', 'Tutor Sin Materias', 'sinmaterias@test.co', []);
    await logout();
    await login('ana@test.co');
    const dDesk = await measureTutors('Escritorio (estudiante)', { width: 1500, height: 900 });
    check('Escritorio: varias columnas en la cuadrícula (tarjetas en la misma fila)', dDesk.cards.some((c, i) => i > 0 && c.top === dDesk.cards[0].top));
    await page.evaluate(() => { document.getElementById('toastContainer').innerHTML = ''; });
    await page.waitForTimeout(500); // termina la animación de entrada de la pestaña
    await page.screenshot({ path: path.join(__dirname, 'screenshot-tutores-estudiante.png'), fullPage: true });
    await measureTutors('Tablet 800px (estudiante)', { width: 800, height: 900 });
    const dMob = await measureTutors('Móvil 390px (estudiante)', { width: 390, height: 900 });
    check('Móvil: una sola columna, todas del mismo ancho', new Set(dMob.cards.map(c => c.width)).size === 1 && new Set(dMob.cards.map(c => c.top)).size === dMob.cards.length);
    await page.waitForTimeout(500); // termina la animación de entrada de la pestaña
    await page.screenshot({ path: path.join(__dirname, 'screenshot-tutores-movil.png'), fullPage: true });

    // La acción de la tarjeta sigue funcionando: "Solicitar con este tutor"
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.click('.nav-btn[data-tab="tutors"]');
    await page.locator('.tutor-card', { hasText: 'Tutor Beta' }).locator('[data-action="select-tutor"]').click();
    check('"Solicitar con este tutor" lleva al formulario de solicitud', await page.locator('#request-tab.active').count() === 1);
    check('…con Tutor Beta preseleccionado', (await page.inputValue('#selectTutor')) === 'Tutor Beta');
    await logout();

    // Tarjeta del propio tutor: variante ancha con gestión; el resto no se deforma
    await login('alfa@test.co');
    const dOwn = await measureTutors('Escritorio (tutor, con su propia tarjeta)', { width: 1500, height: 900 });
    check('Tutor: su tarjeta va primero, ocupa todo el ancho y trae la gestión de materias', dOwn.cards[0].own && await page.locator('.tutor-card--own .tutor-card__manage').count() === 1 && await page.locator('.tutor-card--own [data-action="delete-tutor"]').count() === 1);
    check('Tutor: su propia tarjeta NO tiene "Solicitar con este tutor"', await page.locator('.tutor-card--own [data-action="select-tutor"]').count() === 0);
    await page.waitForTimeout(500); // termina la animación de entrada de la pestaña
    await page.screenshot({ path: path.join(__dirname, 'screenshot-tutores-tutor.png'), fullPage: true });
    await measureTutors('Móvil 390px (tutor)', { width: 390, height: 900 });
    await page.setViewportSize({ width: 1500, height: 900 });
    await goHistory();
    await logout();

    // ================= PRUEBA 13: la selección de otro tutor sigue funcionando =================
    section('PRUEBA 13. "Elegir otro tutor" (tutor asignado sin la materia) sigue funcionando; el retirado NO usa selector');
    await login('ana@test.co');
    await requestTutor('Álgebra Lineal', 'Tutor Beta', 'R7-elegir-otro');
    // Dato heredado: Beta ya no ofrece la materia pero la solicitud sigue apuntando a él
    // (por la UI actual no se puede producir: retirar la materia reasigna solo).
    await page.evaluate(() => {
        const users = JSON.parse(localStorage.getItem('edumatch_users'));
        users.find(u => u.email === 'beta@test.co').subjects = users.find(u => u.email === 'beta@test.co').subjects.filter(s => s !== 'Álgebra Lineal');
        localStorage.setItem('edumatch_users', JSON.stringify(users));
    });
    await reload();
    check('Estudiante ve el aviso y "Elegir otro tutor"', (await btnTexts('R7-elegir-otro')).includes('Elegir otro tutor'));
    await card('R7-elegir-otro').locator('[data-action="clear-tutor"]').click();
    check('Se muestran los tutores disponibles de la materia (select con candidatos)', await card('R7-elegir-otro').locator('select option').count() >= 1);
    check('El select NO incluye al tutor que ya no da la materia', !(await card('R7-elegir-otro').locator('select option').allInnerTexts()).some(t => t.includes('Tutor Beta')));
    await card('R7-elegir-otro').locator('select').selectOption({ label: 'Tutor Alfa' });
    await card('R7-elegir-otro').locator('[data-action="assign-new-tutor"]').click();
    check('Tutor seleccionado correctamente: asignada a Tutor Alfa, Pendiente', (await statusOf('R7-elegir-otro')) === 'Pendiente' && (await card('R7-elegir-otro').innerText()).includes('Tutor Alfa'));
    await reload();
    check('Tras recargar sigue con Tutor Alfa (Pendiente)', (await statusOf('R7-elegir-otro')) === 'Pendiente' && (await card('R7-elegir-otro').innerText()).includes('Tutor Alfa'));
    await logout();


    // ================= PRUEBA 14: versión web / versión app (móvil) =================
    section('PRUEBA 14. Responsive web + app (Capacitor): barra inferior, zonas seguras, sin desbordes');
    check('viewport-fit=cover (necesario para las zonas seguras de Android)', (await page.getAttribute('meta[name="viewport"]', 'content')).includes('viewport-fit=cover'));
    await login('ana@test.co');
    for (const [w, h] of [[320, 568], [360, 740], [412, 915], [600, 960], [768, 1024]]) {
        await page.setViewportSize({ width: w, height: h });
        for (const tab of ['explore', 'tutors', 'request', 'history']) {
            await page.evaluate(t => switchTab(t), tab);
            const r = await page.evaluate(() => {
                const de = document.documentElement, vw = de.clientWidth;
                const nav = document.querySelector('.nav-links').getBoundingClientRect();
                const off = [...document.querySelectorAll('body *')].filter(e => { const c = getComputedStyle(e); if (c.display === 'none' || c.visibility === 'hidden') return false; const b = e.getBoundingClientRect(); return b.width && !e.closest('.toast-container') && (b.right > vw + 1 || b.left < -1); }).length;
                return { hs: de.scrollWidth > vw, off, navBottom: Math.round(nav.bottom), navPos: getComputedStyle(document.querySelector('.nav-links')).position, vh: innerHeight, icons: getComputedStyle(document.querySelector('.nav-ico')).display };
            });
            check(`${w}px / ${tab}: sin scroll horizontal ni elementos fuera de pantalla`, !r.hs && r.off === 0, JSON.stringify(r));
            check(`${w}px / ${tab}: barra de pestañas fija y pegada al borde inferior`, r.navPos === 'fixed' && r.navBottom === r.vh && r.icons !== 'none', JSON.stringify(r));
        }
    }
    await page.setViewportSize({ width: 1500, height: 900 });
    const desk = await page.evaluate(() => ({ pos: getComputedStyle(document.querySelector('.nav-links')).position, ico: getComputedStyle(document.querySelector('.nav-ico')).display, extra: getComputedStyle(document.querySelector('.nav-label-extra')).display }));
    check('Web (1500px): enlaces arriba en el navbar, sin iconos ni barra inferior', desk.pos !== 'fixed' && desk.ico === 'none' && desk.extra !== 'none', JSON.stringify(desk));
    await logout();
    const app = await page.context().newPage();
    await app.goto(url + '?app=1');
    check('Modo app (?app=1 / Capacitor): <html> lleva la clase is-app', await app.evaluate(() => document.documentElement.classList.contains('is-app')));
    check('Web normal: sin is-app', !(await page.evaluate(() => document.documentElement.classList.contains('is-app'))));
    await app.click('#themeToggleBtn');
    check('El tema también se aplica a <html> y a la barra de estado (theme-color)', await app.evaluate(() => document.documentElement.dataset.theme === 'dark' && document.getElementById('metaThemeColor').content === '#202124'));
    await app.close();


    // ================= PRUEBA 15: botón "atrás" de Android y tipografía incluida =================
    section('PRUEBA 15. Botón atrás (Capacitor) y fuente Plus Jakarta Sans empaquetada');
    const bk = await page.context().newPage();
    const external = [];
    bk.on('request', r => { if (!r.url().startsWith(url)) external.push(r.url()); });
    // Simula EXACTAMENTE lo que Android inyecta en la página (native-bridge.js): sin
    // Capacitor.Plugins (no hay bundler), solo addListener() y nativePromise().
    await bk.addInitScript(() => {
        window.__exited = false; window.__ran = false; window.__calls = [];
        window.Capacitor = {
            isNativePlatform: () => true, getPlatform: () => 'android',
            addListener: (plugin, eventName, cb) => { if (plugin === 'App' && eventName === 'backButton') window.__back = cb; return { remove: async () => {} }; },
            nativePromise: (plugin, method, options) => { window.__calls.push([plugin, method, options]); if (plugin === 'App' && method === 'exitApp') window.__exited = true; return Promise.resolve(); }
        };
    });
    await bk.goto(url);
    const back = () => bk.evaluate(() => window.__back());
    const isActive = id => bk.evaluate(i => document.getElementById(i).classList.contains('active'), id);
    check('El puente nativo registró el listener del botón atrás (App.backButton)', await bk.evaluate(() => typeof window.__back === 'function'));

    await bk.evaluate(() => openModal('authModal'));
    await back();
    check('Atrás con el modal de cuenta abierto: lo cierra y la app NO se cierra', !(await isActive('authModal')) && !(await bk.evaluate(() => window.__exited)));

    await bk.evaluate(() => { openSettingsModal(); startResetConfirmation(); });
    await back();
    check('Atrás en la confirmación de "Restablecer datos": vuelve un paso (Configuración sigue abierta)', (await isActive('settingsModal')) && (await bk.evaluate(() => document.getElementById('settingsResetConfirm').style.display)) === 'none');
    await back();
    check('Atrás otra vez: cierra Configuración', !(await isActive('settingsModal')));

    await bk.evaluate(() => openConfirmModal({ title: 'Prueba', message: 'x', confirmLabel: 'Sí', onConfirm: () => { window.__ran = true; } }));
    await back();
    check('Atrás en un aviso de confirmación = "Cancelar": lo cierra SIN ejecutar la acción', !(await isActive('confirmModal')) && !(await bk.evaluate(() => window.__ran)));

    await bk.evaluate(() => openModal('historyModal'));
    await back();
    check('Atrás con el historial de una solicitud abierto: lo cierra', !(await isActive('historyModal')));

    await bk.evaluate(() => { openModal('authModal'); openModal('historyModal'); });
    await back();
    check('Con dos modales abiertos, atrás cierra primero el de arriba (historial) y deja el de cuenta', !(await isActive('historyModal')) && (await isActive('authModal')));
    await back();
    check('…y el siguiente atrás cierra el de cuenta', !(await isActive('authModal')));

    await bk.evaluate(() => switchTab('tutors'));
    await back();
    check('Atrás desde otra pestaña: vuelve a "Materias" sin cerrar la app', (await bk.evaluate(() => document.getElementById('explore-tab').classList.contains('active'))) && !(await bk.evaluate(() => window.__exited)));
    await back();
    check('Atrás en "Materias" sin modales: cierra la app (exitApp)', await bk.evaluate(() => window.__exited));

    // Tipografía: se carga desde assets/fonts/ (sin internet) y se aplica de verdad
    await bk.evaluate(() => document.fonts.load('600 16px "Plus Jakarta Sans"', 'Solicitud áéíóúñ¿¡'));
    await bk.evaluate(() => document.fonts.ready);
    const font = await bk.evaluate(() => ({
        loaded: [...document.fonts].filter(f => f.family.replace(/"/g, '') === 'Plus Jakarta Sans' && f.status === 'loaded').length,
        check: document.fonts.check('600 16px "Plus Jakarta Sans"', 'Solicitud áéíóúñ¿¡'),
        family: getComputedStyle(document.querySelector('h2')).fontFamily
    }));
    check('Plus Jakarta Sans se carga desde el propio proyecto (fuente "loaded")', font.loaded >= 1 && font.check, JSON.stringify(font));
    check('El texto de la interfaz usa Plus Jakarta Sans', font.family.startsWith('"Plus Jakarta Sans"') || font.family.startsWith('Plus Jakarta Sans'), font.family);
    check('Ninguna petición sale a internet (funciona sin conexión): ni Google Fonts ni CDN', external.length === 0, JSON.stringify(external));
    await bk.close();


    // ================= PRUEBA 16: integración con la app Android (puente nativo) =================
    section('PRUEBA 16. App Android: barra de estado, zonas seguras inyectadas por Capacitor 8');
    const ap = await page.context().newPage();
    await ap.addInitScript(() => {
        try { localStorage.setItem('edumatch_theme', 'light'); } catch (e) {}
        window.__calls = [];
        window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', addListener: () => ({ remove: async () => {} }), nativePromise: (p, m, o) => { window.__calls.push([p, m, o]); return Promise.resolve(); } };
    });
    await ap.setViewportSize({ width: 390, height: 844 });
    await ap.goto(url);
    check('Dentro de la app (isNativePlatform) el <html> lleva is-app', await ap.evaluate(() => document.documentElement.classList.contains('is-app')));
    check('Al arrancar (tema claro) pide iconos oscuros en la barra de estado: SystemBars.setStyle LIGHT', await ap.evaluate(() => window.__calls.some(c => c[0] === 'SystemBars' && c[1] === 'setStyle' && c[2].style === 'LIGHT')));
    await ap.click('#themeToggleBtn');
    check('Al pasar a tema oscuro pide iconos claros: SystemBars.setStyle DARK', await ap.evaluate(() => window.__calls.some(c => c[0] === 'SystemBars' && c[1] === 'setStyle' && c[2].style === 'DARK')));
    await ap.click('#themeToggleBtn');
    // Capacitor 8 inyecta --safe-area-inset-* en <html>; el diseño debe usarlas
    await ap.evaluate(() => { const st = document.documentElement.style; st.setProperty('--safe-area-inset-top', '30px'); st.setProperty('--safe-area-inset-bottom', '24px'); st.setProperty('--safe-area-inset-left', '0px'); st.setProperty('--safe-area-inset-right', '0px'); });
    const sa = await ap.evaluate(() => {
        const nb = document.querySelector('.navbar'); const nav = document.querySelector('.nav-links');
        const btn = document.querySelector('.nav-btn').getBoundingClientRect();
        return { navTop: parseFloat(getComputedStyle(nb).paddingTop), navBottomPad: parseFloat(getComputedStyle(nav).paddingBottom), barBottom: Math.round(nav.getBoundingClientRect().bottom), vh: innerHeight, btnBottom: Math.round(btn.bottom), barTop: Math.round(nb.getBoundingClientRect().top) };
    });
    check('Zona segura superior (barra de estado): el navbar añade 30px arriba', sa.navTop === 30, JSON.stringify(sa));
    check('Zona segura inferior (gestos): la barra de pestañas añade 24px y sus botones quedan por encima', sa.navBottomPad >= 24 && sa.btnBottom <= sa.vh - 24, JSON.stringify(sa));
    await ap.close();
    // En el navegador (sin Capacitor) nada de esto falla
    check('En el navegador: sin is-app y sin errores por falta de Capacitor', !(await page.evaluate(() => document.documentElement.classList.contains('is-app'))) && pageErrors.length === 0);


    // ================= PRUEBA 17: scroll táctil y teclado en pantalla (móvil / app) =================
    section('PRUEBA 17. Scroll con el dedo, <body> sin contenedor de scroll propio y teclado en pantalla');
    const mctx = await browser.newContext({ viewport: { width: 393, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.75 });
    const mp = await mctx.newPage();
    await mp.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', addListener: () => ({ remove: async () => {} }), nativePromise: () => Promise.resolve() }; });
    await mp.goto(url);
    await mp.evaluate(() => {
        const u = [{ id: 1, name: 'Daniel codina', email: 'd@t.co', password: 'x', role: 'Estudiante' }, { id: 2, name: 'Tutor T', email: 't@t.co', password: 'x', role: 'Tutor', subjects: ['Cálculo Diferencial'] }];
        localStorage.setItem('edumatch_users', JSON.stringify(u)); localStorage.setItem('edumatch_current_user', JSON.stringify(u[0]));
    });
    await mp.reload();
    const mcdp = await mctx.newCDPSession(mp);
    const swipe = async (x, y, dy) => { // dy < 0: el dedo sube (la página baja)
        await mcdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let i = 1; i <= 10; i++) { await mcdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (i * dy) / 10 }] }); await mp.waitForTimeout(16); }
        await mcdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await mp.waitForTimeout(450);
    };
    const sy = () => mp.evaluate(() => Math.round(scrollY));
    const ov = await mp.evaluate(() => ({ html: getComputedStyle(document.documentElement).overflowX, body: getComputedStyle(document.body).overflowX, bodyY: getComputedStyle(document.body).overflowY }));
    check('<html> sin overflow propio y <body> no es contenedor de scroll (causa del "no baja con el dedo")', ov.html === 'visible' && (ov.bodyY === 'visible'), JSON.stringify(ov));
    await mp.evaluate(() => switchTab('explore')); await mp.waitForTimeout(450);
    await swipe(200, 620, -400);
    const y1 = await sy();
    check('Materias: arrastrar el dedo hacia arriba baja la página', y1 > 200, `scrollY=${y1}`);
    await swipe(200, 300, 300);
    check('…y arrastrar hacia abajo la sube', (await sy()) < y1 - 100, `scrollY=${await sy()}`);
    await mp.evaluate(() => switchTab('request')); await mp.waitForTimeout(450);
    const selBox = await mp.locator('#selectSubject').boundingBox();
    await swipe(selBox.x + selBox.width / 2, selBox.y + 10, -250);
    check('Solicitar: también baja si el dedo empieza sobre un campo (select)', (await sy()) > 100, `scrollY=${await sy()}`);
    await mp.evaluate(() => window.scrollTo(0, 1e6)); await mp.waitForTimeout(250);
    const end = await mp.evaluate(() => ({ btn: Math.round(document.querySelector('#request-tab button[type="submit"]').getBoundingClientRect().bottom), nav: Math.round(document.querySelector('.nav-links').getBoundingClientRect().top) }));
    check('Al llegar al final, el botón "Enviar Solicitud" queda por encima de la barra inferior', end.btn <= end.nav, JSON.stringify(end));

    // Teclado: se simula encogiendo el alto de la ventana con un campo enfocado
    await mp.evaluate(() => document.getElementById('requestTopic').focus());
    await mp.setViewportSize({ width: 393, height: 440 }); await mp.waitForTimeout(300);
    const kb = await mp.evaluate(() => ({ cls: document.documentElement.classList.contains('kb-open'), nav: getComputedStyle(document.querySelector('.nav-links')).display }));
    check('Con el teclado abierto se oculta la barra de pestañas (kb-open)', kb.cls && kb.nav === 'none', JSON.stringify(kb));
    await mp.evaluate(() => document.activeElement.blur()); await mp.setViewportSize({ width: 393, height: 800 }); await mp.waitForTimeout(400);
    const kb2 = await mp.evaluate(() => ({ cls: document.documentElement.classList.contains('kb-open'), nav: getComputedStyle(document.querySelector('.nav-links')).display }));
    check('Al cerrar el teclado la barra vuelve a aparecer', !kb2.cls && kb2.nav !== 'none', JSON.stringify(kb2));
    await mp.setViewportSize({ width: 852, height: 393 }); await mp.waitForTimeout(300);
    check('Girar la pantalla (horizontal) NO se confunde con un teclado abierto', !(await mp.evaluate(() => document.documentElement.classList.contains('kb-open'))));
    await mctx.close();


    // ================= PRUEBA 18: selectores propios (lista / calendario / reloj) y toasts =================
    section('PRUEBA 18. Listas, calendario y reloj propios (sin diálogos nativos) + toasts cortos');
    await login('ana@test.co');
    await page.click('.nav-btn[data-tab="request"]');
    const subjField = page.locator('.ui-field--select', { has: page.locator('#selectSubject') });
    await subjField.locator('.ui-trigger').click();
    check('Select "Materia": se abre como lista junto al campo (no diálogo nativo)', await subjField.locator('.ui-menu[role="listbox"]').isVisible());
    await subjField.locator('.ui-option', { hasText: 'Álgebra Lineal' }).click();
    check('Elegir una opción actualiza el <select> real (value + botón)', (await page.inputValue('#selectSubject')) === 'Álgebra Lineal' && (await subjField.locator('.ui-trigger__label').innerText()) === 'Álgebra Lineal');
    check('El panel se cierra solo al elegir', await subjField.locator('.ui-menu').isHidden());

    const dateField = page.locator('.ui-field--date', { has: page.locator('#preferredDate') });
    await dateField.locator('.ui-trigger').click();
    const calPanel = page.locator('.ui-cal'); // diálogo COMPARTIDO: uno solo en toda la página (ver pickers.js)
    check('Fecha: se abre un calendario compacto (no el selector nativo enorme)', await calPanel.isVisible());
    const calBox = await calPanel.boundingBox();
    check('El calendario es compacto (no ocupa media pantalla)', calBox.width <= 320 && calBox.height < 360, JSON.stringify(calBox));
    const todayCell = calPanel.locator('.ui-cal__day.is-today');
    const todayNum = await todayCell.innerText();
    await todayCell.click();
    check('Elegir un día actualiza el <input type=date> real', (await page.inputValue('#preferredDate')) === (await page.evaluate(() => { const t = new Date(); return t.toISOString().slice(0, 10); })));
    check('…y el botón muestra dd/mm/aaaa', (await dateField.locator('.ui-trigger__label').innerText()).endsWith(`/${(await page.evaluate(() => new Date().getMonth() + 1)).toString().padStart(2, '0')}/${await page.evaluate(() => new Date().getFullYear())}`));
    await dateField.locator('.ui-trigger').click();
    await calPanel.locator('[data-nav="1"]').click();
    check('La flecha ">" avanza de mes sin recargar la página', await calPanel.isVisible());
    await page.keyboard.press('Escape');
    check('Escape cierra el calendario', await calPanel.isHidden());

    // Bug de dispositivo real: su <label for="preferredDate"> enfocaba el <input> real al
    // tocarlo (comportamiento nativo del navegador), y en Android eso basta para que el
    // sistema abra SU PROPIO selector por encima del nuestro. Debe quedar interceptado.
    await page.locator('label[for="preferredDate"]').click();
    check('Tocar la etiqueta "Fecha preferida" abre NUESTRO calendario (no enfoca el <input> nativo)', await calPanel.isVisible() && !(await page.evaluate(() => document.activeElement === document.getElementById('preferredDate'))));
    await page.keyboard.press('Escape');
    await page.locator('label[for="preferredTime"]').click();
    check('Tocar la etiqueta "Hora preferida" abre NUESTRO reloj (no el selector nativo de Android)', await page.locator('.ui-time').isVisible());
    await page.keyboard.press('Escape');

    const timeField = page.locator('.ui-field--time', { has: page.locator('#preferredTime') });
    await timeField.locator('.ui-trigger').click();
    const timePanel = page.locator('.ui-time'); // también un único diálogo compartido
    check('Hora: se abre un reloj compacto de 12 h con a. m. / p. m. (no el nativo)', await timePanel.isVisible());
    const timeBox = await timePanel.boundingBox();
    check('El selector de hora es compacto', timeBox.width < 320 && timeBox.height < 340, JSON.stringify(timeBox));
    await timePanel.locator('[data-h="09"]').click();
    await timePanel.locator('[data-m="30"]').click();
    await timePanel.locator('[data-period="PM"]').click();
    check('Elegir hora, minuto y a. m./p. m. actualiza el <input type=time> real (12 h -> 24 h)', (await page.inputValue('#preferredTime')) === '21:30');
    check('La vista previa grande muestra el formato 12 h correcto', (await timePanel.locator('.ui-time__preview').innerText()) === '9:30 p. m.');
    await timePanel.locator('[data-done]').click();
    check('"Listo" cierra el panel', await timePanel.isHidden());

    // Un solo panel abierto a la vez: el desplegable de Materia es alto y, mientras está
    // abierto, tapa los campos de debajo (igual que cualquier lista nativa) — por eso, para
    // abrir el siguiente selector hay una interacción de por medio (elegir algo o tocar fuera),
    // nunca un tap "a través" de la lista abierta. Se comprueba a nivel de estado con .click()
    // del DOM (no un tap en pantalla, que ahí SÍ debería caer sobre la lista, no debajo de ella).
    await subjField.locator('.ui-trigger').click();
    check('El desplegable abierto de Materia cubre el campo de Fecha de debajo (evita toques accidentales "a través" de la lista)', (await subjField.locator('.ui-menu').boundingBox()).y + (await subjField.locator('.ui-menu').boundingBox()).height > (await dateField.locator('.ui-trigger').boundingBox()).y);
    await page.evaluate(() => { document.querySelector('[data-ui="date"]').closest('.ui-field').querySelector('.ui-trigger').click(); });
    check('Abrir otro selector cierra automáticamente el anterior (nunca dos a la vez)', await subjField.locator('.ui-menu').isHidden() && await calPanel.isVisible());
    check('El calendario abierto queda SIEMPRE centrado en la pantalla, sin importar dónde esté el campo', await page.evaluate(() => { const r = document.querySelector('.ui-cal').getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; return Math.abs(cx - innerWidth / 2) < 2 && Math.abs(cy - innerHeight / 2) < 2; }));
    await page.mouse.click(20, 20);
    check('Tocar fuera de cualquier panel lo cierra', await calPanel.isHidden());
    check('El diálogo compartido no deja copias huérfanas en el DOM (uno solo de cada uno, siempre)', await page.evaluate(() => document.querySelectorAll('.ui-cal').length === 1 && document.querySelectorAll('.ui-time').length === 1));

    // Fecha/hora obligatorias en el formulario (ya no dice "opcional")
    const labelsTxt = await page.locator('label[for="preferredDate"], label[for="preferredTime"]').allInnerTexts();
    check('Fecha y Hora ya NO dicen "(opcional)" (son obligatorias)', labelsTxt.every(t => !/opcional/i.test(t)), JSON.stringify(labelsTxt));
    check('"Tema específico" sigue siendo el único campo opcional', (await page.locator('label[for="requestTopic"]').innerText()).toLowerCase().includes('opcional'));
    await page.evaluate(() => { document.getElementById('preferredDate').value = ''; document.getElementById('preferredTime').value = ''; });
    await page.selectOption('#selectSubject', 'Cálculo Diferencial');
    await page.fill('#requestTopic', 'X-sin-fecha');
    await page.click('#tutorRequestForm button[type="submit"]');
    check('Enviar sin fecha avisa y NO crea la solicitud', (await lastToast()).includes('fecha') && !(await store('edumatch_requests')).some(r => r.topic === 'X-sin-fecha'));

    // Toasts: cortos, apilan como máximo 2 y no tapan el contenido
    await page.evaluate(() => { document.getElementById('toastContainer').innerHTML = ''; });
    const t0 = Date.now();
    await page.evaluate(() => showToast('Prueba de duración', 'success'));
    await page.waitForSelector('.toast', { state: 'hidden', timeout: 4000 });
    const elapsed = Date.now() - t0;
    check('El toast desaparece solo, en 3 s o menos', elapsed <= 3200, `${elapsed}ms`);
    await page.evaluate(() => { showToast('Aviso 1', 'info'); showToast('Aviso 2', 'info'); showToast('Aviso 3', 'info'); });
    await page.waitForTimeout(150);
    check('Nunca hay más de 2 avisos activos a la vez (el más viejo se retira al llegar un tercero)', (await page.locator('#toastContainer .toast:not(.is-leaving)').count()) <= 2);
    const toastBox = await page.locator('#toastContainer').boundingBox();
    const navBox = await page.locator('.nav-links').boundingBox().catch(() => null);
    check('El aviso queda en una esquina, sin cubrir todo el ancho de la pantalla', toastBox.width < (await page.evaluate(() => innerWidth)) * 0.9);
    await page.evaluate(() => { document.getElementById('toastContainer').innerHTML = ''; });

    await goHistory();

    check('Sin errores de JavaScript en la página', pageErrors.length === 0, pageErrors.join(' | '));

    await browser.close();
    server.close();
    console.log(`\n=== ${passed} pruebas OK, ${failed} fallidas ===`);
    if (failed) { console.log('Fallaron:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(2); });

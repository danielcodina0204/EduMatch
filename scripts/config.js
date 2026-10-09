// Genera assets/js/backend-config.js a partir de SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY
// (archivo .env o variables del sistema). Así las claves no quedan versionadas en el
// repositorio. Con --strict (lo usa build:web para el APK) falla si faltan los valores.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'assets', 'js', 'backend-config.js');
const strict = process.argv.includes('--strict');

function readEnvFile(file) {
    if (!fs.existsSync(file)) return {};
    const vars = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m) vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return vars;
}

const fileVars = readEnvFile(path.join(root, '.env'));
const url = (process.env.SUPABASE_URL || fileVars.SUPABASE_URL || '').trim();
const publishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY || fileVars.SUPABASE_PUBLISHABLE_KEY || '').trim();

const isPlaceholder = v => !v || /[<>]|tu-proyecto|xxxx/i.test(v);
// La secret key (o la antigua service_role) salta RLS: nunca debe viajar al navegador ni al APK.
if (/^sb_secret_/.test(publishableKey) || /service_role/.test(publishableKey)) {
    console.error('SUPABASE_PUBLISHABLE_KEY contiene una clave secreta. Usa la "publishable key" del proyecto.');
    process.exit(1);
}

const configured = !isPlaceholder(url) && !isPlaceholder(publishableKey) && /^https:\/\//.test(url);
if (!configured) {
    const help = 'Copia .env.example como .env y completa SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY.';
    if (strict) {
        console.error(`Falta la configuración de Supabase. ${help}`);
        process.exit(1);
    }
    console.warn(`Aviso: Supabase sin configurar; la app abrirá pero no podrá registrar ni iniciar sesión. ${help}`);
}

const body = `// Archivo generado por scripts/config.js a partir de .env. No editar ni versionar.
window.EDUMATCH_SUPABASE_CONFIG = Object.freeze({
    url: ${JSON.stringify(configured ? url : '')},
    publishableKey: ${JSON.stringify(configured ? publishableKey : '')}
});
`;
fs.writeFileSync(out, body);
console.log(`backend-config.js generado${configured ? ` para ${url}` : ' (vacío)'}.`);

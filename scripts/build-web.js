// Copia SOLO los archivos de la app web a www/ (la carpeta que Capacitor empaqueta
// dentro del APK). Así tests/, node_modules/, android/ y demás no viajan en la app.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const INCLUDE = ['index.html', 'assets'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const item of INCLUDE) {
    const from = path.join(root, item);
    if (!fs.existsSync(from)) { console.error(`Falta ${item}`); process.exit(1); }
    fs.cpSync(from, path.join(out, item), { recursive: true });
}
console.log('www/ listo:', fs.readdirSync(out).join(', '));

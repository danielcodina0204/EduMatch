// Ejecuta el Gradle Wrapper del proyecto Android en cualquier sistema operativo
// (Windows usa gradlew.bat; macOS/Linux usan ./gradlew).
//   node scripts/gradle.js assembleDebug
const { spawnSync } = require('child_process');
const path = require('path');

const androidDir = path.join(__dirname, '..', 'android');
const isWin = process.platform === 'win32';
const cmd = isWin ? 'gradlew.bat' : './gradlew';
const args = process.argv.slice(2);
if (!args.length) { console.error('Uso: node scripts/gradle.js <tarea>  (p. ej. assembleDebug)'); process.exit(1); }

const r = spawnSync(cmd, args, { cwd: androidDir, stdio: 'inherit', shell: isWin });
if (r.error) { console.error(r.error.message); process.exit(1); }
process.exit(r.status === null ? 1 : r.status);

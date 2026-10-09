// Ejecuta el Gradle Wrapper del proyecto Android en cualquier sistema operativo
// (Windows usa gradlew.bat; macOS/Linux ejecutan gradlew con sh).
//   node scripts/gradle.js assembleDebug
const { spawnSync } = require('child_process');
const path = require('path');

const androidDir = path.join(__dirname, '..', 'android');
const isWin = process.platform === 'win32';
const taskArgs = process.argv.slice(2);
if (!taskArgs.length) { console.error('Uso: node scripts/gradle.js <tarea>  (p. ej. assembleDebug)'); process.exit(1); }

// En macOS/Linux se ejecuta con `sh` para no depender del bit de ejecución de gradlew
// (se pierde al descomprimir ZIPs creados en Windows).
const cmd = isWin ? 'gradlew.bat' : 'sh';
const args = isWin ? taskArgs : ['gradlew', ...taskArgs];

const r = spawnSync(cmd, args, { cwd: androidDir, stdio: 'inherit', shell: isWin });
if (r.error) { console.error(r.error.message); process.exit(1); }
process.exit(r.status === null ? 1 : r.status);

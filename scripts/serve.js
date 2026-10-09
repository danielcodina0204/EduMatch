// Servidor estático mínimo para probar la versión web en http://localhost:3000
// (el site_url de supabase/config.toml; puerto configurable con PORT). Solo
// publica index.html y assets/, igual que build-web.js, para no exponer .env,
// tests/ ni el resto del repositorio.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.env.PORT) || 3000;
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch (_) { res.writeHead(400); res.end(); return; }
    if (pathname === '/') pathname = '/index.html';

    const file = path.join(root, pathname);
    const allowed = file === path.join(root, 'index.html') || file.startsWith(path.join(root, 'assets') + path.sep);
    if (!allowed) { res.writeHead(404); res.end('No encontrado'); return; }

    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('No encontrado'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(port, () => console.log(`EduMatch disponible en http://localhost:${port}`));

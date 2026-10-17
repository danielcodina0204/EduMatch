// Genera las 8 composiciones HyperFrames de VEYRA SOLUCIONES (4 videos x 2 formatos) en ./projects
// Brief vigente: 2026-10-14. Uso: node build.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(ROOT, 'src');
const PROJECTS = path.join(ROOT, 'projects');
const SIZE = { p: [1080, 1920], l: [1920, 1080] };

// ---------- datos de marca (única fuente: el brief) ----------
const WA = '+57 320 488 9616';
const WEB = 'veyrasoluciones.com';
const SLOGAN = 'Procesos más claros. Empresas más fuertes.';
const EX = 'Ejemplo conceptual';
const TAB = 'Tablero ilustrativo';

// ---------- CSS (la raíz se estiliza con #root; se genera por formato y tema) ----------
const VARS = {
  p: '--px:84px;--st:250px;--sb:360px;--h1:112px;--h2:80px;--body:48px;--lab:32px;--src:30px;--gap:48px;--cp:28px 32px;--cn:56px;--r:24px',
  l: '--px:140px;--st:84px;--sb:90px;--h1:124px;--h2:78px;--body:44px;--lab:30px;--src:28px;--gap:44px;--cp:36px 40px;--cn:60px;--r:26px',
};
const css = (fmt, theme) => {
  const dk = theme === 'dk';
  const bg = dk ? 'var(--navy)' : 'var(--soft)';
  const fg = dk ? 'var(--white)' : 'var(--navy)';
  const body = dk ? 'var(--line)' : 'var(--gray)';
  return `
@font-face{font-family:Outfit;font-weight:600;src:url(assets/fonts/outfit-latin-600-normal.woff2) format("woff2")}
@font-face{font-family:Outfit;font-weight:700;src:url(assets/fonts/outfit-latin-700-normal.woff2) format("woff2")}
@font-face{font-family:Inter;font-weight:400;src:url(assets/fonts/inter-latin-400-normal.woff2) format("woff2")}
@font-face{font-family:Inter;font-weight:500;src:url(assets/fonts/inter-latin-500-normal.woff2) format("woff2")}
@font-face{font-family:Inter;font-weight:600;src:url(assets/fonts/inter-latin-600-normal.woff2) format("woff2")}
#root{--navy:#080f2e;--blue:#0561ef;--blue-d:#004bd0;--gray:#343c51;--line:#dce8f2;--soft:#f3f8fc;--white:#ffffff;${VARS[fmt]};
 position:absolute;inset:0;overflow:hidden;font-family:Inter,sans-serif;background:${bg};color:${fg}}
#root *{margin:0;padding:0;box-sizing:border-box}
.in{position:absolute;inset:0;padding:var(--st) var(--px) var(--sb);display:flex;flex-direction:column;z-index:2}
.hdr{display:flex;align-items:center;gap:28px;flex:none}
.wmw{display:flex;flex-direction:column;gap:2px}
.wm{font:700 46px/1 Outfit,sans-serif;letter-spacing:.34em}
.ws{font:600 24px/1 Outfit,sans-serif;letter-spacing:.42em}
.rule{display:block;flex:1;height:4px;border-radius:2px;background:currentColor;transform-origin:left center}
.main{flex:1;display:flex;flex-direction:column;justify-content:center;gap:var(--gap);min-height:0}
.foot{flex:none;font:500 var(--src) Inter,sans-serif;min-height:34px;color:${dk ? 'var(--line)' : 'var(--gray)'}}
h1{font:700 var(--h1)/1.04 Outfit,sans-serif;letter-spacing:-.02em}
h2{font:700 var(--h2)/1.06 Outfit,sans-serif;letter-spacing:-.015em}
.body{font:500 var(--body)/1.3 Inter,sans-serif;color:${body}}
.acc{color:var(--blue)}
.split{display:flex;gap:56px;align-items:center${fmt === 'p' ? ';flex-direction:column;align-items:stretch;gap:36px' : ''}}
.split>.t{flex:1}.split>.v{flex:1.25}
.gridbg{position:absolute;inset:0;z-index:0;background-image:${dk ? 'linear-gradient(rgba(220,232,242,.12) 2px,transparent 2px),linear-gradient(90deg,rgba(220,232,242,.12) 2px,transparent 2px)' : 'linear-gradient(var(--line) 2px,transparent 2px),linear-gradient(90deg,var(--line) 2px,transparent 2px)'};background-size:120px 120px;opacity:${dk ? 1 : .55}}
.glow{position:absolute;width:1100px;height:1100px;right:-380px;top:-300px;border-radius:50%;background:radial-gradient(circle,rgba(5,97,239,.5) 0,rgba(5,97,239,0) 66%);z-index:1}
.chip{display:block;width:fit-content;font:600 var(--body)/1.2 Outfit,sans-serif;padding:20px 34px;border-radius:var(--r);border:3px solid ${dk ? 'var(--line)' : 'var(--navy)'};color:${fg}${dk ? '' : ';background:var(--white)'}}
.list{display:flex;flex-direction:${fmt === 'p' ? 'column' : 'row;flex-wrap:wrap'};gap:20px}
.grid{display:grid;gap:22px;grid-template-columns:repeat(${fmt === 'p' ? 1 : 'var(--lcols,3)'},1fr)}
.card{position:relative;background:var(--white);border:3px solid var(--line);border-radius:var(--r);padding:var(--cp);overflow:hidden}
.card .n{font:700 var(--cn)/1 Outfit,sans-serif;color:var(--blue)}
.card .tx{font:600 var(--body)/1.2 Inter,sans-serif;color:var(--navy)}
.card .sub{font:500 calc(var(--body) - 6px)/1.3 Inter,sans-serif;color:var(--gray);margin-top:10px}
.card .bar{display:block;height:12px;border-radius:6px;background:var(--line);margin-top:18px;overflow:hidden}
.card .bar i{display:block;height:100%;width:100%;border-radius:6px;background:var(--blue);transform-origin:left center}
.btn{display:block;width:fit-content;background:var(--blue);color:var(--white);font:700 calc(var(--body) + 8px) Outfit,sans-serif;padding:28px 56px;border-radius:var(--r);border-bottom:10px solid var(--blue-d)}
.btn2{display:block;width:fit-content;font:600 calc(var(--body) - 2px) Outfit,sans-serif;padding:20px 40px;border-radius:var(--r);border:3px solid var(--line);color:var(--white)}
.contact .v{font:700 var(--h2) Outfit,sans-serif}
.contact .w{font:600 calc(var(--body) + 2px) Inter,sans-serif;margin-top:8px;color:var(--line)}
.tag{display:block;width:fit-content;font:600 var(--lab) Inter,sans-serif;letter-spacing:.06em;padding:10px 22px;border-radius:999px;background:var(--blue);color:var(--white)}
.flow{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.flow .nd{font:600 var(--lab) Inter,sans-serif;padding:14px 26px;border-radius:999px;border:3px solid var(--blue);color:var(--navy);background:var(--white)}
.flow .ar{font:700 var(--lab) Outfit,sans-serif;color:var(--blue)}
svg text{font-family:Inter,sans-serif}
`;
};

// ---------- piezas ----------
const hdr = () => `<div class="hdr"><div class="wmw"><span class="wm">VEYRA</span><span class="ws">SOLUCIONES</span></div><i class="rule"></i></div>`;
const foot = (t = '') => `<div class="foot">${t}</div>`;
const darkBg = () => `<div class="gridbg"></div><div class="glow" data-layout-allow-overflow></div>`;
const lightBg = () => `<div class="gridbg"></div>`;

const ent = (s, sel, t, step = 0.035) =>
  `tl.fromTo("#${s} ${sel}",{opacity:0,y:8},{opacity:1,y:0,duration:.26,ease:"power2.out",stagger:${step}},${t.toFixed(2)});`;
const rule = (s, t) => `tl.fromTo("#${s} .rule",{scaleX:0},{scaleX:1,duration:.5,ease:"power2.out"},${t.toFixed(2)});`;
const bars = (s, t, step = 0.12) =>
  `tl.fromTo("#${s} .bar i",{scaleX:0},{scaleX:1,duration:.6,ease:"power2.out",stagger:${step}},${t.toFixed(2)});`;

// CTA: principal "Empezar diagnóstico" + secundario "Hablar con un especialista" (WhatsApp)
const ctaScene = (primary = 'Empezar diagnóstico') => ({
  theme: 'dk', dur: 3.6, bg: darkBg(),
  html: `${hdr()}<div class="main">
  <h1 class="e" style="font-size:calc(var(--h1) - 24px)">${SLOGAN}</h1>
  <div class="btn e">${primary}</div>
  <div class="btn2 e">Hablar con un especialista</div>
  <div class="contact e"><div class="v">${WA}</div><div class="w">${WEB}</div></div></div>${foot()}`,
  js: (s, at) => [ent(s, '.e', at(0.2), 0.12)],
});

// tablero ilustrativo (HTML): tres mosaicos con barras de progreso
const boardHtml = () => `<div class="grid" style="--lcols:3">${['Clientes en un lugar', 'Tareas bajo control', 'Una visión clara'].map((t) => `<div class="card b"><div class="tx">${t}</div><i class="bar"><i></i></i></div>`).join('')}</div>`;

// flujo de solicitudes que se ordenan (SVG): tarjetas dispersas -> fila ordenada
const FROM = [[90, 70], [250, 210], [150, 330], [420, 110], [520, 290], [330, 400]];
const flowSvg = () => `<svg viewBox="0 0 760 460" width="100%" aria-label="Flujo de solicitudes (${EX})">
<line x1="40" y1="230" x2="720" y2="230" stroke="#dce8f2" stroke-width="3" stroke-dasharray="10 10"/>
${FROM.map(([x, y], i) => `<g class="rq" data-i="${i}" transform="translate(${x} ${y})"><rect x="-34" y="-26" width="68" height="52" rx="14" fill="#0561ef"/><rect x="-18" y="-8" width="36" height="6" rx="3" fill="#ffffff"/><rect x="-18" y="6" width="22" height="6" rx="3" fill="#ffffff"/></g>`).join('')}
<text x="40" y="440" fill="#dce8f2" font-size="34" font-weight="600">Solicitudes en un solo flujo</text></svg>`;
const flowJs = (s, t) => FROM.map(([x, y], i) =>
  `tl.fromTo("#${s} .rq[data-i='${i}']",{attr:{transform:"translate(${x} ${y})"}},{attr:{transform:"translate(${90 + i * 112} 230)"},duration:.8,ease:"power2.inOut"},${(t + i * 0.035).toFixed(3)});`);

// ---------- videos ----------
const V = {};
const CHIP = (t) => `<span class="chip e">${t}</span>`;
const body6 = 'style="font-size:calc(var(--body) + 6px)"';

V.v1 = { slug: '01-presentacion', title: 'Presentación de VEYRA SOLUCIONES', music: 'music-20.mp3', poster: 11.5, scenes: [
  { theme: 'dk', dur: 4.6, bg: darkBg(),
    html: `${hdr()}<div class="main"><h1 class="e">¿Te suena familiar?</h1><div class="list">${CHIP('Solicitudes perdidas en WhatsApp')}${CHIP('Seguimiento manual')}${CHIP('Información dispersa')}</div></div>${foot()}`,
    js: (s, at) => [ent(s, 'h1', at(0.1)), ent(s, '.chip', at(0.5), 0.5)] },
  { theme: 'lt', dur: 4.4, bg: lightBg(),
    html: `${hdr()}<div class="main"><h2 class="e">Transformamos empresas desordenadas en operaciones claras, medibles y eficientes.</h2><div class="e">${boardHtml()}</div></div>${foot(TAB)}`,
    js: (s, at) => [ent(s, 'h2', at(0.1)), ent(s, '.b', at(0.7)), bars(s, at(0.9))] },
  { theme: 'lt', dur: 7.4, bg: lightBg(),
    html: `${hdr()}<div class="main"><h2 class="e">Así trabajamos, en 3 pasos</h2><div class="grid" style="--lcols:3">${[['1', 'Diagnóstico', 'Encontramos puntos de fuga y oportunidades.'], ['2', 'Implementación', 'Automatizamos y organizamos tus procesos.'], ['3', 'Resultados', 'Medimos lo que cambia y ajustamos contigo.']].map(([n, t, d]) => `<div class="card st"><div style="display:flex;gap:22px;align-items:baseline"><span class="n">${n}</span><span class="tx">${t}</span></div><div class="sub">${d}</div></div>`).join('')}</div></div>${foot()}`,
    js: (s, at) => [ent(s, 'h2', at(0.1)), ent(s, '.st', at(0.7), 1.4)] },
  ctaScene(),
]};

V.v2 = { slug: '02-business-mri', title: 'Business MRI y Diagnóstico inicial', music: 'music-20.mp3', poster: 8.8, scenes: [
  { theme: 'dk', dur: 3.4, bg: darkBg(),
    html: `${hdr()}<div class="main"><h1 class="e">¿Sabes dónde se te va el tiempo en tu empresa?</h1><div class="list">${CHIP('Cuellos de botella')}${CHIP('Tiempo y recursos')}</div></div>${foot()}`,
    js: (s, at) => [ent(s, 'h1', at(0.1)), ent(s, '.chip', at(0.9), 0.5)] },
  { theme: 'lt', dur: 4.4, bg: lightBg(),
    html: `${hdr()}<div class="main"><span class="tag e">Diagnóstico empresarial</span><h1 class="e acc">Business MRI</h1><h2 class="e">Claridad para mejorar tu empresa.</h2><p class="body e">Analizamos tus procesos e identificamos prioridades para empezar.</p></div>${foot()}`,
    js: (s, at) => [ent(s, '.e', at(0.1), 0.35)] },
  { theme: 'lt', dur: 5.2, bg: lightBg(),
    html: `${hdr()}<div class="main"><h2 class="e">Qué revisa</h2><div class="grid" style="--lcols:2">${['Cuellos de botella', 'Tiempo y recursos', 'Prioridades operativas', 'Plan de mejora'].map((t) => `<div class="card st"><div class="tx">${t}</div><i class="bar"><i></i></i></div>`).join('')}</div></div>${foot(EX)}`,
    js: (s, at) => [ent(s, 'h2', at(0.1)), ent(s, '.st', at(0.6), 0.5), bars(s, at(0.8), 0.5)] },
  { theme: 'lt', dur: 3.4, bg: lightBg(),
    html: `${hdr()}<div class="main"><h1 class="e">El inicio es gratuito.</h1><p class="body e" ${body6}>El siguiente paso lo acordamos contigo, antes de contratar.</p></div>${foot()}`,
    js: (s, at) => [ent(s, '.e', at(0.1), 0.5)] },
  ctaScene(),
]};

V.v3 = { slug: '03-servicios', title: 'Servicios', music: 'music-20.mp3', poster: 9.5, scenes: [
  { theme: 'dk', dur: 3.2, bg: darkBg(),
    html: `${hdr()}<div class="main"><div class="split"><div class="t"><h1 class="e">¿Pierdes clientes por procesos manuales?</h1></div><div class="v e">${flowSvg()}</div></div></div>${foot(EX)}`,
    js: (s, at) => [ent(s, 'h1', at(0.1)), ent(s, '.v', at(0.3)), ...flowJs(s, at(1.2))] },
  { theme: 'lt', dur: 4.4, bg: lightBg(),
    html: `${hdr()}<div class="main"><span class="tag e">Servicio 1</span><h1 class="e">Diagnóstico inicial</h1><p class="body e" ${body6}>Analizamos tus procesos e identificamos prioridades para empezar. Son preguntas sobre el negocio y es gratuito.</p></div>${foot()}`,
    js: (s, at) => [ent(s, '.e', at(0.1), 0.35)] },
  { theme: 'lt', dur: 5.2, bg: lightBg(),
    html: `${hdr()}<div class="main"><span class="tag e">Servicio 2</span><h1 class="e">Transformación digital</h1><p class="body e" ${body6}>Implementamos:</p><div class="list">${CHIP('Páginas web')}${CHIP('Automatizaciones')}${CHIP('Software a medida')}</div></div>${foot()}`,
    js: (s, at) => [ent(s, '.tag', at(0.1)), ent(s, 'h1', at(0.1)), ent(s, '.body', at(0.4)), ent(s, '.chip', at(0.9), 0.5)] },
  { theme: 'lt', dur: 3.6, bg: lightBg(),
    html: `${hdr()}<div class="main"><span class="tag e">Servicio 3</span><h1 class="e">Optimización continua</h1><p class="body e" ${body6}>Medimos resultados, ajustamos procesos y acompañamos las mejoras.</p></div>${foot()}`,
    js: (s, at) => [ent(s, '.e', at(0.1), 0.35)] },
  ctaScene(),
]};

const sector = (name, line, sub, nodes, dur) => ({ theme: 'lt', dur, bg: lightBg(),
  html: `${hdr()}<div class="main"><span class="tag e">Sector</span><h1 class="e acc">${name}</h1><h2 class="e">${line}</h2><p class="body e">${sub}</p><div class="flow e">${nodes.map((n, i) => `${i ? '<span class="ar">→</span>' : ''}<span class="nd">${n}</span>`).join('')}</div></div>${foot(EX)}`,
  js: (s, at) => [ent(s, '.e', at(0.1), 0.3)] });
V.v4 = { slug: '04-sectores', title: 'Sectores', music: 'music-20.mp3', poster: 5.5, scenes: [
  { theme: 'dk', dur: 3.0, bg: darkBg(),
    html: `${hdr()}<div class="main"><h1 class="e">¿Tu sector también vive de procesos manuales?</h1><div class="list">${CHIP('Salud')}${CHIP('Legal')}${CHIP('Inmobiliario')}</div></div>${foot()}`,
    js: (s, at) => [ent(s, 'h1', at(0.1)), ent(s, '.chip', at(0.7), 0.35)] },
  sector('Salud', 'Automatizamos solicitudes, citas y seguimiento de pacientes.', 'Web informativa y solicitudes administrativas de cita.', ['Solicitud', 'Cita', 'Seguimiento'], 4.6),
  sector('Legal', 'Organizamos clientes, casos y documentación.', 'Web de servicios y organización de consultas.', ['Consulta', 'Caso', 'Documentos'], 4.6),
  sector('Inmobiliario', 'Centralizamos oportunidades comerciales y seguimiento de ventas.', 'Web de inmuebles y seguimiento de solicitudes.', ['Oportunidad', 'Seguimiento', 'Solicitud'], 4.2),
  ctaScene('Consultar mi sector'),
]};

// ---------- ensamblado ----------
function build(key, fmt) {
  const v = V[key]; const [w, h] = SIZE[fmt];
  const name = `${v.slug}-${fmt === 'p' ? '9x16' : '16x9'}`;
  const dir = path.join(PROJECTS, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'compositions'), { recursive: true });
  for (const f of ['hyperframes.json', 'package.json']) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  fs.cpSync(path.join(SRC, 'assets', 'fonts'), path.join(dir, 'assets', 'fonts'), { recursive: true });
  for (const f of ['gsap.min.js', v.music]) fs.copyFileSync(path.join(SRC, 'assets', f), path.join(dir, 'assets', f));

  let t = 0; const hosts = [];
  v.scenes.forEach((sc, i) => {
    const id = `s${i + 1}`; const at = (x) => x; const last = i === v.scenes.length - 1;
    const js = [rule(id, at(0.05)), ...sc.js(id, at)];
    if (last) js.push(`tl.to("#${id} .in",{opacity:0,duration:.3,ease:"power1.in"},${(sc.dur - 0.35).toFixed(2)});`);
    fs.writeFileSync(path.join(dir, 'compositions', `${id}.html`), `<!doctype html>
<html lang="es"><body>
<template id="${id}-template">
<style>${css(fmt, sc.theme)}</style>
<div id="root" data-composition-id="${id}" data-start="0" data-duration="${sc.dur.toFixed(2)}" data-width="${w}" data-height="${h}">${sc.bg}<div class="in">${sc.html}</div></div>
<script>
const tl = gsap.timeline({ paused: true });
${js.join('\n')}
window.__timelines["${id}"] = tl;
</script>
</template>
</body></html>`);
    hosts.push(`<div id="${id}" class="host" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${t.toFixed(2)}" data-duration="${sc.dur.toFixed(2)}" data-track-index="0" data-width="${w}" data-height="${h}"></div>`);
    t += sc.dur;
  });
  v.total = Math.round(t * 100) / 100;
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=${w}, height=${h}"/>
<title>VEYRA SOLUCIONES · ${v.title} · ${fmt === 'p' ? '9:16' : '16:9'}</title>
<script src="assets/gsap.min.js"></script>
<style>html,body{width:${w}px;height:${h}px;margin:0;background:#080f2e;overflow:hidden}#root{position:relative;width:100%;height:100%;overflow:hidden}.host{position:absolute;inset:0}</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${v.total}" data-width="${w}" data-height="${h}" data-fps="30">
${hosts.join('\n')}
<audio id="music" src="assets/${v.music}" data-start="0" data-duration="${v.total}" data-track-index="1" data-volume="1"></audio>
</div>
<script>
const tl = gsap.timeline({ paused: true });
window.__timelines["main"] = tl;
</script></body></html>`);
  return name;
}

fs.mkdirSync(PROJECTS, { recursive: true });
for (const k of Object.keys(V)) for (const f of ['p', 'l']) console.log(build(k, f), V[k].total);
fs.writeFileSync(path.join(PROJECTS, 'videos.json'), JSON.stringify(Object.fromEntries(Object.entries(V).map(([k, v]) => [k, { slug: v.slug, title: v.title, dur: v.total, poster: v.poster, scenes: v.scenes.map((s) => s.dur) }])), null, 2));

#!/usr/bin/env node
// tiempos.mjs · cuánto tiempo llevó cada tarea en cada proyecto, con datos reales.
//
// Existe para cotizar: si "pagos con MercadoPago" ya se hizo en tres proyectos,
// el número para el cuarto sale del promedio de esos tres y no de la intuición.
//
// Lee tres fuentes, todas en solo lectura:
//   1. Las transcripciones de Claude Code (~/.claude/projects/**.jsonl): de cada
//      línea usa el timestamp, el cwd y, para clasificar el tema, los primeros
//      200 caracteres de los mensajes del usuario. No guarda ni escribe texto de
//      los chats en ningún lado: solo nombres de temas y números.
//   2. El git de cada repo en ~/Documents/GitHub (git log --all, sin merges).
//   3. manual.csv, para el que no usa Claude Code (ver README).
//
// Método: los eventos de un proyecto se agrupan en sesiones (un hueco mayor al
// corte, 45 min por defecto, corta la sesión; cada sesión suma su duración más
// 15 min de arranque). Las sesiones con transcripción son tiempo MEDIDO. Las que
// solo tienen commits (antes de que existan transcripciones, o de gente que no
// usa Claude Code) son tiempo ESTIMADO: su duración por un factor que se calibra
// comparando, donde hay las dos cosas, las horas medidas contra las que darían
// los commits solos.
//
// Uso:
//   node tiempos.mjs [--transcripciones DIR] [--repos DIR] [--corte 45]
//                    [--arranque 15] [--salida DIR] [--manual ARCHIVO] [--config ARCHIVO]
//                    [--desde-transcripciones AAAA-MM-DD]
//
// Sin dependencias: solo node (18+) y git en el PATH.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ───────────────────────────── argumentos ─────────────────────────────

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const arg = (nombre, def) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const OPC = {
  transcripciones: arg('transcripciones', path.join(os.homedir(), '.claude', 'projects')),
  repos: arg('repos', path.join(os.homedir(), 'Documents', 'GitHub')),
  corteMin: Number(arg('corte', 45)),
  arranqueMin: Number(arg('arranque', 15)),
  salida: arg('salida', AQUI),
  manual: arg('manual', path.join(AQUI, 'manual.csv')),
  config: arg('config', path.join(AQUI, 'config.json')),
  desdeTranscripciones: arg('desde-transcripciones', null),
};
const CORTE = OPC.corteMin * 60_000;
const ARRANQUE = OPC.arranqueMin * 60_000;
const HORA = 3_600_000;
// Los días y meses se cuentan en la hora local de la máquina.
const DESFASE = -new Date().getTimezoneOffset() * 60_000;
const dia = (t) => new Date(t + DESFASE).toISOString().slice(0, 10);
const mes = (t) => dia(t).slice(0, 7);

// ───────────────────────────── catálogo ─────────────────────────────
// Tareas genéricas, con el mismo nombre en todos los proyectos. El tipo sale de
// la regla de "quién maneja el reloj" (ver el README):
//   propio · factor 0,3-0,4 · ajeno (comportamiento de terceros) · 0,5-0,6 ·
//   otro (alta de cuentas, tiendas, dominios, esperar a alguien) · 0,7-0,9.
// Los textos se comparan sin tildes y en minúscula. El orden desempata.

const TIPOS = {
  propio: 'Reloj propio (0,3-0,4)',
  ajeno: 'Propio, comportamiento ajeno (0,5-0,6)',
  otro: 'Reloj de otro (0,7-0,9)',
};

const CATALOGO = [
  ['auth', 'Login, registro y autenticación', 'propio', /\blogin|\blogout|sign.?(in|up)\b|\bregistr|\bauth|autentic|\bsso\b|oauth|contrasen|password|magic.?link|\botp\b|\bjwt\b/g],
  ['onboarding', 'Onboarding y alta de usuarios', 'propio', /onboarding|\bbienvenida|primeros? pasos|\bwizard|\balta (del|de la|de) |confirmacion (de|del) (mail|correo)|embudo de alta/g],
  ['pagos-mp', 'Pagos con MercadoPago', 'ajeno', /mercado.?pago|\bmp\b|preapproval|checkout|\bcobro|\bcobrar|tarjeta|pago recurrente/g],
  ['pagos-otros', 'Pagos con otras pasarelas (Stripe, Lemon, PayPal)', 'ajeno', /stripe|lemon.?squeezy|paddle|paypal|dlocal/g],
  ['billing-tiendas', 'Suscripciones y billing de tiendas', 'otro', /play billing|\bbilling|in.?app purchase|revenuecat|storekit/g],
  ['tiendas', 'Publicación en tiendas (Play / App Store)', 'otro', /play store|play console|google play|app store|testflight|prueba interna|ficha de (la )?(tienda|play)|store listing|\.aab\b/g],
  ['expo', 'App nativa (Expo / React Native)', 'ajeno', /\bexpo\b|react.?native|\beas\b|android|\bios\b|\bapk\b|nativa|\bmetro\b|capacitor|app movil/g],
  ['push', 'Notificaciones push', 'otro', /\bpush\b|notificacion|vapid|\bfcm\b|firebase|web.?push|avisos? al telefono/g],
  ['whatsapp', 'WhatsApp', 'otro', /whats.?app|\bwaba\b|cloud api de meta|wa\.me/g],
  ['emails', 'Emails transaccionales', 'otro', /resend|\be-?mails?\b|\bmails?\b|correo|smtp|\bdkim|\bspf\b|\bmx\b|newsletter/g],
  ['voz', 'Voz con IA (TTS / STT / tiempo real)', 'ajeno', /\bvoz\b|voice|\btts\b|\bstt\b|\baudio|realtime|tiempo real|elevenlabs|whisper|microfono/g],
  ['chat-ia', 'Chat con IA', 'ajeno', /\bchat|conversacion|asistente|tutor|chatbot|streaming|\bsse\b/g],
  ['contenido-ia', 'Generación de contenido con IA', 'ajeno', /\bclases?\b|\bgenera|gemini|\bprompts?\b|\bllm|openai|anthropic|modelo de ia|\bia\b|\bai\b|curricul|verificac|\bmatche|ranking|\bcv\b|carta de presentacion|examen|ejercicio/g],
  ['pdf', 'PDF e imprimibles', 'propio', /\bpdf|imprimib|\bhojas?\b|worksheet|\bprint/g],
  ['gamificacion', 'Gamificación (juegos, avatares, logros)', 'propio', /\bjuego|\bgames?\b|\bgemas?\b|avatar|\blogros?\b|\bracha|\bpuntos\b|badge|\bxp\b|interactiv/g],
  ['cupos', 'Cupos, topes y reglas de plan', 'propio', /\bcupos?\b|\btopes?\b|limite (de|diario)|\bcuota|\bgate\b|dia gratis|prueba gratis|\btrial|freemium/g],
  ['panel-usuario', 'Panel del usuario y métricas', 'propio', /\bpanel\b|dashboard|progreso|reporte semanal|resumen semanal|historial/g],
  ['admin', 'Panel de admin, alertas y backoffice', 'propio', /\badmin|backoffice|telegram|\balertas?\b/g],
  ['seo', 'SEO', 'propio', /\bseo\b|sitemap|og.?tags?|og.?image|meta.?tags?|search console|schema\.org|robots\.txt|indexa/g],
  ['landing', 'Landing y web de marketing', 'propio', /landing|\bhero\b|portfolio|\bsitio\b|\bweb\b|pagina principal|scroll|cinemat|plantilla/g],
  ['legales', 'Legales y políticas', 'propio', /terminos|privacidad|\blegal|politicas? de|cookies|coppa|consentimiento|\bgdpr|borrado de cuenta|eliminar (la )?cuenta/g],
  ['seguridad', 'Seguridad, anti-spam y protección de menores', 'ajeno', /seguridad|\brls\b|rate.?limit|anti.?spam|captcha|turnstile|moderacion|safety|vulnerab|\bxss|csrf|menores|hardening/g],
  ['analitica', 'Analítica y telemetría', 'propio', /umami|analytics|telemetr|\bmetricas?\b|posthog|embudo|logrocket|sentry|mixpanel|\bkpi/g],
  ['i18n', 'Internacionalización y localización', 'propio', /i18n|traduc|idiomas?|neutro|voseo|latam|\blocale|monedas?|multi.?pais/g],
  ['integraciones', 'Integraciones con APIs de terceros', 'ajeno', /webhook|integracion|api externa|tokko|clover|\bn8n|\bcrm\b|scrap|crawler|ingesta|\bmcp\b|google (sheets|calendar|drive)/g],
  ['crecimiento', 'Referidos, campañas y crecimiento', 'propio', /referid|campana|marketing|growth|invitacion|\bcupon|\bpromo|retencion|reactivar/g],
  ['video', 'Video y material de producto', 'propio', /\bvideo|remotion|\bdemo\b|screenshot|capturas?\b|grabar|grabacion/g],
  ['datos', 'Base de datos y migraciones', 'propio', /migracion|\bmig \d|supabase|postgres|\bsql\b|esquema|\brpc\b|edge function/g],
  ['infra', 'Despliegue e infraestructura', 'otro', /deploy|despleg|caddy|coolify|\bvps\b|docker|github actions|\bci\b|vercel|netlify|\bdns\b|cloudflare|backup|nginx|servidor|\bssh\b|staging|\bcron/g],
  ['rediseno', 'Rediseño UI y design system', 'propio', /redisen|mobile.?first|responsive|design.?system|\btokens?\b|\bui\b|\bux\b|estilos?\b|dark mode|tipografia|iconos?\b|\bcss\b|tailwind|layout/g],
  ['tests', 'Tests y QA', 'propio', /\btests?\b|testing|\be2e\b|playwright|vitest|\bjest\b|\bsmoke|\bhumo\b|\bqa\b/g],
  ['crud', 'CRUD, listados y pantallas de producto', 'propio', /\bcrud|listado|formulario|\bperfil|\babm\b|filtros?\b|buscador|pantalla/g],
  ['docs-negocio', 'Documentación, investigación y negocio', 'propio', /plan de negocio|pitch|financier|cotizac|propuesta|unit economics|competencia|competidor|investiga|openspec|\bdocs?\b|readme|tesis|presupuesto|pricing|estrategia/g],
  ['mantenimiento', 'Mantenimiento, bugs y refactors', 'propio', /\bfix|\bbug|errores?\b|arregl|refactor|limpie|dependenc|actualiz|\brompe|no anda|falla/g],
];
const SIN = 'sin-clasificar';
const CAT = Object.fromEntries(CATALOGO.map(([id, nombre, tipo]) => [id, { id, nombre, tipo }]));
CAT[SIN] = { id: SIN, nombre: 'Sin clasificar', tipo: null };
// mantenimiento solo gana si no hay nada más concreto.
const PESO_CAT = { mantenimiento: 0.4, crud: 0.6, 'docs-negocio': 0.7 };

// ───────────────────────────── configuración ─────────────────────────────
// Lo propio de cada persona vive en config.json, que no se versiona: quién es, con
// quién trabaja y qué carpetas son qué proyecto. Sin config.json el script anda igual:
// cada carpeta de la carpeta de repos es un proyecto con su nombre, y la persona sale
// del git config. Ver config.ejemplo.json.
//
// proyectos[].carpetas:    patrones de nombre de carpeta que son ese proyecto, worktrees incluidos.
// proyectos[].palabras:    si una sesión arrancó en la carpeta raíz y un mensaje nombra el
//                          proyecto, esa sesión se le asigna.
// proyectos[].temas:       funcionalidades propias, cada una mapeada a una tarea del catálogo.
//                          Se prueban en orden antes que el catálogo genérico.
// proyectos[].carpetaTema: tema por defecto para un worktree dedicado a una rama.
// Los patrones son expresiones regulares escritas como texto ("^mi-app" o "/mi.?app/g").

const aRegex = (x) => {
  if (x instanceof RegExp) return x;
  const m = /^\/(.*)\/([a-z]*)$/.exec(x);
  return m ? new RegExp(m[1], m[2]) : new RegExp(x);
};
const gitConfig = (clave) => {
  try { return execFileSync('git', ['config', '--global', clave], { encoding: 'utf8' }).trim(); } catch { return ''; }
};
const escapar = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let CONFIG = {};
try { CONFIG = JSON.parse(fs.readFileSync(OPC.config, 'utf8')); } catch { /* sin config: todo por defecto */ }

const YO = CONFIG.yo || gitConfig('user.name').split(' ')[0] || 'Yo';

const PROYECTOS = (CONFIG.proyectos || []).map((p) => ({
  id: p.id, nombre: p.nombre || p.id,
  carpetas: (p.carpetas || []).map(aRegex),
  palabras: p.palabras ? aRegex(p.palabras) : null,
  temas: p.temas ? p.temas.map(([tema, cat, r]) => [tema, cat, aRegex(r)]) : undefined,
  carpetaTema: p.carpetaTema ? p.carpetaTema.map(([r, tema]) => [aRegex(r), tema]) : undefined,
}));

// Lo que no es un proyecto: herramientas, dependencias, temporales.
const NO_PROYECTO = aRegex(CONFIG.ignorarCarpetas || '^(node_modules|skills|tiempos-reales|\\.claude|memory)$');

// Autores de git. Los commits de Claude Code y de otros agentes los dispara quien los
// usa, así que cuentan como suyos. Los bots de CI no son trabajo. Los autores que no
// están en la lista (upstream de forks, gente de otros equipos) se ignoran.
const AGENTES = '^claude$|noreply@anthropic|gpt-engineer-app|^lovable|codex cli';
const PERSONAS = CONFIG.personas
  ? CONFIG.personas.map((p) => [p.nombre, aRegex(p.patron)])
  : [[YO, new RegExp([gitConfig('user.name'), gitConfig('user.email')].filter(Boolean).map((t) => escapar(t.toLowerCase())).concat(AGENTES).join('|'))]];
const quien = (nombre, mail) => {
  const s = `${nombre} ${mail}`.toLowerCase();
  if (/github-actions|dependabot|\[bot\]/.test(s) && !/gpt-engineer-app/.test(s)) return null;
  for (const [p, re] of PERSONAS) if (re.test(nombre.toLowerCase()) || re.test(mail.toLowerCase())) return p;
  return null;
};

// Otras carpetas, además de la de repos, donde hay proyectos (por ejemplo el escritorio).
const RAICES_EXTRA = (CONFIG.raicesExtra || []).map((r) => r.replace(/^~/, os.homedir()).split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase());

// ───────────────────────────── utilidades ─────────────────────────────

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const barra = (s) => (s || '').split(String.fromCharCode(92)).join('/');
const RAIZ = '__raiz__';
const proyectoPorId = Object.fromEntries(PROYECTOS.map((p) => [p.id, p]));

// Dado un cwd devuelve { proyecto, carpeta } o RAIZ o null (no es proyecto).
function proyectoDeRuta(ruta) {
  const r = barra(ruta).replace(/\/+$/, '').toLowerCase();
  if (!r) return null;
  const home = barra(os.homedir()).toLowerCase();
  const repos = barra(OPC.repos).toLowerCase();
  if (r === repos || r === home) return RAIZ;
  let carpeta = null;
  if (r.startsWith(repos + '/')) carpeta = r.slice(repos.length + 1).split('/')[0];
  else {
    const raiz = RAICES_EXTRA.find((x) => r.startsWith(x + '/'));
    if (raiz) carpeta = r.slice(raiz.length + 1).split('/')[0];
  }
  if (!carpeta || NO_PROYECTO.test(carpeta)) return null;
  for (const p of PROYECTOS) if (p.carpetas.some((re) => re.test(carpeta))) return { proyecto: p.id, carpeta };
  // Carpeta nueva que todavía no está en la lista: proyecto propio con su nombre.
  const id = carpeta.replace(/-wt-.*$/, '');
  if (!proyectoPorId[id]) proyectoPorId[id] = { id, nombre: id, carpetas: [], auto: true };
  return { proyecto: id, carpeta };
}

// Clasifica un texto para un proyecto. Devuelve { tema, cat } o null.
function clasificar(proyectoId, texto, rutas = '') {
  const t = norm(texto);
  const p = proyectoPorId[proyectoId];
  const etiqueta = /\[t:([a-z0-9-]+)\]/.exec(t);
  if (etiqueta && CAT[etiqueta[1]]) return { tema: CAT[etiqueta[1]].nombre, cat: etiqueta[1] };
  if (p?.temas) for (const [tema, cat, re] of p.temas) if (re.test(t)) return { tema, cat };
  const r = norm(rutas).replace(/[/_.\-]+/g, ' ');
  let mejor = null, max = 0;
  for (const [id, nombre, , re] of CATALOGO) {
    const n = ((t.match(re) || []).length * 2 + Math.min(3, (r.match(re) || []).length) * 0.5) * (PESO_CAT[id] ?? 1);
    if (n > max) { max = n; mejor = { tema: nombre, cat: id }; }
  }
  if (!mejor && p?.temas && r) for (const [tema, cat, re] of p.temas) if (re.test(r)) return { tema, cat };
  return mejor;
}

function temaDeCarpeta(proyectoId, carpeta) {
  const p = proyectoPorId[proyectoId];
  for (const [re, tema] of p?.carpetaTema || []) if (re.test(carpeta)) {
    const def = p.temas.find(([n]) => n === tema);
    return { tema, cat: def ? def[1] : SIN };
  }
  return null;
}

// Texto real escrito por el usuario (no resultados de herramientas ni avisos del sistema).
function textoDeUsuario(o) {
  if (o.isMeta) return null;
  const c = o.message?.content;
  let s = null;
  if (typeof c === 'string') s = c;
  else if (Array.isArray(c)) {
    if (c.some((x) => x?.type === 'tool_result')) return null;
    s = c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ');
  }
  if (!s) return null;
  s = s.trim();
  if (!s || /^<(command-|local-command|system-reminder|task-notification|bash-)|^caveat:/i.test(s)) return null;
  return s.slice(0, 200);
}

function* archivos(dir) {
  let entradas = [];
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'memory') yield* archivos(p); }
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

// ───────────────────────────── 1 · transcripciones ─────────────────────────────

// eventos[proyecto] = [{ t, quien, tema, cat, fuente, humano, commit }]
const eventos = {};
const agregar = (proy, ev) => (eventos[proy] ||= []).push(ev);
let primeraTranscripcion = Infinity, raizSinProyecto = [], lineasLeidas = 0;

async function leerTranscripciones() {
  for (const f of archivos(OPC.transcripciones)) {
    const conv = { proyecto: null, tema: {} }; // estado por archivo (conversación o subagente)
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const linea of rl) {
      if (!linea.includes('"timestamp"')) continue;
      if (!linea.includes('"type":"user"') && !linea.includes('"type":"assistant"')) continue;
      let o;
      try { o = JSON.parse(linea); } catch { continue; }
      if (o.type !== 'user' && o.type !== 'assistant') continue;
      const t = Date.parse(o.timestamp);
      if (!Number.isFinite(t)) continue;
      lineasLeidas++;
      if (t < primeraTranscripcion) primeraTranscripcion = t;
      const texto = o.type === 'user' ? textoDeUsuario(o) : null;
      let ubic = proyectoDeRuta(o.cwd);
      let fuenteProy = 'cwd';
      if (ubic === RAIZ) {
        if (texto) {
          const tn = norm(texto);
          let mejor = null, pos = Infinity;
          for (const p of PROYECTOS) {
            const m = p.palabras && p.palabras.exec(tn);
            if (m && m.index < pos) { pos = m.index; mejor = p.id; }
          }
          if (mejor) conv.proyecto = mejor;
        }
        if (!conv.proyecto) { raizSinProyecto.push({ t }); continue; }
        ubic = { proyecto: conv.proyecto, carpeta: '' };
        fuenteProy = 'raiz';
      }
      if (!ubic) continue;
      const { proyecto, carpeta } = ubic;
      if (texto) {
        const c = clasificar(proyecto, texto);
        if (c) conv.tema[proyecto] = { ...c, fuente: fuenteProy === 'raiz' ? 'raiz' : 'mensaje' };
      }
      let tc = conv.tema[proyecto];
      if (!tc) { const d = temaDeCarpeta(proyecto, carpeta); if (d) tc = { ...d, fuente: 'carpeta' }; }
      tc ||= { tema: CAT[SIN].nombre, cat: SIN, fuente: fuenteProy === 'raiz' ? 'raiz' : 'sin' };
      agregar(proyecto, { t, quien: YO, tema: tc.tema, cat: tc.cat, fuente: tc.fuente, humano: !!texto, commit: false });
    }
  }
}

// ───────────────────────────── 2 · git ─────────────────────────────

let commitsIgnorados = 0, commitsLeidos = 0;
function leerGit() {
  const vistos = new Set(), repos = new Set();
  let carpetas = [];
  try { carpetas = fs.readdirSync(OPC.repos, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  for (const d of carpetas) {
    const dir = path.join(OPC.repos, d.name);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const ubic = proyectoDeRuta(dir);
    if (!ubic || ubic === RAIZ) continue;
    let comun;
    try { comun = path.resolve(dir, execFileSync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()); } catch { continue; }
    if (repos.has(comun)) continue; // worktree de un repo ya leído
    repos.add(comun);
    let salida;
    try {
      salida = execFileSync('git', ['-C', dir, 'log', '--all', '--no-merges', '--format=%x1e%an%x1f%ae%x1f%aI%x1f%s', '--name-only'],
        { encoding: 'utf8', maxBuffer: 1 << 30 });
    } catch { continue; }
    for (const bloque of salida.split('\x1e').slice(1)) {
      const [cab, ...resto] = bloque.split('\n');
      const [an, ae, fecha, asunto] = cab.split('\x1f');
      const t = Date.parse(fecha);
      const p = quien(an, ae);
      if (!p) { commitsIgnorados++; continue; }
      const clave = `${ubic.proyecto}|${t}|${asunto}`;
      if (vistos.has(clave)) continue; // cherry-picks y rebases repiten el mismo commit
      vistos.add(clave);
      commitsLeidos++;
      const rutas = resto.filter(Boolean).slice(0, 40).join(' ');
      const c = clasificar(ubic.proyecto, asunto, rutas) || { tema: CAT[SIN].nombre, cat: SIN };
      agregar(ubic.proyecto, { t, quien: p, tema: c.tema, cat: c.cat, fuente: c.cat === SIN ? 'sin' : 'commit', humano: false, commit: true });
    }
  }
}

// ───────────────────────────── 3 · manual.csv ─────────────────────────────

const manuales = [];
function leerManual() {
  if (!fs.existsSync(OPC.manual)) return;
  for (const linea of fs.readFileSync(OPC.manual, 'utf8').split(/\r?\n/)) {
    if (!linea.trim() || linea.startsWith('#') || /^fecha,/i.test(linea)) continue;
    const [fecha, proyecto, tarea, horas, persona = YO] = linea.split(',').map((s) => s.trim());
    const h = Number(String(horas).replace(',', '.'));
    if (!fecha || !proyecto || !Number.isFinite(h)) continue;
    const id = norm(proyecto);
    proyectoPorId[id] ||= { id, nombre: proyecto, carpetas: [], auto: true };
    const p = proyectoPorId[id];
    let cat = CAT[tarea] ? tarea : null, tema = cat ? CAT[cat].nombre : tarea;
    const def = p.temas?.find(([n]) => norm(n) === norm(tarea));
    if (def) { tema = def[0]; cat = def[1]; }
    if (!cat) { const c = clasificar(id, tarea); cat = c?.cat || SIN; }
    manuales.push({ t: Date.parse(`${fecha}T12:00:00Z`) - DESFASE, proyecto: id, quien: persona || YO, tema, cat, horas: h });
  }
}

// ───────────────────────────── sesiones ─────────────────────────────

function sesiones(evs) {
  const out = [];
  let actual = null;
  for (const e of evs) {
    if (!actual || e.t - actual.fin > CORTE) { actual = { ini: e.t, fin: e.t, evs: [] }; out.push(actual); }
    actual.fin = e.t;
    actual.evs.push(e);
  }
  for (const s of out) s.horas = (s.fin - s.ini + ARRANQUE) / HORA;
  return out;
}

// Cómo se reparte una sesión entre temas: por eventos de transcripción; lo que
// quedó sin clasificar se reparte según los commits de esa misma sesión. Si la
// sesión no tiene transcripción, por commits.
function reparto(s) {
  const pesos = new Map();
  const suma = (k, v, ev) => { const x = pesos.get(k) || { w: 0, tema: ev.tema, cat: ev.cat, fuente: ev.fuente }; x.w += v; pesos.set(k, x); };
  const trans = s.evs.filter((e) => !e.commit), commits = s.evs.filter((e) => e.commit && e.cat !== SIN);
  if (trans.length) {
    let sinClas = 0;
    for (const e of trans) if (e.cat === SIN) sinClas++; else suma(`${e.tema}|${e.fuente}`, 1, e);
    if (sinClas) {
      if (commits.length) for (const c of commits) suma(`${c.tema}|reparto`, sinClas / commits.length, { ...c, fuente: 'reparto' });
      else suma(`${CAT[SIN].nombre}|sin`, sinClas, { tema: CAT[SIN].nombre, cat: SIN, fuente: 'sin' });
    }
  } else for (const c of s.evs) suma(`${c.tema}|${c.fuente}`, 1, c);
  const total = [...pesos.values()].reduce((a, x) => a + x.w, 0) || 1;
  return [...pesos.values()].map((x) => ({ ...x, frac: x.w / total }));
}

// ───────────────────────────── cálculo ─────────────────────────────

await leerTranscripciones();
leerGit();
leerManual();
if (OPC.desdeTranscripciones) primeraTranscripcion = Date.parse(`${OPC.desdeTranscripciones}T00:00:00-03:00`);

// Factor de calibración: en el período con transcripciones, horas medidas contra
// horas que darían los commits propios solos. Por proyecto si hay datos de sobra;
// si no, el factor conjunto.
const calib = {};
let medTot = 0, comTot = 0;
for (const [proy, evs] of Object.entries(eventos)) {
  const ax = evs.filter((e) => e.quien === YO && e.t >= primeraTranscripcion).sort((a, b) => a.t - b.t);
  const med = sesiones(ax).filter((s) => s.evs.some((e) => !e.commit)).reduce((a, s) => a + s.horas, 0);
  const cs = ax.filter((e) => e.commit);
  const com = sesiones(cs).reduce((a, s) => a + s.horas, 0);
  calib[proy] = { med, com, n: cs.length };
  if (cs.length >= 15 && med >= 5) { medTot += med; comTot += com; }
}
const acotar = (x) => Math.max(1, Math.min(6, x));
const FACTOR_GLOBAL = comTot ? acotar(medTot / comTot) : 2;
const factorDe = (proy) => {
  const c = calib[proy];
  return c && c.n >= 15 && c.med >= 5 && c.com > 0 ? { f: acotar(c.med / c.com), propio: true } : { f: FACTOR_GLOBAL, propio: false };
};

// Resultado por proyecto.
const R = {};
const relojPropio = []; // todos los eventos propios, para las horas de reloj sin superponer
for (const [proy, evsTodos] of Object.entries(eventos)) {
  const { f } = factorDe(proy);
  const r = R[proy] = { temas: {}, personas: {}, meses: {}, medido: 0, estimado: 0, crudo: 0, humano: 0, ini: Infinity, fin: -Infinity, sesiones: 0, commits: 0 };
  const porPersona = {};
  for (const e of evsTodos) (porPersona[e.quien] ||= []).push(e);
  for (const [persona, evs] of Object.entries(porPersona)) {
    evs.sort((a, b) => a.t - b.t);
    if (persona === YO) relojPropio.push(...evs);
    r.commits += evs.filter((e) => e.commit).length;
    const pr = r.personas[persona] ||= { medido: 0, estimado: 0, crudo: 0, sesiones: 0 };
    for (const s of sesiones(evs)) {
      const medida = s.evs.some((e) => !e.commit);
      const horas = medida ? s.horas : s.horas * f;
      r.sesiones++; pr.sesiones++;
      r.crudo += s.horas; pr.crudo += s.horas;
      if (medida) { r.medido += horas; pr.medido += horas; } else { r.estimado += horas; pr.estimado += horas; }
      r.ini = Math.min(r.ini, s.ini); r.fin = Math.max(r.fin, s.fin);
      const m = r.meses[mes(s.ini)] ||= { medido: 0, estimado: 0 };
      m[medida ? 'medido' : 'estimado'] += horas;
      for (const x of reparto(s)) {
        const h = horas * x.frac;
        const tm = r.temas[x.tema] ||= { tema: x.tema, cat: x.cat, medido: 0, estimado: 0, directo: 0, ini: Infinity, fin: -Infinity, sesiones: 0, personas: {} };
        tm[medida ? 'medido' : 'estimado'] += h;
        if (['mensaje', 'carpeta', 'commit', 'manual'].includes(x.fuente)) tm.directo += h;
        tm.personas[persona] = (tm.personas[persona] || 0) + h;
        if (h >= 0.25 || x.frac >= 0.25) { tm.sesiones++; tm.ini = Math.min(tm.ini, s.ini); tm.fin = Math.max(tm.fin, s.fin); }
      }
    }
    if (persona === YO) r.humano = sesiones(evs.filter((e) => e.humano)).reduce((a, s) => a + s.horas, 0);
  }
}
for (const m of manuales) {
  const r = R[m.proyecto] ||= { temas: {}, personas: {}, meses: {}, medido: 0, estimado: 0, crudo: 0, humano: 0, ini: Infinity, fin: -Infinity, sesiones: 0, commits: 0 };
  r.medido += m.horas; r.crudo += m.horas; r.sesiones++;
  r.ini = Math.min(r.ini, m.t); r.fin = Math.max(r.fin, m.t);
  const pr = r.personas[m.quien] ||= { medido: 0, estimado: 0, crudo: 0, sesiones: 0 };
  pr.medido += m.horas; pr.sesiones++;
  (r.meses[mes(m.t)] ||= { medido: 0, estimado: 0 }).medido += m.horas;
  const tm = r.temas[m.tema] ||= { tema: m.tema, cat: m.cat, medido: 0, estimado: 0, directo: 0, ini: Infinity, fin: -Infinity, sesiones: 0, personas: {} };
  tm.medido += m.horas; tm.directo += m.horas; tm.sesiones++;
  tm.personas[m.quien] = (tm.personas[m.quien] || 0) + m.horas;
  tm.ini = Math.min(tm.ini, m.t); tm.fin = Math.max(tm.fin, m.t);
}

relojPropio.sort((a, b) => a.t - b.t);
const horasRelojPropio = sesiones(relojPropio).reduce((a, s) => a + s.horas, 0);

// ───────────────────────────── informes ─────────────────────────────

const h1 = (x) => (Math.round(x * 10) / 10).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const h0 = (x) => Math.round(x).toLocaleString('es-AR');
const diasCal = (a, b) => (Number.isFinite(a) ? Math.round((Date.parse(dia(b)) - Date.parse(dia(a))) / 86_400_000) + 1 : 0);
const totalDe = (x) => x.medido + x.estimado;
const confianza = (tm) => {
  if (tm.cat === SIN) return 'baja';
  const tot = totalDe(tm) || 1;
  const pts = (tm.medido / tot) * 0.6 + (tm.directo / tot) * 0.4;
  if (tot < 1.5) return pts >= 0.65 ? 'media' : 'baja';
  return pts >= 0.65 ? 'alta' : pts >= 0.35 ? 'media' : 'baja';
};
const nombreProy = (id) => proyectoPorId[id]?.nombre || id;
const ordenProy = Object.keys(R).filter((p) => totalDe(R[p]) >= 0.5).sort((a, b) => totalDe(R[b]) - totalDe(R[a]));
const hoy = new Date().toISOString().slice(0, 10);
const PIE = `\n---\nGenerado por \`tiempos.mjs\` el ${hoy} · corte de sesión ${OPC.corteMin} min · arranque ${OPC.arranqueMin} min · transcripciones desde ${Number.isFinite(primeraTranscripcion) ? dia(primeraTranscripcion) : 'nunca'}.\n`;

fs.mkdirSync(path.join(OPC.salida, 'proyectos'), { recursive: true });

// Detalle por proyecto.
for (const p of ordenProy) {
  const r = R[p], fc = factorDe(p);
  const temas = Object.values(r.temas).filter((t) => totalDe(t) >= 0.1).sort((a, b) => totalDe(b) - totalDe(a));
  const L = [];
  L.push(`# ${nombreProy(p)} · tiempos reales\n`);
  L.push(`**${h0(totalDe(r))} h** en total (${h0(r.medido)} medidas, ${h0(r.estimado)} estimadas) · ${dia(r.ini)} → ${dia(r.fin)} (${diasCal(r.ini, r.fin)} días) · ${r.sesiones} sesiones · ${r.commits} commits.`);
  L.push(`De las medidas, ${h0(r.humano)} h tienen mensajes de ${YO} (el resto es Claude trabajando solo o subagentes).`);
  L.push(`Factor de los períodos sin transcripción: ×${h1(fc.f)} ${fc.propio ? '(calibrado en este proyecto)' : '(factor conjunto, este proyecto no tiene datos para calibrar el suyo)'}.\n`);
  L.push('## Por persona\n\n| Quién | Horas | Medidas | Estimadas | Sesiones |\n|---|--:|--:|--:|--:|');
  for (const [q, x] of Object.entries(r.personas).sort((a, b) => totalDe(b[1]) - totalDe(a[1])))
    L.push(`| ${q} | ${h1(totalDe(x))} | ${h1(x.medido)} | ${h1(x.estimado)} | ${x.sesiones} |`);
  L.push('\n## Por funcionalidad\n');
  L.push('| Funcionalidad | Tarea del catálogo | Horas | Medidas | Estimadas | Días calendario | Sesiones | Quién | Tipo de trabajo | Confianza |');
  L.push('|---|---|--:|--:|--:|--:|--:|---|---|---|');
  for (const t of temas) {
    const quienes = Object.entries(t.personas).sort((a, b) => b[1] - a[1]).map(([q, h]) => `${q} ${h0(h)}`).join(', ');
    L.push(`| ${t.tema} | ${CAT[t.cat].nombre} | ${h1(totalDe(t))} | ${h1(t.medido)} | ${h1(t.estimado)} | ${diasCal(t.ini, t.fin)} | ${t.sesiones} | ${quienes} | ${TIPOS[CAT[t.cat].tipo] || '—'} | ${confianza(t)} |`);
  }
  L.push('\n## Por mes\n\n| Mes | Horas | Medidas | Estimadas |\n|---|--:|--:|--:|');
  for (const [m, x] of Object.entries(r.meses).sort()) L.push(`| ${m} | ${h1(totalDe(x))} | ${h1(x.medido)} | ${h1(x.estimado)} |`);
  L.push('\nMedidas: sesiones con transcripción de Claude Code (o manual.csv). Estimadas: sesiones con commits solos, multiplicadas por el factor. Los días calendario van del primer al último día con al menos 15 minutos del tema, así que incluyen las pausas.');
  L.push(PIE);
  fs.writeFileSync(path.join(OPC.salida, 'proyectos', `${p}.md`), L.join('\n'));
}

// Catálogo: promedio por tarea genérica entre proyectos.
const porCat = {};
for (const p of ordenProy) for (const t of Object.values(R[p].temas)) {
  if (t.cat === SIN) continue;
  const c = porCat[t.cat] ||= {};
  const x = c[p] ||= { h: 0, medido: 0, directo: 0 };
  x.h += totalDe(t); x.medido += t.medido; x.directo += t.directo;
}
const MIN_VEZ = 1; // menos de una hora en un proyecto no cuenta como "una vez"
const filasCat = Object.entries(porCat).map(([cat, ps]) => {
  const vals = Object.entries(ps).filter(([, x]) => x.h >= MIN_VEZ).sort((a, b) => b[1].h - a[1].h);
  const hs = vals.map(([, x]) => x.h);
  const tot = hs.reduce((a, b) => a + b, 0);
  const med = vals.reduce((a, [, x]) => a + x.medido, 0), dir = vals.reduce((a, [, x]) => a + x.directo, 0);
  return { cat, vals, n: hs.length, tot, prom: hs.length ? tot / hs.length : 0, min: Math.min(...hs), max: Math.max(...hs), conf: confianza({ cat, medido: med, estimado: tot - med, directo: dir }) };
}).filter((f) => f.n > 0).sort((a, b) => b.tot - a.tot);

const totalSuma = ordenProy.reduce((a, p) => a + totalDe(R[p]), 0);
const totalMed = ordenProy.reduce((a, p) => a + R[p].medido, 0);
const mesesGlob = {};
for (const p of ordenProy) for (const [m, x] of Object.entries(R[p].meses)) {
  const g = mesesGlob[m] ||= { medido: 0, estimado: 0 }; g.medido += x.medido; g.estimado += x.estimado;
}
const iniG = Math.min(...ordenProy.map((p) => R[p].ini)), finG = Math.max(...ordenProy.map((p) => R[p].fin));

const C = [];
C.push('# Catálogo de tiempos reales por tarea\n');
C.push(`**${h0(totalSuma)} h** sumando todos los proyectos (${h0(totalMed)} medidas, ${h0(totalSuma - totalMed)} estimadas) · ${dia(iniG)} → ${dia(finG)} · ${ordenProy.length} proyectos.`);
C.push(`Horas de reloj de ${YO} sin superponer proyectos en paralelo: **${h0(horasRelojPropio)} h** (la suma por proyecto es mayor porque varias sesiones corren a la vez).`);
C.push(`Factor conjunto para lo que solo tiene commits: ×${h1(FACTOR_GLOBAL)}. Sesiones que arrancaron en la carpeta raíz sin nombrar un proyecto: ${h0(sesiones(raizSinProyecto.sort((a, b) => a.t - b.t)).reduce((a, s) => a + s.horas, 0))} h que no entran en ningún lado.\n`);
C.push('## Por tarea genérica\n');
C.push('Cada fila junta la misma tarea en todos los proyectos donde llevó al menos una hora. **Promedio** es el número para arrancar una cotización; mínimo y máximo dicen cuánto varía.\n');
C.push('| Tarea | Veces | Promedio h | Mín – máx h | Total h | Tipo de trabajo | Confianza | Proyectos (h) |');
C.push('|---|--:|--:|--:|--:|---|---|---|');
for (const f of filasCat)
  C.push(`| ${CAT[f.cat].nombre} | ${f.n} | ${h1(f.prom)} | ${h1(f.min)} – ${h1(f.max)} | ${h0(f.tot)} | ${TIPOS[CAT[f.cat].tipo]} | ${f.conf} | ${f.vals.map(([p, x]) => `${nombreProy(p)} ${h0(x.h)}`).join(' · ')} |`);
C.push('\n## Por proyecto\n\n| Proyecto | Horas | Medidas | Estimadas | Período | Sesiones | Detalle |\n|---|--:|--:|--:|---|--:|---|');
for (const p of ordenProy) {
  const r = R[p];
  C.push(`| ${nombreProy(p)} | ${h0(totalDe(r))} | ${h0(r.medido)} | ${h0(r.estimado)} | ${dia(r.ini)} → ${dia(r.fin)} | ${r.sesiones} | [ver](proyectos/${p}.md) |`);
}
C.push('\n## Por mes (todos los proyectos)\n\n| Mes | Horas | Medidas | Estimadas |\n|---|--:|--:|--:|');
for (const [m, x] of Object.entries(mesesGlob).sort()) C.push(`| ${m} | ${h0(totalDe(x))} | ${h0(x.medido)} | ${h0(x.estimado)} |`);
C.push('\nTipos de trabajo según quién maneja el reloj: el factor entre paréntesis es cuánto se achica una estimación tradicional trabajando con Claude Code. Confianza: alta si casi todo es tiempo medido y clasificado por el mensaje, la carpeta o el commit; baja si es mayormente estimado o repartido.');
C.push(PIE);
fs.writeFileSync(path.join(OPC.salida, 'catalogo.md'), C.join('\n'));

// Tablero: los mismos números en un HTML que se abre con doble clic, con valor por
// hora y cotizador. Los datos van embebidos porque una página abierta desde el disco
// no puede leer un archivo vecino.
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : 0);
const DATOS = {
  generado: hoy, desde: dia(iniG), hasta: dia(finG),
  total: r1(totalSuma), medido: r1(totalMed), estimado: r1(totalSuma - totalMed),
  reloj: r1(horasRelojPropio), factor: r1(FACTOR_GLOBAL),
  tipos: { propio: 'Reloj propio', ajeno: 'Propio, comportamiento ajeno', otro: 'Reloj de otro' },
  tareas: filasCat.map((f) => ({
    id: f.cat, nombre: CAT[f.cat].nombre, tipo: CAT[f.cat].tipo, n: f.n,
    prom: r1(f.prom), min: r1(f.min), max: r1(f.max), tot: r1(f.tot), conf: f.conf,
    proyectos: f.vals.map(([p, x]) => ({ nombre: nombreProy(p), h: r1(x.h) })),
  })),
  proyectos: ordenProy.map((p) => ({
    id: p, nombre: nombreProy(p), total: r1(totalDe(R[p])), medido: r1(R[p].medido), estimado: r1(R[p].estimado),
    ini: dia(R[p].ini), fin: dia(R[p].fin), sesiones: R[p].sesiones,
    temas: Object.values(R[p].temas).filter((t) => totalDe(t) >= 0.1).sort((a, b) => totalDe(b) - totalDe(a))
      .map((t) => ({ tema: t.tema, tarea: CAT[t.cat].nombre, h: r1(totalDe(t)), medido: r1(t.medido), estimado: r1(t.estimado), dias: diasCal(t.ini, t.fin), conf: confianza(t) })),
  })),
  meses: Object.entries(mesesGlob).sort().map(([m, x]) => ({ mes: m, medido: r1(x.medido), estimado: r1(x.estimado) })),
};
const PLANTILLA = path.join(AQUI, 'tablero.plantilla.html');
if (fs.existsSync(PLANTILLA)) {
  const marcaDatos = '/*__DATOS__*/null';
  const plantilla = fs.readFileSync(PLANTILLA, 'utf8');
  if (plantilla.includes(marcaDatos)) {
    const json = JSON.stringify(DATOS).split('<').join('\\u003c');
    fs.writeFileSync(path.join(OPC.salida, 'tablero.html'), plantilla.replace(marcaDatos, () => json));
    console.log(`Escrito: ${path.join(OPC.salida, 'tablero.html')}`);
  }
}


console.log(`Transcripciones: ${lineasLeidas.toLocaleString('es-AR')} mensajes · commits: ${commitsLeidos} (${commitsIgnorados} de terceros ignorados) · manual: ${manuales.length} filas`);
console.log(`Total: ${h0(totalSuma)} h (${h0(totalMed)} medidas) · reloj de ${YO} sin superponer: ${h0(horasRelojPropio)} h · factor conjunto ×${h1(FACTOR_GLOBAL)}`);
console.log(`Escrito: ${path.join(OPC.salida, 'catalogo.md')} y ${ordenProy.length} archivos en proyectos/`);

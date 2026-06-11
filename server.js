#!/usr/bin/env node
/**
 * OpenClaw Stack Ops — bridge server
 * ----------------------------------
 * Zero-dependency Node bridge between a running OpenClaw gateway and the
 * Stack Ops UI. It polls the OpenClaw CLI (JSON output), diffs background
 * task state, parses SHARP score lines, and streams normalized events to
 * the browser over Server-Sent Events (SSE).
 *
 *   GET  /                       → UI (static files from ./public)
 *   GET  /events                 → SSE stream of live events
 *   GET  /api/state              → snapshot { tasks, events }
 *   POST /api/run                → { message, agent? } dispatch a real task via the CLI
 *   GET  /api/projects           → list project folders under the projects root
 *   POST /api/projects           → { name } create a new project folder + AGENTS.md
 *   GET  /api/agents/models      → per-agent model overrides (+ fleet default)
 *   PUT  /api/agents/<id>/model  → { model } set/clear one agent's model override
 *   GET  /api/sitrep             → AI narrator: one-paragraph status of the fleet
 *
 * Every /api/* route (including the new ones above) is covered by the existing
 * STACKOPS_TOKEN auth gate — no per-route auth wiring needed.
 *
 * Config (env vars):
 *   PORT                   HTTP port            (default 7788)
 *   HOST                   bind address         (default 127.0.0.1 — keep it local!)
 *   OPENCLAW_BIN           CLI command          (default "openclaw")
 *   POLL_MS                poll interval in ms  (default 2500)
 *   STACKOPS_TOKEN         shared secret        (unset = no auth; set = require token
 *                                                on /api/* and /events — needed before
 *                                                exposing the bridge off localhost)
 *   STACKOPS_PROJECTS_ROOT projects root dir    (default "C:\\Work")
 *   STACKOPS_NARRATOR_MODEL sitrep narrator model (default "haiku")
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, spawn, spawnSync } = require('child_process');

const PORT = parseInt(process.env.PORT || '7788', 10);
const HOST = process.env.HOST || '127.0.0.1';
const BIN = process.env.OPENCLAW_BIN || 'openclaw';
const POLL_MS = Math.max(1000, parseInt(process.env.POLL_MS || '2500', 10));
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_WIN = process.platform === 'win32';
const PROJECTS_ROOT = process.env.STACKOPS_PROJECTS_ROOT || 'C:\\Work';
const NARRATOR_MODEL = process.env.STACKOPS_NARRATOR_MODEL || 'haiku';

// Optional shared-secret auth. When STACKOPS_TOKEN is set, every /api/* and
// /events request must present it (header or ?token=); static files stay open
// so the UI can load and prompt for the token. Unset = current local behavior.
const TOKEN = process.env.STACKOPS_TOKEN || '';
const AUTH_ON = TOKEN.length > 0;
const TOKEN_DIGEST = AUTH_ON ? crypto.createHash('sha256').update(TOKEN, 'utf8').digest() : null;

/* ----------------------------- state ----------------------------- */

const state = {
  startedAt: Date.now(),
  gatewayOk: null,          // null=unknown, true/false after first poll
  tasks: new Map(),         // taskId -> normalized task
  events: [],               // ring buffer of emitted events
  pollErrors: 0,
};
const MAX_EVENTS = 1000;
const sseClients = new Set();
let firstPollDone = false;
// Shared mutex for the two endpoints that read-modify-write openclaw.json
// (POST /api/fleet and PUT /api/agents/<id>/model). Without it, two concurrent
// writers race: each snapshots `original`, and a revert-on-invalid can clobber
// the other's just-written change. One config write at a time → second gets 409.
let configWriteInFlight = false;

/* --------------------------- helpers ------------------------------ */

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function agentFromSessionKey(key) {
  // "agent:security-rls:subagent:<uuid>" -> "security-rls"
  if (typeof key !== 'string') return null;
  const m = key.match(/^agent:([^:]+):/);
  return m ? m[1] : null;
}

const PROJECT_SESSION_RE = /^p-[a-z0-9-]+$/;
function sessionFromSessionKey(key) {
  // Project-thread id of the dispatching session, e.g.
  // "agent:architect:p-c-work-onlyreels" -> "p-c-work-onlyreels".
  // main/subagent/legacy keys (e.g. "agent:foo:subagent:<uuid>") -> null,
  // so the UI routes them to the "global" view.
  if (typeof key !== 'string') return null;
  const m = key.match(/^agent:[^:]+:(.+)$/);
  if (!m) return null;
  return PROJECT_SESSION_RE.test(m[1]) ? m[1] : null;
}

const SHARP_RE = /SHARP:\s*S\s*=\s*(\d)\s*H\s*=\s*(\d)\s*A\s*=\s*(\d)\s*R\s*=\s*(\d)\s*P\s*=\s*(\d)\s*TOTAL\s*=\s*(\d+)\s*\/\s*25\s*VERDICT\s*=\s*(APPROVE|REVISE)/i;
function parseSharp(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(SHARP_RE);
  if (!m) return null;
  return {
    S: +m[1], H: +m[2], A: +m[3], R: +m[4], P: +m[5],
    total: +m[6],
    verdict: m[7].toUpperCase(),
  };
}

function excerpt(text, max = 220) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function taskTitle(text) {
  if (typeof text !== 'string') return '';
  // First meaningful line of the dispatched prompt.
  const line = text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
  return excerpt(line, 160);
}

function runCli(args, timeoutMs = 30000) {
  // exec through the shell so the npm .cmd/.ps1 shim resolves on Windows.
  const cmd = `${BIN} ${args}`;
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      resolve(stdout || '');
    });
  });
}

/* ----------------------------- events ----------------------------- */

function pushEvent(evt) {
  evt.t = evt.t || Date.now();
  state.events.push(evt);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { /* dropped client; cleaned on close */ }
  }
}

/* ----------------------------- polling ---------------------------- */

function normalizeTask(raw) {
  const child = agentFromSessionKey(raw.childSessionKey) || raw.agentId || null;
  const requester = agentFromSessionKey(raw.requesterSessionKey) || null;
  const session = sessionFromSessionKey(raw.requesterSessionKey); // project thread, or null
  const summary = raw.progressSummary || raw.terminalSummary || '';
  const task = {
    taskId: raw.taskId,
    runtime: raw.runtime || 'subagent',
    child,
    requester,
    status: raw.status,                       // queued|running|succeeded|failed|timed_out|cancelled|lost
    deliveryStatus: raw.deliveryStatus || null,
    title: taskTitle(raw.task),
    summary: excerpt(summary, 600),
    sharp: parseSharp(summary),
    error: raw.error || null,
    createdAt: raw.createdAt || null,
    startedAt: raw.startedAt || raw.createdAt || null,
    endedAt: raw.endedAt || null,
  };
  // Optional contract field: only present for project-thread dispatches.
  if (session) task.session = session;
  return task;
}

function emitTransition(prev, cur) {
  const isCritic = cur.child && cur.child.endsWith('-critic');
  const selfRun = !cur.requester || cur.requester === cur.child; // top-level run (no dispatcher arrow)
  const session = cur.session; // undefined for non-project threads → dropped by JSON.stringify
  if (!prev) {
    // Newly discovered task.
    if (!selfRun) {
      pushEvent({
        type: 'spawn', a: cur.requester, to: cur.child,
        text: cur.title, taskId: cur.taskId, critic: isCritic, session,
        t: cur.startedAt || Date.now(),
      });
    }
    if (cur.status === 'running' || cur.status === 'queued') {
      pushEvent({ type: 'work', a: cur.child, text: cur.title, taskId: cur.taskId, critic: isCritic, session });
    }
  }
  const statusChanged = prev && prev.status !== cur.status;
  if ((statusChanged || !prev) && ['succeeded', 'failed', 'timed_out', 'cancelled', 'lost'].includes(cur.status)) {
    if (cur.status === 'succeeded') {
      pushEvent({
        type: 'done', a: cur.child, to: cur.requester,
        text: cur.summary || 'completado', sharp: cur.sharp,
        taskId: cur.taskId, critic: isCritic, session, t: cur.endedAt || Date.now(),
      });
    } else {
      pushEvent({
        type: 'fail', a: cur.child, to: cur.requester,
        text: cur.error || cur.status, taskId: cur.taskId, critic: isCritic, session,
        t: cur.endedAt || Date.now(),
      });
    }
  } else if (statusChanged && cur.status === 'running') {
    pushEvent({ type: 'work', a: cur.child, text: cur.title, taskId: cur.taskId, critic: isCritic, session });
  }
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const out = await runCli('tasks list --json');
    const data = JSON.parse(out);
    const list = Array.isArray(data.tasks) ? data.tasks : [];
    if (state.gatewayOk !== true) {
      state.gatewayOk = true;
      pushEvent({ type: 'sys', text: 'bridge conectado al gateway de OpenClaw' });
    }
    for (const raw of list) {
      if (!raw || !raw.taskId) continue;
      // Skip "cli" runtime mirrors of subagent sessions (same run shows up twice).
      if (raw.runtime === 'cli' && /:subagent:/.test(raw.childSessionKey || raw.requesterSessionKey || '')) continue;
      const cur = normalizeTask(raw);
      if (!cur.child) continue;
      const prev = state.tasks.get(cur.taskId) || null;
      // A later poll may omit requesterSessionKey; don't lose a session we already had.
      if (!cur.session && prev && prev.session) cur.session = prev.session;
      state.tasks.set(cur.taskId, cur);
      if (!firstPollDone) continue; // history is delivered via snapshot, not as live events
      if (!prev || prev.status !== cur.status) emitTransition(prev, cur);
    }
    if (!firstPollDone) {
      firstPollDone = true;
      log(`primer poll: ${state.tasks.size} tareas históricas cargadas`);
    }
    state.pollErrors = 0;
  } catch (err) {
    state.pollErrors++;
    if (state.gatewayOk !== false && state.pollErrors >= 2) {
      state.gatewayOk = false;
      pushEvent({ type: 'sys', text: 'sin respuesta del CLI/gateway de OpenClaw — ¿está corriendo? (openclaw gateway status)' });
      log('poll error:', String(err.message || err).slice(0, 200));
    }
  } finally {
    polling = false;
  }
}

/* --------------------------- dispatch ----------------------------- */

// Resolve the openclaw CLI entry so we can spawn node directly:
// no cmd.exe (no quoting limits) and no extra console window
// (windowsHide is broken when combined with detached — nodejs/node#21825).
let cliEntryCache = null;
function resolveCliEntry() {
  if (cliEntryCache !== null) return cliEntryCache;
  const candidates = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'openclaw.mjs'));
  candidates.push('/usr/local/lib/node_modules/openclaw/openclaw.mjs', '/usr/lib/node_modules/openclaw/openclaw.mjs');
  cliEntryCache = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || '';
  return cliEntryCache;
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
function extractReply(raw) {
  // Strip ANSI + banner/decoration lines, keep the agent's actual reply text.
  const lines = String(raw).replace(ANSI_RE, '').split('\n')
    .map(l => l.trim())
    .filter(l => l &&
      !/OpenClaw \d{4}\./.test(l) &&
      !/^[◇│└├─|]+$/.test(l) &&
      !/lobster in your shell/i.test(l));
  return excerpt(lines.join(' '), 500);
}

function dispatchRun(message, agent, sessionKey) {
  return new Promise((resolve, reject) => {
    const target = (agent || 'architect').replace(/[^a-zA-Z0-9_-]/g, '');
    const clean = String(message || '').trim();
    if (!clean) return reject(new Error('mensaje vacío'));
    const sk = sessionKey ? String(sessionKey).replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 80) : null;
    const logPath = path.join(__dirname, 'dispatch.log');
    fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] dispatch → ${target}${sk ? ` (session ${sk})` : ''}: ${clean.slice(0, 120)}\n`);

    const entry = resolveCliEntry();
    const args = ['agent', '--agent', target, '-m', clean];
    if (sk) args.push('--session-key', sk);
    let child;
    if (entry) {
      // Direct node spawn: hidden window, exact args, full output capture.
      child = spawn(process.execPath, [entry, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } else if (IS_WIN) {
      const safe = clean.replace(/"/g, "'"); // cmd quoting limitation (fallback path only)
      child = spawn('cmd.exe', ['/c', BIN, 'agent', '--agent', target, '-m', safe],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      child = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    let out = '';
    const cap = d => { out += d.toString(); if (out.length > 400000) out = out.slice(-200000); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', reject);
    // Only emit `session` when sk matches the documented p-<slug> contract; the
    // raw sk still drives --session-key above so arbitrary callers still dispatch.
    const session = (sk && PROJECT_SESSION_RE.test(sk)) ? sk : undefined;
    child.on('exit', (code) => {
      try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] run ${target} exited code=${code}\n${out.slice(-4000)}\n`); } catch { /* noop */ }
      if (code === 0) {
        pushEvent({ type: 'done', a: target, text: extractReply(out) || 'turno completado', session });
      } else {
        pushEvent({ type: 'fail', a: target, text: `el run terminó con código ${code} — revisa dispatch.log`, session });
      }
    });
    pushEvent({ type: 'sys', text: `tarea despachada a "${target}" — los spawns aparecerán en cuanto el orquestador reparta`, session });
    resolve({ ok: true, agent: target });
  });
}

/* ------------------------- projects (F1) -------------------------- */

// Shared path to the OpenClaw config (same file /api/fleet reads/writes).
function openclawCfgPath() {
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');
}

// Project-thread slug for a folder. MUST stay byte-for-byte identical to the UI
// helper `projSlug` (public/app.js:84): operator precedence makes the method
// chain (incl. slice(-40)) bind tighter than `+`, so slice(-40) is applied to
// the normalized body BEFORE the 'p-' prefix is concatenated.
function projectSlug(dir) {
  return 'p-' + dir.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-40);
}

function listProjects() {
  const root = PROJECTS_ROOT;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return { root, projects: [] }; } // root missing/unreadable → empty list, no crash
  const projects = [];
  for (const ent of entries) {
    try {
      if (!ent.isDirectory()) continue;            // direct subfolders only (skip files)
      const name = ent.name;
      if (name.startsWith('.') || name.startsWith('_')) continue; // ignore hidden/internal
      const dir = path.join(root, name);
      const slug = projectSlug(dir);
      const hasAgentsMd = fs.existsSync(path.join(dir, 'AGENTS.md'));
      const isGit = fs.existsSync(path.join(dir, '.git'));
      const hasThread = [...state.tasks.values()].some(t => t.session === slug);
      projects.push({ name, dir, slug, hasAgentsMd, isGit, hasThread });
    } catch { /* tolerate a single unreadable folder (permissions) — keep going */ }
  }
  return { root, projects };
}

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$/;

function starterAgentsMd(name) {
  // Minimal Spanish starter (UI text is Spanish; code/comments English).
  return [
    `# ${name}`,
    '',
    'Proyecto gestionado desde OpenClaw Stack Ops.',
    '',
    '## Stack',
    '',
    '- (describe aquí las tecnologías del proyecto)',
    '',
    '## Reglas',
    '',
    '- Código y comentarios en inglés; textos visibles en español.',
    '- No introducir dependencias sin justificarlo.',
    '- Cambios pequeños y verificables antes de continuar.',
    '',
  ].join('\n');
}

function createProject(name) {
  const root = PROJECTS_ROOT;
  // Hard validation: charset + length + no traversal + no trailing dot/space
  // (Windows silently strips a trailing '.'/' ', so the real folder name would
  // diverge from `name` and from the slug we return).
  if (typeof name !== 'string' || !PROJECT_NAME_RE.test(name) || name.includes('..') || /[. ]$/.test(name)) {
    throw Object.assign(new Error('nombre de proyecto inválido'), { code: 400 });
  }
  const dir = path.join(root, name);
  // Defense-in-depth against traversal: resolved path must stay inside the root.
  const rootResolved = path.resolve(root);
  const dirResolved = path.resolve(dir);
  if (dirResolved !== rootResolved && !dirResolved.startsWith(rootResolved + path.sep)) {
    throw Object.assign(new Error('nombre de proyecto inválido'), { code: 400 });
  }
  // Ensure the root exists (recursive is EEXIST-safe), then create the project
  // folder NON-recursively: a non-recursive mkdir throws EEXIST atomically if it
  // already exists, closing the TOCTOU gap a separate existsSync() check leaves.
  fs.mkdirSync(root, { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if (err.code === 'EEXIST') throw Object.assign(new Error('el proyecto ya existe'), { code: 409 });
    throw err;
  }
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), starterAgentsMd(name), 'utf8');
  return { name, dir, slug: projectSlug(dir) };
}

/* ------------------------- sitrep (F3) ---------------------------- */

// Cached CLI detection (resolveCliEntry-style): does the `claude` CLI exist?
// null = not yet probed; {ok, path} thereafter. claude.exe is a real binary on
// this box, so we can spawn the resolved path directly — no shell needed.
let claudeCli = null;
function detectClaude() {
  if (claudeCli !== null) return claudeCli;
  try {
    const probe = IS_WIN ? 'where' : 'which';
    const r = spawnSync(probe, ['claude'], { windowsHide: true, timeout: 5000 });
    if (r.status === 0) {
      const lines = String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (IS_WIN) {
        // spawn() with no shell can't launch a .cmd/.ps1 shim (EINVAL on Node
        // >=18.20), and `where` may list that shim first. Prefer a real .exe;
        // if PATH only has shims, degrade to disabled rather than spawn a dud.
        const exe = lines.find(l => /\.exe$/i.test(l));
        if (exe) { claudeCli = { ok: true, path: exe }; return claudeCli; }
        if (lines.length) { claudeCli = { ok: false, path: '' }; return claudeCli; }
      } else if (lines[0]) {
        claudeCli = { ok: true, path: lines[0] }; return claudeCli;
      }
    }
  } catch { /* fall through to a version probe */ }
  // Fallback probe for environments without where/which on PATH.
  try {
    const r = spawnSync('claude', ['--version'], { windowsHide: true, timeout: 6000, shell: IS_WIN });
    claudeCli = { ok: r.status === 0, path: 'claude' };
  } catch { claudeCli = { ok: false, path: '' }; }
  return claudeCli;
}

const sitrep = {
  text: null,        // last good narration (kept across CLI failures)
  t: null,           // timestamp of last good narration
  inFlight: false,   // anti-stampede lock: one generation at a time
  lastAttempt: 0,    // throttle marker (success OR failure) — caps gen to 1/60s
  lastCount: 0,      // ring length at last attempt
  lastT: 0,          // newest ring event timestamp at last attempt
};
const SITREP_MIN_MS = 60000;

// Tasks "running" for longer than this are crash leftovers (the gateway's own
// watchdogs cap real runs at 1h) — feeding them to the narrator as live work
// derails it into contradictions.
const SITREP_GHOST_MS = 4 * 60 * 60 * 1000;

function buildSitrepPrompt() {
  const now = Date.now();
  const hhmm = ms => new Date(ms).toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit' });
  const active = [...state.tasks.values()]
    .filter(t => (t.status === 'running' || t.status === 'queued')
      && t.startedAt && (now - t.startedAt) < SITREP_GHOST_MS)
    .slice(0, 30) // cap: Windows CreateProcess args ~32KB, an unbounded list breaks spawn silently
    .map(t => `- ${t.child} (desde ${hhmm(t.startedAt)}): ${excerpt(t.title, 80)}`);
  const recent = state.events.slice(-30).map(e => {
    const arrow = e.to ? `${e.a || '?'}→${e.to}` : (e.a || '?');
    const sh = e.sharp ? ` SHARP=${e.sharp.total}/25 ${e.sharp.verdict}` : '';
    const proj = e.session ? ` [proyecto ${e.session}]` : '';
    return `${hhmm(e.t || now)} [${e.type}]${proj} ${arrow}: ${excerpt(e.text || '', 80)}${sh}`;
  });
  return [
    'Eres SITREP, el narrador de estado embebido en el panel de monitoreo de una flota',
    'multi-agente de OpenClaw (un orquestador "architect" reparte trabajo a agentes',
    'especialistas por capa; agentes "-critic" revisan con la rúbrica SHARP, gate >=20/25).',
    'Tu salida se muestra TAL CUAL en el panel, sin intervención humana.',
    '',
    'REGLAS ABSOLUTAS:',
    '- Devuelve ÚNICAMENTE el resumen: 2-3 frases en español, sin markdown ni preámbulo.',
    '- NUNCA hagas preguntas, NUNCA pidas contexto, NUNCA digas que falta información.',
    '- Si no hay tareas activas: di que la flota está en reposo y cuál fue el último',
    '  movimiento relevante con su hora.',
    '- Nombra agentes y proyectos tal como aparecen; los veredictos SHARP son noticia.',
    '',
    `Hora actual: ${hhmm(now)}.`,
    '',
    'Tareas activas AHORA (filtradas, sin residuos de crashes):',
    active.length ? active.join('\n') : '(ninguna — flota en reposo)',
    '',
    'Eventos recientes (más nuevos al final):',
    recent.length ? recent.join('\n') : '(ninguno)',
  ].join('\n');
}

// Spawn the narrator with no shell (direct args, windowsHide), kill on timeout.
// Never throws: resolves to a sanitized string, or null on any failure.
function generateSitrep() {
  return new Promise((resolve) => {
    const cli = detectClaude();
    if (!cli.ok) return resolve(null);
    const args = ['-p', buildSitrepPrompt(), '--model', NARRATOR_MODEL];
    let child;
    try {
      child = spawn(cli.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { log('sitrep spawn error:', String(err.message || err)); return resolve(null); }
    let out = '', errOut = '';
    const killTimer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } }, 45000);
    child.stdout.on('data', d => { out += d.toString(); if (out.length > 20000) out = out.slice(-10000); });
    child.stderr.on('data', d => { errOut += d.toString(); });
    child.on('error', err => { clearTimeout(killTimer); log('sitrep cli error:', String(err.message || err)); resolve(null); });
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) { log('sitrep cli exit', code, excerpt(errOut, 160)); return resolve(null); }
      // Sanitize: strip ANSI, collapse whitespace, cap length.
      const text = excerpt(out.replace(ANSI_RE, '').replace(/\s+/g, ' ').trim(), 500);
      resolve(text || null);
    });
  });
}

/* ------------------------------ http ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    // Malformed percent-encoding (e.g. "/%" or "/%zz") makes decodeURIComponent
    // throw URIError. Static files are unauthenticated, so without this guard a
    // single bad request would crash the synchronous handler and kill the bridge.
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch { res.writeHead(400); return res.end('url inválida'); }
  let file = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  // Require the path separator so a sibling like `public-x` can't pass the prefix
  // check; `full === PUBLIC_DIR` (e.g. url "//") falls through and 404s on readFile.
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Normalize an error's `code` into a valid HTTP status. fs errors carry string
// codes ('ENOENT'), and runCli rejections carry the process exit code (e.g. 1);
// passing either to writeHead throws ERR_HTTP_INVALID_STATUS_CODE inside an
// async callback → uncaughtException → dead bridge. Only honor explicit 4xx/5xx.
function httpCode(err) {
  return Number.isInteger(err && err.code) && err.code >= 400 && err.code <= 599 ? err.code : 400;
}

function extractToken(req) {
  // EventSource can't set headers, so ?token= is the SSE path; fetches use headers.
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const x = req.headers['x-stackops-token'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  const qi = (req.url || '').indexOf('?');
  if (qi !== -1) {
    // Defensive: never let query-string parsing throw on malformed network input.
    try {
      const t = new URLSearchParams(req.url.slice(qi + 1)).get('token');
      if (t) return t;
    } catch { /* malformed query string → treat as no token */ }
  }
  return null;
}

function tokenOk(req) {
  if (!AUTH_ON) return true;
  const provided = extractToken(req);
  if (!provided) return false;
  // Hash both sides to a fixed 32-byte digest: timing-safe and length-blind.
  const got = crypto.createHash('sha256').update(provided, 'utf8').digest();
  return crypto.timingSafeEqual(got, TOKEN_DIGEST);
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  // Auth gate: protect data/dispatch surfaces; static files stay open so the
  // UI can load and prompt for the token (they expose no fleet data).
  if (AUTH_ON && (url === '/events' || url.startsWith('/api/')) && !tokenOk(req)) {
    return json(res, 401, { ok: false, error: 'token requerido' });
  }

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    // initial snapshot so the UI can render history immediately
    const snapshot = {
      type: 'snapshot',
      t: Date.now(),
      gatewayOk: state.gatewayOk,
      tasks: [...state.tasks.values()],
      events: state.events.slice(-200),
    };
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url === '/api/state') {
    return json(res, 200, {
      gatewayOk: state.gatewayOk,
      startedAt: state.startedAt,
      tasks: [...state.tasks.values()],
      events: state.events.slice(-300),
    });
  }

  if (url === '/api/fleet') {
    // Fleet control: read or switch the whole fleet's model + thinking effort.
    const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');
    if (req.method === 'GET') {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const d = cfg.agents?.defaults || {};
        return json(res, 200, {
          ok: true,
          model: d.model?.primary || null,
          thinking: d.thinkingDefault || 'off',
          subagentThinking: d.subagents?.thinking || null,
          running: [...state.tasks.values()].filter(t => t.status === 'running' || t.status === 'queued').length,
        });
      } catch (err) { return json(res, 500, { ok: false, error: String(err.message || err) }); }
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 16 * 1024) req.destroy(); });
      req.on('end', async () => {
        if (configWriteInFlight) {
          return json(res, 409, { ok: false, error: 'otra operación de config en curso' });
        }
        configWriteInFlight = true;
        try {
          const { model, thinking } = JSON.parse(body || '{}');
          const VALID_THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max'];
          if (model && !/^[a-z0-9/._-]+$/i.test(model)) throw new Error('modelo inválido');
          if (thinking && !VALID_THINKING.includes(thinking)) throw new Error('thinking inválido');
          const original = fs.readFileSync(cfgPath, 'utf8'); // snapshot for revert-on-invalid
          const cfg = JSON.parse(original);
          cfg.agents = cfg.agents || {}; cfg.agents.defaults = cfg.agents.defaults || {};
          const d = cfg.agents.defaults;
          if (model) {
            d.models = d.models || {};
            if (model.startsWith('anthropic/') && !d.models[model]) {
              d.models[model] = { agentRuntime: { id: 'claude-cli' } }; // route through the local Claude CLI
            }
            d.model = d.model || {};
            d.model.primary = model;
          }
          if (thinking) {
            d.thinkingDefault = thinking;
            d.subagents = d.subagents || {};
            d.subagents.thinking = thinking; // specialists + critics spawns too
          }
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
          const validate = await runCli('config validate');
          if (!/Config valid/i.test(validate)) {
            try { fs.writeFileSync(cfgPath, original, 'utf8'); } catch { /* best-effort revert */ }
            throw new Error('config no validó (revertido): ' + excerpt(validate, 200));
          }
          const restart = await runCli('gateway restart', 90000);
          pushEvent({ type: 'sys', text: `FLOTA actualizada → modelo: ${model || 'sin cambio'} · effort: ${thinking || 'sin cambio'} · gateway reiniciado` });
          json(res, 200, { ok: true, model: model || null, thinking: thinking || null, restarted: /Restart/i.test(restart) });
        } catch (err) {
          json(res, 400, { ok: false, error: String(err.message || err) });
        } finally {
          configWriteInFlight = false;
        }
      });
      return;
    }
  }

  if (url === '/api/upload' && req.method === 'POST') {
    // Save a pasted/dropped image so file-reading agent runtimes can see it.
    let body = '';
    req.on('data', c => { body += c; if (body.length > 24 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, dataBase64, dir } = JSON.parse(body || '{}');
        const ext = (path.extname(name || '') || '.png').toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) throw new Error('solo imágenes png/jpg/gif/webp');
        const buf = Buffer.from(String(dataBase64 || ''), 'base64');
        if (!buf.length) throw new Error('imagen vacía');
        if (buf.length > 16 * 1024 * 1024) throw new Error('imagen > 16MB');
        const baseDir = (dir && path.isAbsolute(dir)) ? path.join(dir, '_inbox') : path.join(__dirname, 'inbox');
        fs.mkdirSync(baseDir, { recursive: true });
        const file = path.join(baseDir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`);
        fs.writeFileSync(file, buf);
        json(res, 200, { ok: true, path: file });
      } catch (err) {
        json(res, 400, { ok: false, error: String(err.message || err) });
      }
    });
    return;
  }

  if (url === '/api/run' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const { message, agent, sessionKey } = JSON.parse(body || '{}');
        const out = await dispatchRun(message, agent, sessionKey);
        json(res, 200, out);
      } catch (err) {
        json(res, 400, { ok: false, error: String(err.message || err) });
      }
    });
    return;
  }

  /* --- F1: projects --- */
  if (url === '/api/projects') {
    if (req.method === 'GET') {
      try { return json(res, 200, { ok: true, ...listProjects() }); }
      catch (err) { return json(res, 500, { ok: false, error: String(err.message || err) }); }
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 16 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const { name } = JSON.parse(body || '{}');
          json(res, 200, { ok: true, ...createProject(name) });
        } catch (err) {
          json(res, httpCode(err), { ok: false, error: String(err.message || err) });
        }
      });
      return;
    }
  }

  /* --- F2: per-agent model (read) --- */
  if (url === '/api/agents/models' && req.method === 'GET') {
    try {
      const cfg = JSON.parse(fs.readFileSync(openclawCfgPath(), 'utf8'));
      const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
      return json(res, 200, {
        ok: true,
        default: cfg.agents?.defaults?.model?.primary || null,
        running: [...state.tasks.values()].filter(t => t.status === 'running' || t.status === 'queued').length,
        agents: list.map(a => ({ id: a.id, model: (typeof a.model === 'string' && a.model) ? a.model : null })),
      });
    } catch (err) { return json(res, 500, { ok: false, error: String(err.message || err) }); }
  }

  /* --- F2: per-agent model (write) — prefix/regex match for /api/agents/<id>/model --- */
  const agentModelMatch = url.match(/^\/api\/agents\/([^/]+)\/model$/);
  if (agentModelMatch && (req.method === 'PUT' || req.method === 'POST')) {
    // Malformed percent-encoding (e.g. /api/agents/%zz/model) makes
    // decodeURIComponent throw URIError synchronously, crashing the handler and
    // killing the bridge. Same guard serveStatic already has; bad <id> → 404.
    let id;
    try { id = decodeURIComponent(agentModelMatch[1]); }
    catch { return json(res, 404, { ok: false, error: 'agente no encontrado' }); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 16 * 1024) req.destroy(); });
    req.on('end', async () => {
      if (configWriteInFlight) {
        return json(res, 409, { ok: false, error: 'otra operación de config en curso' });
      }
      configWriteInFlight = true;
      try {
        const { model } = JSON.parse(body || '{}');
        // null/undefined/'' mean "remove override"; anything else must be a string.
        if (model !== undefined && model !== null && typeof model !== 'string') {
          throw new Error('modelo inválido');
        }
        const cfgPath = openclawCfgPath();
        const original = fs.readFileSync(cfgPath, 'utf8'); // snapshot for revert-on-invalid
        const cfg = JSON.parse(original);
        const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
        const entry = list.find(a => a.id === id);
        if (!entry) throw Object.assign(new Error('agente no encontrado'), { code: 404 });

        // model === '' / null → remove override (agent falls back to fleet default).
        const remove = model === '' || model === null || model === undefined;
        if (!remove && !/^[a-z0-9/._-]+$/i.test(model)) throw new Error('modelo inválido');

        if (remove) {
          delete entry.model;
        } else {
          // Same pattern as /api/fleet: register anthropic/* models with the local
          // Claude CLI runtime so the gateway can route to them.
          cfg.agents.defaults = cfg.agents.defaults || {};
          const d = cfg.agents.defaults;
          if (model.startsWith('anthropic/')) {
            d.models = d.models || {};
            if (!d.models[model]) d.models[model] = { agentRuntime: { id: 'claude-cli' } };
          }
          entry.model = model;
        }

        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
        const validate = await runCli('config validate');
        if (!/Config valid/i.test(validate)) {
          try { fs.writeFileSync(cfgPath, original, 'utf8'); } catch { /* best-effort revert */ }
          throw new Error('config no validó (revertido): ' + excerpt(validate, 200));
        }
        const restart = await runCli('gateway restart', 90000);
        pushEvent({ type: 'sys', text: `AGENTE "${id}" → modelo: ${remove ? 'heredado (default)' : model} · gateway reiniciado` });
        json(res, 200, { ok: true, id, model: remove ? null : model, restarted: /Restart/i.test(restart) });
      } catch (err) {
        json(res, httpCode(err), { ok: false, error: String(err.message || err) });
      } finally {
        configWriteInFlight = false;
      }
    });
    return;
  }

  /* --- F3: sitrep (AI narrator) --- */
  if (url === '/api/sitrep' && req.method === 'GET') {
    const cli = detectClaude();
    if (!cli.ok) return json(res, 200, { ok: false, disabled: true }); // silent degradation
    const now = Date.now();
    const active = [...state.tasks.values()].filter(t => t.status === 'running' || t.status === 'queued');
    const lastT = state.events.length ? state.events[state.events.length - 1].t : 0;
    const count = state.events.length;
    // Regenerate at most every 60s, and only when there's something to narrate:
    // active tasks OR new ring events since the last attempt.
    const newActivity = active.length > 0 || count !== sitrep.lastCount || lastT !== sitrep.lastT;
    const stale = !sitrep.lastAttempt || (now - sitrep.lastAttempt) >= SITREP_MIN_MS;
    if (sitrep.inFlight || !stale || !newActivity) {
      return json(res, 200, { ok: true, text: sitrep.text, t: sitrep.t, model: NARRATOR_MODEL });
    }
    sitrep.inFlight = true;
    sitrep.lastAttempt = now;
    sitrep.lastCount = count;
    sitrep.lastT = lastT;
    generateSitrep().then(text => {
      if (text) { sitrep.text = text; sitrep.t = Date.now(); } // keep last good on null
      sitrep.inFlight = false;
      json(res, 200, { ok: true, text: sitrep.text, t: sitrep.t, model: NARRATOR_MODEL });
    }).catch(err => {
      sitrep.inFlight = false;
      log('sitrep error:', String((err && err.message) || err));
      json(res, 200, { ok: true, text: sitrep.text, t: sitrep.t, model: NARRATOR_MODEL });
    });
    return;
  }

  serveStatic(req, res);
});

/* ------------------------------ boot ------------------------------ */

server.listen(PORT, HOST, () => {
  log(`OpenClaw Stack Ops → http://${HOST}:${PORT}`);
  log(`bridge: "${BIN}" · poll cada ${POLL_MS}ms`);
  log(AUTH_ON
    ? 'auth: ACTIVA (STACKOPS_TOKEN) — /api/* y /events exigen token'
    : 'auth: desactivada — solo para uso local (127.0.0.1)');
  poll();
  setInterval(poll, POLL_MS);
  setInterval(() => {
    for (const res of sseClients) { try { res.write(': hb\n\n'); } catch { /* noop */ } }
  }, 25000);
});

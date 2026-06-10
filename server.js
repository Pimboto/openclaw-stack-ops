#!/usr/bin/env node
/**
 * OpenClaw Stack Ops — bridge server
 * ----------------------------------
 * Zero-dependency Node bridge between a running OpenClaw gateway and the
 * Stack Ops UI. It polls the OpenClaw CLI (JSON output), diffs background
 * task state, parses SHARP score lines, and streams normalized events to
 * the browser over Server-Sent Events (SSE).
 *
 *   GET  /            → UI (static files from ./public)
 *   GET  /events      → SSE stream of live events
 *   GET  /api/state   → snapshot { tasks, events }
 *   POST /api/run     → { message, agent? } dispatch a real task via the CLI
 *
 * Config (env vars):
 *   PORT          HTTP port            (default 7788)
 *   HOST          bind address         (default 127.0.0.1 — keep it local!)
 *   OPENCLAW_BIN  CLI command          (default "openclaw")
 *   POLL_MS       poll interval in ms  (default 2500)
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '7788', 10);
const HOST = process.env.HOST || '127.0.0.1';
const BIN = process.env.OPENCLAW_BIN || 'openclaw';
const POLL_MS = Math.max(1000, parseInt(process.env.POLL_MS || '2500', 10));
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_WIN = process.platform === 'win32';

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
  const summary = raw.progressSummary || raw.terminalSummary || '';
  return {
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
}

function emitTransition(prev, cur) {
  const isCritic = cur.child && cur.child.endsWith('-critic');
  const selfRun = !cur.requester || cur.requester === cur.child; // top-level run (no dispatcher arrow)
  if (!prev) {
    // Newly discovered task.
    if (!selfRun) {
      pushEvent({
        type: 'spawn', a: cur.requester, to: cur.child,
        text: cur.title, taskId: cur.taskId, critic: isCritic,
        t: cur.startedAt || Date.now(),
      });
    }
    if (cur.status === 'running' || cur.status === 'queued') {
      pushEvent({ type: 'work', a: cur.child, text: cur.title, taskId: cur.taskId, critic: isCritic });
    }
  }
  const statusChanged = prev && prev.status !== cur.status;
  if ((statusChanged || !prev) && ['succeeded', 'failed', 'timed_out', 'cancelled', 'lost'].includes(cur.status)) {
    if (cur.status === 'succeeded') {
      pushEvent({
        type: 'done', a: cur.child, to: cur.requester,
        text: cur.summary || 'completado', sharp: cur.sharp,
        taskId: cur.taskId, critic: isCritic, t: cur.endedAt || Date.now(),
      });
    } else {
      pushEvent({
        type: 'fail', a: cur.child, to: cur.requester,
        text: cur.error || cur.status, taskId: cur.taskId, critic: isCritic,
        t: cur.endedAt || Date.now(),
      });
    }
  } else if (statusChanged && cur.status === 'running') {
    pushEvent({ type: 'work', a: cur.child, text: cur.title, taskId: cur.taskId, critic: isCritic });
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

function dispatchRun(message, agent) {
  return new Promise((resolve, reject) => {
    const target = (agent || 'architect').replace(/[^a-zA-Z0-9_-]/g, '');
    const clean = String(message || '').trim();
    if (!clean) return reject(new Error('mensaje vacío'));
    const logPath = path.join(__dirname, 'dispatch.log');
    const logFd = fs.openSync(logPath, 'a');
    fs.writeSync(logFd, `\n[${new Date().toISOString()}] dispatch → ${target}: ${clean.slice(0, 120)}\n`);
    let child;
    if (IS_WIN) {
      // Pass args separately so Node quotes each one for cmd.exe (compound strings break).
      const safe = clean.replace(/"/g, "'"); // cmd quoting limitation, documented in README
      child = spawn('cmd.exe', ['/c', BIN, 'agent', '--agent', target, '-m', safe],
        { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
    } else {
      child = spawn(BIN, ['agent', '--agent', target, '-m', clean],
        { detached: true, stdio: ['ignore', logFd, logFd] });
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      try { fs.writeSync(logFd, `[${new Date().toISOString()}] run exited code=${code}\n`); fs.closeSync(logFd); } catch { /* noop */ }
      if (code !== 0) pushEvent({ type: 'sys', text: `el run despachado terminó con código ${code} — revisa dispatch.log` });
    });
    child.unref();
    pushEvent({ type: 'sys', text: `tarea despachada a "${target}" — los spawns aparecerán en cuanto el orquestador reparta` });
    resolve({ ok: true, agent: target });
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
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
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

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

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
        const { message, agent } = JSON.parse(body || '{}');
        const out = await dispatchRun(message, agent);
        json(res, 200, out);
      } catch (err) {
        json(res, 400, { ok: false, error: String(err.message || err) });
      }
    });
    return;
  }

  serveStatic(req, res);
});

/* ------------------------------ boot ------------------------------ */

server.listen(PORT, HOST, () => {
  log(`OpenClaw Stack Ops → http://${HOST}:${PORT}`);
  log(`bridge: "${BIN}" · poll cada ${POLL_MS}ms`);
  poll();
  setInterval(poll, POLL_MS);
  setInterval(() => {
    for (const res of sseClients) { try { res.write(': hb\n\n'); } catch { /* noop */ } }
  }, 25000);
});

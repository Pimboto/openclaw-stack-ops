/* ============================================================
   OPENCLAW STACK OPS · app
   Two engines, one renderer:
   - LIVE: real events from the bridge (/events, SSE)
   - DEMO: scripted simulator (no gateway required)
   ============================================================ */
'use strict';

/* ---------- config ---------- */
const CFG = window.STACKOPS;
const GROUPS = CFG.groups;
const SPECIALISTS = CFG.agents;
const HUBCFG = CFG.hub;
const ALL = SPECIALISTS.map(a => a.id);

const AG = {};            // id -> meta (specialists + critics + hub)
const criticOf = {};      // specialist id -> critic id
const parentOf = {};      // critic id -> specialist id
SPECIALISTS.forEach(a => {
  AG[a.id] = { ...a, isCritic: false };
  if (a.critic) {
    criticOf[a.id] = a.critic;
    parentOf[a.critic] = a.id;
    AG[a.critic] = { id: a.critic, code: 'C', cap: 'critic', g: a.g, isCritic: true, desc: 'Crítico de arquitectura de la capa ' + a.cap + '. Califica con la rúbrica SHARP (S/H/A/R/P, 0-5). Gate: total >= 20 y ninguna dimensión <= 2.' };
  }
});
AG[HUBCFG.id] = { ...HUBCFG, g: 'build', isHub: true, isCritic: false };

/* ---------- dom ---------- */
const $ = id => document.getElementById(id);
const stage = $('stage'), net = $('net'), fx = $('fx'), feed = $('feed'), roster = $('roster');
const agentP = $('agentP'), hint = $('hint'), pill = $('pill'), pillTxt = $('pillTxt');
const tlWrap = $('tlWrap'), playhead = $('playhead');
const runBtn = $('run'), pauseBtn = $('pause'), resetBtn = $('reset'), speedSel = $('speed'), taskIn = $('task');
const ctx = fx.getContext('2d');
const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- shared state ---------- */
const ST = {
  mode: null,                 // 'live' | 'demo'
  selected: null,
  agents: {},                 // id -> {status,current,msgs[],sharp,collabs{},tokens}
  // demo engine
  vt: 0, running: false, paused: false, speed: 1,
  script: null, idx: 0, lastEnd: {}, doneFlag: {}, totals: { tk: 0, msg: 0 }, shownTk: 0, finished: false,
  // live engine
  live: { es: null, tasks: new Map(), t0: null, spawns: 0, ok: 0, fail: 0, dirty: false, firstEventAt: null },
};
let POS = {}, CPOS = {}, HUB = { x: 0, y: 0 }, particles = [], nodeEls = {}, cnodeEls = {}, rosterEls = {}, tlRows = {}, tlBarEls = [], firstTrack = null;

const STATUS_TXT = { idle: '·', on: 'LIVE', work: 'BUSY', done: 'OK', fail: 'ERR', skip: 'OFF' };
const STATUS_LONG = { idle: 'EN ESPERA', on: 'ACTIVO', work: 'TRABAJANDO…', done: 'LISTO ✓', fail: 'FALLÓ ✕', skip: 'STANDBY — NO REQUERIDO' };

function freshAgents() {
  const m = {};
  Object.keys(AG).forEach(id => { m[id] = { status: 'idle', current: null, msgs: [], sharp: null, collabs: {}, tokens: 0, activeUntil: 0 }; });
  return m;
}
const gcol = id => (GROUPS[AG[id]?.g] || GROUPS.other).c;
function fmtTk(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n); }
function fmtT(s) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0'); }
function fmtClock(ms) { const d = new Date(ms); return d.toTimeString().slice(0, 8); }
function ensureAgent(id) {
  // runtime discovery: unknown agent → add to "other"
  if (AG[id]) return;
  AG[id] = { id, code: id.slice(0, 6).toUpperCase(), cap: id, g: 'other', isCritic: id.endsWith('-critic'), desc: 'Agente descubierto en runtime (no está en agents.js).' };
  ST.agents[id] = { status: 'idle', current: null, msgs: [], sharp: null, collabs: {}, tokens: 0, activeUntil: 0 };
}

/* ============================================================
   RENDER: roster, legend, graph, timeline
   ============================================================ */
function buildRoster() {
  roster.innerHTML = '';
  let lastG = null;
  SPECIALISTS.forEach(a => {
    if (a.g !== lastG) {
      lastG = a.g;
      const g = document.createElement('div');
      g.className = 'rgroup';
      g.innerHTML = '<i style="background:' + GROUPS[a.g].c + '"></i>' + GROUPS[a.g].label;
      roster.appendChild(g);
    }
    const el = document.createElement('div');
    el.className = 'ritem'; el.dataset.st = 'idle'; el.dataset.a = a.id;
    el.style.setProperty('--agc', GROUPS[a.g].c);
    el.innerHTML =
      '<span class="code" style="color:' + GROUPS[a.g].c + '">' + a.code + '</span>' +
      '<span class="nm">' + a.cap + '</span>' +
      '<span class="sharp">·</span>' +
      '<span class="st"><b></b><span class="stx">·</span></span>';
    el.addEventListener('click', () => select(a.id));
    roster.appendChild(el);
    rosterEls[a.id] = el;
  });
  $('rosterCount').textContent = SPECIALISTS.length;
}

function buildLegend() {
  const L = $('legend');
  let h = '';
  Object.entries(GROUPS).forEach(([k, g]) => { if (k !== 'other') h += '<div class="row"><i style="background:' + g.c + '"></i>' + g.label + '</div>'; });
  h += '<div class="sep"></div>';
  h += '<div class="row"><i style="background:#fff;box-shadow:0 0 6px #fff"></i>trabajando</div>';
  h += '<div class="row"><i style="background:var(--green)"></i>listo</div>';
  h += '<div class="row"><i style="background:var(--violet)"></i>crítico revisando</div>';
  h += '<div class="row"><i style="background:transparent;border:1px dashed var(--dim);box-sizing:border-box"></i>standby</div>';
  L.innerHTML = h;
}

const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }

function buildGraph() {
  net.innerHTML = '';
  const spokes = el('g', {});
  net.appendChild(spokes);
  SPECIALISTS.forEach(a => {
    spokes.appendChild(el('line', { class: 'spoke', 'data-a': a.id }));
    if (a.critic) spokes.appendChild(el('line', { class: 'clink', 'data-c': a.critic }));
  });
  SPECIALISTS.forEach(a => {
    const g = el('g', { class: 'node', 'data-a': a.id, 'data-st': 'idle' });
    g.style.setProperty('--agc', GROUPS[a.g].c);
    g.appendChild(el('circle', { class: 'halo', r: 24 }));
    g.appendChild(el('circle', { class: 'ring', r: 24 }));
    const code = el('text', { class: 'code', y: 0 }); code.textContent = a.code; g.appendChild(code);
    const cap = el('text', { class: 'cap', y: 41 }); cap.textContent = a.cap; g.appendChild(cap);
    const sb = el('text', { class: 'sharpbadge', y: 55 }); sb.textContent = ''; g.appendChild(sb);
    const badge = el('g', { class: 'badge' });
    badge.appendChild(el('circle', { cx: 17, cy: -17, r: 7, fill: '#4ade80' }));
    const ck = el('text', { x: 17, y: -16.5, fill: '#06220f', 'font-size': '9', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-weight': '700' });
    ck.textContent = '✓'; badge.appendChild(ck);
    g.appendChild(badge);
    g.addEventListener('click', () => select(a.id));
    net.appendChild(g);
    nodeEls[a.id] = g;

    if (a.critic) {
      const c = el('g', { class: 'cnode', 'data-c': a.critic, 'data-st': 'idle' });
      c.appendChild(el('circle', { class: 'ring', r: 11 }));
      const lab = el('text', { class: 'lab', y: 0 }); lab.textContent = 'C'; c.appendChild(lab);
      c.addEventListener('click', (ev) => { ev.stopPropagation(); select(a.critic); });
      net.appendChild(c);
      cnodeEls[a.critic] = c;
    }
  });
  const hub = el('g', { class: 'hub' });
  hub.appendChild(el('circle', { class: 'ring', r: 33 }));
  const em = el('text', { class: 'emoji', y: -3 }); em.textContent = '🦞'; hub.appendChild(em);
  const hc = el('text', { class: 'cap', y: 50 }); hc.textContent = HUBCFG.cap; hub.appendChild(hc);
  hub.addEventListener('click', () => select(HUBCFG.id));
  net.appendChild(hub);
  nodeEls.__hub = hub;
}

function layout() {
  const w = stage.clientWidth, h = stage.clientHeight;
  net.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  fx.width = w * devicePixelRatio; fx.height = h * devicePixelRatio;
  fx.style.width = w + 'px'; fx.style.height = h + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const cx = w / 2, cy = h * 0.47;
  const R = Math.max(120, Math.min(w, h * 0.96) / 2 - 104);
  HUB = { x: cx, y: cy };
  SPECIALISTS.forEach((a, i) => {
    const ang = (-90 + i * (360 / SPECIALISTS.length)) * Math.PI / 180;
    POS[a.id] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
    nodeEls[a.id].setAttribute('transform', 'translate(' + POS[a.id].x + ',' + POS[a.id].y + ')');
    if (a.critic) {
      CPOS[a.critic] = { x: cx + (R + 52) * Math.cos(ang), y: cy + (R + 52) * Math.sin(ang) };
      cnodeEls[a.critic].setAttribute('transform', 'translate(' + CPOS[a.critic].x + ',' + CPOS[a.critic].y + ')');
    }
  });
  nodeEls.__hub.setAttribute('transform', 'translate(' + cx + ',' + cy + ')');
  net.querySelectorAll('.spoke').forEach(ln => {
    const p = POS[ln.dataset.a];
    ln.setAttribute('x1', cx); ln.setAttribute('y1', cy);
    ln.setAttribute('x2', p.x); ln.setAttribute('y2', p.y);
  });
  net.querySelectorAll('.clink').forEach(ln => {
    const cid = ln.dataset.c, p = POS[parentOf[cid]], q = CPOS[cid];
    ln.setAttribute('x1', p.x); ln.setAttribute('y1', p.y);
    ln.setAttribute('x2', q.x); ln.setAttribute('y2', q.y);
  });
  net.querySelectorAll('.node .cap').forEach(c => c.style.display = w < 560 ? 'none' : '');
}

/* ---------- particles ---------- */
function nodePos(id) {
  if (id === HUBCFG.id || id === '__hub') return HUB;
  return POS[id] || CPOS[id] || null;
}
function spawnP(fromId, toId, color) {
  if (RM) return;
  const a = nodePos(fromId), b = nodePos(toId);
  if (!a || !b) return;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const chord = fromId !== HUBCFG.id && toId !== HUBCFG.id;
  const pull = chord ? 0.38 : 0;
  particles.push({
    x0: a.x, y0: a.y, x1: b.x, y1: b.y,
    cx: mx + (HUB.x - mx) * pull, cy: my + (HUB.y - my) * pull,
    born: performance.now() / 1000, dur: 0.9, color,
  });
}
function drawParticles() {
  ctx.clearRect(0, 0, fx.width, fx.height);
  const now = performance.now() / 1000;
  particles = particles.filter(p => (now - p.born) / p.dur < 1.45);
  particles.forEach(p => {
    const q = (now - p.born) / p.dur;
    const qa = Math.min(q, 1);
    ctx.globalAlpha = Math.max(0, (1.45 - q)) * 0.22;
    ctx.strokeStyle = p.color; ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(p.x0, p.y0);
    ctx.quadraticCurveTo(p.cx, p.cy, p.x1, p.y1);
    ctx.stroke();
    if (q <= 1) {
      const u = 1 - qa;
      const x = u * u * p.x0 + 2 * u * qa * p.cx + qa * qa * p.x1;
      const y = u * u * p.y0 + 2 * u * qa * p.cy + qa * qa * p.y1;
      ctx.globalAlpha = 0.95;
      ctx.shadowBlur = 11; ctx.shadowColor = p.color;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
  });
  ctx.globalAlpha = 1;
}

/* ---------- timeline ---------- */
function buildTimelineRows() {
  tlWrap.innerHTML = ''; tlRows = {};
  SPECIALISTS.forEach(a => {
    const r = document.createElement('div');
    r.className = 'tl-row'; r.dataset.a = a.id;
    r.innerHTML = '<span class="lab" style="color:' + GROUPS[a.g].c + '">' + a.code + '</span><div class="tl-track"></div>';
    tlWrap.appendChild(r);
    tlRows[a.id] = r;
  });
  firstTrack = tlWrap.querySelector('.tl-track');
}
function clearTimelineBars() {
  Object.values(tlRows).forEach(r => { r.querySelector('.tl-track').innerHTML = ''; r.dataset.st = ''; });
  tlBarEls = [];
}
function movePlayhead(frac) {
  if (!firstTrack) return;
  const tr = firstTrack.getBoundingClientRect();
  const tl = playhead.parentElement.getBoundingClientRect();
  playhead.style.left = (tr.left - tl.left + Math.max(0, Math.min(1, frac)) * tr.width) + 'px';
  playhead.style.opacity = 1;
}

/* ---------- feed ---------- */
function stamp() {
  return ST.mode === 'demo' ? fmtT(ST.vt) : fmtClock(Date.now());
}
function feedLine(cls, html, ts) {
  const d = document.createElement('div');
  d.className = 'fl ' + cls;
  d.innerHTML = '<span class="t">[' + (ts || stamp()) + ']</span>' + html;
  feed.appendChild(d);
  while (feed.children.length > 350) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}
const tag = id => '<span class="tag" style="color:' + (AG[id]?.isHub ? 'var(--coral)' : gcol(id)) + '">[' + (AG[id]?.isCritic ? (AG[parentOf[id]]?.code || '?') + '·C' : (AG[id]?.code || id)) + ']</span> ';
function sharpHtml(sh) {
  if (!sh) return '';
  const cls = sh.verdict === 'APPROVE' ? '' : ' warn';
  return '<br><span class="sharpline' + cls + '">SHARP ' + sh.S + '/' + sh.H + '/' + sh.A + '/' + sh.R + '/' + sh.P + ' · ' + sh.total + '/25 · ' + sh.verdict + '</span>';
}

/* ---------- status & sharp ---------- */
function setStatus(id, st) {
  ensureAgent(id);
  const ag = ST.agents[id];
  ag.status = st;
  if (nodeEls[id]) { nodeEls[id].dataset.st = st; }
  if (cnodeEls[id]) { cnodeEls[id].dataset.st = st; }
  if (rosterEls[id]) {
    rosterEls[id].dataset.st = st;
    rosterEls[id].querySelector('.stx').textContent = STATUS_TXT[st] || '·';
  }
  if (ST.selected === id) renderAgentPanel(id);
}
function setSharp(specId, sh) {
  if (!sh || !AG[specId]) return;
  ST.agents[specId].sharp = sh;
  const node = nodeEls[specId];
  if (node) {
    const b = node.querySelector('.sharpbadge');
    b.textContent = sh.total + '/25';
    b.classList.add('show');
    b.classList.toggle('ok', sh.verdict === 'APPROVE');
    b.classList.toggle('warn', sh.verdict !== 'APPROVE');
  }
  const r = rosterEls[specId];
  if (r) {
    const cell = r.querySelector('.sharp');
    cell.textContent = sh.total + '/25';
    cell.classList.toggle('ok', sh.verdict === 'APPROVE');
    cell.classList.toggle('warn', sh.verdict !== 'APPROVE');
  }
  if (ST.selected === specId) renderAgentPanel(specId);
}

/* ---------- agent panel ---------- */
function select(id) {
  ST.selected = id;
  Object.values(nodeEls).forEach(n => n.classList && n.classList.remove('sel'));
  Object.values(cnodeEls).forEach(n => n.classList.remove('sel'));
  Object.values(rosterEls).forEach(r => r.classList.remove('sel'));
  if (nodeEls[id]) nodeEls[id].classList.add('sel');
  if (cnodeEls[id]) cnodeEls[id].classList.add('sel');
  if (rosterEls[id]) rosterEls[id].classList.add('sel');
  renderAgentPanel(id);
  showTab('agent');
}
function renderAgentPanel(id) {
  const a = AG[id], ag = ST.agents[id];
  if (!a || !ag) return;
  const c = a.isHub ? 'var(--coral)' : gcol(id);
  const collabs = Object.entries(ag.collabs).sort((x, y) => y[1] - x[1]);
  let h = '';
  h += '<div class="ag-head"><div class="ag-dot" style="border-color:' + c + ';color:' + c + '">' + (a.isCritic ? 'C' : a.code) + '</div>';
  h += '<div><h3>' + (a.isCritic ? (AG[parentOf[id]]?.cap || '') + ' · Critic' : (a.cap || a.id)) + '</h3><div class="gtag" style="color:' + c + '">' + (a.isHub ? 'ORQUESTADOR' : (a.isCritic ? 'CRÍTICO SHARP' : GROUPS[a.g].label)) + '</div></div></div>';
  h += '<div class="ag-state">' + STATUS_LONG[ag.status] + '</div>';
  h += '<div class="ag-sec"><div class="k">ROL</div><div class="v muted">' + (a.desc || '—') + '</div></div>';
  h += '<div class="ag-sec"><div class="k">' + (ag.status === 'work' ? 'TRABAJANDO EN' : 'ÚLTIMA TAREA') + '</div><div class="v">' + (ag.current || '— todavía nada') + '</div></div>';
  const sh = ag.sharp || (a.isCritic ? ST.agents[parentOf[id]]?.sharp : null);
  if (sh) {
    h += '<div class="ag-sec"><div class="k">ÚLTIMO SHARP</div><div class="sharp-grid">';
    ['S', 'H', 'A', 'R', 'P'].forEach(d => {
      const n = sh[d];
      const col = n <= 2 ? 'var(--red)' : (n >= 4 ? 'var(--green)' : 'var(--amber)');
      h += '<div class="cell"><div class="d">' + d + '</div><div class="n" style="color:' + col + '">' + n + '</div></div>';
    });
    h += '</div><div class="sharp-total' + (sh.verdict === 'APPROVE' ? '' : ' warn') + '">' + sh.total + '/25 · ' + sh.verdict + '</div></div>';
  }
  if (ST.mode === 'demo' && !a.isCritic) {
    h += '<div class="ag-sec"><div class="k">TOKENS (DEMO)</div><div class="v">' + fmtTk(ag.tokens) + '</div></div>';
  }
  h += '<div class="ag-sec"><div class="k">HA TRABAJADO CON</div>';
  if (collabs.length) {
    h += '<div class="ag-collabs" style="display:flex;gap:6px;flex-wrap:wrap">' + collabs.map(([oid, n]) =>
      '<span style="font-size:10px;padding:4px 9px;border-radius:99px;border:1px solid ' + gcol(oid) + '55;color:var(--muted)"><b style="color:' + gcol(oid) + '">' + (AG[oid]?.code || oid) + '</b>×' + n + '</span>').join('') + '</div>';
  } else h += '<div class="v muted">— nadie aún</div>';
  h += '</div>';
  h += '<div class="ag-sec"><div class="k">ÚLTIMOS MENSAJES</div>';
  if (ag.msgs.length) {
    h += '<div class="ag-msgs">' + ag.msgs.slice(-6).reverse().map(m => {
      const arrow = m.dir === 'out' ? '→ <span class="who">' + (AG[m.other]?.code || m.other || '?') + '</span>' : '← <span class="who">' + (AG[m.other]?.code || m.other || '?') + '</span>';
      return '<div class="m">' + arrow + ' · ' + m.text + '</div>';
    }).join('') + '</div>';
  } else h += '<div class="v muted">— sin mensajes</div>';
  h += '</div>';
  h += '<button class="btn ag-back" id="agBack">← VOLVER AL FEED</button>';
  agentP.innerHTML = h;
  $('agBack').addEventListener('click', () => showTab('feed'));
}
function showTab(which) {
  const tf = $('tabFeed'), ta = $('tabAgent');
  if (which === 'agent') {
    if (!ST.selected) renderAgentEmpty();
    ta.classList.add('on'); tf.classList.remove('on');
    agentP.classList.add('on'); feed.style.display = 'none';
  } else {
    tf.classList.add('on'); ta.classList.remove('on');
    agentP.classList.remove('on'); feed.style.display = 'flex';
  }
}
function renderAgentEmpty() {
  agentP.innerHTML = '<div class="ag-empty">'
    + '<div class="glyph">⌖</div>'
    + '<div class="tit">Ningún agente seleccionado</div>'
    + '<div class="txt">Toca un nodo del anillo, un crítico satélite o un agente del roster para ver su detalle, su último SHARP y sus mensajes.</div>'
    + '<button class="btn ag-back" id="agBack">← VOLVER AL FEED</button>'
    + '</div>';
  $('agBack').addEventListener('click', () => showTab('feed'));
}
$('tabFeed').addEventListener('click', () => showTab('feed'));
$('tabAgent').addEventListener('click', () => showTab('agent'));

function recordMsg(a, b, text) {
  if (!a || !b) return;
  ensureAgent(a); ensureAgent(b);
  const A = ST.agents[a], B = ST.agents[b];
  A.collabs[b] = (A.collabs[b] || 0) + 1;
  B.collabs[a] = (B.collabs[a] || 0) + 1;
  A.msgs.push({ dir: 'out', other: b, text });
  B.msgs.push({ dir: 'in', other: a, text });
}

/* ---------- stats ---------- */
function setStatLabels() {
  if (ST.mode === 'live') {
    $('k0').textContent = 'RUNS COMPLETADOS';
    $('k1').textContent = 'SPAWNS DESPACHADOS';
    $('k2').textContent = 'TRABAJANDO AHORA';
    $('k3').textContent = 'VENTANA';
  } else {
    $('k0').textContent = 'TOKENS QUEMADOS';
    $('k1').textContent = 'MENSAJES ENTRE AGENTES';
    $('k2').textContent = 'AGENTES ACTIVOS';
    $('k3').textContent = 'TIEMPO';
  }
}
function updateStats() {
  if (ST.mode === 'live') {
    const L = ST.live;
    $('stTk').textContent = L.ok;
    $('stMsg').textContent = L.spawns;
    const working = ALL.filter(id => ST.agents[id]?.status === 'work').length;
    $('stAg').innerHTML = working + '<small>/' + ALL.length + '</small>';
    $('stTime').textContent = L.t0 ? fmtT((Date.now() - L.t0) / 1000) : '00:00';
    const total = L.ok + L.fail + [...L.tasks.values()].filter(t => !t.end).length;
    $('progFill').style.width = total ? Math.round(((L.ok + L.fail) / total) * 100) + '%' : '0%';
  } else {
    ST.shownTk += (ST.totals.tk - ST.shownTk) * 0.09;
    if (Math.abs(ST.totals.tk - ST.shownTk) < 1) ST.shownTk = ST.totals.tk;
    $('stTk').textContent = fmtTk(ST.shownTk);
    $('stMsg').textContent = ST.totals.msg;
    const act = ALL.filter(id => ['on', 'work', 'done'].includes(ST.agents[id]?.status)).length;
    $('stAg').innerHTML = act + '<small>/' + ALL.length + '</small>';
    $('stTime').textContent = fmtT(ST.vt);
    $('progFill').style.width = ST.script ? Math.min(100, ST.vt / ST.script.total * 100) + '%' : '0%';
  }
}

/* ============================================================
   LIVE ENGINE
   ============================================================ */
function liveRowFor(agentId) {
  // critic tasks land on their specialist's row
  if (parentOf[agentId]) return parentOf[agentId];
  return tlRows[agentId] ? agentId : null;
}
function rebuildLiveTimeline() {
  clearTimelineBars();
  const L = ST.live;
  if (!L.tasks.size) return;
  const now = Date.now();
  let t0 = Math.min(...[...L.tasks.values()].map(t => t.start));
  const span = Math.max(now - t0, 60_000);
  $('tlTitle').textContent = 'TIMELINE · RUNS REALES';
  for (const t of L.tasks.values()) {
    const row = liveRowFor(t.agent);
    if (!row) continue;
    const track = tlRows[row].querySelector('.tl-track');
    const bar = document.createElement('div');
    bar.className = 'tl-bar' + (t.critic ? ' critic' : '');
    const left = ((t.start - t0) / span) * 100;
    const width = (((t.end || now) - t.start) / span) * 100;
    bar.style.left = left + '%';
    bar.style.width = Math.max(0.5, width) + '%';
    const fill = document.createElement('i');
    fill.style.width = '100%';
    fill.style.background = t.status === 'fail' ? 'var(--red)' : gcol(row);
    if (!t.end) fill.style.opacity = '0.55';
    bar.appendChild(fill);
    track.appendChild(bar);
  }
  movePlayhead(1);
}

function liveHandle(evt) {
  const L = ST.live;
  if (!L.firstEventAt) L.firstEventAt = Date.now();
  switch (evt.type) {
    case 'sys':
      feedLine('sys', '<span class="tag">[BRIDGE]</span> ' + evt.text, fmtClock(evt.t));
      break;
    case 'spawn': {
      if (evt.a) ensureAgent(evt.a);
      if (evt.to) ensureAgent(evt.to);
      L.spawns++;
      if (!L.t0) L.t0 = evt.t || Date.now();
      L.tasks.set(evt.taskId, { agent: evt.to, start: evt.t || Date.now(), end: null, critic: !!evt.critic, status: 'run' });
      recordMsg(evt.a || HUBCFG.id, evt.to, evt.text || 'spawn');
      spawnP(evt.a || HUBCFG.id, evt.to, gcol(evt.to));
      feedLine('spawn' + (evt.critic ? ' critic' : ''), tag(evt.a || HUBCFG.id) + '<span class="arrow">→</span> ' + tag(evt.to) + (evt.text || ''), fmtClock(evt.t));
      L.dirty = true;
      break;
    }
    case 'work':
      if (!evt.a) break;
      ensureAgent(evt.a);
      setStatus(evt.a, 'work');
      ST.agents[evt.a].current = evt.text || null;
      break;
    case 'done': {
      if (!evt.a) break;
      ensureAgent(evt.a);
      setStatus(evt.a, 'done');
      ST.agents[evt.a].current = evt.text || ST.agents[evt.a].current;
      L.ok++;
      const t = L.tasks.get(evt.taskId);
      if (t) { t.end = evt.t || Date.now(); t.status = 'ok'; }
      if (evt.sharp) {
        // a critic's verdict scores its specialist; a specialist echoing SHARP scores itself
        const target = parentOf[evt.a] || evt.a;
        setSharp(target, evt.sharp);
        if (cnodeEls[evt.a]) ST.agents[evt.a].sharp = evt.sharp;
      }
      if (evt.to) { recordMsg(evt.a, evt.to, (evt.text || '').slice(0, 120)); spawnP(evt.a, evt.to, 'var(--green)'.startsWith('var') ? '#4ade80' : '#4ade80'); }
      feedLine('done' + (evt.critic ? ' critic' : ''), tag(evt.a) + '✅ ' + (evt.text || 'completado') + sharpHtml(evt.sharp), fmtClock(evt.t));
      L.dirty = true;
      break;
    }
    case 'fail': {
      if (!evt.a) break;
      ensureAgent(evt.a);
      setStatus(evt.a, 'fail');
      L.fail++;
      const t = L.tasks.get(evt.taskId);
      if (t) { t.end = evt.t || Date.now(); t.status = 'fail'; }
      feedLine('fail', tag(evt.a) + '✕ ' + (evt.text || 'falló'), fmtClock(evt.t));
      L.dirty = true;
      break;
    }
  }
  updateStats();
}

function liveSnapshot(snap) {
  ST.agents = freshAgents();
  const L = ST.live;
  L.tasks = new Map(); L.spawns = 0; L.ok = 0; L.fail = 0; L.t0 = null;
  feed.innerHTML = '';
  feedLine('sys', '<span class="tag">[BRIDGE]</span> conectado · ' + (snap.tasks?.length || 0) + ' runs en historial');
  const tasks = (snap.tasks || []).slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  for (const t of tasks) {
    if (!t.child) continue;
    ensureAgent(t.child);
    if (t.requester) ensureAgent(t.requester);
    const isCritic = !!(t.child && t.child.endsWith('-critic'));
    L.spawns++;
    if (!L.t0 && t.startedAt) L.t0 = t.startedAt;
    L.tasks.set(t.taskId, {
      agent: t.child, start: t.startedAt || Date.now(), end: t.endedAt || null,
      critic: isCritic, status: t.status === 'succeeded' ? 'ok' : (t.status === 'running' || t.status === 'queued' ? 'run' : 'fail'),
    });
    if (t.requester) recordMsg(t.requester, t.child, t.title || '');
    if (t.status === 'succeeded') {
      L.ok++;
      setStatus(t.child, 'done');
      ST.agents[t.child].current = t.summary || t.title;
      if (t.sharp) setSharp(parentOf[t.child] || t.child, t.sharp);
      feedLine('done' + (isCritic ? ' critic' : ''), tag(t.child) + '✅ ' + (t.title || 'run') + sharpHtml(t.sharp), fmtClock(t.endedAt || Date.now()));
    } else if (t.status === 'running' || t.status === 'queued') {
      setStatus(t.child, 'work');
      ST.agents[t.child].current = t.title;
      feedLine('spawn', tag(t.requester || HUBCFG.id) + '<span class="arrow">→</span> ' + tag(t.child) + (t.title || ''), fmtClock(t.startedAt || Date.now()));
    } else {
      L.fail++;
      setStatus(t.child, 'fail');
      ST.agents[t.child].current = t.title;
      feedLine('fail', tag(t.child) + '✕ ' + (t.error || t.status) + ' · ' + (t.title || ''), fmtClock(t.endedAt || Date.now()));
    }
  }
  rebuildLiveTimeline();
  updateStats();
  hint.textContent = snap.gatewayOk === false
    ? 'Bridge arriba, pero el gateway no responde — corre: openclaw gateway status'
    : 'LIVE · escribe una tarea y dale ▶ para despacharla al orquestador';
  setPill(snap.gatewayOk === false ? 'offline' : 'live', snap.gatewayOk === false ? 'SIN GATEWAY' : 'LIVE');
}

function connectLive() {
  const es = new EventSource('/events');
  ST.live.es = es;
  es.onmessage = (m) => {
    let evt;
    try { evt = JSON.parse(m.data); } catch { return; }
    if (evt.type === 'snapshot') liveSnapshot(evt);
    else liveHandle(evt);
  };
  es.onerror = () => { setPill('offline', 'RECONECTANDO'); };
}
function disconnectLive() {
  if (ST.live.es) { ST.live.es.close(); ST.live.es = null; }
}
async function dispatchReal() {
  const msg = taskIn.value.trim();
  if (!msg) { taskIn.focus(); return; }
  runBtn.disabled = true;
  try {
    const r = await fetch('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, agent: HUBCFG.id }),
    });
    const out = await r.json();
    if (!out.ok) feedLine('fail', '<span class="tag">[BRIDGE]</span> error al despachar: ' + (out.error || '?'));
    else taskIn.value = '';
  } catch (e) {
    feedLine('fail', '<span class="tag">[BRIDGE]</span> no pude despachar: ' + e.message);
  } finally {
    runBtn.disabled = false;
  }
}

/* ============================================================
   DEMO ENGINE (scripted simulator + critic synthesis)
   ============================================================ */
const SHORT = {
  front: 'frontend-foundations', api: 'apis-backend-logic', db: 'database-storage',
  auth: 'auth-permissions', host: 'hosting-deployment', cloud: 'cloud-computing',
  cicd: 'cicd-version-control', sec: 'security-rls', rate: 'rate-limiting',
  cache: 'caching-cdn', scale: 'load-balancing-scaling', logs: 'error-tracking-logs',
  recov: 'availability-recovery',
};
const R = k => SHORT[k] || k;

const SCENARIOS = [
  {
    id: 'feature', label: '✨ Feature: avatar + thumbnails',
    task: 'Nueva feature: subida de avatar con thumbnails',
    involved: ['front', 'api', 'db', 'auth', 'host', 'cloud', 'cicd', 'sec', 'rate', 'cache', 'logs'],
    events: [
      { t: 0, type: 'sys', text: 'ARCHITECT recibió la tarea: «subida de avatar con thumbnails»' },
      { t: 0.8, type: 'sys', text: 'Descomposición lista → plan con 11/13 capas en 3 olas' },
      { t: 1.2, type: 'skip', a: 'scale', text: 'sin cambios de capacidad esperados' },
      { t: 1.45, type: 'skip', a: 'recov', text: 'sin riesgo de disponibilidad' },
      { t: 2.0, type: 'work', a: 'db', text: 'Columna avatar_url en profiles + bucket avatars', dur: 4, tk: 1900 },
      { t: 2.3, type: 'work', a: 'auth', text: 'Ownership: solo el dueño edita su avatar', dur: 3.5, tk: 1400 },
      { t: 3.1, type: 'msg', a: 'auth', to: 'db', text: '¿profiles.user_id apunta a users? Necesito validar ownership' },
      { t: 4.0, type: 'msg', a: 'db', to: 'auth', text: 'Sí: profiles.user_id → users.id (ON DELETE CASCADE)' },
      { t: 5.6, type: 'work', a: 'sec', text: 'Política RLS avatars_owner_crud sobre storage', dur: 4, tk: 2100 },
      { t: 7.2, type: 'work', a: 'api', text: 'POST /api/profile/avatar — presigned URL + validación MIME', dur: 5, tk: 2600 },
      { t: 9.6, type: 'work', a: 'cloud', text: 'Worker avatar-thumbs: 256px + 64px WebP', dur: 5, tk: 2400 },
      { t: 11.8, type: 'work', a: 'rate', text: 'Límite: 5 uploads/min por usuario', dur: 2.5, tk: 700 },
      { t: 12.6, type: 'work', a: 'cache', text: 'Invalidación CDN /avatars/* + Cache-Control immutable', dur: 3, tk: 1100 },
      { t: 14.2, type: 'work', a: 'front', text: '<AvatarUploader/> con crop, preview y update optimista', dur: 5.5, tk: 3200 },
      { t: 15.1, type: 'msg', a: 'front', to: 'api', text: '¿El presigned devuelve también la URL del CDN?' },
      { t: 15.9, type: 'msg', a: 'api', to: 'front', text: 'Sí: { uploadUrl, publicUrl } por el CDN' },
      { t: 18.6, type: 'work', a: 'cicd', text: 'PR feat(avatar) — tests E2E del flujo de upload', dur: 4, tk: 1500 },
      { t: 21.2, type: 'work', a: 'host', text: 'Preview deploy + env S3_AVATAR_BUCKET', dur: 3.5, tk: 900 },
      { t: 23.6, type: 'work', a: 'logs', text: 'Alertas: error rate del endpoint > 2%', dur: 3, tk: 800 },
      { t: 30.5, type: 'sum', text: '✨ Feature lista · 11 capas + sus críticos · todos los SHARP ≥ 20' },
    ],
  },
  {
    id: 'hotfix', label: '🔥 Hotfix: 500 en /api/credits',
    task: 'Hotfix urgente: error 500 en /api/credits en producción',
    involved: ['logs', 'api', 'db', 'recov', 'cicd', 'host'],
    events: [
      { t: 0, type: 'sys', text: '🔴 ALERTA — error rate 14% en /api/credits' },
      { t: 0.6, type: 'work', a: 'logs', text: 'Stack trace: P2002 en credit_ledger', dur: 3, tk: 900 },
      { t: 1.5, type: 'skip', a: 'front', text: 'incidente solo de backend' },
      { t: 1.7, type: 'skip', a: 'auth', text: 'sesión no involucrada' },
      { t: 1.9, type: 'skip', a: 'sec', text: 'no es tema de seguridad' },
      { t: 2.1, type: 'skip', a: 'rate', text: 'tráfico normal' },
      { t: 2.3, type: 'skip', a: 'cache', text: 'endpoint sin caché' },
      { t: 2.5, type: 'skip', a: 'scale', text: 'capacidad estable' },
      { t: 2.7, type: 'skip', a: 'cloud', text: 'workers no participan' },
      { t: 4.2, type: 'work', a: 'api', text: 'Doble insert en outbox por retry sin idempotency key', dur: 4, tk: 1700 },
      { t: 6.3, type: 'work', a: 'db', text: 'Parche: ON CONFLICT DO NOTHING + índice unique', dur: 3.5, tk: 1300 },
      { t: 8.5, type: 'work', a: 'recov', text: 'Ledger verificado: 0 créditos perdidos · snapshot pre-fix', dur: 3, tk: 800 },
      { t: 10.6, type: 'work', a: 'cicd', text: 'hotfix/outbox-idempotency + test de regresión', dur: 3, tk: 1100 },
      { t: 12.1, type: 'work', a: 'host', text: 'Deploy canary 10% → 100%', dur: 3.5, tk: 600 },
      { t: 14.6, type: 'work', a: 'logs', text: 'Error rate: 14% → 0.2% · cerrando incidente', dur: 2.5, tk: 400 },
      { t: 20.0, type: 'sum', text: '🔥 Incidente resuelto · 6 capas · 0 créditos perdidos' },
    ],
  },
  {
    id: 'boot', label: '🚀 Bootstrap: SaaS desde cero',
    task: 'Montar un SaaS completo desde cero — entran las 13 capas',
    involved: Object.keys(SHORT),
    events: [
      { t: 0, type: 'sys', text: 'Tarea grande: SaaS desde cero. Las 13 capas entran' },
      { t: 1.2, type: 'phase', text: 'OLA 1 · FUNDACIONES' },
      { t: 1.4, type: 'work', a: 'db', text: 'Schema: users, orgs, subscriptions, ledger + outbox', dur: 4, tk: 2800 },
      { t: 1.7, type: 'work', a: 'auth', text: 'Auth: email + OAuth · sesiones JWT', dur: 3.5, tk: 1900 },
      { t: 3.7, type: 'work', a: 'api', text: 'Routers /auth /credits /media + validación', dur: 4.5, tk: 3100 },
      { t: 6.2, type: 'phase', text: 'OLA 2 · PRODUCTO' },
      { t: 6.4, type: 'work', a: 'front', text: 'Layout, design system, auth y dashboard', dur: 5, tk: 3600 },
      { t: 8.8, type: 'work', a: 'sec', text: 'RLS en todas las tablas + headers CSP', dur: 4, tk: 2200 },
      { t: 10.7, type: 'work', a: 'rate', text: 'Límites base: 60 rpm user · 20 rpm anon', dur: 2.5, tk: 800 },
      { t: 12.2, type: 'phase', text: 'OLA 3 · SHIP' },
      { t: 12.4, type: 'work', a: 'cicd', text: 'PR checks, lint, tests, preview por branch', dur: 4, tk: 1700 },
      { t: 13.9, type: 'work', a: 'host', text: 'Front en edge · API en contenedor · envs', dur: 3.5, tk: 1200 },
      { t: 15.0, type: 'work', a: 'cloud', text: 'Workers GPU + colas con SKIP LOCKED', dur: 4, tk: 2500 },
      { t: 17.7, type: 'phase', text: 'OLA 4 · PERFORMANCE' },
      { t: 17.9, type: 'work', a: 'cache', text: 'CDN delante del media · TTL por asset', dur: 3, tk: 1300 },
      { t: 19.3, type: 'work', a: 'scale', text: 'PgBouncer + autoscaling configurado', dur: 3, tk: 1000 },
      { t: 21.2, type: 'phase', text: 'OLA 5 · FIABILIDAD' },
      { t: 21.4, type: 'work', a: 'logs', text: 'Error tracking + logs estructurados + alertas', dur: 3, tk: 900 },
      { t: 22.9, type: 'work', a: 'recov', text: 'Backups diarios + PITR · runbook de rollback', dur: 3, tk: 1100 },
      { t: 29.0, type: 'sum', text: '🚀 Stack completo · 13/13 capas con críticos en verde' },
    ],
  },
];

function synthSharp() {
  const dims = ['S', 'H', 'A', 'R', 'P'].map(() => 3 + Math.floor(Math.random() * 3)); // 3..5
  const total = dims.reduce((a, b) => a + b, 0);
  return { S: dims[0], H: dims[1], A: dims[2], R: dims[3], P: dims[4], total, verdict: total >= 20 ? 'APPROVE' : 'REVISE' };
}

function expandScenario(s) {
  // map short ids → real ids and synthesize the critic review pass after each work block
  const evs = [];
  s.events.forEach(e => {
    const ev = { ...e };
    if (ev.a) ev.a = R(ev.a);
    if (ev.to) ev.to = R(ev.to);
    evs.push(ev);
    if (ev.type === 'work') {
      const critic = criticOf[ev.a];
      if (critic) {
        evs.push({ t: ev.t + ev.dur + 0.15, type: 'cwork', a: critic, parent: ev.a, dur: 1.3 });
        evs.push({ t: ev.t + ev.dur + 1.55, type: 'cdone', a: critic, parent: ev.a, sharp: synthSharp() });
      }
    }
  });
  evs.sort((x, y) => x.t - y.t);
  return { ...s, involved: s.involved.map(R), events: evs };
}

const GENERIC_WORK = {
  'frontend-foundations': 'Construyendo la UI: componentes, estados y flujos',
  'apis-backend-logic': 'Diseñando endpoints y lógica de negocio',
  'database-storage': 'Modelando schema, migraciones e índices',
  'auth-permissions': 'Validando identidad, sesiones y ownership',
  'hosting-deployment': 'Preparando preview deploy y variables de entorno',
  'cloud-computing': 'Levantando cómputo para los jobs pesados',
  'cicd-version-control': 'Abriendo PR con tests y checks del pipeline',
  'security-rls': 'Revisando RLS, secretos y superficie de ataque',
  'rate-limiting': 'Ajustando límites de uso de los endpoints',
  'caching-cdn': 'Definiendo estrategia de caché e invalidaciones',
  'load-balancing-scaling': 'Verificando capacidad, pools y balanceo',
  'error-tracking-logs': 'Instrumentando trazas, métricas y alertas',
  'availability-recovery': 'Confirmando backups y plan de rollback',
};
const KEYWORDS = [
  [/auth|login|registro|sesion|usuario|permiso|jwt|oauth|rol/, ['auth', 'sec']],
  [/\bdb\b|base de datos|schema|migra|postgres|tabla|sql|indice/, ['db']],
  [/\bui\b|front|componente|pantalla|diseno|react|landing|dashboard|pagina/, ['front']],
  [/api|endpoint|backend|webhook|logica|rest/, ['api']],
  [/deploy|produccion|lanzar|publicar|hosting/, ['host', 'cicd']],
  [/lambda|gpu|serverless|worker|cola|video|imagen|procesa|render|\bia\b/, ['cloud']],
  [/cache|cdn|rapido|lento|performance|optimiza|latencia/, ['cache']],
  [/trafico|escala|viral|concurrent|carga|balanceo/, ['scale', 'rate']],
  [/error|bug|500|fix|crash|incidente|falla|roto/, ['logs']],
  [/backup|caida|disponibilidad|recupera|rollback/, ['recov']],
  [/seguridad|rls|vulnerab|proteger|ataque/, ['sec']],
  [/limite|abuso|spam|rate/, ['rate']],
  [/subir|upload|archivo|storage|bucket|foto|avatar/, ['db', 'cloud', 'cache']],
  [/pago|stripe|checkout|suscripcion|plan|credito/, ['api', 'db', 'sec']],
  [/test|pipeline|\bci\b|\bpr\b|git/, ['cicd']],
];
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function buildCustomScenario(task) {
  const tnorm = norm(task);
  const set = new Set();
  KEYWORDS.forEach(([re, ids]) => { if (re.test(tnorm)) ids.forEach(i => set.add(R(i))); });
  if (/feature|crear|agregar|implementa|nueva|nuevo|hacer|montar|construir/.test(tnorm)) { set.add(R('cicd')); set.add(R('host')); }
  set.add(R('logs'));
  if (set.size < 3) ['front', 'api', 'db', 'cicd', 'host'].forEach(i => set.add(R(i)));
  const involved = ALL.filter(id => set.has(id));
  const skipped = ALL.filter(id => !set.has(id));
  const evs = [];
  const short = task.length > 52 ? task.slice(0, 52) + '…' : task;
  evs.push({ t: 0, type: 'sys', text: 'ARCHITECT recibió: «' + short + '»' });
  evs.push({ t: 0.7, type: 'sys', text: 'Plan con ' + involved.length + '/13 capas' });
  skipped.forEach((id, i) => evs.push({ t: 1.1 + i * 0.13, type: 'skip', a: id, text: 'no se requiere' }));
  let t = 2.0;
  involved.forEach(id => {
    const dur = 2.8 + Math.random() * 2.2;
    const tk = Math.round((650 + Math.random() * 2300) / 50) * 50;
    evs.push({ t: +t.toFixed(2), type: 'work', a: id, text: GENERIC_WORK[id] || 'Trabajando en la tarea', dur: +dur.toFixed(2), tk });
    const critic = criticOf[id];
    if (critic) {
      evs.push({ t: +(t + dur + 0.15).toFixed(2), type: 'cwork', a: critic, parent: id, dur: 1.3 });
      evs.push({ t: +(t + dur + 1.55).toFixed(2), type: 'cdone', a: critic, parent: id, sharp: synthSharp() });
    }
    t += 1.45 + Math.random() * 0.9;
  });
  const end = t + 5;
  evs.push({ t: +end.toFixed(2), type: 'sum', text: '✅ Tarea completada · ' + involved.length + ' capas con revisión de crítico' });
  evs.sort((x, y) => x.t - y.t);
  return { id: 'custom', label: 'Tarea libre', task, involved, events: evs };
}

function demoHandle(e) {
  switch (e.type) {
    case 'sys': feedLine('sys', '<span class="tag">[ARCH]</span> ' + e.text); break;
    case 'phase': feedLine('phase', '— ' + e.text + ' —'); break;
    case 'skip':
      setStatus(e.a, 'skip');
      feedLine('skip', tag(e.a) + 'en standby — ' + e.text); break;
    case 'work': {
      if (ST.agents[e.a].status === 'idle') { spawnP(HUBCFG.id, e.a, gcol(e.a)); }
      setStatus(e.a, 'work');
      const ag = ST.agents[e.a];
      ag.activeUntil = e.t + e.dur;
      ag.current = e.text;
      ag.tokens += e.tk;
      ST.totals.tk += e.tk;
      recordMsg(HUBCFG.id, e.a, e.text);
      ST.totals.msg++;
      feedLine('work', tag(e.a) + e.text);
      break;
    }
    case 'msg': {
      recordMsg(e.a, e.to, e.text);
      ST.totals.msg++;
      spawnP(e.a, e.to, gcol(e.a));
      feedLine('msg', tag(e.a) + '<span class="arrow">→</span> ' + tag(e.to) + e.text);
      break;
    }
    case 'cwork':
      setStatus(e.a, 'work');
      ST.agents[e.a].current = 'Revisando la arquitectura de ' + (AG[e.parent]?.cap || e.parent);
      spawnP(e.parent, e.a, '#b07aff');
      feedLine('critic', tag(e.a) + 'revisando contra la rúbrica SHARP…');
      break;
    case 'cdone':
      setStatus(e.a, 'done');
      ST.agents[e.a].sharp = e.sharp;
      setSharp(e.parent, e.sharp);
      spawnP(e.a, e.parent, '#4ade80');
      feedLine('done critic', tag(e.a) + 'veredicto' + sharpHtml(e.sharp));
      break;
    case 'sum': feedLine('sum', e.text); break;
  }
}

function loadScript(s) {
  ST.script = { ...s, total: s.events[s.events.length - 1].t + 2.5 };
  ST.vt = 0; ST.idx = 0; ST.totals = { tk: 0, msg: 0 }; ST.shownTk = 0;
  ST.finished = false; ST.running = false; ST.paused = false;
  ST.agents = freshAgents(); ST.doneFlag = {}; ST.lastEnd = {};
  s.events.forEach(e => {
    if (e.a && (e.type === 'work' || e.type === 'msg' || e.type === 'cdone')) {
      const owner = e.parent || e.a;
      const end = e.t + (e.dur || 0.6);
      ST.lastEnd[owner] = Math.max(ST.lastEnd[owner] || 0, end);
    }
  });
  particles = [];
  Object.keys(AG).forEach(id => setStatus(id, 'idle'));
  Object.values(rosterEls).forEach(r => { const c = r.querySelector('.sharp'); c.textContent = '·'; c.className = 'sharp'; });
  Object.values(nodeEls).forEach(n => { const b = n.querySelector && n.querySelector('.sharpbadge'); if (b) { b.textContent = ''; b.classList.remove('show', 'ok', 'warn'); } });
  clearTimelineBars();
  $('tlTitle').textContent = 'TIMELINE · PLAN VS EJECUCIÓN';
  const total = ST.script.total;
  ST.script.events.forEach(ev => {
    if (ev.type !== 'work') return;
    const track = tlRows[ev.a].querySelector('.tl-track');
    const bar = document.createElement('div');
    bar.className = 'tl-bar';
    bar.style.left = (ev.t / total * 100) + '%';
    bar.style.width = (ev.dur / total * 100) + '%';
    const fill = document.createElement('i');
    fill.style.background = gcol(ev.a);
    bar.appendChild(fill);
    track.appendChild(bar);
    tlBarEls.push({ ev, fill });
  });
  ALL.forEach(id => { if (!ST.script.involved.includes(id)) tlRows[id].dataset.st = 'skip'; });
  feed.innerHTML = '';
  feedLine('sys', '<span class="tag">[ARCH]</span> Plan cargado: «' + s.task + '» · ' + s.involved.length + ' capas');
  setPill('ready', 'PLAN LISTO');
  hint.textContent = 'Dale ▶ Ejecutar para ver la orquestación simulada';
  hint.classList.remove('off');
  runBtn.disabled = false; resetBtn.disabled = false;
  pauseBtn.disabled = true; pauseBtn.textContent = '⏸ Pausar';
  updateStats();
}

function demoStart() {
  const txt = taskIn.value.trim();
  if (!ST.script || (txt && ST.script.task !== txt)) {
    const scripted = SCENARIOS.find(s => s.task === txt);
    loadScript(scripted ? expandScenario(scripted) : (txt ? buildCustomScenario(txt) : expandScenario(SCENARIOS[0])));
    if (!txt) taskIn.value = ST.script.task;
    markChip();
  } else if (ST.finished) {
    const cur = ST.script;
    loadScript(cur.id === 'custom' ? buildCustomScenario(cur.task) : expandScenario(SCENARIOS.find(s => s.id === cur.id)));
  }
  ST.running = true; ST.paused = false;
  setPill('run', 'EJECUTANDO');
  hint.classList.add('off');
  runBtn.disabled = true; pauseBtn.disabled = false; resetBtn.disabled = false;
}
function demoFinish() {
  ST.running = false; ST.finished = true;
  setPill('done', 'COMPLETADO');
  runBtn.disabled = false; pauseBtn.disabled = true;
  runBtn.textContent = '▶ Repetir';
}

/* ============================================================
   MODE SWITCHING
   ============================================================ */
function setPill(st, txt) { pill.dataset.st = st; pillTxt.textContent = txt; }

function setMode(mode) {
  if (ST.mode === mode) return;
  ST.mode = mode;
  localStorage.setItem('stackops-mode', mode);
  $('modeLive').classList.toggle('on', mode === 'live');
  $('modeDemo').classList.toggle('on', mode === 'demo');
  $('chips').classList.toggle('hidden', mode === 'live');
  speedSel.style.display = mode === 'live' ? 'none' : '';
  pauseBtn.style.display = mode === 'live' ? 'none' : '';
  resetBtn.style.display = mode === 'live' ? 'none' : '';
  runBtn.textContent = mode === 'live' ? '▶ Despachar' : '▶ Ejecutar';
  taskIn.placeholder = mode === 'live'
    ? 'Tarea REAL para el orquestador (se despacha vía openclaw agent)…'
    : 'Escribe una tarea… ej: agregar login y proteger la API';
  ST.agents = freshAgents();
  Object.keys(AG).forEach(id => setStatus(id, 'idle'));
  clearTimelineBars();
  feed.innerHTML = '';
  particles = [];
  ST.script = null; ST.running = false; ST.finished = false;
  ST.live.tasks = new Map(); ST.live.spawns = 0; ST.live.ok = 0; ST.live.fail = 0; ST.live.t0 = null;
  setStatLabels();
  if (mode === 'live') {
    setPill('live', 'CONECTANDO');
    hint.textContent = 'Conectando al bridge…';
    hint.classList.remove('off');
    runBtn.disabled = false; pauseBtn.disabled = true; resetBtn.disabled = true;
    $('tlTitle').textContent = 'TIMELINE · RUNS REALES';
    connectLive();
  } else {
    disconnectLive();
    setPill('idle', 'EN ESPERA');
    $('footStatus').textContent = 'modo demo · simulador guionado';
    loadScript(expandScenario(SCENARIOS[0]));
    taskIn.value = ST.script.task;
    markChip();
  }
}

$('modeLive').addEventListener('click', () => setMode('live'));
$('modeDemo').addEventListener('click', () => setMode('demo'));

/* ---------- chips / controls ---------- */
function markChip() {
  document.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('on', ST.script && c.dataset.id === ST.script.id);
  });
}
function buildChips() {
  const box = $('chips');
  SCENARIOS.forEach(s => {
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.id = s.id; b.textContent = s.label;
    b.addEventListener('click', () => {
      taskIn.value = s.task;
      loadScript(expandScenario(s)); markChip();
    });
    box.appendChild(b);
  });
  const free = document.createElement('span');
  free.className = 'lbl'; free.textContent = '… O ESCRIBE LA TUYA Y DALE ▶';
  box.appendChild(free);
}

runBtn.addEventListener('click', () => { ST.mode === 'live' ? dispatchReal() : demoStart(); });
pauseBtn.addEventListener('click', () => {
  if (!ST.running) return;
  ST.paused = !ST.paused;
  pauseBtn.textContent = ST.paused ? '▶ Seguir' : '⏸ Pausar';
  setPill(ST.paused ? 'pause' : 'run', ST.paused ? 'EN PAUSA' : 'EJECUTANDO');
});
resetBtn.addEventListener('click', () => {
  if (ST.mode !== 'demo' || !ST.script) return;
  const cur = ST.script;
  runBtn.textContent = '▶ Ejecutar';
  loadScript(cur.id === 'custom' ? buildCustomScenario(cur.task) : expandScenario(SCENARIOS.find(s => s.id === cur.id)));
});
speedSel.addEventListener('change', () => { ST.speed = parseFloat(speedSel.value); });
taskIn.addEventListener('keydown', e => { if (e.key === 'Enter') (ST.mode === 'live' ? dispatchReal() : demoStart()); });

let rzPend = false;
window.addEventListener('resize', () => {
  if (rzPend) return; rzPend = true;
  requestAnimationFrame(() => { layout(); rzPend = false; });
});

/* ---------- main loop ---------- */
let lastTs = null, lastTlRefresh = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  if (lastTs == null) { lastTs = ts; return; }
  const dt = (ts - lastTs) / 1000; lastTs = ts;
  if (ST.mode === 'demo' && ST.running && !ST.paused && ST.script) {
    ST.vt += dt * ST.speed;
    const evs = ST.script.events;
    while (ST.idx < evs.length && evs[ST.idx].t <= ST.vt) { demoHandle(evs[ST.idx]); ST.idx++; }
    Object.keys(AG).forEach(id => {
      const ag = ST.agents[id];
      if (!ag) return;
      if (ag.status === 'work' && !AG[id].isCritic && ST.vt > ag.activeUntil && ag.activeUntil) setStatus(id, 'on');
      if (ag.status === 'on' && ST.lastEnd[id] != null && ST.vt > ST.lastEnd[id] + 0.25 && !ST.doneFlag[id] && ST.script.involved.includes(id)) {
        ST.doneFlag[id] = true;
        setStatus(id, 'done');
        feedLine('done', tag(id) + '✅ listo · ' + fmtTk(ag.tokens) + ' tokens');
      }
    });
    tlBarEls.forEach(b => {
      const q = (ST.vt - b.ev.t) / b.ev.dur;
      b.fill.style.width = (Math.max(0, Math.min(1, q)) * 100) + '%';
    });
    movePlayhead(ST.vt / ST.script.total);
    if (ST.idx >= evs.length && ST.vt > ST.script.total) demoFinish();
  }
  if (ST.mode === 'live' && ts - lastTlRefresh > 2000) {
    lastTlRefresh = ts;
    if (ST.live.dirty || ST.live.tasks.size) { rebuildLiveTimeline(); ST.live.dirty = false; }
  }
  updateStats();
  drawParticles();
}

/* ---------- boot ---------- */
ST.agents = freshAgents();
buildRoster();
buildLegend();
buildGraph();
buildTimelineRows();
buildChips();
layout();
setStatLabels();
requestAnimationFrame(loop);

// default mode: LIVE if the bridge responds, else DEMO
(async () => {
  const saved = localStorage.getItem('stackops-mode');
  try {
    const r = await fetch('/api/state', { signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error('no bridge');
    await r.json();
    setMode(saved === 'demo' ? 'demo' : 'live');
    $('footStatus').textContent = 'bridge ok · ' + location.host;
  } catch {
    setMode('demo');
    feedLine('sys', '<span class="tag">[BRIDGE]</span> sin bridge — modo DEMO (corre "node server.js" para datos reales)');
  }
})();

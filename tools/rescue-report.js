// Rescue the last assistant message from an OpenClaw session transcript (.jsonl)
// Usage: node rescue-report.js <transcript.jsonl> <out.md> "<header title>"
'use strict';
const fs = require('fs');

const [, , src, out, title] = process.argv;
if (!src || !out) { console.error('usage: node rescue-report.js <transcript.jsonl> <out.md> [title]'); process.exit(1); }

const lines = fs.readFileSync(src, 'utf8').trim().split('\n');
const texts = [];
for (const ln of lines) {
  try {
    const o = JSON.parse(ln);
    const m = o.message || o;
    if (m.role === 'assistant' && m.content) {
      const t = Array.isArray(m.content)
        ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
        : String(m.content);
      if (t.trim()) texts.push(t.trim());
    }
  } catch { /* skip non-json lines */ }
}
// Skip protocol sentinels (e.g. NO_REPLY turns after announce handling) and
// pick the last substantive message.
const meaningful = texts.filter(t => t !== 'NO_REPLY' && t.length > 40);
const last = meaningful[meaningful.length - 1] || texts[texts.length - 1] || '';
if (!last) { console.error('no assistant messages found'); process.exit(1); }

const header = '# ' + (title || 'Reporte rescatado') + '\n\n> Rescatado del transcript de sesión por Stack Ops.\n\n';
fs.writeFileSync(out, header + last, 'utf8');
console.log('guardado: ' + out + ' (' + last.length + ' chars)');

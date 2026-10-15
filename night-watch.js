// Guardian nocturno money. Imprime estado; el monitor dedup-ea por (activas + total-commits)
// asi cualquier commit de cualquier fase dispara evento, y los cambios de sin-commit NO hacen ruido.
const { execSync } = require('child_process');
function sh(cmd, opts) {
  try { return execSync(cmd, { maxBuffer: 1e8, windowsHide: true, ...opts }).toString(); }
  catch (e) { return ''; }
}
let activas = 0, lastChild = '';
try {
  const j = JSON.parse(sh('openclaw tasks list --runtime subagent --json'));
  const money = (j.tasks || []).filter(t => String(t.requesterSessionKey || '').includes('p-c-work-money'));
  activas = money.filter(t => t.status === 'running' || t.status === 'queued').length;
  money.sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
  if (money[0]) lastChild = String(money[0].childSessionKey || '').split(':')[1] || '';
} catch (e) {}
const log = sh('git log --oneline', { cwd: 'C:\\Work\\money' });
const f2 = (log.match(/fase-2/gi) || []).length;
const f3 = (log.match(/fase-3/gi) || []).length;
const f4 = (log.match(/fase-4/gi) || []).length;
const f5 = (log.match(/fase-5/gi) || []).length;
const f6 = (log.match(/fase-6/gi) || []).length;
const f7 = (log.match(/fase-7/gi) || []).length;
const f8 = (log.match(/fase-8/gi) || []).length;
const total = f2 + f3 + f4 + f5 + f6 + f7 + f8;
const st = sh('git status --porcelain', { cwd: 'C:\\Work\\money' });
const unc = st.split('\n').filter(l => l.trim()).length;
// tiempo transcurrido desde el primer commit de la noche (2026-06-15 22:15:00 +0200)
const START = Date.parse('2026-06-15T22:15:00+02:00');
const mins = Math.floor((Date.now() - START) / 60000);
const elapsed = `${Math.floor(mins/60)}h${String(mins%60).padStart(2,'0')}m`;
console.log(`activas:${activas} total-commits:${total} sin-commit:${unc} elapsed:${elapsed} ult:${lastChild} | f2:${f2} f3:${f3} f4:${f4} f5:${f5} f6:${f6} f7:${f7} f8:${f8}`);

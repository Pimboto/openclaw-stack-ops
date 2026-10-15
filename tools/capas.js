#!/usr/bin/env node
/**
 * Las 13 capas del stack.
 *
 * Lee public/agents.js (única fuente de verdad) y las imprime en texto plano.
 * Si añades o quitas una capa allí, esto se actualiza solo.
 *
 *   node tools/capas.js       (o: npm run capas)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AGENTS_FILE = path.join(__dirname, '..', 'public', 'agents.js');

function loadAgents() {
  const src = fs.readFileSync(AGENTS_FILE, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: AGENTS_FILE });

  const agents = sandbox.window.STACKOPS && sandbox.window.STACKOPS.agents;
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error(`No encontre agents[] en ${AGENTS_FILE}`);
  }
  return agents;
}

function main() {
  const agents = loadAgents();
  const width = String(agents.length).length;

  console.log('');
  console.log(`LAS ${agents.length} CAPAS`);
  console.log('');

  agents.forEach((a, i) => {
    const n = String(i + 1).padStart(width, ' ');
    console.log(`${n}. ${a.cap} — ${a.id}`);
    console.log(`${' '.repeat(width + 2)}${a.desc}`);
  });

  console.log('');
}

try {
  main();
} catch (err) {
  console.error(`capas: ${err.message}`);
  process.exit(1);
}

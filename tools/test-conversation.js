// Runner-less test for the /api/conversation feature (zero deps, node assert).
// Requires ../server.js for its pure helpers (no port opened — see require.main
// guard there). Run: node tools/test-conversation.js
'use strict';
const assert = require('assert');
const { parseConversationJsonl, resolveSessionFile } = require('../server.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS  ' + name); }
  catch (err) { failed++; console.error('FAIL  ' + name + '\n      ' + (err && err.message || err)); }
}

/* --- 1. Real transcript: agent:architect:p-c-work-barcelona --- */
test('barcelona: resolves to an existing transcript file', () => {
  const file = resolveSessionFile('architect', 'p-c-work-barcelona');
  assert.ok(file, 'expected a resolved transcript path, got ' + file);
});

test('barcelona: parses >0 turns, clean roles, noise filtered, t non-decreasing, capped', () => {
  const fs = require('fs');
  const file = resolveSessionFile('architect', 'p-c-work-barcelona');
  const { turns, truncated } = parseConversationJsonl(fs.readFileSync(file, 'utf8'));

  assert.ok(turns.length > 0, 'expected >0 turns, got ' + turns.length);

  for (const turn of turns) {
    assert.ok(turn.role === 'user' || turn.role === 'assistant', 'bad role: ' + turn.role);
    assert.ok(typeof turn.text === 'string' && turn.text.length > 0, 'empty text turn');
    assert.ok(turn.t === null || typeof turn.t === 'number', 't must be number|null, got ' + turn.t);
    assert.ok(turn.text.length <= 8000, 'turn exceeds 8000-char cap: ' + turn.text.length);
    if (turn.role === 'user') {
      assert.ok(!/^A background task completed/.test(turn.text), 'runtime-noise user turn leaked');
      assert.ok(!turn.text.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>'), 'internal-context turn leaked');
      assert.ok(!turn.text.includes('[Inter-session message]'), 'inter-session turn leaked');
    }
    if (turn.role === 'assistant') {
      assert.notStrictEqual(turn.text, 'NO_REPLY', 'NO_REPLY sentinel leaked');
    }
  }

  // t non-decreasing across turns that carry a timestamp (chronological order).
  let prev = null;
  for (const turn of turns) {
    if (typeof turn.t === 'number') {
      if (prev !== null) assert.ok(turn.t >= prev, 't went backwards: ' + prev + ' -> ' + turn.t);
      prev = turn.t;
    }
  }

  // Respects the 100-turn cap (and the truncated flag agrees with it).
  assert.ok(turns.length <= 100, 'turns over cap: ' + turns.length);
  assert.strictEqual(typeof truncated, 'boolean', 'truncated must be boolean');
  console.log('      (barcelona: ' + turns.length + ' turns, truncated=' + truncated + ')');
});

/* --- 2. Nonexistent session → empty history (null file → turns:[]) --- */
test('nonexistent session resolves to null → empty turns', () => {
  const file = resolveSessionFile('architect', 'p-this-session-does-not-exist-zzz');
  assert.strictEqual(file, null, 'expected null for unknown session, got ' + file);
  // The route turns a null file into { turns: [] }; mirror that contract here.
  const turns = file ? null : [];
  assert.deepStrictEqual(turns, [], 'unknown session must yield empty turns');
});

/* --- 3. Pure parser: noise filtering, caps, corrupt-line tolerance --- */
test('parseConversationJsonl: filters noise, tolerates corrupt lines, sets t', () => {
  const lines = [
    JSON.stringify({ type: 'session', sessionId: 'x' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'A background task completed. ...' }, timestamp: '2026-06-12T02:06:21.401Z' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'NO_REPLY' }] }, timestamp: '2026-06-12T02:06:21.610Z' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> stuff' }, timestamp: '2026-06-12T02:07:00.000Z' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: '[Inter-session message] hi' }, timestamp: '2026-06-12T02:07:10.000Z' }),
    '{ this is a corrupt line',
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'Hola, ¿estado del proyecto?' }, timestamp: '2026-06-12T02:08:00.000Z' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Todo en marcha.' }, { type: 'tool_use', name: 'x' }] }, timestamp: '2026-06-12T02:08:05.000Z' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '' }] }, timestamp: 'bad-timestamp' }),
  ].join('\n');

  const { turns, truncated } = parseConversationJsonl(lines);
  assert.strictEqual(turns.length, 2, 'expected exactly 2 surviving turns, got ' + turns.length);
  assert.deepStrictEqual(turns.map(t => t.role), ['user', 'assistant']);
  assert.strictEqual(turns[0].text, 'Hola, ¿estado del proyecto?');
  assert.strictEqual(turns[1].text, 'Todo en marcha.'); // tool_use block dropped, text joined
  assert.strictEqual(turns[0].t, Date.parse('2026-06-12T02:08:00.000Z'));
  assert.strictEqual(typeof turns[1].t, 'number');
  assert.strictEqual(truncated, false);
});

test('parseConversationJsonl: 100-turn cap keeps most recent, sets truncated', () => {
  const arr = [];
  for (let i = 0; i < 150; i++) {
    arr.push(JSON.stringify({ type: 'message', message: { role: 'user', content: 'msg ' + i }, timestamp: new Date(1700000000000 + i * 1000).toISOString() }));
  }
  const { turns, truncated } = parseConversationJsonl(arr.join('\n'));
  assert.strictEqual(turns.length, 100, 'cap should keep 100, got ' + turns.length);
  assert.strictEqual(truncated, true, 'truncated should be true');
  assert.strictEqual(turns[0].text, 'msg 50', 'should keep the most recent 100 (50..149)');
  assert.strictEqual(turns[99].text, 'msg 149');
});

test('parseConversationJsonl: per-turn char cap appends …', () => {
  const big = 'x'.repeat(9000);
  const line = JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: big }] }, timestamp: '2026-06-12T02:08:00.000Z' });
  const { turns } = parseConversationJsonl(line);
  assert.strictEqual(turns.length, 1);
  assert.strictEqual(turns[0].text.length, 8000, 'capped length should be exactly 8000');
  assert.ok(turns[0].text.endsWith('…'), 'capped text should end with …');
});

/* --- summary --- */
console.log('\n' + (failed === 0 ? 'ALL PASS' : 'SOME FAILED') + ' — ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

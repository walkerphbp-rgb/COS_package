'use strict';
// Schema-invalid researcher claims must never crash the mission with "cannot be bound to SQLite parameter N".
// Run: node test_schema_invalid_claims.js
// Network fully stubbed (global.fetch). Exit codes: 0 pass, 1 test failure, 2 harness error.
// Self-check: unless COS_MUTANT=1, the file copies the runtime tree to a temp dir, disables, in turn, the claimBindable guard and the
// validateResearcher null guard there, re-runs itself and requires each copy to FAIL (prints MUTATION-DETECTED). If the mutation does not apply or
// the copy passes, this file exits non-zero.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { runResearcher } = require('./mission_chain');

const SEED = 'https://seed.test/doc', NONCE = 'N0NCE';
const SNIP = 'The Chief of Staff refuses to execute anything without a human issued approval row in the decisions table.';
const KEYS = { gemini: 'k', groq: 'k' }, MODELS = { gemini: 'g', groq: 'q' };
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const geminiOut = (o) => resp(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] });
const groqOut = (o) => resp(200, { choices: [{ message: { content: JSON.stringify(o) } }] });
let calls;
function setProviders(gem, groq) {
  calls = [];
  global.fetch = async (url) => {
    if (url.includes('generativelanguage')) { calls.push('gemini'); return geminiOut(gem); }
    if (url.includes('api.groq.com')) { calls.push('groq'); return groqOut(groq); }
    calls.push('seed'); return resp(200, `Intro. ${SNIP} Outro.`);
  };
}
function newDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE fetch_log (mission_id, url, status_code, bytes, error, created_at);
    CREATE TABLE provider_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id, call_seq, specialist, provider_attempted, provider_used, fallback_triggered, attempted_status_code, injected_failure, schema_valid, raw_output, created_at);
    CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id, provider_call_id, text, source_url, evidence_snippet, confidence, fetch_match, poisoned, created_at);
    CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id, status, rationale, created_at);`);
  return db;
}
const research = (db) => runResearcher(db, { missionId: 'm1', callSeq: 1, requestText: 'q', nonce: NONCE, seedUrl: SEED, keys: KEYS, models: MODELS, persona: null, minSnippet: undefined, fx: undefined });
const n = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
const good = { text: `Approval is required [ref:${NONCE}]`, source_url: SEED, evidence_snippet: SNIP, confidence: 0.9 };
// Each bad claim has a value node:sqlite cannot bind (or nothing to store). All are schema-invalid for validateResearcher.
const BAD = {
  'boolean text': { ...good, text: true },
  'array source_url': { ...good, source_url: [SEED] },
  'object evidence_snippet': { ...good, evidence_snippet: { a: 1 } },
  'missing confidence': { text: 'x', source_url: SEED, evidence_snippet: SNIP },
  'string confidence': { ...good, confidence: '0.9' },
  'boolean confidence': { ...good, confidence: false },
  'empty text': { ...good, text: '' },
};

const tests = []; const T = (name, fn) => tests.push([name, fn]);

for (const [label, bad] of Object.entries(BAD)) {
  T(`1 ${label}: mission completes, bad claim skipped, no crash`, async () => {
    // Both providers return the same schema-invalid response, so fallback is exhausted and schemaValid=0 is returned.
    const body = { claims: [bad], verification_token: NONCE };
    setProviders(body, body);
    const db = newDb(); const r = await research(db);
    assert.strictEqual(r.claimIds.length, 0); assert.strictEqual(n(db, 'claims'), 0);
    assert.strictEqual(r.tokenVerified, false);
    const row = db.prepare('SELECT schema_valid FROM provider_calls').get(); assert.strictEqual(row.schema_valid, 0);
    const d = db.prepare(`SELECT rationale FROM decisions WHERE status='RESEARCHED'`).get();
    assert.ok(d && /0 claim\(s\) recorded \(1 unstorable claim\(s\) skipped\)/.test(d.rationale), d && d.rationale);
  });
}
T('1k null claim element: validate() rejects the response without throwing, falls back, null is skipped, mission continues', async () => {
  const body = { claims: [null], verification_token: NONCE }; setProviders(body, body);
  const db = newDb(); const r = await research(db);
  assert.deepStrictEqual(calls, ['seed', 'gemini', 'groq']);   // schema-invalid on Gemini => Groq fallback attempted
  assert.strictEqual(r.claimIds.length, 0); assert.strictEqual(n(db, 'claims'), 0); assert.strictEqual(r.tokenVerified, false);
  assert.strictEqual(db.prepare('SELECT schema_valid FROM provider_calls').get().schema_valid, 0);
  assert.match(db.prepare(`SELECT rationale FROM decisions WHERE status='RESEARCHED'`).get().rationale, /0 claim\(s\) recorded \(1 unstorable claim\(s\) skipped\)/);
});
T('1l null element beside a valid claim, both providers: valid claim stored, null skipped', async () => {
  const body = { claims: [good, null], verification_token: NONCE }; setProviders(body, body);
  const db = newDb(); const r = await research(db);
  assert.strictEqual(r.claimIds.length, 1); assert.strictEqual(n(db, 'claims'), 1); assert.strictEqual(r.tokenVerified, false);
  assert.match(db.prepare(`SELECT rationale FROM decisions WHERE status='RESEARCHED'`).get().rationale, /1 claim\(s\) recorded \(1 unstorable claim\(s\) skipped\)/);
});
T('1m Gemini returns a null element, Groq valid: falls back and stores the valid claim', async () => {
  setProviders({ claims: [good, null], verification_token: NONCE }, { claims: [good], verification_token: NONCE });
  const db = newDb(); const r = await research(db);
  assert.deepStrictEqual(calls, ['seed', 'gemini', 'groq']); assert.strictEqual(r.providerUsed, 'groq'); assert.strictEqual(r.tokenVerified, true); assert.strictEqual(r.claimIds.length, 1);
});
T('2 mixed: one bindable + one unbindable claim: only the bindable one is stored, skip count recorded', async () => {
  const body = { claims: [good, { ...good, source_url: [SEED] }], verification_token: NONCE + 'x' };   // wrong token => schema-invalid
  setProviders(body, body);
  const db = newDb(); const r = await research(db);
  assert.strictEqual(r.claimIds.length, 1); assert.strictEqual(n(db, 'claims'), 1);
  assert.strictEqual(r.tokenVerified, false);
  assert.match(db.prepare(`SELECT rationale FROM decisions WHERE status='RESEARCHED'`).get().rationale, /1 claim\(s\) recorded \(1 unstorable claim\(s\) skipped\)/);
});
T('3 claims is not an array: zero claims, no crash', async () => {
  const body = { claims: 'nope', verification_token: NONCE }; setProviders(body, body);
  const db = newDb(); const r = await research(db); assert.strictEqual(r.claimIds.length, 0); assert.strictEqual(n(db, 'claims'), 0);
});
T('4 Gemini invalid, Groq valid: falls back and stores the valid claim (control)', async () => {
  setProviders({ claims: [BAD['boolean text']], verification_token: NONCE }, { claims: [good], verification_token: NONCE });
  const db = newDb(); const r = await research(db);
  assert.deepStrictEqual(calls, ['seed', 'gemini', 'groq']); assert.strictEqual(r.providerUsed, 'groq'); assert.strictEqual(r.tokenVerified, true);
  assert.strictEqual(r.claimIds.length, 1); assert.strictEqual(db.prepare('SELECT fetch_match FROM claims').get().fetch_match, 1);
});
T('5 fully valid response: stored, no skipped note (control)', async () => {
  setProviders({ claims: [good], verification_token: NONCE }, {});
  const db = newDb(); const r = await research(db);
  assert.strictEqual(r.claimIds.length, 1);
  assert.ok(!/skipped/.test(db.prepare(`SELECT rationale FROM decisions WHERE status='RESEARCHED'`).get().rationale));
});

async function main() {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e && e.message); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
  if (process.env.COS_MUTANT === '1') return;
  // ---- mutation self-check -------------------------------------------------------------------------------
  const MUTANTS = [
    ['claimBindable guard', 'if (!claimBindable(c)) { skippedClaims++; continue; }', '/* mutant: guard removed */'],
    ['validateResearcher null guard', "resp.claims.every((c) => c && typeof c.text", "resp.claims.every((c) => typeof c.text"],
  ];
  for (const [label, from, to] of MUTANTS) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mut-'));
    for (const f of fs.readdirSync(__dirname)) if (/\.(js|json|sql)$/.test(f) || f === 'formats') fs.cpSync(path.join(__dirname, f), path.join(tmp, f), { recursive: true });
    const mc = path.join(tmp, 'mission_chain.js'); const src = fs.readFileSync(mc, 'utf8');
    if (src.split(from).length !== 2) { console.error(`HARNESS ERROR: mutation "${label}" does not apply exactly once`); process.exit(2); }
    fs.writeFileSync(mc, src.replace(from, to));
    const r = spawnSync(process.execPath, [path.join(tmp, 'test_schema_invalid_claims.js')], { cwd: tmp, env: { ...process.env, COS_MUTANT: '1' }, encoding: 'utf8' });
    fs.rmSync(tmp, { recursive: true, force: true });
    if (r.status === 1 && /FAIL/.test(r.stdout)) console.log(`MUTATION-DETECTED: removing the ${label} makes this test fail`);
    else { console.error(`MUTATION NOT DETECTED for ${label} (child exit ${r.status})`); process.exit(r.status === 0 ? 1 : 2); }
  }
}
main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });

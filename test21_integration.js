/**
 * TEST 21 — integration of the canonical gate (gate.js) and migrations (db_migrations.js)
 * into the LIVE code paths. Zero live provider calls (fetch stubbed).
 *  21A system-approval class at gate level (valid / medium tier / critic FLAG / after human gate)
 *  21B real runLiveMission low-risk path -> AUTO_COMPLETED through gate.js; fail-closed when gate refuses
 *  21C source guards: one gate only (no second EXECUTED writer, no execute() export)
 *  21D migrations on fresh DB and on an existing DB with data (idempotent, data untouched, triggers bite)
 *  21E real backend: boot runs migrations, /health shows guards, human APPROVE executes once, repeat -> 409
 * Needs gate.js, db_migrations.js, mission_chain.js, provider_fallback.js, cos_backend.js, test17_schema.sql. Node 22.5+.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const schema = fs.readFileSync(path.join(__dirname, 'test17_schema.sql'), 'utf8');
let passed = 0, failed = 0;
const check = (n, ok, d) => { if (ok) { passed++; console.log(`PASS  ${n}`); } else { failed++; console.log(`FAIL  ${n}${d ? '  -> ' + d : ''}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't21-'));
const SYS = 'system: auto-approved (low risk tier + critic PASS)';
const dec = (db, id, st, r) => db.prepare(`INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES (?,?,?,?)`).run(id, st, r, 't');
const execs = (db, id) => db.prepare(`SELECT COUNT(*) c FROM execution_log WHERE mission_id=?`).get(id).c;
function fresh(tier) { const db = new DatabaseSync(':memory:'); db.exec(schema);
  db.prepare(`INSERT INTO missions (id,request_text,risk_tier,created_at) VALUES ('M','x',?,'t')`).run(tier || 'low'); return db; }
const review = (db, v) => db.prepare(`INSERT INTO critic_reviews (mission_id,target_type,target_id,verdict,rationale,created_at) VALUES ('M','artifact',1,?,'r','t')`).run(v);
const { gateExecute } = require('./gate');

function sysCase(label, setup, expectRun) {
  const db = fresh(); setup(db); let t = null; try { gateExecute(db, 'M'); } catch (e) { t = e.message; }
  const ok = expectRun ? (t === null && execs(db, 'M') === 1) : (t && /BOUNDARY VIOLATION/.test(t) && execs(db, 'M') === 0);
  check(label, !!ok, t || `exec_rows=${execs(db, 'M')}`);
}
// ---- 21A
sysCase('21A-1 valid system approval (low + critic PASS, no human gate) executes once', db => { review(db, 'PASS'); dec(db, 'M', 'APPROVED', SYS); }, true);
sysCase('21A-2 system approval on a medium-tier mission refuses', db => { db.prepare(`UPDATE missions SET risk_tier='medium'`).run(); review(db, 'PASS'); dec(db, 'M', 'APPROVED', SYS); }, false);
sysCase('21A-3 system approval with critic FLAG refuses', db => { review(db, 'FLAG'); dec(db, 'M', 'APPROVED', SYS); }, false);
sysCase('21A-4 system approval with no critic review refuses', db => dec(db, 'M', 'APPROVED', SYS), false);
sysCase('21A-5 system approval after a human gate was raised refuses', db => { review(db, 'PASS'); dec(db, 'M', 'AWAITING_APPROVAL', 'halt'); dec(db, 'M', 'APPROVED', SYS); }, false);
sysCase('21A-6 old "auto:" wording is not a valid approval class', db => { review(db, 'PASS'); dec(db, 'M', 'APPROVED', 'auto: low risk tier + critic PASS, no human input required'); }, false);

// ---- 21B: real runLiveMission with network stub
const calls = []; const realFetch = global.fetch;
let mode = 'ok';
global.fetch = async (url, opts) => {
  const u = String(url); calls.push(u);
  if (!u.startsWith('https://generativelanguage.googleapis.com/')) {
    const b = 'Stub reference document. The SDK exposes a typed client for the API.';
    return { ok: true, status: 200, text: async () => b };
  }
  const p = JSON.parse(opts.body).contents[0].parts[0].text; const nonce = (p.match(/NONCE_[A-Z0-9]+/) || [''])[0];
  let out;
  if (/research specialist/.test(p)) out = { claims: [{ text: `The SDK exposes a typed client. [ref:${nonce}]`, source_url: (p.match(/Cite source_url exactly as: (\S+)/) || [])[1] || 'u', evidence_snippet: 'The SDK exposes a typed client', confidence: 0.9 }], verification_token: nonce };
  else if (/analyst/.test(p)) out = { summary: 'Benign summary.', llm_self_tier: 'low' };
  else out = { type: 'written', payload: `Draft containing ${mode === 'flagless' ? nonce : nonce}` };
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }) };
};
const chain = require('./mission_chain');
const keys = { gemini: 'k' }, models = { gemini: 'm' };
async function liveCase(dbPath, nonce) {
  const db = new DatabaseSync(dbPath); db.exec(schema);
  const r = await chain.runLiveMission(db, { requestText: 'task', nonce, seedUrl: 'https://seed.test/doc', keys, models });
  return { db, r };
}
(async () => {
  try {
    let { db, r } = await liveCase(path.join(tmp, 'b1.db'), 'NONCE_ABC123');
    const last = db.prepare(`SELECT status FROM decisions WHERE mission_id=? ORDER BY id DESC LIMIT 1`).get(r.missionId).status;
    const ap = db.prepare(`SELECT rationale FROM decisions WHERE mission_id=? AND status='APPROVED'`).get(r.missionId);
    check('21B-1 live low-risk mission AUTO_COMPLETED through the gate', r.outcome === 'AUTO_COMPLETED' && last === 'COMPLETED', `${r.outcome}/${last}`);
    check('21B-2 approval row is the defined system class; exactly one execution', ap && ap.rationale === SYS && execs(db, r.missionId) === 1, ap && ap.rationale);
    db.close();
    // fail-closed: make gate refuse by sabotaging the critic verdict path (tier forced non-low after critic, before approval is impossible), so use a mission whose critic is FLAG => AWAITING_APPROVAL already; instead stub gate refusal directly:
    const gate = require('./gate'); const orig = gate.gateExecuteInTx;
    // gate refusal injected via a DB trigger that blocks execution_log inserts
    const p2 = path.join(tmp, 'b2.db'); const d2 = new DatabaseSync(p2); d2.exec(schema);
    d2.exec(`CREATE TRIGGER block_exec BEFORE INSERT ON execution_log BEGIN SELECT RAISE(ABORT,'BOUNDARY VIOLATION BLOCKED: injected'); END;`);
    const r2 = await chain.runLiveMission(d2, { requestText: 'task', nonce: 'NONCE_DEF456', seedUrl: 'https://seed.test/doc', keys, models });
    const rows = d2.prepare(`SELECT status FROM decisions WHERE mission_id=? ORDER BY id`).all(r2.missionId).map(x => x.status);
    check('21B-3 gate refusal fails closed: AWAITING_APPROVAL, no APPROVED/EXECUTED left behind',
      r2.outcome === 'AWAITING_APPROVAL' && !rows.includes('APPROVED') && !rows.includes('EXECUTED') && rows[rows.length - 1] === 'AWAITING_APPROVAL', rows.join(','));
    d2.close();
  } catch (e) { check('21B ran without exception', false, e.stack || e.message); }
  global.fetch = realFetch;

  // ---- 21C source guards
  const src = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
  check('21C-1 cos_backend.js and mission_chain.js both require ./gate', /require\('\.\/gate'\)/.test(src('cos_backend.js')) && /require\('\.\/gate'\)/.test(src('mission_chain.js')));
  check('21C-2 only gate.js writes execution_log / EXECUTED',
    ['cos_backend.js', 'mission_chain.js'].every(f => !/INSERT INTO execution_log/.test(src(f)) && !/(recordDecision\([^)]*|INSERT INTO decisions[^;]*)'EXECUTED'/.test(src(f))));
  check('21C-3 mission_chain.js exports no execute() and cos_backend.js defines no local gateExecute', typeof chain.execute === 'undefined' && !/function gateExecute\(/.test(src('cos_backend.js')));
  check('21C-4 Dockerfile copies gate.js and db_migrations.js', /gate\.js/.test(src('Dockerfile')) && /db_migrations\.js/.test(src('Dockerfile')));

  // ---- 21D migrations
  const { migrate, guardStatus } = require('./db_migrations');
  { const d = new DatabaseSync(':memory:'); d.exec(schema);
    check('21D-1 fresh DB: guards absent before migrate', !guardStatus(d).ok);
    const m1 = migrate(d); check('21D-2 migrate applies all guards, ok', m1.ok && guardStatus(d).ok && m1.applied.length === 7, JSON.stringify(m1));
    const m2 = migrate(d); check('21D-3 second run is a no-op (idempotent)', m2.ok && m2.applied.length === 0);
    d.prepare(`INSERT INTO missions (id,request_text,created_at) VALUES ('M','x','t')`).run(); dec(d, 'M', 'PROPOSED', 'r');
    let u = null; try { d.prepare(`UPDATE decisions SET status='APPROVED'`).run(); } catch (e) { u = e.message; }
    let x = null; try { d.prepare(`DELETE FROM decisions`).run(); } catch (e) { x = e.message; }
    check('21D-4 UPDATE and DELETE on decisions are blocked', /append-only/.test(u || '') && /append-only/.test(x || ''), `${u}|${x}`);
    d.prepare(`INSERT INTO execution_log (mission_id,detail,created_at) VALUES ('M','a','t')`).run();
    let dup = null; try { d.prepare(`INSERT INTO execution_log (mission_id,detail,created_at) VALUES ('M','b','t')`).run(); } catch (e) { dup = e.message; }
    check('21D-5 duplicate execution_log row blocked by unique index', !!dup); d.close(); }
  { const p = path.join(tmp, 'old.db'); const d = new DatabaseSync(p); d.exec(schema);
    d.prepare(`INSERT INTO missions (id,request_text,created_at) VALUES ('M','x','t')`).run(); dec(d, 'M', 'PROPOSED', 'r'); dec(d, 'M', 'FAILED', 'old');
    const before = JSON.stringify(d.prepare(`SELECT * FROM decisions`).all()); const m = migrate(d);
    check('21D-6 existing DB with data: migrated, existing rows byte-identical', m.ok && JSON.stringify(d.prepare(`SELECT * FROM decisions`).all()) === before); d.close(); }
  { const d = new DatabaseSync(':memory:'); d.exec(schema); d.prepare(`INSERT INTO missions (id,request_text,created_at) VALUES ('M','x','t')`).run();
    for (const s of ['a', 'b']) d.prepare(`INSERT INTO execution_log (mission_id,detail,created_at) VALUES ('M',?,'t')`).run(s);
    const m = migrate(d); check('21D-7 legacy duplicate execution rows: not modified, reported, boot not blocked', m.ok === false && m.skipped.length === 1 && d.prepare(`SELECT COUNT(*) c FROM execution_log`).get().c === 2); d.close(); }

  // ---- 21E real backend
  const PORT = 20000 + Math.floor(Math.random() * 20000), TOKEN = 't21-token-' + 'x'.repeat(24);
  const dbp = path.join(tmp, 'e.db'); const sd = new DatabaseSync(dbp); sd.exec(schema);
  for (const id of ['A', 'B']) { sd.prepare(`INSERT INTO missions (id,request_text,risk_tier,created_at) VALUES (?, 'x','high','t')`).run(id); dec(sd, id, 'PROPOSED', 'r'); dec(sd, id, 'AWAITING_APPROVAL', 'halt'); }
  sd.close();
  const req = (method, p, body) => new Promise((res, rej) => { const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, rs => { let s = ''; rs.on('data', c => s += c); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} res({ status: rs.statusCode, json: j }); }); });
    r.on('error', rej); if (data) r.write(data); r.end(); });
  const child = spawn(process.execPath, [path.join(__dirname, 'cos_backend.js')], { env: { ...process.env, COS_DB: dbp, COS_PORT: String(PORT), PORT: String(PORT), COS_HOST: '127.0.0.1', COS_TOKEN: TOKEN, COS_MODE: 'MOCK', COS_INIT_DB: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  try {
    let up = false; for (let i = 0; i < 50 && !up; i++) { try { up = (await req('GET', '/health')).status === 200; } catch {} if (!up) await new Promise(r => setTimeout(r, 200)); }
    check('21E-1 backend started', up, log.slice(-300));
    const h = (await req('GET', '/health')).json;
    check('21E-2 boot ran migrations: /health reports guards ok', h && h.db && h.db.guards && h.db.guards.ok === true, JSON.stringify(h && h.db));
    const a = await req('POST', '/api/missions/A/decision', { decision: 'APPROVED' });
    const v = new DatabaseSync(dbp);
    check('21E-3 human APPROVE executes via canonical gate: 200, exactly one execution', a.status === 200 && execs(v, 'A') === 1, `status=${a.status}`);
    const a2 = await req('POST', '/api/missions/A/decision', { decision: 'APPROVED' });
    check('21E-4 repeat APPROVE refused (409), still exactly one execution', a2.status === 409 && execs(v, 'A') === 1, `status=${a2.status}`);
    const rj = await req('POST', '/api/missions/B/decision', { decision: 'REJECTED' });
    check('21E-5 human REJECT: 200, zero execution rows', rj.status === 200 && execs(v, 'B') === 0);
    let tamper = null; try { v.prepare(`UPDATE decisions SET rationale='forged' WHERE mission_id='A'`).run(); } catch (e) { tamper = e.message; }
    check('21E-6 on the live DB file, audit rows cannot be rewritten', /append-only/.test(tamper || ''), tamper); v.close();
  } catch (e) { check('21E ran without exception', false, e.stack || e.message); }
  child.kill('SIGKILL');
  console.log(`\nTEST21 result=${failed === 0 ? 'PASS' : 'FAIL'} passed=${passed} failed=${failed}`); process.exit(failed === 0 ? 0 : 1);
})();

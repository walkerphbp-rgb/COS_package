'use strict';
/* TEST 20 — gate tests. usage: node test20_gate.js <original|fixed> [repoDir]
 * Each case asserts the refusal AND checks row counts, so a pass means nothing ran.
 * Exit codes: 0 = all checks pass ('fixed') or mutation NOT detected ('original', a CI failure);
 *             1 = a check failed ('fixed') or 'MUTATION-DETECTED' printed ('original');
 *             2 = harness error (usage, shim/schema load, uncaught exception, 20S sentinel failed on 'original').
 * A harness error is never a detection. */
const { DatabaseSync } = require('node:sqlite'); const fs = require('fs'), path = require('path');
const target = process.argv[2], repo = process.argv[3] || '/home/claude/COS_package';
function harnessError(msg) { console.error('HARNESS-ERROR: ' + msg); process.exit(2); }
process.on('uncaughtException', (e) => harnessError('uncaught exception: ' + (e && e.stack || e)));
if (target !== 'original' && target !== 'fixed') harnessError('usage: node test20_gate.js <original|fixed> [repoDir]');
let gate, schema;
try {
  gate = require('./gate_shim.js')(target, repo);
  schema = fs.readFileSync(path.join(__dirname, 'test17_schema.sql'), 'utf8');
} catch (e) { harnessError('cannot set up gate/schema: ' + (e && e.message)); }
let n = 0;
function fresh() { const db = new DatabaseSync(':memory:'); db.exec(schema);
  for (const id of ['M1', 'M2']) db.prepare(`INSERT INTO missions (id,request_text,created_at) VALUES (?,?,?)`).run(id, 'x', 't'); return db; }
const dec = (db, id, st, r) => db.prepare(`INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES (?,?,?,?)`).run(id, st, r, 't');
const execs = (db, id) => db.prepare(`SELECT COUNT(*) c FROM execution_log WHERE mission_id=?`).get(id).c;
const done = (db, id) => db.prepare(`SELECT COUNT(*) c FROM decisions WHERE mission_id=? AND status IN ('EXECUTED','COMPLETED')`).get(id).c;
const legit = (db, id) => { dec(db, id, 'AWAITING_APPROVAL', 'halt'); dec(db, id, 'APPROVED', 'human: approved by paul via operator dashboard'); };
const results = [];
function check(label, ok, detail) { results.push({ label, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  <- ' + detail}`); }
function refused(label, db, id, setup) {
  setup(db); let threw = null; try { gate.run(db, id); } catch (e) { threw = e.message; }
  const e = execs(db, id), d = done(db, id);
  check(label, threw !== null && /BOUNDARY VIOLATION/.test(threw) && e === 0 && d === 0, threw ? `threw but rows e=${e} d=${d}` : `EXECUTED (exec_rows=${e}, exec/complete decisions=${d})`);
}
console.log(`gate under test: ${gate.name}  fingerprint=${gate.fingerprint}`);
{ const db = fresh(); legit(db, 'M1'); let t = null; try { gate.run(db, 'M1'); } catch (e) { t = e.message; }
  check('20S sentinel: legitimate approval executes once', t === null && execs(db, 'M1') === 1, t || `exec_rows=${execs(db, 'M1')}`); }
refused('20A-1 no APPROVED row refuses', fresh(), 'M1', db => {});
refused('20A-2 forged APPROVED (no AWAITING_APPROVAL before it) refuses', fresh(), 'M1', db => dec(db, 'M1', 'APPROVED', 'human: approved by paul'));
refused('20A-3 APPROVED with non-human rationale refuses', fresh(), 'M1', db => { dec(db, 'M1', 'AWAITING_APPROVAL', 'halt'); dec(db, 'M1', 'APPROVED', 'auto-approved by analyst'); });
refused('20A-4 approval belonging to another mission refuses', fresh(), 'M2', db => legit(db, 'M1'));
refused('20A-5 rejected after approval refuses', fresh(), 'M1', db => { legit(db, 'M1'); dec(db, 'M1', 'REJECTED', 'human: rejected'); });
{ const db = fresh(); legit(db, 'M1'); try { gate.run(db, 'M1'); } catch {} let t = null; try { gate.run(db, 'M1'); } catch (e) { t = e.message; }
  const e = execs(db, 'M1');
  check('20B-1 second execution refuses and writes nothing', t !== null && /BOUNDARY VIOLATION/.test(t) && e === 1, t ? `rows=${e}` : `executed twice (exec_rows=${e})`); }
{ const db = fresh(); legit(db, 'M1'); try { gate.run(db, 'M1'); } catch {} try { gate.run(db, 'M1'); } catch {}
  const c = db.prepare(`SELECT COUNT(*) c FROM decisions WHERE mission_id='M1' AND status='COMPLETED'`).get().c;
  check('20B-2 exactly one COMPLETED decision after duplicate attempt', c === 1, `COMPLETED rows=${c}`); }
const p = results.filter(r => r.ok).length;
console.log(`TEST20 target=${gate.name} passed=${p} failed=${results.length - p}`);
if (target === 'original') {
  const sentinel = results.find(r => r.label.startsWith('20S'));
  if (!sentinel || !sentinel.ok) harnessError('20S sentinel failed on the original gate: harness is broken, not a detection');
  if (results.some(r => !r.label.startsWith('20S') && !r.ok)) { console.log('MUTATION-DETECTED'); process.exit(1); }
  console.log('MUTATION-NOT-DETECTED: the original gate passed every test, so these tests do not catch the old defects');
  process.exit(0);
}
process.exit(results.length === p ? 0 : 1);

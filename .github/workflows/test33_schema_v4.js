'use strict';
/* Test 33 group H: schema v4 (source-based research). Stubbed/local only: no network, no model.
 * Runs migrations on COPIES of a v3 database. Run: node test33_schema_v4.js */
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const M = require('./db_migrations');
const schema = fs.readFileSync(path.join(__dirname, 'test17_schema.sql'), 'utf8');
let pass = 0, fail = 0;
const check = (id, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${ok ? '' : '  -> ' + (detail || '')}`); };
const J = JSON.stringify, uv = (db) => Number(Object.values(db.prepare('PRAGMA user_version').get())[0]);
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(String(e.message)) : true; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't33h-'));

// ---- build a real v3 database file (v1 base + v2 + v3 steps), with legacy rows ----
function makeV3(file) {
  const d = new DatabaseSync(file); d.exec(schema); M.migrate(d); M.migrateV2(d); M.migrateV3(d); d.exec('PRAGMA user_version = 3');
  d.prepare(`INSERT INTO missions (id,request_text,risk_tier,created_at) VALUES ('OLD','legacy','low','t')`).run();
  d.prepare(`INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES ('OLD','PROPOSED','p','t')`).run();
  return d;
}
const colsOf = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all();
const f3 = path.join(tmp, 'v3.db'); { const d = makeV3(f3); d.close(); }
const fcopy = path.join(tmp, 'v3-copy.db'); fs.copyFileSync(f3, fcopy);

// H1 migration of a COPY: original stays v3 and byte-identical, copy goes to v4
const origBytes = fs.readFileSync(f3);
const db = new DatabaseSync(fcopy);
const dumpOld = () => J([db.prepare('SELECT * FROM missions').all(), db.prepare('SELECT * FROM decisions').all()]);
const before = dumpOld(), claimsBefore = J(db.prepare('SELECT * FROM claims').all());
const r1 = M.migrateVersioned(db);
check('H1 v3 copy -> v4: not fatal, version_before 3, version_after 4', !r1.fatal && r1.version_before === 3 && r1.version_after === 4 && uv(db) === 4, J(r1));
check('H2 the original v3 file is untouched (byte-identical) and still v3', Buffer.compare(origBytes, fs.readFileSync(f3)) === 0 && uv(new DatabaseSync(f3)) === 3);
check('H3 additive: legacy missions/decisions rows byte-identical after migration, legacy claims untouched', dumpOld() === before && J(db.prepare('SELECT * FROM claims').all()) === claimsBefore);
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((x) => x.name);
check('H4 new tables exist (mission_research, mission_sources) and claims.source_id is a nullable TEXT column', tables.includes('mission_research') && tables.includes('mission_sources') && colsOf(db, 'claims').some((c) => c.name === 'source_id' && c.type === 'TEXT' && c.notnull === 0));
check('H5 mission_sources primary key is (mission_id, source_id)', J(colsOf(db, 'mission_sources').filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name)) === J(['mission_id', 'source_id']));
const r2 = M.migrateVersioned(db);
check('H6 idempotent: second run applies nothing, version stays 4', !r2.fatal && r2.report.applied.length === 0 && r2.version_before === 4 && uv(db) === 4, J(r2));
check('H7 guardStatus ok at v4 and lists the v4 triggers', M.guardStatus(db).ok === true);

// H8 append-only + integrity behaviour of the new tables
const now = 't';
db.prepare(`INSERT INTO missions (id,request_text,risk_tier,created_at) VALUES ('M1','r','low',?)`).run(now);
db.prepare(`INSERT INTO mission_research VALUES ('M1','question text here','','','','[]',?)`).run(now);
const insSrc = (sid, ok = 1) => db.prepare(`INSERT INTO mission_sources (mission_id,source_id,url,final_url,redirects_json,host,label,input_index,ok,code,http_status,content_type,bytes_downloaded,download_truncated,raw_sha256,text,text_chars,model_truncated,text_sha256,connected_ip,attempted_at,retrieved_at)
  VALUES ('M1',?,'https://a.example/x','https://a.example/x','[]','a.example',NULL,0,?, 'OK',200,'text/plain',5,0,'raw','hello',5,0,'txt','1.2.3.4',?,?)`).run(sid, ok, now, now);
insSrc('S1'); insSrc('S2', 0);
check('H8 a mission can store several sources (ok and failed) and one research request', db.prepare('SELECT COUNT(*) c FROM mission_sources WHERE mission_id=?').get('M1').c === 2);
check('H9 duplicate (mission_id, source_id) is refused', throws(() => insSrc('S1'), /UNIQUE|constraint/i));
check('H10 ok must be 0 or 1', throws(() => insSrc('S3', 2), /CHECK|constraint/i));
for (const [t, upd] of [['mission_sources', `UPDATE mission_sources SET text='tampered' WHERE mission_id='M1'`], ['mission_research', `UPDATE mission_research SET question='tampered' WHERE mission_id='M1'`]]) {
  check(`H11 ${t}: UPDATE refused (append-only)`, throws(() => db.exec(upd), /append-only/));
  check(`H12 ${t}: DELETE refused (append-only)`, throws(() => db.exec(`DELETE FROM ${t}`), /append-only/));
}
check('H13 stored text and hashes unchanged after the refused tamper attempts', db.prepare(`SELECT text, raw_sha256, text_sha256 FROM mission_sources WHERE source_id='S1'`).get().text === 'hello');
check('H14 claims.source_id: research claim stores a source_id; legacy claim (no source_id) stays NULL', (() => {
  db.prepare(`INSERT INTO provider_calls (mission_id,call_seq,specialist,provider_attempted,provider_used,created_at) VALUES ('M1',1,'researcher','gemini','gemini',?)`).run(now);
  const pc = db.prepare('SELECT id FROM provider_calls WHERE mission_id=?').get('M1').id;
  db.prepare(`INSERT INTO claims (mission_id,provider_call_id,text,created_at,source_id) VALUES ('M1',?,'research claim',?,'S1')`).run(pc, now);
  db.prepare(`INSERT INTO claims (mission_id,provider_call_id,text,created_at) VALUES ('M1',?,'legacy-style claim',?)`).run(pc, now);
  const g = (t) => db.prepare('SELECT source_id FROM claims WHERE text=?').get(t).source_id;
  return g('research claim') === 'S1' && g('legacy-style claim') === null;
})());
check('H15 a dropped guard is detected by guardStatus', (() => { db.exec('DROP TRIGGER cos_append_only_mission_sources_update'); const g = M.guardStatus(db); return !g.ok && g.missing.includes('cos_append_only_mission_sources_update'); })());
db.close();

// H16 the BASELINE (v3) build must refuse a v4 database. Real baseline code from git, not a simulation.
try {
  const base = path.join(tmp, 'baseline_db_migrations.js');
  fs.writeFileSync(base, cp.execFileSync('git', ['show', '6542e37:db_migrations.js'], { cwd: __dirname }).toString());
  const OldM = require(base);
  const v4file = path.join(tmp, 'v4.db'); fs.copyFileSync(f3, v4file); { const d = new DatabaseSync(v4file); M.migrateVersioned(d); d.close(); }
  const d = new DatabaseSync(v4file); const rr = OldM.migrateVersioned(d); const stillV4 = uv(d) === 4; d.close();
  check('H16 baseline 6542e37 build (SCHEMA_VERSION 3) refuses a v4 DB and does not change it', OldM.SCHEMA_VERSION === 3 && rr.fatal && /newer than this build/.test(rr.errors.join()) && stillV4, J(rr));
} catch (e) { check('H16 baseline build refuses a v4 DB', false, String(e.message)); }

// H17 backup verifier (B2 path) refuses a v4 snapshot for a build whose maxSchema is 3, accepts it for 4
try {
  const B = require('./b2_backup'); const v4file = path.join(tmp, 'v4.db');
  const bad = B.verifyDbFile(v4file, 3), good = B.verifyDbFile(v4file, M.SCHEMA_VERSION);
  check('H17 B2 snapshot verification: v4 file refused when maxSchema=3, accepted when maxSchema=SCHEMA_VERSION (4)', !bad.ok && good.ok, J({ bad, good }));
} catch (e) { check('H17 B2 snapshot verification', false, String(e.message)); }

// H18 fresh install path: empty base schema reaches v4 with all guards
{ const d = new DatabaseSync(':memory:'); d.exec(schema); const r = M.migrateVersioned(d);
  check('H18 fresh DB -> v4 in one boot, guards ok', !r.fatal && uv(d) === 4 && M.guardStatus(d).ok); }

console.log(`\nTEST33-H (schema v4, local files only, no network/model) result=${fail ? 'FAIL' : 'PASS'} passed=${pass} failed=${fail}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

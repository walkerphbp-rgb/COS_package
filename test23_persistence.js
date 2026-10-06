/**
 * TEST 23 — persistence safety (LOCAL). Spawns the REAL cos_backend.js.
 *
 *   23A  persistence guard (COS_REQUIRE_PERSISTENT): refuses outside root / missing root / no root /
 *        symlink escape / unwritable dir; accepts a fresh empty disk (no DB file yet)
 *   23B  /health evidence, WAL, busy timeout, user_version, init + restart does not recreate/wipe
 *   23C  write -> SIGTERM -> restart -> fresh read, and write -> SIGKILL -> restart -> fresh read
 *   23D  migrations: unversioned (v0) DB stamped not wiped; newer version refused; missing core table
 *        refused; legacy duplicate rows still non-fatal (Test 21D-7 contract); append-only triggers intact
 *   23E  SIGTERM drains an in-flight request, refuses new ones, exits 0, writes no synthetic rows
 *
 * This proves the CODE against a local filesystem. It does NOT prove Render: only a real
 * write -> redeploy -> fresh read on the deployed service does that.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const persistence = require('./persistence');

let passed = 0, failed = 0;
const check = (n, ok, d) => { if (ok) { passed++; console.log(`PASS  ${n}`); } else { failed++; console.log(`FAIL  ${n}${d ? '  -> ' + d : ''}`); } };
const skip = (n, why) => console.log(`SKIP  ${n}  (${why})`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const schema = fs.readFileSync(path.join(__dirname, 'test17_schema.sql'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't23-'));
const TOKEN = 't23-token-' + 'x'.repeat(26);
const mk = n => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
const port = () => 20000 + Math.floor(Math.random() * 20000);
const dec = (d, id, st, r) => d.prepare(`INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES (?,?,?,?)`).run(id, st, r, 't');

function req(P, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: P, path: p, method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, rs => {
      let s = ''; rs.on('data', c => s += c); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: rs.statusCode, json: j, raw: s }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function boot(env, { preload } = {}) {
  const P = port();
  const args = preload ? ['--require', preload, path.join(__dirname, 'cos_backend.js')] : [path.join(__dirname, 'cos_backend.js')];
  const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, COS_PORT: String(P), PORT: String(P), COS_HOST: '127.0.0.1', COS_TOKEN: TOKEN, COS_MODE: 'MOCK', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const b = { P, child, log: '', exited: null };
  child.stdout.on('data', d => b.log += d); child.stderr.on('data', d => b.log += d);
  b.done = new Promise(res => child.on('exit', (code, sig) => { b.exited = { code, sig }; res(b.exited); }));
  b.up = async () => { for (let i = 0; i < 60 && !b.exited; i++) { try { if ((await req(P, 'GET', '/health')).status === 200) return true; } catch {} await sleep(150); } return false; };
  return b;
}
const expectRefusal = async (env, code) => { const b = boot(env); const r = await Promise.race([b.done, sleep(6000).then(() => null)]); if (!r) b.child.kill('SIGKILL'); return { r, log: b.log, listening: /on http:/.test(b.log) }; };

(async () => {
  try {
    // ---------------- 23A guard ----------------
    { const root = mk('A1root'), cfg = persistence.resolveConfig({ COS_DB_PATH: path.join(root, 'cos.db'), COS_REQUIRE_PERSISTENT: '1', COS_PERSISTENT_ROOT: root }, __dirname);
      const g = persistence.checkGuard(cfg);
      check('23A-1 fresh empty persistent disk (no DB file yet) is accepted', g.ok && !g.info.db_file_exists, g.errors.join(';')); }
    { const root = mk('A2root'), other = mk('A2other');
      const g = persistence.checkGuard(persistence.resolveConfig({ COS_DB_PATH: path.join(other, 'cos.db'), COS_REQUIRE_PERSISTENT: '1', COS_PERSISTENT_ROOT: root }, __dirname));
      check('23A-2 DB path outside the persistent root is refused', !g.ok && /outside the persistent root/.test(g.errors.join()), g.errors.join(';')); }
    { const g = persistence.checkGuard(persistence.resolveConfig({ COS_DB_PATH: path.join(tmp, 'nope', 'cos.db'), COS_REQUIRE_PERSISTENT: '1', COS_PERSISTENT_ROOT: path.join(tmp, 'nope') }, __dirname));
      check('23A-3 persistent root that does not exist is refused', !g.ok && /does not exist/.test(g.errors.join()), g.errors.join(';')); }
    { const root = mk('A4root'), g = persistence.checkGuard(persistence.resolveConfig({ COS_DB_PATH: path.join(root, 'cos.db'), COS_REQUIRE_PERSISTENT: '1' }, __dirname));
      check('23A-4 REQUIRE=1 without a persistent root is refused (cannot verify)', !g.ok && /COS_PERSISTENT_ROOT is not set/.test(g.errors.join())); }
    { const root = mk('A5root'), out = mk('A5out'); fs.writeFileSync(path.join(out, 'real.db'), ''); fs.symlinkSync(path.join(out, 'real.db'), path.join(root, 'cos.db'));
      const g = persistence.checkGuard(persistence.resolveConfig({ COS_DB_PATH: path.join(root, 'cos.db'), COS_REQUIRE_PERSISTENT: '1', COS_PERSISTENT_ROOT: root }, __dirname));
      check('23A-5 symlink inside the root pointing outside it is refused', !g.ok, JSON.stringify(g.info.db_path_inside_root)); }
    { const root = mk('A6root'), g = persistence.checkGuard(persistence.resolveConfig({ COS_DB_PATH: path.join(root, '..', 'A6root-sibling', 'cos.db'), COS_REQUIRE_PERSISTENT: '1', COS_PERSISTENT_ROOT: root }, __dirname));
      check('23A-6 ".." traversal and sibling-prefix paths are refused', !g.ok); }
    { const g = persistence.checkGuard(persistence.resolveConfig({ COS_DB_PATH: '/cos.db', COS_REQUIRE_PERSISTENT: '1', COS_PERSISTENT_ROOT: '/' }, __dirname));
      check('23A-7 filesystem root "/" is not an acceptable persistent root', !g.ok); }
    { const cfg = persistence.resolveConfig({}, __dirname);
      check('23A-8 no variables: local default ./cos.db, absolute, guard not required', path.isAbsolute(cfg.dbPath) && cfg.dbPath.endsWith('cos.db') && persistence.checkGuard(cfg).ok && !cfg.requirePersistent); }
    { const cfg = persistence.resolveConfig({ COS_DB: 'rel/legacy.db' }, __dirname);
      check('23A-9 legacy COS_DB still honoured, resolved absolute', path.isAbsolute(cfg.dbPath) && cfg.dbPathSource === 'COS_DB (legacy)'); }
    if (process.getuid && process.getuid() === 0) {
      const root = mk('A10root'); fs.chmodSync(root, 0o555); fs.chmodSync(tmp, 0o755);
      const code = `process.setuid(65534);const p=require(${JSON.stringify(path.join(__dirname, 'persistence.js'))});const g=p.checkGuard(p.resolveConfig({COS_DB_PATH:${JSON.stringify(path.join(root, 'cos.db'))},COS_REQUIRE_PERSISTENT:'1',COS_PERSISTENT_ROOT:${JSON.stringify(root)}},'/'));console.log(JSON.stringify({ok:g.ok,e:g.errors}))`;
      const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
      let j = null; try { j = JSON.parse(r.stdout); } catch {}
      if (j) check('23A-10 unwritable DB directory is refused (run as an unprivileged user)', j.ok === false && /not writable/.test(j.e.join()), r.stdout + r.stderr);
      else skip('23A-10 unwritable DB directory', 'could not drop privileges here: ' + (r.stderr || '').slice(0, 120));
    } else {
      const root = mk('A10root'); fs.chmodSync(root, 0o555);
      const g = persistence.checkGuard(persistence.resolveConfig({ COS_DB_PATH: path.join(root, 'cos.db'), COS_REQUIRE_PERSISTENT: '1', COS_PERSISTENT_ROOT: root }, __dirname));
      check('23A-10 unwritable DB directory is refused', !g.ok && /not writable/.test(g.errors.join())); fs.chmodSync(root, 0o755);
    }
    // the real process: refuses and never listens
    { const root = mk('A11root'), other = mk('A11other');
      const x = await expectRefusal({ COS_DB_PATH: path.join(other, 'cos.db'), COS_REQUIRE_PERSISTENT: '1', COS_PERSISTENT_ROOT: root, COS_INIT_DB: '1' });
      check('23A-11 real server: DB outside root -> exits 3, never listens, creates no DB file', x.r && x.r.code === 3 && !x.listening && !fs.existsSync(path.join(other, 'cos.db')) && /persistence guard/.test(x.log), JSON.stringify(x.r) + x.log.slice(-200)); }
    { const x = await expectRefusal({ COS_DB_PATH: path.join(tmp, 'gone', 'cos.db'), COS_REQUIRE_PERSISTENT: '1', COS_PERSISTENT_ROOT: path.join(tmp, 'gone'), COS_INIT_DB: '1' });
      check('23A-12 real server: missing root -> exits 3, directory is NOT auto-created', x.r && x.r.code === 3 && !fs.existsSync(path.join(tmp, 'gone')), JSON.stringify(x.r)); }

    // ---------------- 23B/23C lifecycle on a "persistent disk" ----------------
    const disk = mk('disk'), dbp = path.join(disk, 'cos.db');
    const penv = { COS_DB_PATH: dbp, COS_PERSISTENT_ROOT: disk, COS_REQUIRE_PERSISTENT: '1', COS_INIT_DB: '1' };
    const MARK = 'PERSISTENCE_ACCEPTANCE_LOCAL_' + Date.now();
    let b = boot(penv);
    check('23B-1 boots on an empty persistent disk and creates the DB under the root', await b.up() && fs.existsSync(dbp), b.log.slice(-300));
    let h = (await req(b.P, 'GET', '/health')).json;
    check('23B-2 /health: resolved path, root, REQUIRE, guard pass, inside root, dir writable', h.persistence.db_path === dbp && h.persistence.persistent_root === disk && h.persistence.require_persistent === true && h.persistence.guard === 'pass' && h.persistence.db_path_inside_root === true && h.persistence.db_dir_writable === true && h.persistence.db_file_exists === true && h.persistence.using_persistent_location === true, JSON.stringify(h.persistence));
    check('23B-3 /health: db.guards ok, journal_mode=wal, busy_timeout reported', h.db.guards.ok === true && h.db.journal_mode === 'wal' && h.db.busy_timeout_ms === 5000, JSON.stringify(h.db));
    check('23B-4 /health: schema user_version == expected (1) and migration summary present', h.db.schema.user_version === 1 && h.db.schema.expected === 1 && h.db.schema.ok === true && h.db.schema.migration.ran === true, JSON.stringify(h.db.schema));
    check('23B-5 /health exposes no token or key material', !h.persistence || !JSON.stringify(h).includes(TOKEN) && !/api[_-]?key/i.test(JSON.stringify(h)));
    check('23B-6 init result is created on first boot', h.init.result === 'created', h.init.result);

    // seed two awaiting-approval missions, then exercise the REAL approval path
    { const d = new DatabaseSync(dbp); d.exec('PRAGMA busy_timeout=5000');
      for (const id of ['M_ONE', 'M_TWO']) { d.prepare(`INSERT INTO missions (id,request_text,risk_tier,created_at) VALUES (?,?, 'high','t')`).run(id, `${MARK} ${id}`); dec(d, id, 'PROPOSED', `${MARK} proposed`); dec(d, id, 'AWAITING_APPROVAL', `${MARK} halt`); }
      d.close(); }
    const a1 = await req(b.P, 'POST', '/api/missions/M_ONE/decision', { decision: 'APPROVED' });
    check('23C-1 approval through the normal path: 200', a1.status === 200, a1.raw.slice(0, 200));
    let s1 = (await req(b.P, 'GET', '/api/snapshot')).json;
    const countAudit = (s, id) => (s.audit || []).filter(a => a.mission_id === id).length;
    check('23C-2 before restart: mission, marker and audit rows present', s1.missions.some(m => m.id === 'M_ONE') && JSON.stringify(s1).includes(MARK) && countAudit(s1, 'M_ONE') >= 2, `audit=${countAudit(s1, 'M_ONE')}`);
    const rows1 = new DatabaseSync(dbp).prepare(`SELECT status FROM decisions WHERE mission_id='M_ONE' ORDER BY id`).all().map(r => r.status).join(',');

    b.child.kill('SIGTERM'); const ex1 = await b.done;
    check('23C-3 SIGTERM: clean exit code 0 and "clean" shutdown logged', ex1.code === 0 && /SHUTDOWN: clean/.test(b.log), JSON.stringify(ex1) + b.log.slice(-200));
    { const stray = []; const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, f.name); if (f.isDirectory()) walk(fp); else if (/-(wal|shm)$/.test(f.name)) stray.push(fp); } }; walk(tmp);
      check('23C-4 after a clean stop any -wal/-shm file is beside the DB on the disk (none elsewhere)', stray.every(f => path.dirname(f) === disk), stray.join(',')); }
    b = boot(penv); check('23C-5 restart on the same disk with COS_INIT_DB=1 boots', await b.up(), b.log.slice(-300));
    h = (await req(b.P, 'GET', '/health')).json;
    check('23C-6 after restart: init not_needed (existing DB untouched), guard pass, journal wal, version 1', h.init.result === 'not_needed' && h.persistence.guard === 'pass' && h.db.journal_mode === 'wal' && h.db.schema.user_version === 1 && h.db.guards.ok, JSON.stringify({ i: h.init, g: h.persistence.guard, d: h.db.schema }));
    let s2 = (await req(b.P, 'GET', '/api/snapshot')).json;
    const rows2 = new DatabaseSync(dbp).prepare(`SELECT status FROM decisions WHERE mission_id='M_ONE' ORDER BY id`).all().map(r => r.status).join(',');
    check('23C-7 FRESH READ after SIGTERM restart: same mission, marker, decisions, audit', s2.missions.some(m => m.id === 'M_ONE') && JSON.stringify(s2).includes(MARK) && rows2 === rows1 && countAudit(s2, 'M_ONE') === countAudit(s1, 'M_ONE'), `${rows1} | ${rows2}`);
    const a2 = await req(b.P, 'POST', '/api/missions/M_TWO/decision', { decision: 'APPROVED' });
    b.child.kill('SIGKILL'); await b.done;     // hard kill right after a committed write (no graceful path)
    b = boot(penv); await b.up();
    const s3 = (await req(b.P, 'GET', '/api/snapshot')).json;
    const v3 = new DatabaseSync(dbp);
    check('23C-8 FRESH READ after SIGKILL restart: both committed approvals + executions survive', a2.status === 200 && ['M_ONE', 'M_TWO'].every(id => v3.prepare(`SELECT COUNT(*) c FROM execution_log WHERE mission_id=?`).get(id).c === 1) && s3.missions.some(m => m.id === 'M_TWO') && s3.health.audit === 'ok', `a2=${a2.status}`);
    check('23C-9 integrity_check ok and audit rows still append-only after restarts', Object.values(v3.prepare('PRAGMA integrity_check').get())[0] === 'ok' && (() => { try { v3.prepare(`UPDATE decisions SET rationale='forged'`).run(); return false; } catch (e) { return /append-only/.test(e.message); } })());
    v3.close(); b.child.kill('SIGTERM'); await b.done;

    // ---------------- 23D migrations ----------------
    { const dp = path.join(mk('D1'), 'v0.db'); const d = new DatabaseSync(dp); d.exec(schema);   // pre-versioning DB: user_version 0, no guards
      d.prepare(`INSERT INTO missions (id,request_text,created_at) VALUES ('OLD','legacy','t')`).run(); dec(d, 'OLD', 'PROPOSED', 'legacy row'); d.close();
      const before = JSON.stringify(new DatabaseSync(dp).prepare('SELECT * FROM decisions').all());
      let bb = boot({ COS_DB_PATH: dp, COS_INIT_DB: '0' }); const up = await bb.up(); const hh = up ? (await req(bb.P, 'GET', '/health')).json : null;
      bb.child.kill('SIGTERM'); await bb.done;
      const v = new DatabaseSync(dp);
      check('23D-1 unversioned existing DB: boots, stamped v0 -> v1, existing rows byte-identical, guards applied', up && hh.db.schema.user_version === 1 && hh.db.guards.ok && JSON.stringify(v.prepare('SELECT * FROM decisions').all()) === before, bb.log.slice(-300));
      bb = boot({ COS_DB_PATH: dp, COS_INIT_DB: '0' }); await bb.up(); const h2 = (await req(bb.P, 'GET', '/health')).json; bb.child.kill('SIGTERM'); await bb.done;
      check('23D-2 second boot is idempotent: nothing applied, version stays 1', h2.db.schema.migration.applied === 0 && h2.db.schema.migration.version_before === 1 && h2.db.schema.user_version === 1, JSON.stringify(h2.db.schema.migration)); v.close(); }
    { const dp = path.join(mk('D2'), 'new.db'); const d = new DatabaseSync(dp); d.exec(schema); d.exec('PRAGMA user_version = 99'); d.close();
      const x = await expectRefusal({ COS_DB_PATH: dp, COS_INIT_DB: '0' });
      check('23D-3 DB stamped with a NEWER schema version: refuses to boot (exit 4), data untouched', x.r && x.r.code === 4 && !x.listening && /newer than this build/.test(x.log) && Number(Object.values(new DatabaseSync(dp).prepare('PRAGMA user_version').get())[0]) === 99, JSON.stringify(x.r) + x.log.slice(-200)); }
    { const dp = path.join(mk('D3'), 'broken.db'); const d = new DatabaseSync(dp); d.exec('CREATE TABLE missions (id TEXT PRIMARY KEY)'); d.close();
      const x = await expectRefusal({ COS_DB_PATH: dp, COS_INIT_DB: '0' });
      check('23D-4 DB missing core tables: refuses to boot (exit 4), does not recreate or reset it', x.r && x.r.code === 4 && !x.listening && /core table/.test(x.log) && new DatabaseSync(dp).prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE type='table'`).get().c === 1, JSON.stringify(x.r) + x.log.slice(-200)); }
    { const dp = path.join(mk('D4'), 'dup.db'); const d = new DatabaseSync(dp); d.exec(schema); d.prepare(`INSERT INTO missions (id,request_text,created_at) VALUES ('M','x','t')`).run();
      for (const s of ['a', 'b']) d.prepare(`INSERT INTO execution_log (mission_id,detail,created_at) VALUES ('M',?,'t')`).run(s); d.close();
      const bb = boot({ COS_DB_PATH: dp, COS_INIT_DB: '0' }); const up = await bb.up(); const hh = up ? (await req(bb.P, 'GET', '/health')).json : null; bb.child.kill('SIGTERM'); await bb.done;
      check('23D-5 legacy duplicate execution rows stay NON-fatal (Test 21D-7 contract) but are surfaced', up && hh.db.guards.ok === false && hh.db.schema.migration.warnings >= 1, bb.log.slice(-300)); }

    // ---------------- 23E drain on SIGTERM ----------------
    { const stub = path.join(tmp, 'slow_stub.js');
      fs.writeFileSync(stub, `global.fetch=async(url)=>{const u=String(url);if(u.startsWith('https://generativelanguage.googleapis.com/')){await new Promise(r=>setTimeout(r,1500));return{ok:false,status:503,json:async()=>({}),text:async()=>'stub 503'};}const b='seed';return{ok:true,status:200,json:async()=>({}),text:async()=>b,arrayBuffer:async()=>Buffer.from(b),headers:{get:()=>'text/plain'}};};`);
      const dp = path.join(mk('E'), 'cos.db');
      const bb = boot({ COS_DB_PATH: dp, COS_INIT_DB: '1', COS_MODE: 'LIVE', GEMINI_API_KEY: 'test-key-not-real' }, { preload: stub });
      check('23E-1 backend (slow stubbed provider) started', await bb.up(), bb.log.slice(-200));
      const inflight = req(bb.P, 'POST', '/api/missions', { objective: 'Shutdown drain regression request', nonce: 'DRAIN23_NONCE_01' }).catch(e => ({ status: 'reset', json: null, raw: String(e && e.message) }));
      await sleep(400); bb.child.kill('SIGTERM'); await sleep(250);
      let late = null; try { late = await req(bb.P, 'GET', '/health'); } catch (e) { late = { status: 'refused' }; }
      const r = await inflight; const ex = await bb.done;
      check('23E-2 request already running when SIGTERM arrived completes normally (502 + mission_id)', r.status === 502 && r.json && typeof r.json.mission_id === 'string', `${r.status} ${r.raw.slice(0, 120)}`);
      check('23E-3 a NEW request after SIGTERM is refused (503 or connection refused)', late.status === 503 || late.status === 'refused', String(late.status));
      check('23E-4 process exits 0 with a clean shutdown after the drain', ex.code === 0 && /SHUTDOWN: clean/.test(bb.log), JSON.stringify(ex) + bb.log.slice(-200));
      const v = new DatabaseSync(dp);
      const st = v.prepare(`SELECT status FROM decisions WHERE mission_id=? ORDER BY id`).all((r.json && r.json.mission_id) || '').map(x => x.status);
      check('23E-5 the drained request left its own truthful FAILED row; no COMPLETED/APPROVED/EXECUTED fabricated', st.includes('FAILED') && !st.some(x => /COMPLETED|APPROVED|EXECUTED/.test(x)) && v.prepare('SELECT COUNT(*) c FROM execution_log').get().c === 0, st.join(',')); v.close(); }
  } catch (e) { check('test run completed without exception', false, e && e.stack); }
  console.log(`\nTEST23 result=${failed === 0 ? 'PASS' : 'FAIL'} passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();

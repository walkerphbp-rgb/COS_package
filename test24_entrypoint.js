/**
 * TEST 24 — container entrypoint + Dockerfile readiness (LOCAL, no Docker needed).
 *
 *   24A  static: Dockerfile ships persistence.js + docker-entrypoint.js, starts via the entrypoint, does NOT bake
 *        COS_REQUIRE_PERSISTENT into the image, does not pin USER root, and the example Blueprint is not named render.yaml
 *   24B  behaviour (needs to run as root, otherwise SKIPPED): simulate a host that mounts a fresh disk ROOT-OWNED
 *        - control: the unprivileged server alone cannot use it (guard refuses: not writable)
 *        - entrypoint: chowns the dir, drops to uid 1000, boots, guard passes, DB created and owned by 1000
 *        - an existing root-owned DB (from an earlier root deployment) is re-owned, data intact
 *        - already-unprivileged start (docker run --user) works with no chown
 *        - invalid COS_RUN_UID refuses to start instead of running as root
 *        - a symlinked DB path is never chowned
 *
 * This is NOT a Docker build and NOT Render. It proves the ownership logic against a simulated root-owned mount.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

let passed = 0, failed = 0;
const check = (n, ok, d) => { if (ok) { passed++; console.log(`PASS  ${n}`); } else { failed++; console.log(`FAIL  ${n}${d ? '  -> ' + d : ''}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const df = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

// ---------------- 24A static ----------------
const docker = df('Dockerfile');
const dockerCode = docker.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
check('24A-1 Dockerfile COPYs persistence.js and docker-entrypoint.js', /COPY[^\n]*persistence\.js/.test(dockerCode) && /COPY[^\n]*docker-entrypoint\.js/.test(dockerCode));
check('24A-2 Dockerfile starts through the entrypoint', /CMD \["node", "docker-entrypoint\.js"\]/.test(dockerCode));
check('24A-3 COS_REQUIRE_PERSISTENT is NOT baked into the image (deployment decides)', !/COS_REQUIRE_PERSISTENT/.test(dockerCode));
check('24A-4 image does not pin the whole container to USER root or a RUN_AS toggle', !/^\s*USER\s/m.test(dockerCode) && !/RUN_AS/.test(dockerCode));
check('24A-6 Dockerfile declares no VOLUME (an anonymous ephemeral volume would fake a dedicated /data mount)', !/^\s*VOLUME\s/m.test(dockerCode));
check('24A-5 Blueprint example is not named render.yaml (cannot imply a configured disk)', !fs.existsSync(path.join(__dirname, 'render.yaml')) && fs.existsSync(path.join(__dirname, 'render.example.yaml')) && /DOCUMENTATION ONLY/.test(df('render.example.yaml')));

const isRoot = process.getuid && process.getuid() === 0;
if (!isRoot) {
  console.log('SKIP  24B behavioural checks (need root to simulate a root-owned mount and drop privileges)');
  console.log(`\nTEST24 result=${failed === 0 ? 'PASS' : 'FAIL'} passed=${passed} failed=${failed} (24B skipped)`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---------------- 24B behaviour ----------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't24-')); fs.chmodSync(tmp, 0o755);
const TOKEN = 't24-token-' + 'x'.repeat(26);
const port = () => 20000 + Math.floor(Math.random() * 20000);
const mkdisk = n => { const d = path.join(tmp, n); fs.mkdirSync(d); fs.chownSync(d, 0, 0); fs.chmodSync(d, 0o755); return d; };   // root-owned 0755, like a fresh mount
const owner = p => { const s = fs.lstatSync(p); return `${s.uid}:${s.gid}`; };
function get(P, p) { return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: P, path: p }, rs => { let s = ''; rs.on('data', c => s += c); rs.on('end', () => { try { res(JSON.parse(s)); } catch { res(null); } }); }).on('error', rej); }); }
function start(argv, env, { asUser } = {}) {
  const P = port();
  const base = asUser ? ['setpriv', ['--reuid=' + asUser, '--regid=' + asUser, '--clear-groups', process.execPath, ...argv]] : [process.execPath, argv];
  const child = spawn(base[0], base[1], { env: { PATH: process.env.PATH, COS_PORT: String(P), PORT: String(P), COS_HOST: '127.0.0.1', COS_TOKEN: TOKEN, COS_MODE: 'MOCK', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const b = { P, child, log: '', exited: null };
  child.stdout.on('data', d => b.log += d); child.stderr.on('data', d => b.log += d);
  b.done = new Promise(r => child.on('exit', (code, sig) => { b.exited = { code, sig }; r(b.exited); }));
  b.up = async () => { for (let i = 0; i < 60 && !b.exited; i++) { try { if (await get(P, '/health')) return true; } catch {} await sleep(150); } return false; };
  b.uid = () => { try { return /^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${child.pid}/status`, 'utf8'))[1]; } catch { return null; } };
  return b;
}
const stop = async b => { b.child.kill('SIGTERM'); await Promise.race([b.done, sleep(5000)]); b.child.kill('SIGKILL'); };
const ENTRY = [path.join(__dirname, 'docker-entrypoint.js')], SERVER = [path.join(__dirname, 'cos_backend.js')];
const penv = disk => ({ COS_DB_PATH: path.join(disk, 'cos.db'), COS_PERSISTENT_ROOT: disk, COS_REQUIRE_PERSISTENT: '1', COS_INIT_DB: '1' });

(async () => {
  try {
    // control: the problem
    { const disk = mkdisk('ctl'); const b = start(SERVER, penv(disk), { asUser: 1000 }); const r = await Promise.race([b.done, sleep(6000).then(() => null)]); if (!r) b.child.kill('SIGKILL');
      check('24B-1 CONTROL: unprivileged server on a root-owned disk refuses to boot (not writable), no DB created', r && r.code === 3 && /not writable/.test(b.log) && !fs.existsSync(path.join(disk, 'cos.db')), JSON.stringify(r) + b.log.slice(-200)); }

    // the fix
    { const disk = mkdisk('fix'); check('24B-2 precondition: simulated disk is root-owned', owner(disk) === '0:0');
      const b = start(ENTRY, penv(disk)); const up = await b.up(); const h = up ? await get(b.P, '/health') : null;
      check('24B-3 entrypoint on the same root-owned disk: boots', up, b.log.slice(-300));
      check('24B-4 process runs as uid 1000, not root', b.uid() === '1000', 'uid=' + b.uid());
      check('24B-5 /health: guard pass, inside root, dir writable, db created', h && h.persistence.guard === 'pass' && h.persistence.db_path_inside_root === true && h.persistence.db_dir_writable === true && h.persistence.db_file_exists === true, h && JSON.stringify(h.persistence));
      check('24B-6 persistent dir and DB are owned by 1000:1000 (only these were chowned)', owner(disk) === '1000:1000' && owner(path.join(disk, 'cos.db')) === '1000:1000' && /chowned 1 path\(s\)/.test(b.log), owner(disk) + ' | ' + b.log.slice(0, 200));
      check('24B-7 entrypoint log states the privilege drop', /now running as uid=1000 gid=1000/.test(b.log));
      await stop(b);
      const b2 = start(ENTRY, penv(disk)); const up2 = await b2.up(); const h2 = up2 ? await get(b2.P, '/health') : null;
      check('24B-8 second start (disk now owned by 1000): boots, init not_needed, nothing re-chowned', up2 && h2.init.result === 'not_needed' && /chowned 0 path\(s\)/.test(b2.log), b2.log.slice(0, 250)); await stop(b2); }

    // earlier root deployment left a root-owned DB
    { const disk = mkdisk('legacy'); const dbp = path.join(disk, 'cos.db');
      const schema = fs.readFileSync(path.join(__dirname, 'test17_schema.sql'), 'utf8'); const d = new DatabaseSync(dbp); d.exec(schema);
      d.prepare(`INSERT INTO missions (id,request_text,created_at) VALUES ('ROOTMADE','keep me','t')`).run(); d.close();
      check('24B-9 precondition: existing DB is root-owned', owner(dbp) === '0:0');
      const b = start(ENTRY, penv(disk)); const up = await b.up(); await stop(b);
      const v = new DatabaseSync(dbp);
      check('24B-10 existing root-owned DB is re-owned to 1000 and its data is intact', up && owner(dbp) === '1000:1000' && v.prepare(`SELECT request_text t FROM missions WHERE id='ROOTMADE'`).get().t === 'keep me', b.log.slice(0, 250)); v.close(); }

    // already unprivileged
    { const disk = mkdisk('nonroot'); fs.chownSync(disk, 1000, 1000);
      const b = start(ENTRY, penv(disk), { asUser: 1000 }); const up = await b.up();
      check('24B-11 started already as uid 1000 on a writable disk (docker run --user): boots, no chown attempted', up && b.uid() === '1000' && !/ENTRYPOINT/.test(b.log), b.log.slice(0, 250)); await stop(b); }

    // fail closed
    { const disk = mkdisk('bad'); const b = start(ENTRY, { ...penv(disk), COS_RUN_UID: 'abc' }); const r = await Promise.race([b.done, sleep(6000).then(() => null)]); if (!r) b.child.kill('SIGKILL');
      check('24B-12 invalid COS_RUN_UID: refuses to start (exit 1), never serves as root, disk untouched', r && r.code === 1 && /REFUSING TO START/.test(b.log) && owner(disk) === '0:0' && !/on http:/.test(b.log), JSON.stringify(r) + b.log.slice(-200)); }
    { const disk = mkdisk('zero'); const b = start(ENTRY, { ...penv(disk), COS_RUN_UID: '0' }); const r = await Promise.race([b.done, sleep(6000).then(() => null)]); if (!r) b.child.kill('SIGKILL');
      check('24B-13 COS_RUN_UID=0 (root) is refused', r && r.code === 1 && !/on http:/.test(b.log), JSON.stringify(r)); }

    // symlink safety
    { const disk = mkdisk('sym'), outside = mkdisk('symout'); fs.writeFileSync(path.join(outside, 'real.db'), '');
      fs.symlinkSync(path.join(outside, 'real.db'), path.join(disk, 'cos.db'));
      const b = start(ENTRY, { ...penv(disk), COS_INIT_DB: '0' }); const r = await Promise.race([b.done, sleep(6000).then(() => null)]); if (!r) b.child.kill('SIGKILL');
      check('24B-14 symlinked DB path is never chowned and the server refuses it (guard)', owner(path.join(outside, 'real.db')) === '0:0' && /not chowning symlink/.test(b.log) && r && r.code === 3, owner(path.join(outside, 'real.db')) + ' ' + JSON.stringify(r) + b.log.slice(-200)); }
  } catch (e) { check('test run completed without exception', false, e && e.stack); }
  console.log(`\nTEST24 result=${failed === 0 ? 'PASS' : 'FAIL'} passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();

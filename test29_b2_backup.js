/**
 * TEST 29 — Backblaze B2 backup and recovery (LOCAL; real SQLite, real backend processes, a fake S3-compatible server that
 * VERIFIES every AWS Signature V4 request). A successful upload is not proof of recoverability, so the centrepiece is a
 * DISASTER-RECOVERY DRILL: build real system state, destroy the database, restore from "B2" into a fresh process and prove
 * the required state (rows, audit, approvals, executions, routing, formats, Decision Memory, guards) comes back identical.
 *
 *   29A  SigV4 correctness (AWS published example) + the fake S3 really enforces signatures
 *   29B  configuration is validated and fails closed; credentials never appear in errors
 *   29C  snapshot consistency while another process writes
 *   29D  upload verification and failure handling: latest.json only ever points at a proven-restorable object
 *   29E  DISASTER-RECOVERY DRILL through real backend processes (SIGKILL + deleted database + restore)
 *   29F  restore rules: fallback, no silent fallback on transient errors, stale sidecars, newer schema, atomicity
 *   29G  single-writer lease (fencing)
 *   29H  throttling, idle behaviour, retention
 *   29I  fail-closed boot, degraded operation, and "disabled changes nothing"
 *   29J  secrets never leak; packaging
 *
 * Local proof only. This does NOT prove anything about Render or the real Backblaze service.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const S3 = require('./b2_s3'), B = require('./b2_backup'), M = require('./db_migrations'), gate = require('./gate');

let passed = 0, failed = 0;
const check = (n, ok, d) => { if (ok) { passed++; console.log(`PASS  ${n}`); } else { failed++; console.log(`FAIL  ${n}${d ? '  -> ' + String(d).slice(0, 320) : ''}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000, step = 150) => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() > end) return null; await sleep(step); } };
const J = JSON.stringify, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't29-'));
const schema = fs.readFileSync(path.join(__dirname, 'test17_schema.sql'), 'utf8');
const TOKEN = 't29-token-' + 'x'.repeat(26);
const KEY_ID = 'K00TESTKEYID0123456789', APP_KEY = 'SECRETAPPKEY_AbC123dEf456_zzzzzzzz', BUCKET = 'cos-test-bucket', REGION = 'us-west-004';
const RAW = 'https://raw.githubusercontent.com/o/r/main/README.md';
const throwsAsync = async (fn, re) => { try { await fn(); return false; } catch (e) { return !re || re.test(e.message); } };
const newDb = file => { const d = new DatabaseSync(file); d.exec(schema); const r = M.migrateVersioned(d); if (r.fatal) throw new Error(r.errors.join()); d.exec('PRAGMA journal_mode = WAL'); return d; };

/* ------------------------------------------------------------------ fake S3 (verifies SigV4) */
function startFakeS3() {
  const store = new Map(), log = [], inject = { putFail: null, getCorrupt: null, getFail: null, delFail: false, down: false, afterPut: null };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks); const u = new URL(req.url, 'http://x'); log.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: body.toString('latin1') });
      if (inject.down) return req.socket.destroy();
      const err = (st, code) => { res.writeHead(st, { 'content-type': 'application/xml' }); res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`); };
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(req.headers.authorization || '');
      if (!m) return err(403, 'AccessDenied'); if (m[1] !== KEY_ID) return err(403, 'InvalidAccessKeyId');
      if (req.headers['x-amz-content-sha256'] !== S3.sha256hex(body)) return err(400, 'XAmzContentSHA256Mismatch');
      const hdr = {}; for (const n of m[4].split(';')) if (!['host', 'x-amz-content-sha256', 'x-amz-date'].includes(n)) hdr[n] = req.headers[n];
      const t = req.headers['x-amz-date'], date = new Date(t.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
      const sig = S3.signRequest({ method: req.method, host: req.headers.host, path: u.pathname.split('/').map(decodeURIComponent).join('/'), query: Object.fromEntries(u.searchParams.entries()), headers: hdr, payload: body, keyId: KEY_ID, secret: APP_KEY, region: REGION, date });
      if (sig.signature !== m[5]) return err(403, 'SignatureDoesNotMatch');
      const parts = u.pathname.split('/').map(decodeURIComponent); if (parts[1] !== BUCKET) return err(404, 'NoSuchBucket'); const key = parts.slice(2).join('/');
      if (req.method === 'GET' && (key === '' ) && u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') || '', keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
        res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys.map(k => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${store.get(k).body.length}</Size><LastModified>2026-10-16T00:00:00.000Z</LastModified></Contents>`).join('')}</ListBucketResult>`);
      }
      if (req.method === 'PUT') {
        if (inject.putFail && inject.putFail.re.test(key) && inject.putFail.n-- > 0) return err(500, 'InternalError');
        const meta = {}; for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-amz-meta-')) meta[k] = v; store.set(key, { body, meta }); res.writeHead(200, { etag: '"x"' }); res.end();
        if (inject.afterPut) inject.afterPut(key); return;
      }
      if (req.method === 'DELETE') { if (inject.delFail) return err(500, 'InternalError'); store.delete(key); res.writeHead(204); return res.end(); }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (inject.getFail && inject.getFail.re.test(key)) return err(inject.getFail.status || 503, 'ServiceUnavailable');
        const o = store.get(key); if (!o) return err(404, 'NoSuchKey');
        let b = o.body; if (inject.getCorrupt && inject.getCorrupt.re.test(key)) { b = Buffer.from(b); if (inject.getCorrupt.truncate) b = b.subarray(0, Math.floor(b.length / 2)); else b[Math.floor(b.length / 2)] ^= 0xff; }
        res.writeHead(200, { 'content-length': b.length, ...o.meta }); return res.end(req.method === 'HEAD' ? undefined : b);
      }
      err(400, 'BadRequest');
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ port: srv.address().port, url: `http://127.0.0.1:${srv.address().port}`, store, log, inject, stop: () => new Promise(x => srv.close(x)) })));
}
const cfgFor = (fake, extra = {}) => B.loadConfig({ COS_B2_BACKUP: '1', COS_B2_ENDPOINT: fake.url, COS_B2_BUCKET: BUCKET, COS_B2_KEY_ID: KEY_ID, COS_B2_APP_KEY: APP_KEY, COS_B2_REGION: REGION, COS_B2_MIN_INTERVAL_SEC: '1', ...extra });
const mkMgr = (fake, dbPath, o = {}) => { const cfg = cfgFor(fake, o.env); return new B.BackupManager({ cfg, dbPath, s3: B.clientFor(cfg), maxSchema: M.SCHEMA_VERSION, lease: o.lease, restore: o.restore, log: () => {} }); };
const mkS3 = fake => { const c = cfgFor(fake); return { cfg: c, s3: B.clientFor(c) }; };
const fingerprint = file => { const d = new DatabaseSync(file); try { const out = { user_version: Object.values(d.prepare('PRAGMA user_version').get())[0], tables: {}, triggers: d.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).all().map(x => x.name), indexes: d.prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`).all().map(x => x.name) };
  for (const t of d.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(x => x.name)) { const rows = d.prepare(`SELECT * FROM ${t}`).all(); out.tables[t] = { n: rows.length, h: crypto.createHash('sha256').update(J(rows)).digest('hex') }; } return out; } finally { d.close(); } };

/* ------------------------------------------------------------------ real backend processes */
const SEED = 'Stub reference document. The SDK exposes a typed client for the API.';
const preload = path.join(tmp, 'stub.js');
fs.writeFileSync(preload, `const SEED=${J(SEED)};const realFetch=global.fetch;global.fetch=async(url,opts)=>{const u=String(url);if(u.startsWith('http://127.0.0.1'))return realFetch(url,opts);if(!u.startsWith('https://generativelanguage.googleapis.com/'))return{ok:true,status:200,text:async()=>SEED};const p=JSON.parse(opts.body).contents[0].parts[0].text;const n2=(p.match(/NONCE_[A-Z0-9]+/)||[''])[0];let out;if(/research specialist/.test(p))out={claims:[{text:'The SDK exposes a typed client. [ref:'+n2+']',source_url:(p.match(/Cite source_url exactly as: (\\S+)/)||[])[1]||'u',evidence_snippet:SEED,confidence:0.9}],verification_token:n2};else if(/analyst/.test(p))out={summary:'Benign summary.',llm_self_tier:'low'};else out={type:'written',payload:'Draft containing '+n2};return{ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(out)}]}}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2}})}};`);
const port = () => 20000 + Math.floor(Math.random() * 20000);
function req(P, method, p, body, auth = true) {
  return new Promise((res, rej) => { const data = body === undefined ? null : J(body); const r = http.request({ host: '127.0.0.1', port: P, path: p, method, headers: { ...(auth ? { Authorization: 'Bearer ' + TOKEN } : {}), 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, rs => { let s = ''; rs.on('data', c => s += c); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} res({ status: rs.statusCode, json: j }); }); }); r.on('error', rej); if (data) r.write(data); r.end(); });
}
function boot(env) {
  const P = port(), child = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'cos_backend.js')], { env: { PATH: process.env.PATH, COS_PORT: String(P), PORT: String(P), COS_HOST: '127.0.0.1', COS_TOKEN: TOKEN, COS_MODE: 'LIVE', GEMINI_API_KEY: 'k', COS_MISSION_SEED_URL: RAW, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const b = { P, child, log: '', exited: null }; child.stdout.on('data', d => b.log += d); child.stderr.on('data', d => b.log += d);
  b.done = new Promise(r => child.on('exit', (code, sig) => { b.exited = { code, sig }; r(b.exited); }));
  b.up = async () => !!(await waitFor(async () => !b.exited && (await req(P, 'GET', '/health', undefined, false)).status === 200, 20000));
  b.health = async () => (await req(P, 'GET', '/health', undefined, false)).json;
  b.kill9 = async () => { b.child.kill('SIGKILL'); await b.done; };
  b.term = async () => { b.child.kill('SIGTERM'); return Promise.race([b.done, sleep(15000).then(() => null)]); };
  b.stop = async () => { if (!b.exited) { b.child.kill('SIGTERM'); await Promise.race([b.done, sleep(4000)]); } b.child.kill('SIGKILL'); };
  return b;
}
const refusal = async env => { const b = boot(env); const r = await Promise.race([b.done, sleep(15000).then(() => null)]); if (!r) b.child.kill('SIGKILL'); return { r, log: b.log, listening: /on http:/.test(b.log) }; };
const post = (b, body) => req(b.P, 'POST', '/api/missions', { objective: 'Summarise the SDK for the team', nonce: 'NONCE_T29' + Math.floor(Math.random() * 1e9), ...body });

(async () => {
  const fakes = []; const newFake = async () => { const f = await startFakeS3(); fakes.push(f); return f; };
  try {
    // ================= 29A SigV4 =================
    { const r = S3.signRequest({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' }, payload: '', keyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') });
      check('29A-1 SigV4 reproduces the signature printed in the AWS documentation example (independent verification of the signer)', r.signature === 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41', r.signature);
      const fake = await newFake(), { cfg, s3 } = mkS3(fake); const odd = 'cos/snap shots/é+&=?#.db';
      await s3.put(odd, Buffer.from('hello')); const g = await s3.get(odd); const l = await s3.list('cos/snap shots/');
      check('29A-2 keys with spaces, unicode and reserved characters round-trip through put/get/list and sign correctly', g.body.toString() === 'hello' && l.length === 1 && l[0].key === odd);
      const bad1 = S3.makeS3({ endpoint: fake.url, bucket: BUCKET, keyId: KEY_ID, appKey: 'WRONG' + APP_KEY, region: REGION }), bad2 = S3.makeS3({ endpoint: fake.url, bucket: BUCKET, keyId: 'K00OTHER', appKey: APP_KEY, region: REGION });
      let e1 = null, e2 = null; try { await bad1.put('x', Buffer.from('1')); } catch (e) { e1 = e; } try { await bad2.put('x', Buffer.from('1')); } catch (e) { e2 = e; }
      check('29A-3 the fake S3 really enforces signatures: a wrong secret or key id is rejected (403), and the error text contains no credential', e1 && e1.status === 403 && e1.code === 'SignatureDoesNotMatch' && e2 && e2.status === 403 && !J([e1.message, e2.message]).includes(APP_KEY) && !fake.store.has('x'));
      const raw = await fetch(fake.url + `/${BUCKET}/y`, { method: 'PUT', body: 'tampered', headers: { authorization: 'AWS4-HMAC-SHA256 Credential=' + KEY_ID + '/20261016/' + REGION + '/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=' + '0'.repeat(64), 'x-amz-content-sha256': 'a'.repeat(64), 'x-amz-date': '20261016T000000Z' } });
      check('29A-4 a request whose payload hash does not match its body is rejected', raw.status === 400 && !fake.store.has('y'));
      const dn = await newFake(); dn.inject.down = true; const dc = mkS3(dn); let ne = null; try { await dc.s3.get('k'); } catch (e) { ne = e; }
      check('29A-5 a dropped connection becomes a NetworkError (status 0), not a crash', ne && ne.status === 0 && ne.code === 'NetworkError'); }

    // ================= 29B configuration =================
    { const base = { COS_B2_BACKUP: '1', COS_B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com', COS_B2_BUCKET: 'my-bucket', COS_B2_KEY_ID: KEY_ID, COS_B2_APP_KEY: APP_KEY };
      const thr = (o, re) => { try { B.loadConfig({ ...base, ...o }); return false; } catch (e) { return e instanceof B.BackupConfigError && (!re || re.test(e.message)) && !e.message.includes(APP_KEY); } };
      check('29B-1 disabled by default: nothing set (or COS_B2_BACKUP != 1) means enabled:false and no validation', B.loadConfig({}).enabled === false && B.loadConfig({ COS_B2_BACKUP: '0', COS_B2_APP_KEY: 'x' }).enabled === false);
      const c = B.loadConfig(base);
      check('29B-2 valid config: region derived from the endpoint, prefix normalised, defaults 15s / keep 48', c.enabled && c.region === 'us-west-004' && c.prefix === 'cos/' && c.minIntervalSec === 15 && c.keep === 48 && B.loadConfig({ ...base, COS_B2_PREFIX: 'a/b' }).prefix === 'a/b/' && B.loadConfig({ ...base, COS_B2_PREFIX: '' }).prefix === '');
      check('29B-3 each missing variable is named (never its value) and refuses', ['COS_B2_ENDPOINT', 'COS_B2_BUCKET', 'COS_B2_KEY_ID', 'COS_B2_APP_KEY'].every(k => thr({ [k]: '' }, new RegExp(k))));
      check('29B-4 endpoint must be https (http only for loopback), a valid URL, with a derivable region', thr({ COS_B2_ENDPOINT: 'http://example.com' }, /https/) && thr({ COS_B2_ENDPOINT: 'ftp://s3.us-west-004.backblazeb2.com' }, /https/) && thr({ COS_B2_ENDPOINT: 'not a url' }, /valid URL/) && thr({ COS_B2_ENDPOINT: 'https://example.com' }, /region/) && !thr({ COS_B2_ENDPOINT: 'http://127.0.0.1:9000', COS_B2_REGION: 'us-east-1' }) === true);
      check('29B-5 prefix, bucket and numeric settings are validated', ['../x', '/abs', 'a b', 'a//b', 'x'.repeat(70)].every(p => thr({ COS_B2_PREFIX: p }, /COS_B2_PREFIX/)) && thr({ COS_B2_BUCKET: 'bad bucket!' }, /BUCKET/) && ['0', '3601', 'x', '1.5'].every(v => thr({ COS_B2_MIN_INTERVAL_SEC: v }, /INTERVAL/)) && ['2', '1001'].every(v => thr({ COS_B2_KEEP: v }, /KEEP/))); }

    { const base = { COS_B2_BACKUP: '1', COS_B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com', COS_B2_BUCKET: 'my-bucket', COS_B2_KEY_ID: KEY_ID, COS_B2_APP_KEY: APP_KEY };
      const bad = ['COS_B2_ENDPOINT', 'COS_B2_BUCKET', 'COS_B2_KEY_ID', 'COS_B2_APP_KEY'].every(k => [' x', 'x ', '"x"', "'x'", 'x\n', '`x`'].every(v => { try { B.loadConfig({ ...base, [k]: v }); return false; } catch (e) { return e instanceof B.BackupConfigError && e.message.includes(k) && /whitespace or quote/.test(e.message) && !e.message.includes(APP_KEY); } }));
      check('29B-6 a pasted space, newline or quote in any credential/endpoint variable is rejected at boot with the variable NAME (the usual cause of a confusing 403)', bad); }

    // ================= 29C snapshot consistency under concurrent writes =================
    { const f = path.join(tmp, 'c.db'); newDb(f).close();
      const w = spawn(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA busy_timeout=5000');let i=0;const t=Date.now();while(Date.now()-t<2500){d.exec('BEGIN IMMEDIATE');d.prepare("INSERT INTO missions (id,request_text,risk_tier,created_at) VALUES (?,?,'low','t')").run('W'+i,'x');d.prepare("INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES (?,?,?,?)").run('W'+i,'PROPOSED','r','t');d.exec('COMMIT');i++}console.log(i)`, f], { stdio: ['ignore', 'pipe', 'inherit'] });
      let wout = ''; w.stdout.on('data', d => wout += d); const done = new Promise(r => w.on('exit', r)); await sleep(300);
      const snaps = []; for (let i = 0; i < 12; i++) { const o = path.join(tmp, `c-snap-${i}.db`); B.snapshotDb(f, o); const v = B.verifyDbFile(o); const d = new DatabaseSync(o); snaps.push({ ok: v.ok, m: d.prepare('SELECT COUNT(*) c FROM missions').get().c, d: d.prepare('SELECT COUNT(*) c FROM decisions').get().c, orphan: d.prepare('SELECT COUNT(*) c FROM missions m WHERE NOT EXISTS (SELECT 1 FROM decisions x WHERE x.mission_id = m.id)').get().c }); d.close(); await sleep(120); }
      await done; const n = Number(wout.trim());
      check(`29C-1 12 snapshots taken WHILE another process committed ${n} mission+decision transactions: every snapshot passes integrity_check and is transactionally consistent (no half-written pairs, counts never go backwards)`, n > 100 && snaps.every(s => s.ok && s.m === s.d && s.orphan === 0) && snaps.every((s, i) => !i || s.m >= snaps[i - 1].m) && snaps[snaps.length - 1].m > snaps[0].m, J(snaps.slice(0, 3)));
      check('29C-2 the snapshot is an independent file: the source database was never modified by snapshotting', fingerprint(f).tables.missions.n === n); }

    // ================= 29D upload verification and failure handling =================
    { const fake = await newFake(), { cfg, s3 } = mkS3(fake), f = path.join(tmp, 'd.db'), d = newDb(f); d.prepare(`INSERT INTO missions (id,request_text,risk_tier,created_at) VALUES ('M1','x','low','t')`).run(); d.close();
      const lease = await B.claimLease(s3, cfg); const up = () => B.uploadVerified({ s3, cfg, dbPath: f, maxSchema: M.SCHEMA_VERSION, writerId: lease.writerId, epoch: lease.epoch });
      const m1 = await up(), obj = fake.store.get(m1.key), latest = () => JSON.parse(fake.store.get(cfg.prefix + 'latest.json').body.toString());
      check('29D-1 a verified snapshot: object hash equals the manifest, the stored copy opens and passes integrity_check, manifest names the object with counts and schema version', S3.sha256hex(obj.body) === m1.sha256 && m1.bytes === obj.body.length && latest().key === m1.key && latest().counts.missions === 1 && latest().user_version === M.SCHEMA_VERSION && obj.meta['x-amz-meta-sha256'] === m1.sha256);
      const before = J(latest());
      fake.inject.putFail = { re: /snapshots\//, n: 1 }; const e1 = await throwsAsync(up, /S3 PUT failed/);
      check('29D-2 snapshot upload fails (HTTP 500): the error surfaces and latest.json is NOT advanced', e1 && J(latest()) === before);
      fake.inject.getCorrupt = { re: /snapshots\// }; const e2 = await throwsAsync(up, /does not match/);
      fake.inject.getCorrupt = { re: /snapshots\//, truncate: true }; const e3 = await throwsAsync(up, /does not match/); fake.inject.getCorrupt = null;
      check('29D-3 the uploaded object is read back and compared: a bit-flipped OR truncated copy in storage is detected and latest.json is NOT advanced', e2 && e3 && J(latest()) === before);
      fake.inject.putFail = { re: /latest\.json$/, n: 1 }; const e4 = await throwsAsync(up, /S3 PUT failed/);
      check('29D-4 manifest write fails after a good snapshot upload: the previous manifest stays valid and still points at a restorable object', e4 && J(latest()) === before && fake.store.has(latest().key));
      const bad = path.join(tmp, 'd-bad.db'); fs.copyFileSync(f, bad); const fd = fs.openSync(bad, 'r+'); fs.writeSync(fd, Buffer.alloc(4096, 0xAB), 0, 4096, 8192); fs.closeSync(fd);
      const nPut = fake.log.filter(r => r.method === 'PUT').length; const e5 = await throwsAsync(() => B.uploadVerified({ s3, cfg, dbPath: bad, maxSchema: M.SCHEMA_VERSION, writerId: lease.writerId, epoch: lease.epoch }));
      const emp = path.join(tmp, 'd-empty.db'); new DatabaseSync(emp).close(); const e6 = await throwsAsync(() => B.uploadVerified({ s3, cfg, dbPath: emp, maxSchema: M.SCHEMA_VERSION, writerId: lease.writerId, epoch: lease.epoch }), /core table missing/);
      check('29D-5 a corrupted or schema-less local database is never uploaded (nothing is PUT, manifest unchanged)', e5 && e6 && fake.log.filter(r => r.method === 'PUT').length === nPut && J(latest()) === before);
      const v = B.verifyDbFile(path.join(tmp, 'd.db'), 1); check('29D-6 verification rejects a database from a newer schema than this build understands', !v.ok && /newer than this build/.test(v.errors.join()));
      // manager: errors recorded, server-style resilience, recovery clears the error
      const mgr = mkMgr(fake, f, { lease }); fake.inject.putFail = { re: /snapshots\//, n: 1 }; const r1 = await mgr.snapshotNow('t'); const s1 = mgr.status(); const r2 = (mgr.nextAt = 0, await mgr.snapshotNow('t')); const s2 = mgr.status();
      check('29D-7 the manager records a failed upload (sanitised) and keeps running; the next attempt succeeds and clears the error', r1 === false && /S3 PUT failed/.test(s1.last_error) && s1.snapshots_uploaded === 0 && r2 === true && s2.last_error === null && s2.snapshots_uploaded === 1 && s2.last_verified_at);
      const dn = await newFake(), dm = mkMgr(dn, f); dn.inject.down = true; const r3 = await dm.snapshotNow('t');
      check('29D-8 storage completely unreachable: snapshotNow returns false with a network error recorded, no exception escapes', r3 === false && /network error/.test(dm.status().last_error)); }

    // ================= 29E DISASTER-RECOVERY DRILL =================
    { const fake = await newFake(), dbp = path.join(tmp, 'e', 'cos.db'); fs.mkdirSync(path.dirname(dbp), { recursive: true });
      const env = { COS_DB_PATH: dbp, COS_INIT_DB: '1', COS_B2_BACKUP: '1', COS_B2_ENDPOINT: fake.url, COS_B2_BUCKET: BUCKET, COS_B2_KEY_ID: KEY_ID, COS_B2_APP_KEY: APP_KEY, COS_B2_REGION: REGION, COS_B2_MIN_INTERVAL_SEC: '1' };
      const A = boot(env); const upA = await A.up(); const hA = upA ? await A.health() : null;
      check('29E-1 first boot against an EMPTY bucket: starts with a fresh database (no snapshot exists yet) and reports backup enabled', upA && hA.backup.enabled === true && hA.backup.restore.performed === false && hA.backup.restore.reason === 'no_snapshot_in_bucket' && hA.init.result === 'created' && hA.backup.bucket === BUCKET, A.log.slice(-300));
      // build real system state
      const g = await post(A, { mode: 'delegate' }), sm = await post(A, { mode: 'delegate', format_id: 'smme_finance', mission_type: 'cashflow_review' }), sm2 = await post(A, { mode: 'delegate', format_id: 'smme_finance' }), ask = await post(A, { mode: 'ask' }), asst = await post(A, { mode: 'assist' }), dflt = await post(A, {});
      const ap = await req(A.P, 'POST', `/api/missions/${sm.json.missionId}/decision`, { decision: 'APPROVED' }), rj = await req(A.P, 'POST', `/api/missions/${sm2.json.missionId}/decision`, { decision: 'REJECTED' });
      const ids = [g, sm, sm2, ask, asst, dflt].map(x => x.json.missionId);
      check('29E-2 real state built through the real API: auto-completed delegate, human-approved + executed smme_finance, human-REJECTED smme_finance, ask ANSWERED, assist DRAFT_READY, default-mode (ask) mission', g.json.outcome === 'AUTO_COMPLETED' && sm.json.outcome === 'AWAITING_APPROVAL' && ap.status === 200 && rj.status === 200 && ask.json.outcome === 'ANSWERED' && asst.json.outcome === 'DRAFT_READY' && dflt.json.outcome === 'ANSWERED', J([g.json.outcome, sm.json.outcome, ap.status, rj.status]));
      const settled = await waitFor(async () => { const h = await A.health(); return h.backup.pending_changes === false && h.backup.last_verified_at && h.backup.snapshots_uploaded >= 1 && h; }, 25000);
      const manifest = JSON.parse(fake.store.get('cos/latest.json').body.toString()), live = fingerprint(dbp);
      check('29E-3 the backup catches up: pending_changes false, the newest snapshot was downloaded back and verified, and the manifest counts equal the live database', !!settled && manifest.counts.missions === live.tables.missions.n && manifest.counts.decisions === live.tables.decisions.n && manifest.counts.execution_log === live.tables.execution_log.n && manifest.counts.execution_log >= 2 && manifest.user_version === live.user_version, J(manifest.counts) + ' ' + J(settled && settled.backup));
      const explainBefore = {}; for (const id of ids) explainBefore[id] = (await req(A.P, 'GET', `/api/missions/${id}/explain`.replace('/api/missions', '/api/memory/missions'))).json;
      const snapBefore = (await req(A.P, 'GET', '/api/snapshot')).json.missions.map(m => ({ id: m.id, status: m.status, approval: m.approval_status, exec: m.execution_status, tier: m.risk_tier })).sort((a, b) => a.id.localeCompare(b.id));
      // ---- DATA LOSS: hard crash + the database files are destroyed
      await A.kill9(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbp + ext, { force: true });
      check('29E-4 data loss simulated: server SIGKILLed and the database file, WAL and SHM deleted', !fs.existsSync(dbp) && !fs.existsSync(dbp + '-wal'));
      const Bo = boot(env); const upB = await Bo.up(); const hB = upB ? await Bo.health() : null;
      check('29E-5 a fresh process restores from B2 BEFORE creating anything: restore performed, init "not_needed" (it did not create an empty database), guards ok, schema current', upB && hB.backup.restore.performed === true && hB.backup.restore.fallback === false && hB.init.result === 'not_needed' && hB.db.guards.ok && hB.db.schema.ok && /restored/.test(Bo.log), Bo.log.slice(-400));
      const after = fingerprint(dbp), tableDiff = Object.keys(live.tables).filter(t => !after.tables[t] || after.tables[t].h !== live.tables[t].h);
      check('29E-6 REQUIRED STATE RESTORED: every table (missions, decisions, claims, artifacts, critic reviews, execution log, provider calls, format manifests/effects, router decisions...) has identical rows; same triggers, indexes and schema version', tableDiff.length === 0 && J(after.triggers) === J(live.triggers) && J(after.indexes) === J(live.indexes) && after.user_version === live.user_version && Object.keys(live.tables).length >= 12, J(tableDiff));
      let exDiff = []; for (const id of ids) { const e = (await req(Bo.P, 'GET', `/api/memory/missions/${id}/explain`)).json; if (J(e) !== J(explainBefore[id])) exDiff.push(id.slice(0, 8)); }
      const snapAfter = (await req(Bo.P, 'GET', '/api/snapshot')).json.missions.map(m => ({ id: m.id, status: m.status, approval: m.approval_status, exec: m.execution_status, tier: m.risk_tier })).sort((a, b) => a.id.localeCompare(b.id));
      check('29E-7 Decision Memory explain() is BYTE-IDENTICAL for all six missions (provenance, formats re-verified, routing, effects, gaps) and the dashboard snapshot matches', exDiff.length === 0 && J(snapAfter) === J(snapBefore) && explainBefore[sm.json.missionId].approval.status === 'APPROVED' && explainBefore[sm.json.missionId].execution.executed === true && explainBefore[sm.json.missionId].format.status === 'verified', J(exDiff));
      // ---- the safeguards are alive on the restored system
      const again = await req(Bo.P, 'POST', `/api/missions/${sm.json.missionId}/decision`, { decision: 'APPROVED' }), askAp = await req(Bo.P, 'POST', `/api/missions/${ask.json.missionId}/decision`, { decision: 'APPROVED' }), rejAp = await req(Bo.P, 'POST', `/api/missions/${sm2.json.missionId}/decision`, { decision: 'APPROVED' });
      const rd = new DatabaseSync(dbp); rd.exec('PRAGMA busy_timeout=5000'); const exBefore = rd.prepare('SELECT COUNT(*) c FROM execution_log').get().c; let dup = null; try { gate.gateExecute(rd, sm.json.missionId); dup = 'executed'; } catch (e) { dup = e.message; }
      const trig = (sql, ...a) => { try { rd.prepare(sql).run(...a); return 'ok'; } catch (e) { return e.message; } };
      check('29E-8 after restore the controls still bite: an executed mission cannot be approved or executed again (exactly-once), an ASK mission cannot be approved, a REJECTED mission cannot be approved, no new execution rows appeared', again.status === 409 && askAp.status === 409 && rejAp.status === 409 && /already executed|exactly/i.test(dup) && rd.prepare('SELECT COUNT(*) c FROM execution_log').get().c === exBefore, J([again.status, askAp.status, rejAp.status, dup]));
      check('29E-9 database constraints survived: append-only decisions/execution/router tables, immutable bindings, the "no execution outside delegate" trigger, integrity_check ok', /append-only/.test(trig(`UPDATE decisions SET rationale='forged'`)) && /append-only/.test(trig('DELETE FROM execution_log')) && /append-only/.test(trig(`UPDATE router_decisions SET effective_mode='delegate'`)) && /immutable/.test(trig(`UPDATE missions SET manifest_hash='z' WHERE id=?`, g.json.missionId)) && /does not permit execution/.test(trig(`INSERT INTO execution_log (mission_id,detail,created_at) VALUES (?,?,?)`, ask.json.missionId, 'raw', 't')) && Object.values(rd.prepare('PRAGMA integrity_check').get())[0] === 'ok');
      const maxBefore = Math.max(...Object.values(live.tables).map(() => 0)), idBefore = new DatabaseSync(dbp).prepare('SELECT MAX(id) m FROM decisions').get().m; const nm = await post(Bo, { mode: 'delegate' }); const idAfter = new DatabaseSync(dbp).prepare('SELECT MAX(id) m FROM decisions').get().m;
      check('29E-10 the restored system keeps working: a new delegate mission completes through the gate and sequence numbers continue (no reused ids)', nm.json.outcome === 'AUTO_COMPLETED' && idAfter > idBefore, J([idBefore, idAfter, nm.json.outcome]));
      await Bo.stop();
      // ---- the honest limit, and the mitigation
      const envSlow = { ...env, COS_B2_MIN_INTERVAL_SEC: '3600' }; const C = boot(envSlow); await C.up(); await waitFor(async () => (await C.health()).backup.last_verified_at, 20000);
      const lost = await post(C, { mode: 'ask' }); await C.kill9(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbp + ext, { force: true });
      const D = boot(envSlow); await D.up(); const hasLost = new DatabaseSync(dbp).prepare('SELECT COUNT(*) c FROM missions WHERE id=?').get(lost.json.missionId).c;
      check('29E-11 KNOWN LIMIT (documented): a mission committed AFTER the last verified snapshot is LOST if the process dies hard (SIGKILL) before the next snapshot; the backup is not continuous replication', lost.status === 201 && hasLost === 0);
      await waitFor(async () => (await D.health()).backup.last_verified_at, 20000); const kept = await post(D, { mode: 'ask' }); const t0 = Date.now(); const ex = await D.term(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbp + ext, { force: true });
      const E = boot(envSlow); await E.up(); const hasKept = new DatabaseSync(dbp).prepare('SELECT COUNT(*) c FROM missions WHERE id=?').get(kept.json.missionId).c;
      check('29E-12 MITIGATION: on a graceful stop (SIGTERM = what a redeploy or idle spin-down sends) a final VERIFIED snapshot is uploaded first, so the same kind of mission survives the data loss', ex && ex.code === 0 && /B2 final snapshot uploaded/.test(D.log) && hasKept === 1, (ex && ex.code) + ' ' + D.log.slice(-300)); await E.stop();
      // ---- secrets
      const everything = [A.log, Bo.log, C.log, D.log, E.log, J(hA), J(hB), J(fake.log.map(r => [r.url, r.body.length > 100000 ? '' : '', r.headers.host])), ...[...fake.store.values()].map(o => o.body.toString('latin1'))].join('\n');
      check('29E-13 SECRETS: the application key appears in no server log, health output, request URL or stored object (snapshots, manifest, lease); the key id appears in no log or health', !everything.includes(APP_KEY) && ![A.log, Bo.log, C.log, D.log, E.log, J(hA), J(hB)].join('\n').includes(KEY_ID) && !fake.log.some(r => r.url.includes(APP_KEY) || String(r.headers.authorization).includes(APP_KEY)));
    }

    // ================= 29F restore rules =================
    { const mkSnaps = async (fake, n) => { const { cfg, s3 } = mkS3(fake), f = path.join(tmp, 'f-src.db'); fs.rmSync(f, { force: true }); const d = newDb(f); const lease = await B.claimLease(s3, cfg); const ms = [];
        for (let i = 0; i < n; i++) { d.prepare(`INSERT INTO missions (id,request_text,risk_tier,created_at) VALUES (?,?,'low','t')`).run('S' + i, 'x'); ms.push(await B.uploadVerified({ s3, cfg, dbPath: f, maxSchema: M.SCHEMA_VERSION, writerId: lease.writerId, epoch: lease.epoch, now: (() => { const t = new Date(Date.UTC(2026, 9, 16, 8, 0, i)); return () => t; })() })); } d.close(); return { cfg, s3, ms }; };
      const restore = (x, dbp, o = {}) => B.restoreIfNeeded({ s3: x.s3, cfg: x.cfg, dbPath: dbp, maxSchema: o.maxSchema === undefined ? M.SCHEMA_VERSION : o.maxSchema });
      const f1 = await newFake(), x1 = await mkSnaps(f1, 3), p1 = path.join(tmp, 'f1.db'); fs.writeFileSync(p1 + '-wal', 'stale'); fs.writeFileSync(p1 + '-shm', 'stale');
      const r1 = await restore(x1, p1), d1 = new DatabaseSync(p1);
      check('29F-1 newest snapshot restored into a fresh path; stale -wal/-shm from the lost database are removed first; the result opens clean with all 3 missions', r1.performed && r1.key === x1.ms[2].key && !r1.fallback && d1.prepare('SELECT COUNT(*) c FROM missions').get().c === 3 && !fs.existsSync(p1 + '-wal') && fs.readdirSync(path.dirname(p1)).filter(n => n.includes('f1.db.restore')).length === 0);
      const nReq = f1.log.length; const r2 = await restore(x1, p1);
      check('29F-2 a local database that exists is NEVER overwritten and storage is not even contacted', r2.performed === false && r2.reason === 'local_database_present' && f1.log.length === nReq);
      const f2 = await newFake(), x2 = await mkSnaps(f2, 3); f2.store.get(x2.ms[2].key).body[100] ^= 0xff; const p2 = path.join(tmp, 'f2.db'), r3 = await restore(x2, p2), d2 = new DatabaseSync(p2);
      check('29F-3 the newest snapshot is CORRUPT in storage: restore detects it (hash) and falls back to the previous verified snapshot, reporting fallback and what was skipped (2 missions, not 3)', r3.performed && r3.fallback && r3.key === x2.ms[1].key && r3.skipped.length === 1 && /hash/.test(r3.skipped[0].reason) && d2.prepare('SELECT COUNT(*) c FROM missions').get().c === 2);
      const f3 = await newFake(), x3 = await mkSnaps(f3, 3); f3.inject.getFail = { re: new RegExp(x3.ms[2].key.split('/').pop().replace(/\./g, '\\.')), status: 503 }; const p3 = path.join(tmp, 'f3.db');
      check('29F-4 NO SILENT FALLBACK on a transient failure: if the newest snapshot cannot be downloaded (503) restore REFUSES rather than restoring older data; nothing is created', await throwsAsync(() => restore(x3, p3), /refusing to start empty/) && !fs.existsSync(p3));
      const f4 = await newFake(), x4 = await mkSnaps(f4, 2); for (const m of x4.ms) f4.store.get(m.key).body[100] ^= 0xff; const p4 = path.join(tmp, 'f4.db');
      check('29F-5 every snapshot corrupt: RestoreError listing each reason; no database and no temporary file left behind', await throwsAsync(() => restore(x4, p4), /no snapshot could be restored/) && !fs.existsSync(p4) && fs.readdirSync(tmp).filter(n => n.startsWith('f4.db')).length === 0);
      const f5 = await newFake(), c5 = mkS3(f5); const p5 = path.join(tmp, 'f5.db');
      const empty = await restore(c5, p5); f5.store.set('cos/latest.json', { body: Buffer.from('{not json'), meta: {} }); const e5a = await throwsAsync(() => restore(c5, p5), /not valid JSON/);
      f5.store.set('cos/latest.json', { body: Buffer.from(J({ format: 'x' })), meta: {} }); const e5b = await throwsAsync(() => restore(c5, p5), /malformed/);
      f5.store.set('cos/latest.json', { body: Buffer.from(J({ format: B.MANIFEST_FORMAT, key: '../../etc/passwd', sha256: 'a'.repeat(64), bytes: 1 })), meta: {} }); const e5c = await throwsAsync(() => restore(c5, p5), /malformed/); f5.inject.getFail = { re: /latest\.json/, status: 500 }; const e5d = await throwsAsync(() => restore(c5, p5), /cannot read the snapshot manifest/);
      check('29F-6 empty bucket = fresh start (not an error); an unreadable, corrupt, malformed or path-escaping manifest REFUSES (never "start empty")', empty.performed === false && empty.reason === 'no_snapshot_in_bucket' && e5a && e5b && e5c && e5d && !fs.existsSync(p5));
      const f6 = await newFake(), x6 = await mkSnaps(f6, 2); const p6 = path.join(tmp, 'f6.db'); const sv = new DatabaseSync(path.join(tmp, 'f6-src.db')); sv.exec(schema); M.migrateVersioned(sv); sv.exec('PRAGMA user_version = 99'); sv.close();
      const newer = fs.readFileSync(path.join(tmp, 'f6-src.db')), sha = S3.sha256hex(newer), nk = `cos/snapshots/20261016T090000000Z-e1-${sha.slice(0, 8)}.db`; f6.store.set(nk, { body: newer, meta: { 'x-amz-meta-sha256': sha } }); f6.store.set('cos/latest.json', { body: Buffer.from(J({ format: B.MANIFEST_FORMAT, key: nk, sha256: sha, bytes: newer.length, created_at: 'x', epoch: 1 })), meta: {} });
      const r6 = await restore(x6, p6);
      check('29F-7 a snapshot from a NEWER schema than this build is refused (skipped with the reason) and the older compatible snapshot is used instead', r6.performed && r6.fallback && /newer than this build/.test(r6.skipped[0].reason) && r6.key === x6.ms[1].key);
      const nb = S3.makeS3({ endpoint: (await newFake()).url, bucket: 'wrong-bucket-name', keyId: KEY_ID, appKey: APP_KEY, region: REGION }), pnb = path.join(tmp, 'f-nb.db');
      check('29F-9 a MISTYPED BUCKET (HTTP 404 NoSuchBucket) is a configuration error, never "no snapshot yet": restore refuses and creates nothing (it must not start empty)', await throwsAsync(() => B.restoreIfNeeded({ s3: nb, cfg: cfgFor(f1), dbPath: pnb, maxSchema: M.SCHEMA_VERSION }), /refusing to start empty/) && !fs.existsSync(pnb));
      const f7 = await newFake(), x7 = await mkSnaps(f7, 2), renamed = x7.ms[0].key.replace(/-[0-9a-f]{8}\.db$/, '-deadbeef.db'); f7.store.set(renamed, f7.store.get(x7.ms[0].key)); f7.store.delete(x7.ms[0].key);
      f7.store.get(x7.ms[1].key).body[100] ^= 0xff; const p7 = path.join(tmp, 'f7.db');
      check('29F-8 a fallback object whose NAME does not match its content hash (renamed/planted) is never trusted, even though its bytes are a valid database', await throwsAsync(() => restore(x7, p7), /no snapshot could be restored/) && !fs.existsSync(p7)); }

    // ================= 29G fencing =================
    { const fake = await newFake(), { cfg, s3 } = mkS3(fake), f = path.join(tmp, 'g.db'), d = newDb(f); d.prepare(`INSERT INTO missions (id,request_text,risk_tier,created_at) VALUES ('G1','x','low','t')`).run(); d.close();
      const la = await B.claimLease(s3, cfg), A = mkMgr(fake, f, { lease: la }); const okA = await A.snapshotNow('t'); const keyA = JSON.parse(fake.store.get('cos/latest.json').body).key;
      const lb = await B.claimLease(s3, cfg), Bm = mkMgr(fake, f, { lease: lb }); const nb = JSON.parse(fake.store.get('cos/lease.json').body);
      A.dirty = true; A.nextAt = 0; const upsBefore = fake.log.filter(r => r.method === 'PUT' && /snapshots\//.test(r.url)).length; const okA2 = await A.snapshotNow('t'); const fl = await A.flush(2000);
      check('29G-1 FENCING: after a second instance claims the lease (epoch +1), the first sees it is superseded, uploads nothing more (not even a final snapshot) and reports it', okA === true && lb.epoch === la.epoch + 1 && nb.writer_id === lb.writerId && okA2 === false && A.status().superseded === true && fl.flushed === false && fl.reason === 'superseded' && fake.log.filter(r => r.method === 'PUT' && /snapshots\//.test(r.url)).length === upsBefore && JSON.parse(fake.store.get('cos/latest.json').body).key === keyA);
      const okB = await Bm.snapshotNow('t'); check('29G-2 the new owner uploads normally and latest.json moves to its snapshot (epoch 2)', okB === true && JSON.parse(fake.store.get('cos/latest.json').body).epoch === lb.epoch);
      const f2 = await newFake(), c2 = mkS3(f2); f2.inject.afterPut = key => { if (key === 'cos/lease.json') f2.store.set('cos/lease.json', { body: Buffer.from(J({ writer_id: 'someoneelse0000', epoch: 99 })), meta: {} }); }; const lc = await B.claimLease(c2.s3, c2.cfg);
      check('29G-3 two instances claiming at the same moment: the claim is re-read and the loser is told (ok:false) instead of assuming ownership', lc.ok === false); }

    // ================= 29H throttle, idle, retention =================
    { const fake = await newFake(), f = path.join(tmp, 'h.db'), d = newDb(f); const { cfg, s3 } = mkS3(fake); const lease = await B.claimLease(s3, cfg), mgr = mkMgr(fake, f, { lease }); mgr.start();
      const snapPuts = () => fake.log.filter(r => r.method === 'PUT' && /snapshots\//.test(r.url)).length; await waitFor(() => snapPuts() >= 1, 8000); await sleep(3000); const idle = snapPuts();
      check('29H-1 IDLE: with nothing changing, no snapshot is uploaded after the first (data_version unchanged) over 3 seconds', idle === 1, 'puts=' + idle);
      const t0 = snapPuts(); const end = Date.now() + 3300; let i = 0; while (Date.now() < end) { d.prepare(`INSERT INTO missions (id,request_text,risk_tier,created_at) VALUES (?,?,'low','t')`).run('H' + (i++), 'x'); await sleep(80); } const during = snapPuts() - t0;
      check('29H-2 THROTTLE: continuous writes for 3.3s with a 1s minimum interval produce a bounded number of uploads (<= 4), not one per write', during >= 2 && during <= 4, 'puts=' + during + ' writes=' + i);
      const caught = await waitFor(() => mgr.status().pending_changes === false && mgr.status().last_verified_at && JSON.parse(fake.store.get('cos/latest.json').body).counts.missions === i, 8000);
      check('29H-3 after the writes stop the backup catches up to the final state (manifest counts == database)', !!caught); mgr.stop(); d.close();
      const f2 = await newFake(), c2 = mkS3(f2); const cfg2 = cfgFor(f2, { COS_B2_KEEP: '3' }), src = path.join(tmp, 'h2.db'), d2 = newDb(src), l2 = await B.claimLease(c2.s3, cfg2); const keys = [];
      for (let k = 0; k < 8; k++) { d2.prepare(`INSERT INTO missions (id,request_text,risk_tier,created_at) VALUES (?,?,'low','t')`).run('R' + k, 'x'); const m = await B.uploadVerified({ s3: c2.s3, cfg: cfg2, dbPath: src, maxSchema: M.SCHEMA_VERSION, writerId: l2.writerId, epoch: l2.epoch, now: (() => { const t = new Date(Date.UTC(2026, 9, 16, 8, 0, k)); return () => t; })() }); keys.push(m.key); }
      const del = await B.prune(c2.s3, cfg2, keys[7]); const left = [...f2.store.keys()].filter(k => k.includes('/snapshots/')).sort();
      check('29H-4 RETENTION: keeping 3, the 5 oldest snapshots are deleted, the newest 3 remain including the one latest.json names', del === 5 && left.length === 3 && left.includes(keys[7]) && JSON.stringify(left) === JSON.stringify(keys.slice(5).sort()));
      f2.inject.delFail = true; const del2 = await B.prune(c2.s3, cfg2, keys[7]); check('29H-5 a failing delete never throws or removes anything (retention is best effort)', del2 === 0 && [...f2.store.keys()].filter(k => k.includes('/snapshots/')).length === 3); }

    // ================= 29I boot behaviour =================
    { const base = fake => ({ COS_B2_BACKUP: '1', COS_B2_ENDPOINT: fake.url, COS_B2_BUCKET: BUCKET, COS_B2_KEY_ID: KEY_ID, COS_B2_APP_KEY: APP_KEY, COS_B2_REGION: REGION, COS_B2_MIN_INTERVAL_SEC: '1', COS_INIT_DB: '1' });
      const fk = await newFake(), dbp = n => path.join(tmp, 'i-' + n + '.db');
      const x1 = await refusal({ ...base(fk), COS_DB_PATH: dbp(1), COS_B2_APP_KEY: '' });
      check('29I-1 CONFIG FAILS CLOSED: backup enabled with a missing credential exits 7, names the variable, never listens, creates no database, prints no secret', x1.r && x1.r.code === 7 && /COS_B2_APP_KEY/.test(x1.log) && !x1.listening && !fs.existsSync(dbp(1)) && !x1.log.includes(KEY_ID));
      const x2 = await refusal({ ...base(fk), COS_DB_PATH: dbp(2), COS_B2_ENDPOINT: 'http://example.com' }); const x3 = await refusal({ ...base(fk), COS_DB_PATH: dbp(3), COS_B2_PREFIX: '../escape' });
      check('29I-2 plain-http endpoints and path-escaping prefixes refuse to boot (exit 7)', x2.r && x2.r.code === 7 && x3.r && x3.r.code === 7 && !x2.listening && !x3.listening);
      const dead = await newFake(); const deadUrl = dead.url; await dead.stop(); const x4 = await refusal({ ...base(fk), COS_B2_ENDPOINT: deadUrl, COS_DB_PATH: dbp(4) });
      check('29I-3 DATA-LOSS SAFETY: no local database + storage unreachable => REFUSES TO START (exit 7). It does not boot empty (which would later overwrite good history)', x4.r && x4.r.code === 7 && /RESTORE REFUSED/.test(x4.log) && !x4.listening && !fs.existsSync(dbp(4)));
      const fb = await newFake(); fb.store.set('cos/latest.json', { body: Buffer.from('garbage'), meta: {} }); const x5 = await refusal({ ...base(fb), COS_DB_PATH: dbp(5) });
      check('29I-4 a corrupt manifest in storage refuses to boot (exit 7) and nothing is created or overwritten', x5.r && x5.r.code === 7 && !x5.listening && !fs.existsSync(dbp(5)) && fb.store.get('cos/latest.json').body.toString() === 'garbage');
      const fc = await newFake(), p6 = dbp(6), B6 = boot({ ...base(fc), COS_DB_PATH: p6 }); await B6.up(); const mm = await post(B6, { mode: 'delegate' }); fc.inject.down = true; await sleep(300);
      const m2 = await post(B6, { mode: 'delegate' }); const h6 = await waitFor(async () => { const h = await B6.health(); return h.backup.last_error && h; }, 15000);
      check('29I-5 DEGRADED, NOT DOWN: with the local database present and storage unreachable the server keeps serving and creating missions; /health shows the backup error and pending changes', mm.status === 201 && m2.status === 201 && !!h6 && h6.backup.pending_changes === true && /network error/.test(h6.backup.last_error) && h6.db.guards.ok);
      fc.inject.down = false; const rec = await waitFor(async () => { const h = await B6.health(); return h.backup.last_error === null && h.backup.pending_changes === false && h; }, 40000); await B6.stop();
      check('29I-6 when storage returns, the backup recovers on its own (backoff), error clears, and the snapshot contains both missions', !!rec && JSON.parse(fc.store.get('cos/latest.json').body).counts.missions === 2);
      const fd = await newFake(), pd = dbp(7), D7 = boot({ COS_DB_PATH: pd, COS_INIT_DB: '1' }); await D7.up(); const m7 = await post(D7, { mode: 'ask' }); const h7 = await D7.health(); await D7.stop();
      const fe = await newFake(), D8 = boot({ ...base(fe), COS_DB_PATH: dbp(8), COS_READONLY: '1' }); await D8.up(); const h8 = await D8.health(); await D8.stop();
      check('29I-7 DISABLED (the default) changes NOTHING: no B2 configuration means backup.enabled:false, missions work, and storage receives zero requests; read-only mode with B2 set is inactive too (zero requests)', m7.status === 201 && h7.backup.enabled === false && fd.log.length === 0 && h8.backup.enabled === false && fe.log.length === 0 && /inactive in COS_READONLY/.test(D8.log) === true);
      const ff = await newFake(), p9 = dbp(9), F9 = boot({ ...base(ff), COS_DB_PATH: p9 }); const up9 = await F9.up(); const caught9 = await waitFor(async () => { const h = await F9.health(); return h.backup.last_verified_at && h; }, 15000);
      check('29I-8 first boot with an empty bucket creates the database, then uploads and VERIFIES a first snapshot on its own', up9 && !!caught9 && ff.store.has('cos/latest.json') && ff.store.has('cos/lease.json')); await F9.stop(); }

    { const fk = await newFake(); const base = { COS_B2_BACKUP: '1', COS_B2_ENDPOINT: fk.url, COS_B2_BUCKET: BUCKET, COS_B2_KEY_ID: KEY_ID, COS_B2_APP_KEY: APP_KEY, COS_B2_REGION: REGION, COS_INIT_DB: '1' };
      const w1 = await refusal({ ...base, COS_DB_PATH: path.join(tmp, 'i-w1.db'), COS_B2_KEY_ID: 'K00WRONGKEYID999999999' }), w2 = await refusal({ ...base, COS_DB_PATH: path.join(tmp, 'i-w2.db'), COS_B2_APP_KEY: 'WRONG_APPLICATION_KEY_VALUE_123' }), w3 = await refusal({ ...base, COS_DB_PATH: path.join(tmp, 'i-w3.db'), COS_B2_BUCKET: 'some-other-bucket' });
      check('29I-9 DIAGNOSABLE FAILURES: a wrong key id, wrong application key and wrong bucket each refuse to boot (exit 7) with the Backblaze error code, a plain-English HINT and a "B2 target" line (endpoint, region, bucket, key-id length) that contains no secret', w1.r && w2.r && w3.r && [w1, w2, w3].every(x => x.r.code === 7 && !x.listening && /B2 target: endpoint=127\.0\.0\.1:\d+ region=us-west-004 bucket=/.test(x.log) && /HINT:/.test(x.log) && !x.log.includes(APP_KEY)) && /InvalidAccessKeyId/.test(w1.log) && /keyID/.test(w1.log) && /SignatureDoesNotMatch/.test(w2.log) && /Re-enter COS_B2_APP_KEY/.test(w2.log) && /NoSuchBucket/.test(w3.log) && !w1.log.includes('K00WRONGKEYID999999999') && !w2.log.includes('WRONG_APPLICATION_KEY_VALUE_123'), J([w1.log.slice(-300)])); }

    // ================= 29J secrets in source + packaging =================
    { const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
      const code = ['b2_s3.js', 'b2_backup.js', 'b2_boot.js', 'cos_backend.js'].map(read).join('\n'); const browser = ['chief_of_staff_dashboard.html', 'format_live_runner.html'].map(f => fs.existsSync(path.join(__dirname, f)) ? read(f) : '').join('\n');
      check('29J-1 no credential is in source: the B2 values are only ever read from process.env; the browser pages mention neither B2 nor Backblaze', !/(K00[0-9A-Za-z]{18,}|[A-Za-z0-9+/]{40,}={0,2}['"])/.test(code.replace(/hmac|sha256|AWS4|aws4_request|COS_B2_[A-Z_]+/g, '')) && ['COS_B2_KEY_ID', 'COS_B2_APP_KEY'].every(k => code.includes(`env.${k}`)) && !/COS_B2|backblaze|b2_/i.test(browser));
      const docker = read('Dockerfile').split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
      const sc = B.scrubWith({ keyId: KEY_ID, appKey: APP_KEY }), s3x = S3.makeS3({ endpoint: 'http://127.0.0.1:9', bucket: BUCKET, keyId: KEY_ID, appKey: APP_KEY, region: REGION });
      check('29J-4 error text is scrubbed: any occurrence of the key id or application key (e.g. echoed by a proxy or library error) is replaced before it can reach a log or /health', sc(`boom ${APP_KEY} and ${KEY_ID} again ${APP_KEY}`) === 'boom [secret] and [key-id] again [secret]' && s3x.scrub(`x ${APP_KEY}`) === 'x [secret]');
      check('29J-2 Dockerfile ships b2_s3.js, b2_backup.js and b2_boot.js (b2_boot.js is spawned, not required, so the generic packaging test cannot see it)', ['b2_s3.js', 'b2_backup.js', 'b2_boot.js'].every(f => new RegExp(`COPY[^\\n]*\\b${f.replace('.', '\\.')}\\b`).test(docker)));
      check('29J-3 the backup module touches only the files it should: it never writes to the live database (only VACUUM INTO a temp file and reads), and has no network access other than the S3 client', !/(INSERT|UPDATE|DELETE)\s/i.test(read('b2_backup.js').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')) && !/https?:\/\/(?!s3\.|www\.)/.test(read('b2_backup.js').replace(/\/\*[\s\S]*?\*\//g, '')) ); }
  } catch (e) { check('test run completed without exception', false, e && e.stack); }
  for (const f of fakes) try { await f.stop(); } catch {}
  console.log(`\nTEST29 result=${failed === 0 ? 'PASS' : 'FAIL'} passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();

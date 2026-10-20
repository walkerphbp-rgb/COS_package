/**
 * TEST 30 — recovery_check.html: the page's own logic is run against REAL backend processes that really restore from a (fake) B2.
 * What it must do: record a baseline fingerprint of every mission, and after a redeploy prove (a) the instance started by restoring,
 * (b) the restored snapshot is not older than the one the baseline relied on, (c) every baseline mission is present and identical.
 * And it must be able to FAIL: a missing mission, a changed approval, an older snapshot, no restore at all, a wrong token.
 * Local proof only; this does not touch Render or Backblaze.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

let passed = 0, failed = 0;
const check = (n, ok, d) => { if (ok) { passed++; console.log(`PASS  ${n}`); } else { failed++; console.log(`FAIL  ${n}${d ? '  -> ' + String(d).slice(0, 320) : ''}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 25000, step = 150) => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() > end) return null; await sleep(step); } };
const J = JSON.stringify, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't30-'));
const TOKEN = 't30-token-' + 'x'.repeat(26), KEY_ID = 'K00TESTKEYID0123456789', APP_KEY = 'SECRETAPPKEY_AbC123dEf456_zzzzzzzz';
const RAW = 'https://raw.githubusercontent.com/o/r/main/README.md', SEED = 'Stub reference document. The SDK exposes a typed client for the API.';
const html = fs.readFileSync(path.join(__dirname, 'recovery_check.html'), 'utf8');
const code = (/<script id="recovery">([\s\S]*?)<\/script>/.exec(html) || [])[1] || '';
const runRecovery = new Function(code + '\nreturn globalThis.__runRecovery;')();
const fingerprintOf = new Function(code + '\nreturn globalThis.__fingerprintOf;')();
const byId = (r, id) => r.checks.find(c => c.id === id);

function fakeS3() {   // lenient S3 stand-in (signature checking is covered by Test 29)
  const store = new Map();
  const srv = http.createServer((req, res) => { const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => {
    const body = Buffer.concat(ch), u = new URL(req.url, 'http://x'), key = u.pathname.split('/').map(decodeURIComponent).slice(2).join('/'), err = (st, c) => { res.writeHead(st); res.end(`<Error><Code>${c}</Code></Error>`); };
    if (req.method === 'GET' && key === '' && u.searchParams.get('list-type') === '2') { const p = u.searchParams.get('prefix') || ''; res.writeHead(200); return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${[...store.keys()].filter(k => k.startsWith(p)).sort().map(k => `<Contents><Key>${k}</Key><Size>${store.get(k).body.length}</Size></Contents>`).join('')}</ListBucketResult>`); }
    if (req.method === 'PUT') { const meta = {}; for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-amz-meta-')) meta[k] = v; store.set(key, { body, meta }); res.writeHead(200); return res.end(); }
    if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); return res.end(); }
    const o = store.get(key); if (!o) return err(404, 'NoSuchKey'); res.writeHead(200, { 'content-length': o.body.length, ...o.meta }); res.end(req.method === 'HEAD' ? undefined : o.body);
  }); });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, store, stop: () => new Promise(x => srv.close(x)) })));
}
const preload = path.join(tmp, 'stub.js');
fs.writeFileSync(preload, `const SEED=${J(SEED)};const realFetch=global.fetch;global.fetch=async(url,opts)=>{const u=String(url);if(u.startsWith('http://127.0.0.1'))return realFetch(url,opts);if(!u.startsWith('https://generativelanguage.googleapis.com/'))return{ok:true,status:200,text:async()=>SEED};const p=JSON.parse(opts.body).contents[0].parts[0].text;const n2=(p.match(/NONCE_[A-Z0-9]+/)||[''])[0];let out;if(/research specialist/.test(p))out={claims:[{text:'The SDK exposes a typed client. [ref:'+n2+']',source_url:(p.match(/Cite source_url exactly as: (\\S+)/)||[])[1]||'u',evidence_snippet:SEED,confidence:0.9}],verification_token:n2};else if(/analyst/.test(p))out={summary:'Benign summary.',llm_self_tier:'low'};else out={type:'written',payload:'Draft containing '+n2};return{ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(out)}]}}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2}})}};`);
const port = () => 20000 + Math.floor(Math.random() * 20000);
function req(P, method, p, body) {
  return new Promise((res, rej) => { const data = body === undefined ? null : J(body); const r = http.request({ host: '127.0.0.1', port: P, path: p, method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, rs => { let s = ''; rs.on('data', c => s += c); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} res({ status: rs.statusCode, json: j }); }); }); r.on('error', rej); if (data) r.write(data); r.end(); });
}
function boot(env) {
  const P = port(), child = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'cos_backend.js')], { env: { PATH: process.env.PATH, COS_PORT: String(P), PORT: String(P), COS_HOST: '127.0.0.1', COS_TOKEN: TOKEN, COS_MODE: 'LIVE', GEMINI_API_KEY: 'k', COS_MISSION_SEED_URL: RAW, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const b = { P, url: `http://127.0.0.1:${P}`, child, log: '', exited: null }; child.stdout.on('data', d => b.log += d); child.stderr.on('data', d => b.log += d);
  b.done = new Promise(r => child.on('exit', (c, s) => { b.exited = { code: c, sig: s }; r(); }));
  b.up = async () => !!(await waitFor(async () => !b.exited && (await fetch(b.url + '/health')).status === 200, 20000));
  b.health = async () => (await fetch(b.url + '/health')).json();
  b.kill9 = async () => { b.child.kill('SIGKILL'); await b.done; }; b.stop = async () => { if (!b.exited) { b.child.kill('SIGTERM'); await Promise.race([b.done, sleep(4000)]); } b.child.kill('SIGKILL'); };
  return b;
}
const post = (b, body) => req(b.P, 'POST', '/api/missions', { objective: 'Summarise the SDK for the team', nonce: 'NONCE_T30' + Math.floor(Math.random() * 1e9), ...body });
const settled = b => waitFor(async () => { const h = await b.health(); return h.backup.pending_changes === false && h.backup.last_verified_at && h; });
const wipe = dbp => { for (const e of ['', '-wal', '-shm']) fs.rmSync(dbp + e, { force: true }); };
const latestKey = fake => JSON.parse(fake.store.get('cos/latest.json').body.toString()).key;

(async () => {
  const fakes = [];
  try {
    check('30-0 the page script was extracted; it writes results with textContent only (no innerHTML/eval/outside scripts) and never mentions B2 credentials', typeof runRecovery === 'function' && /textContent/.test(code) && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(html) && !/<script[^>]+src=|<link[^>]+href=/i.test(html) && !/COS_B2_APP_KEY|COS_B2_KEY_ID|backblaze/i.test(html));
    const fake = await fakeS3(); fakes.push(fake); const dbp = path.join(tmp, 'a', 'cos.db'); fs.mkdirSync(path.dirname(dbp), { recursive: true });
    const env = { COS_DB_PATH: dbp, COS_INIT_DB: '1', COS_B2_BACKUP: '1', COS_B2_ENDPOINT: fake.url, COS_B2_BUCKET: 'bucket1', COS_B2_KEY_ID: KEY_ID, COS_B2_APP_KEY: APP_KEY, COS_B2_REGION: 'us-west-004', COS_B2_MIN_INTERVAL_SEC: '1' };

    // ---- backup NOT enabled: the page says so
    { const b = boot({ COS_DB_PATH: path.join(tmp, 'plain.db'), COS_INIT_DB: '1' }); await b.up(); const r = await runRecovery({ mode: 'baseline', base: b.url, token: TOKEN }); await b.stop();
      check('30-1 on a deployment with backup disabled the page reports FAIL "backup is not enabled" (there is nothing to recover from) and saves no baseline', r.verdict === 'FAIL' && byId(r, 'R3').status === 'FAIL' && !r.baseline); }

    // ---- build real state, baseline
    const A = boot(env); await A.up(); const m1 = await post(A, { mode: 'delegate' }); await settled(A); const keyAfter1 = latestKey(fake);
    const m2 = await post(A, { mode: 'delegate', format_id: 'smme_finance', mission_type: 'cashflow_review' }); const ap = await req(A.P, 'POST', `/api/missions/${m2.json.missionId}/decision`, { decision: 'APPROVED' }); const m3 = await post(A, { mode: 'ask' }), m4 = await post(A, { mode: 'assist' });
    await sleep(1500); const sA = await settled(A); const keyAfter2 = latestKey(fake);
    const early = await runRecovery({ mode: 'baseline', base: A.url, token: TOKEN });
    check('30-2 real state built (auto-completed delegate, human-approved + executed smme_finance, ask, assist) and two different snapshots exist in "B2"', m1.json.outcome === 'AUTO_COMPLETED' && ap.status === 200 && m3.json.outcome === 'ANSWERED' && m4.json.outcome === 'DRAFT_READY' && !!sA && keyAfter1 !== keyAfter2);
    const base1 = await runRecovery({ mode: 'baseline', base: A.url, token: TOKEN }), base2 = await runRecovery({ mode: 'baseline', base: A.url, token: TOKEN });
    check('30-3 BASELINE: verdict "BASELINE SAVED", 4 missions fingerprinted, backup reported up to date, and the fingerprint is STABLE (two reads give the same value)', base1.verdict === 'BASELINE SAVED' && base1.baseline.count === 4 && byId(base1, 'R5').status === 'PASS' && base1.baseline.overall === base2.baseline.overall && /^[0-9a-f]{64}$/.test(base1.baseline.overall), base1.verdict);
    check('30-4 the baseline contains NO token and no credential (it is safe to copy and paste)', ![J(base1), J(early)].join('').includes(TOKEN) && !J(base1).includes(APP_KEY) && !J(base1).includes(KEY_ID));
    const baseline = base1.baseline;
    const noRestore = await runRecovery({ mode: 'compare', base: A.url, token: TOKEN, baseline });
    check('30-5 COMPARING WITHOUT A REDEPLOY proves nothing and is not allowed to look like success: the instance did not restore, so the verdict is INCONCLUSIVE (R5), never PASS', noRestore.verdict === 'INCONCLUSIVE' && byId(noRestore, 'R5').status === 'INCONCLUSIVE' && byId(noRestore, 'R8').status === 'PASS');

    // ---- the redeploy: hard crash, database destroyed, fresh process restores
    await A.kill9(); wipe(dbp); const Bn = boot(env); const upB = await Bn.up();
    const ok = await runRecovery({ mode: 'compare', base: Bn.url, token: TOKEN, baseline });
    check('30-6 AFTER A REAL RESTORE the comparison PASSES: restore performed, snapshot not older than the baseline\'s, no fallback, all 4 missions present and identical (status, tier, approval + approver, executions, format hash, routing, effects, audit timeline, evidence)', upB && ok.verdict === 'PASS' && ['R5', 'R6', 'R7', 'R8', 'R9'].every(i => byId(ok, i).status === 'PASS') && ok.compared.current_count === 4, J(ok.checks.filter(c => c.status !== 'PASS')).slice(0, 300) + Bn.log.slice(-200));
    const m5 = await post(Bn, { mode: 'ask' }); const more = await runRecovery({ mode: 'compare', base: Bn.url, token: TOKEN, baseline });
    check('30-7 a mission created AFTER the baseline is fine (informational): still PASS, new mission counted', m5.status === 201 && more.verdict === 'PASS' && byId(more, 'R10').detail.startsWith('1 new'));

    // ---- it can FAIL
    { const d = new DatabaseSync(dbp); d.exec('PRAGMA busy_timeout=5000'); d.exec('DROP TRIGGER cos_append_only_decisions_update'); d.prepare(`UPDATE decisions SET rationale='system: approved' WHERE mission_id=? AND status='APPROVED'`).run(m2.json.missionId); d.close();
      const t = await runRecovery({ mode: 'compare', base: Bn.url, token: TOKEN, baseline });
      check('30-8 CAN FAIL: if an approval after the restore differs (human approval silently became a system approval) the verdict is FAIL and R9 names the mission', t.verdict === 'FAIL' && byId(t, 'R9').status === 'FAIL' && byId(t, 'R9').detail.includes(m2.json.missionId.slice(0, 8)));
      const d2 = new DatabaseSync(dbp); d2.exec('PRAGMA busy_timeout=5000'); d2.exec('PRAGMA foreign_keys = OFF'); d2.prepare('DELETE FROM missions WHERE id=?').run(m3.json.missionId); d2.close();
      const mi = await runRecovery({ mode: 'compare', base: Bn.url, token: TOKEN, baseline });
      check('30-9 CAN FAIL: a mission that existed in the baseline but is gone after the restore is FAIL and R8 names it', mi.verdict === 'FAIL' && byId(mi, 'R8').status === 'FAIL' && byId(mi, 'R8').detail.includes(m3.json.missionId.slice(0, 8))); }
    await Bn.kill9(); wipe(dbp);

    // ---- an OLDER snapshot gets restored (the newest is unavailable): data from after it is missing
    { const older = fake.store.get(keyAfter1); const sha = crypto.createHash('sha256').update(older.body).digest('hex');
      fake.store.set('cos/latest.json', { body: Buffer.from(J({ format: 'cos-b2-snapshot-1', key: keyAfter1, sha256: sha, bytes: older.body.length, created_at: 'x', epoch: 1 })), meta: {} }); fake.store.delete(keyAfter2);
      const C = boot(env); await C.up(); const t = await runRecovery({ mode: 'compare', base: C.url, token: TOKEN, baseline });
      check('30-10 CAN FAIL: if an OLDER snapshot is what came back, R6 FAILS ("restored snapshot is older than the baseline\'s") and R8 lists the missions that were lost', t.verdict === 'FAIL' && byId(t, 'R6').status === 'FAIL' && byId(t, 'R8').status === 'FAIL', J(t.checks.filter(c => c.status === 'FAIL').map(c => c.id))); await C.stop(); }

    { const base = { status: 'COMPLETED', risk: { tier: 'HIGH' }, approval: { status: 'APPROVED', decided_by: { type: 'human', name: 'paul' } }, execution: { executed: true, count: 1 }, format: { status: 'verified', format_id: 'smme_finance', format_version: 2, manifest_hash: 'h1' }, router: { status: 'consistent', mode: 'delegate', plan_id: 'delegate_v1', plan_version: 1 }, format_effects: [{ effect_code: 'floor_applied' }], gaps: [], timeline: [{ status: 'PROPOSED' }, { status: 'APPROVED' }], evidence: { claims_total: 1, evidence_verified: 1, unverified: 0, flagged_instruction_like: 0 } };
      const variants = { status: x => { x.status = 'FAILED'; }, tier: x => { x.risk.tier = 'LOW'; }, approval_status: x => { x.approval.status = 'PENDING'; }, approver_type: x => { x.approval.decided_by.type = 'system'; }, approver_name: x => { x.approval.decided_by.name = 'eve'; }, executed: x => { x.execution.executed = false; }, exec_count: x => { x.execution.count = 2; }, format_hash: x => { x.format.manifest_hash = 'h2'; }, format_status: x => { x.format.status = 'hash_mismatch'; }, format_version: x => { x.format.format_version = 1; }, router_mode: x => { x.router.mode = 'ask'; }, router_plan: x => { x.router.plan_id = 'ask_v1'; }, effects: x => { x.format_effects = []; }, gaps: x => { x.gaps = [{ code: 'x' }]; }, timeline: x => { x.timeline.pop(); }, evidence: x => { x.evidence.unverified = 1; } };
      const same = J(fingerprintOf(base)) === J(fingerprintOf(JSON.parse(J(base)))); const missed = Object.entries(variants).filter(([k, f]) => { const v = JSON.parse(J(base)); f(v); return J(fingerprintOf(v)) === J(fingerprintOf(base)); }).map(([k]) => k);
      check('30-12 the fingerprint reacts to EVERY restore-relevant field on its own (status, tier, approval status, approver type and name, execution flag and count, format status/version/hash, routing mode and plan, policy effects, gaps, audit timeline, evidence counts) and is stable for identical input', same && missed.length === 0, 'not detected: ' + missed.join(',')); }

    // ---- misuse and outages
    { const D = boot({ ...env, COS_DB_PATH: path.join(tmp, 'd', 'cos.db') }); await D.up(); fs.mkdirSync(path.join(tmp, 'd'), { recursive: true });
      const wt = await runRecovery({ mode: 'baseline', base: D.url, token: 'wrong-token-' + 'y'.repeat(24) }), nb = await runRecovery({ mode: 'compare', base: D.url, token: TOKEN, baseline: null }), un = await runRecovery({ mode: 'baseline', base: 'http://127.0.0.1:9', token: TOKEN }); await D.stop();
      check('30-11 a wrong token, a missing baseline and an unreachable server are all INCONCLUSIVE with a clear check (never PASS, never an exception)', wt.verdict === 'INCONCLUSIVE' && byId(wt, 'R4').status === 'INCONCLUSIVE' && nb.verdict === 'INCONCLUSIVE' && /baseline/.test(byId(nb, 'R5').detail) && un.verdict === 'INCONCLUSIVE' && byId(un, 'R1').status === 'INCONCLUSIVE'); }
  } catch (e) { check('test run completed without exception', false, e && e.stack); }
  for (const f of fakes) try { await f.stop(); } catch {}
  console.log(`\nTEST30 result=${failed === 0 ? 'PASS' : 'FAIL'} passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();

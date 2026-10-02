/**
 * test19d_mission_failure.js
 *
 * Regression for the Oct 2 finding: a provider 503 mid-mission left the
 * mission IN_PROGRESS and logged MISSION_FAILED with an empty mission_id and
 * violation:true.
 *
 * Spawns the REAL cos_backend.js on loopback with a throwaway SQLite DB
 * (COS_INIT_DB=1 from test17_schema.sql). Network is stubbed INSIDE the child
 * via a preload: generativelanguage.googleapis.com -> HTTP 503; any other URL
 * (the Researcher's seed fetch) -> a small 200 text body. Zero live calls.
 *
 * Asserts: 502 + mission_id in the response; snapshot shows that mission as
 * FAILED (not IN_PROGRESS); the MISSION_FAILED audit row carries the same
 * mission_id and violation:false; the decision core is untouched (no
 * APPROVED/EXECUTED rows, execution not started, health.approval ok).
 *
 * Needs: cos_backend.js, mission_chain.js, provider_fallback.js,
 * test17_schema.sql in the same folder; Node 22.5+.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function finish(code) {
  console.log(`\nTEST19D result=${failed === 0 ? 'PASS' : 'FAIL'} passed=${passed} failed=${failed}`);
  process.exit(code !== undefined ? code : (failed === 0 ? 0 : 1));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't19d-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const TOKEN = 'test19d-token-' + 'x'.repeat(24);

// Preload that runs inside the backend process.
const stub = path.join(tmp, 'stub_fetch.js');
fs.writeFileSync(stub, `
global.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://generativelanguage.googleapis.com/')) {
    return { ok: false, status: 503, json: async () => ({ error: 'stub 503' }), text: async () => 'stub 503' };
  }
  const body = 'stub seed document for test19d';
  return { ok: true, status: 200, json: async () => ({}), text: async () => body,
    arrayBuffer: async () => Buffer.from(body), headers: { get: () => 'text/plain' } };
};
`);

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j, raw: s }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ['--require', stub, path.join(__dirname, 'cos_backend.js')], {
  env: { ...process.env, COS_DB: path.join(tmp, 't.db'), COS_INIT_DB: '1', COS_PORT: String(PORT),
    PORT: String(PORT), COS_HOST: '127.0.0.1', COS_TOKEN: TOKEN, COS_MODE: 'LIVE',
    GEMINI_API_KEY: 'test-key-not-real', GROQ_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
function stop() { try { child.kill('SIGKILL'); } catch {} }

(async () => {
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { const h = await req('GET', '/health'); up = h.status === 200; } catch {}
      if (!up) await sleep(200);
    }
    check('backend started', up, up ? '' : log.slice(-400));
    if (!up) { stop(); return finish(1); }

    const r = await req('POST', '/api/missions', {
      objective: 'Regression: provider outage mid-mission', nonce: 'REGR19D_NONCE_01' });
    check('mission POST returns 502 on provider 503', r.status === 502, `status=${r.status} body=${r.raw.slice(0, 200)}`);
    check('error message reports the provider failure', r.json && /http 503/.test(r.json.error || ''), r.raw.slice(0, 200));
    const mid = r.json && r.json.mission_id;
    check('response includes mission_id', typeof mid === 'string' && mid.length > 8, `mission_id=${mid}`);

    const s = (await req('GET', '/api/snapshot')).json;
    const m = s && s.missions.find((x) => x.id === mid);
    check('mission present in fresh snapshot', !!m);
    check('mission status is FAILED, not IN_PROGRESS', m && m.status === 'FAILED', `status=${m && m.status}`);
    check('no approval or execution recorded', m && m.approval_status === 'NOT REQUIRED' && m.execution_status === 'NOT STARTED',
      m && `${m.approval_status}/${m.execution_status}`);
    check('no APPROVED/EXECUTED audit rows for the failed mission',
      !s.audit.some((a) => a.mission_id === mid && /APPROVED|EXECUTED/i.test(a.event)));

    const fa = s.audit.find((a) => a.event === 'MISSION_FAILED');
    check('MISSION_FAILED audit row exists', !!fa);
    check('  carries the failed mission_id', fa && fa.mission_id === mid, `mission_id=${fa && fa.mission_id}`);
    check('  violation is false (provider outage is not a security violation)', fa && fa.violation === false, `violation=${fa && fa.violation}`);
    check('health.approval and health.audit still ok', s.health.approval === 'ok' && s.health.audit === 'ok',
      JSON.stringify(s.health));
  } catch (e) {
    check('test run completed without exception', false, e && e.message);
  } finally {
    stop();
    finish();
  }
})();

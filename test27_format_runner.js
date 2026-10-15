/**
 * TEST 27 — the phone live-check page (format_live_runner.html) works, and can FAIL.
 * The page's own logic is extracted and run against a real local backend (stubbed model), so what you run on
 * your phone against Render has already been exercised end to end here. Local proof only; not Render.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

let passed = 0, failed = 0;
const check = (n, ok, d) => { if (ok) { passed++; console.log(`PASS  ${n}`); } else { failed++; console.log(`FAIL  ${n}${d ? '  -> ' + String(d).slice(0, 300) : ''}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't27-'));
const TOKEN = 't27-token-' + 'x'.repeat(26);
const html = fs.readFileSync(path.join(__dirname, 'format_live_runner.html'), 'utf8');
const code = (/<script id="runner">([\s\S]*?)<\/script>/.exec(html) || [])[1] || '';
const runFormatCheck = new Function(code + '\nreturn globalThis.__runFormatCheck;')();

const SEED = 'Stub reference document. The SDK exposes a typed client for the API.';
const preload = path.join(tmp, 'stub.js');
fs.writeFileSync(preload, `const SEED=${JSON.stringify(SEED)};global.fetch=async(url,opts)=>{const u=String(url);if(!u.startsWith('https://generativelanguage.googleapis.com/'))return{ok:true,status:200,text:async()=>SEED};const p=JSON.parse(opts.body).contents[0].parts[0].text;const n2=(p.match(/LIVE_FORMAT_[0-9]+_[A-Z0-9]+/)||[''])[0];let out;if(/research specialist/.test(p))out={claims:[{text:'The SDK exposes a typed client. [ref:'+n2+']',source_url:(p.match(/Cite source_url exactly as: (\\S+)/)||[])[1]||'u',evidence_snippet:SEED,confidence:0.9}],verification_token:n2};else if(/analyst/.test(p))out={summary:'Benign summary.',llm_self_tier:'low'};else out={type:'written',payload:'Draft containing '+n2};return{ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(out)}]}}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2}})}};`);
const port = () => 20000 + Math.floor(Math.random() * 20000);
function boot(env) {
  const P = port(), child = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'cos_backend.js')], { env: { PATH: process.env.PATH, COS_PORT: String(P), PORT: String(P), COS_HOST: '127.0.0.1', COS_TOKEN: TOKEN, COS_MODE: 'LIVE', GEMINI_API_KEY: 'k', COS_INIT_DB: '1', COS_ALLOWED_ORIGINS: '*', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const b = { P, child, log: '' }; child.stdout.on('data', d => b.log += d); child.stderr.on('data', d => b.log += d);
  b.url = `http://127.0.0.1:${P}`;
  b.up = async () => { for (let i = 0; i < 80; i++) { try { const r = await fetch(b.url + '/health'); if (r.status === 200) return true; } catch {} await sleep(150); } return false; };
  b.stop = async () => { child.kill('SIGTERM'); await sleep(300); child.kill('SIGKILL'); };
  return b;
}
const byId = (r, id) => r.checks.find(c => c.id === id);
const RAW = 'https://raw.githubusercontent.com/o/r/main/README.md';

(async () => {
  try {
    check('27-0 the runner script was extracted and exposes runFormatCheck', typeof runFormatCheck === 'function' && code.length > 1000);
    check('27-1 the page writes stored text with textContent only: no innerHTML, eval, document.write or outside-origin script/links', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|<script[^>]+src=|<link[^>]+href=/i.test(html.replace(/new Function/g, '')) && /textContent/.test(code));

    // ---- happy path: the seed host is allowed by smme_finance, so the full chain runs
    { const b = boot({ COS_DB_PATH: path.join(tmp, 'a.db'), COS_MISSION_SEED_URL: RAW }); const up = await b.up();
      const r = await runFormatCheck({ base: b.url, token: TOKEN, epoch: '1760000001' });
      check('27-2 happy path against a real backend: verdict PASS, every check PASS, none failed or inconclusive', up && r.verdict === 'PASS' && r.counts.fail === 0 && r.counts.inconclusive === 0 && r.counts.note === 0 && r.checks.length >= 16, JSON.stringify(r.checks.filter(c => c.status !== 'PASS')).slice(0, 300) + b.log.slice(-200));
      check('27-3 it exercised the full chain: ask ends ANSWERED and assist DRAFT_READY with nothing executed; general auto-completed; smme_finance held at medium+ for a human with its recorded effects; nothing executed under smme', byId(r, 'L5').status === 'PASS' && byId(r, 'L6').status === 'PASS' && r.data.explain_smme_finance.approval === 'PENDING' && r.data.explain_smme_finance.executed === false && ['format_bound', 'floor_applied', 'human_required_for_all'].every(c => r.data.explain_smme_finance.effects.includes(c)) && r.data.explain_general.executed === true && r.data.explain_ask.status === 'ANSWERED' && r.data.explain_assist.status === 'DRAFT_READY' && r.data.explain_ask.executed === false && r.data.explain_assist.executed === false, J(r.data));
      check('27-4 the result JSON contains no token', !JSON.stringify(r).includes(TOKEN));
      const tokRun = await runFormatCheck({ base: b.url, token: 'wrong-token-' + 'y'.repeat(24), epoch: '1760000002' });
      check('27-5 a wrong token is NOT reported as success (verdict not PASS) and does not crash the page', tokRun.verdict !== 'PASS' && byId(tokRun, 'L5').status === 'INCONCLUSIVE', tokRun.verdict);
      // tamper with the stored smme manifest while the server runs: the runner must report FAIL
      const d = new DatabaseSync(path.join(tmp, 'a.db')); d.exec('PRAGMA busy_timeout=5000'); d.exec('DROP TRIGGER cos_append_only_format_manifests_update'); d.prepare(`UPDATE format_manifests SET manifest_json = replace(manifest_json, 'SMME finance', 'Tampered') WHERE format_id = 'smme_finance'`).run(); d.close();
      const tam = await runFormatCheck({ base: b.url, token: TOKEN, epoch: '1760000003' });
      check('27-6 CAN FAIL: a tampered stored manifest is detected through Decision Memory and the verdict is FAIL', tam.verdict === 'FAIL' && byId(tam, 'L9a').status === 'FAIL', tam.verdict + J(tam.checks.filter(c => c.status === 'FAIL').map(c => c.id)));
      await b.stop(); }

    // ---- refusal path: seed host outside smme_finance's allowlist
    { const b = boot({ COS_DB_PATH: path.join(tmp, 'b.db'), COS_MISSION_SEED_URL: 'https://seed.test/doc' }); await b.up();
      const r = await runFormatCheck({ base: b.url, token: TOKEN, epoch: '1760000004' });
      check('27-7 refusal path: the runner says so honestly (verdict "PASS (refusal path only)", L6 is a NOTE, refusal and FAILED recorded and explained)', r.verdict === 'PASS (refusal path only)' && byId(r, 'L6').status === 'NOTE' && byId(r, 'L9c').status === 'PASS' && r.data.smme_refusal_path === true && r.data.explain_smme_finance.status === 'FAILED', r.verdict + J(r.checks.filter(c => c.status !== 'PASS')).slice(0, 300));
      await b.stop(); }

    // ---- format not available on the deployment
    { const b = boot({ COS_DB_PATH: path.join(tmp, 'c.db'), COS_MISSION_SEED_URL: RAW, COS_ALLOWED_FORMATS: 'general' }); await b.up();
      const r = await runFormatCheck({ base: b.url, token: TOKEN, epoch: '1760000005' });
      check('27-8 CAN FAIL/INCONCLUSIVE: if smme_finance is not selectable on the deployment, the verdict is not PASS', r.verdict !== 'PASS' && byId(r, 'L6').status === 'INCONCLUSIVE', r.verdict);
      await b.stop(); }

    // ---- unreachable backend
    { const r = await runFormatCheck({ base: 'http://127.0.0.1:9', token: TOKEN, epoch: '1760000006' });
      check('27-9 an unreachable backend gives verdict INCONCLUSIVE with a clear L1, no exception', r.verdict === 'INCONCLUSIVE' && r.checks.length === 1 && byId(r, 'L1').status === 'INCONCLUSIVE'); }
  } catch (e) { check('test run completed without exception', false, e && e.stack); }
  console.log(`\nTEST27 result=${failed === 0 ? 'PASS' : 'FAIL'} passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
function J(x) { return JSON.stringify(x); }

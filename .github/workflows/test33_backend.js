'use strict';
/* Test 33 group J: the REAL cos_backend.js process (Step 3, item 3).
 * What is real: server, router, formats, mission_chain, safe_fetch (incl. its real https transport code path), SQLite.
 * What is STUBBED: the model (global.fetch to Gemini), https.request (no TLS, no network) and DNS lookup, via a --require preload.
 * Run: node test33_backend.js */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const RR = require('./research_request');
let pass = 0, fail = 0;
const check = (id, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${ok ? '' : '  -> ' + String(d).slice(0, 300)}`); };
const J = JSON.stringify, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't33j-')), TOKEN = 't33-token-' + 'x'.repeat(26);

const T1 = 'The Alpha service requires written approval from two named reviewers before any release.';
const T2 = 'Beta retention policy keeps audit logs for seven years in cold storage.';
const preload = path.join(tmp, 'stub.js');
fs.writeFileSync(preload, `
const https = require('node:https'), dns = require('node:dns'), { EventEmitter } = require('node:events');
const PAGES = { 'a.example': [200, ${J(T1)}], 'b.example': [200, ${J(T2)}], 'c.example': [500, 'boom'], 'raw.githubusercontent.com': [200, 'GitHub raw doc: the SDK exposes a typed client for the API surface.'] };
dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
https.request = (opts, cb) => { const req = new EventEmitter(); req.end = () => { setImmediate(() => {
  const p = PAGES[opts.hostname]; const res = new EventEmitter(); res.statusCode = p ? p[0] : 404; res.headers = { 'content-type': 'text/plain' };
  res.socket = { remoteAddress: '93.184.216.34' }; res.destroy = () => {}; cb(res); setImmediate(() => { res.emit('data', Buffer.from(p ? p[1] : 'nope')); res.emit('end'); }); }); };
  return req; };
global.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://generativelanguage.googleapis.com/')) return { ok: true, status: 200, text: async () => 'SEED DOC for legacy route: the SDK exposes a typed client.' };
  const p = JSON.parse(opts.body).contents[0].parts[0].text; const nonce = (p.match(/\\[ref:([^\\]]+)\\]/) || [])[1] || ''; let out;
  if (/research specialist/.test(p)) {
    const re = /<<<SOURCE (S\\d+) BEGIN[^>]*>>>\\n([\\s\\S]*?)\\n<<<SOURCE \\1 END>>>/g; const claims = []; let m;
    while ((m = re.exec(p))) claims.push({ text: 'Claim from ' + m[1], source_id: m[1], evidence_snippet: m[2].slice(0, 60), confidence: 0.9 });
    if (!claims.length) { const sn = 'SEED DOC for legacy route: the SDK exposes'; const url2 = (p.match(/Cite source_url exactly as: (\\S+)/) || [])[1]; claims.push({ text: 'Legacy claim', source_url: url2, evidence_snippet: sn, confidence: 0.8 }); }
    claims[0].text += ' [ref:' + nonce + ']'; out = { claims, verification_token: nonce };
  } else if (/analyst/.test(p)) out = { summary: 'Benign summary.', llm_self_tier: 'low' };
  else out = { type: 'written', payload: 'Draft ' + nonce };
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }) };
};`);

const port = () => 20000 + Math.floor(Math.random() * 20000);
function req(P, method, p, body, auth = true) {
  return new Promise((res, rej) => { const data = body === undefined ? null : J(body);
    const r = http.request({ host: '127.0.0.1', port: P, path: p, method, headers: { ...(auth ? { Authorization: 'Bearer ' + TOKEN } : {}), 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (rs) => { let b = ''; rs.on('data', (c) => (b += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} res({ status: rs.statusCode, json: j, raw: b }); }); });
    r.on('error', rej); if (data) r.write(data); r.end(); });
}
let n = 0;
function boot(env = {}) {
  const P = port(), dir = path.join(tmp, 'd' + ++n); fs.mkdirSync(dir);
  const child = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'cos_backend.js')], { env: { PATH: process.env.PATH, COS_PORT: String(P), PORT: String(P), COS_HOST: '127.0.0.1', COS_TOKEN: TOKEN, COS_MODE: 'LIVE', GEMINI_API_KEY: 'k', COS_INIT_DB: '1', COS_DB_PATH: path.join(dir, 'cos.db'), COS_MISSION_SEED_URL: 'https://seed.test/doc', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const b = { P, child, dir, db: path.join(dir, 'cos.db'), log: '', exited: null };
  child.stdout.on('data', (d) => (b.log += d)); child.stderr.on('data', (d) => (b.log += d));
  b.done = new Promise((r) => child.on('exit', (code, sig) => { b.exited = { code, sig }; r(b.exited); }));
  b.up = async () => { for (let i = 0; i < 80 && !b.exited; i++) { try { if ((await req(P, 'GET', '/health', undefined, false)).status === 200) return true; } catch {} await sleep(150); } return false; };
  b.stop = async () => { try { child.kill('SIGTERM'); } catch {} await Promise.race([b.done, sleep(4000)]); try { child.kill('SIGKILL'); } catch {} };
  return b;
}
const missionsCount = async (b) => { const s = await req(b.P, 'GET', '/api/snapshot'); return (s.json && s.json.missions || []).length; };
const R = (sources, extra = {}) => ({ question: 'What do the sources say about approvals and retention?', sources, ...extra });
const post = (b, o) => req(b.P, 'POST', '/api/missions', { objective: 'Summarise what the sources say', nonce: 'NONCE_J' + (++n), mode: 'ask', ...o });

(async () => {
  // ---- research DISABLED (COS_RESEARCH_HOSTS unset) ----
  { const b = boot(); const up = await b.up();
    const h = up ? (await req(b.P, 'GET', '/health', undefined, false)).json : null;
    check('J1 /health (public) reports research disabled when COS_RESEARCH_HOSTS is unset; legacy route still advertised', up && h.research && h.research.enabled === false && h.research.host_count === 0 && h.research.legacy_seed_route === true && h.db.schema.user_version === 4, b.log.slice(-300));
    const d = await post(b, { research: R(['https://a.example/doc']) });
    check('J2 a research request on a server with research disabled is refused with the DISTINCT code RESEARCH_DISABLED (400); nothing runs, no mission row', d.status === 400 && d.json.code === 'RESEARCH_DISABLED' && (await missionsCount(b)) === 0, J(d.json));
    const lg = await post(b, {});
    check('J3 legacy request (no research object) still works and is labelled legacy_seed_demo', lg.status === 201 && lg.json.research_route === 'legacy_seed_demo' && lg.json.outcome === 'ANSWERED', J(lg.json));
    const g = await req(b.P, 'GET', `/api/missions/${lg.json.missionId}/research`);
    check('J4 GET research for a legacy mission is 404 (no research record), not an empty 200', g.status === 404, J(g.json));
    await b.stop(); }

  // ---- research ENABLED ----
  const b = boot({ COS_RESEARCH_HOSTS: 'a.example, B.Example ,c.example' }); const up = await b.up();
  const h = up ? (await req(b.P, 'GET', '/health', undefined, false)).json : null;
  check('J5 /health: research enabled with 3 operator hosts (count only, host names not listed on the public route)', up && h.research.enabled === true && h.research.host_count === 3 && !/a\.example/.test(J(h.research)), b.log.slice(-300));
  const bad = [['null', null], ['empty object', {}], ['empty sources', R([])], ['unknown field', R(['https://a.example/doc'], { evil: 1 })], ['http scheme', R(['http://a.example/doc'])], ['IP literal', R(['https://93.184.216.34/x'])],
    ['host not in operator list', R(['https://z.example/doc'])], ['userinfo', R(['https://u:p@a.example/doc'])], ['array research', []], ['question too short', R(['https://a.example/doc'], { question: 'x' })]];
  const before = await missionsCount(b); const outs = [];
  for (const [name, r] of bad) { const x = await post(b, { research: r }); outs.push([name, x.status, x.json && x.json.code]); }
  check('J6 every malformed research request is 400 RESEARCH_INVALID (never falls back to the seed document), and no mission row is created', outs.every((o) => o[1] === 400 && o[2] === 'RESEARCH_INVALID') && (await missionsCount(b)) === before, J(outs));

  const ok = await post(b, { research: R(['https://a.example/doc', { url: 'https://b.example/doc', label: 'Beta policy' }, 'https://a.example/doc#dup']) });
  check('J7 a valid research request: 201, ANSWERED, mode ask, route user_sources, 2 sources read (duplicate collapsed), 2 claims', ok.status === 201 && ok.json.outcome === 'ANSWERED' && ok.json.mode === 'ask' && ok.json.research_route === 'user_sources' && ok.json.research.sources_ok === 2 && ok.json.claimCount === 2, J(ok.json).slice(0, 400) + b.log.slice(-200));
  const id = ok.json && ok.json.missionId;
  const g = await req(b.P, 'GET', `/api/missions/${id}/research`);
  const v = g.json || {};
  check('J8 GET /api/missions/:id/research (authenticated, read-only): request, 2 sources with hashes and stored text, 2 claims with source_id; duplicate recorded', g.status === 200 && v.sources && v.sources.length === 2 && v.claims.length === 2 && v.request.duplicates.length === 1 && v.sources[0].text === T1 && v.sources[1].label === 'Beta policy' && /^[0-9a-f]{64}$/.test(v.sources[0].raw_sha256) && /^[0-9a-f]{64}$/.test(v.sources[0].text_sha256), J(v).slice(0, 300));
  check('J9 server-recomputed checks: stored text matches its text hash; every claim snippet is contained in its OWN cited source; raw hash is declared not recomputable', v.sources.every((s) => s.checks.text_hash_matches_stored_text === true && s.checks.raw_hash_recomputable === false) && v.claims.every((c) => c.checks.snippet_contained_in_cited_source_text === true && c.checks.cited_source_exists_and_read_ok) && Array.isArray(v.untrusted_fields) && v.notes.length === 2);
  check('J18 the HTTP response carries the evidence report: four sections, system_checked counts 2/2 read and 2/2 contained, model output only under model_assessed, requirements NOT_VERIFIED', (() => { const r = v.report; return !!r && r.version === 1 && J(Object.keys(r)) === J(['version', 'system_checked', 'model_assessed', 'unchecked_requirements', 'advisories']) && r.system_checked.sources.read_ok === 2 && r.system_checked.claims.snippet_contained_in_own_cited_source === 2 && !J(r.system_checked).includes('confidence') && r.model_assessed.claim_confidence.length === 2 && r.unchecked_requirements[0].status === 'NOT_VERIFIED'; })(), J(v.report).slice(0, 300));
  check('J10 the research route requires the bearer token (401) and returns 404 for unknown or odd ids', (await req(b.P, 'GET', `/api/missions/${id}/research`, undefined, false)).status === 401 && (await req(b.P, 'GET', '/api/missions/nope123/research')).status === 404 && (await req(b.P, 'GET', '/api/missions/..%2f..%2fx/research')).status === 404);
  const dl = await post(b, { research: R(['https://a.example/doc']), mode: 'delegate' });
  const asst = await post(b, { research: R(['https://a.example/doc']), mode: 'assist' });
  check('J11 research with an explicit delegate or assist mode is refused (RESEARCH_ASK_ONLY); with no mode it runs as ask', dl.status === 400 && dl.json.code === 'RESEARCH_ASK_ONLY' && asst.status === 400 && asst.json.code === 'RESEARCH_ASK_ONLY', J([dl.json, asst.json]));
  const nm = await req(b.P, 'POST', '/api/missions', { objective: 'Summarise what the sources say', nonce: 'NONCE_J_nomode', research: R(['https://a.example/doc']) });
  check('J12 research with no mode named: the router default (ask) applies', nm.status === 201 && nm.json.mode === 'ask', J(nm.json).slice(0, 200));
  const part = await post(b, { research: R(['https://a.example/doc', 'https://c.example/doc']) });
  const pv = part.json && (await req(b.P, 'GET', `/api/missions/${part.json.missionId}/research`)).json;
  check('J13 one source fails (HTTP 500): mission still answers on the readable one, risk is at least medium, failure visible in the research record', part.status === 201 && part.json.riskTier !== 'low' && part.json.research.sources_failed === 1 && pv.sources[1].ok === false && pv.sources[1].code === 'HTTP_STATUS', J(part.json).slice(0, 300));
  const none = await post(b, { research: R(['https://c.example/doc']) });
  const nv = none.json && none.json.mission_id && (await req(b.P, 'GET', `/api/missions/${none.json.mission_id}/research`)).json;
  const snap = (await req(b.P, 'GET', '/api/snapshot')).json;
  check('J14 zero readable sources: 502 with mission_id, mission recorded FAILED, failed source kept in the research record, no model claim', none.status === 502 && !!none.json.mission_id && /no readable research source/.test(none.json.error) && nv && nv.sources.length === 1 && nv.claims.length === 0, J(none.json));
  check('J15 smme_finance (format source_domains = raw.githubusercontent.com only): an operator-allowed host outside the format list is refused at validation (400), neither list widens the other', await (async () => { await b.stop(); const b2 = boot({ COS_RESEARCH_HOSTS: 'a.example,raw.githubusercontent.com' }); if (!(await b2.up())) return false;
    const r1 = await post(b2, { format_id: 'smme_finance', research: R(['https://a.example/doc']) });
    const r2 = await post(b2, { format_id: 'smme_finance', research: R(['https://raw.githubusercontent.com/x/y/main/README.md']) });
    await b2.stop(); b.log2 = J([r1.status, r1.json && r1.json.errors, r2.status, r2.json && r2.json.error]);
    return r1.status === 400 && r1.json.code === 'RESEARCH_INVALID' && JSON.stringify(r1.json.errors).includes('HOST_NOT_ALLOWED_BY_FORMAT') && r2.status !== 400; })(), b.log2);

  { const d = new DatabaseSync(b.db); const last = d.prepare(`SELECT status, rationale FROM decisions WHERE mission_id = ? ORDER BY id DESC LIMIT 1`).get(none.json.mission_id); const calls = d.prepare(`SELECT COUNT(*) c FROM provider_calls WHERE mission_id = ?`).get(none.json.mission_id).c; d.close();
    check('J14b the zero-source mission ends in a FAILED decision row (reason recorded) and made ZERO provider calls', last && last.status === 'FAILED' && /no readable research source/.test(last.rationale) && calls === 0, J([last, calls])); }
  // ---- integrity view on a COPY: tampered stored evidence is detected ----
  { const src = path.join(b.dir, 'cos.db'), cp = path.join(tmp, 'copy.db'); fs.copyFileSync(src, cp);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, cp + ext);
    const d = new DatabaseSync(cp); const mid = id; d.exec('DROP TRIGGER cos_append_only_mission_sources_update'); d.prepare(`UPDATE mission_sources SET text = ? WHERE mission_id = ? AND source_id = 'S1'`).run('Totally different text now.', mid);
    const tv = RR.researchView(d, mid); d.close();
    check('J16 raw-DB tampering of a stored source text (guard dropped on a COPY) is detected by the research view: text hash mismatch and the claim snippet is no longer contained', tv.sources[0].checks.text_hash_matches_stored_text === false && tv.claims[0].checks.snippet_contained_in_cited_source_text === false && tv.sources[1].checks.text_hash_matches_stored_text === true); }

  // ---- boot refusals ----
  for (const [name, val] of [['IP literal', '10.0.0.1'], ['URL', 'https://a.example'], ['wildcard', '*.a.example'], ['host with port', 'a.example:8443'], ['path', 'a.example/x']]) {
    const x = boot({ COS_RESEARCH_HOSTS: val }); const r = await Promise.race([x.done, sleep(8000).then(() => null)]); if (!r) await x.stop();
    check(`J17 COS_RESEARCH_HOSTS with ${name} (${val}) refuses to boot (exit 5), never listens`, r && r.code === 5 && /COS_RESEARCH_HOSTS/.test(x.log), J(r) + x.log.slice(-200)); }

  console.log(`\nTEST33-J (real server; model, https.request and DNS STUBBED; no network, no live model) result=${fail ? 'FAIL' : 'PASS'} passed=${pass} failed=${fail}`);
  fs.rmSync(tmp, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

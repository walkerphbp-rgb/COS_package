'use strict';
// Transport-error fallback + bounded grounding fetch. Run: node test_transport_and_grounding.js
// Network is fully stubbed (global.fetch). Short timeouts are set BEFORE the modules load (they read env at load).
process.env.GEMINI_TIMEOUT_MS = '80';
process.env.GROQ_TIMEOUT_MS = '80';
process.env.GROUNDING_TIMEOUT_MS = '60';
const assert = require('assert');
const Module = require('module');

// mission_chain.js requires ./gate, ./format_loader, ./router. Use the real ones when present (the repo);
// stub only when they cannot be resolved (so this file also runs standalone).
const STUBS = {
  './gate': { gateExecuteInTx() {}, SYSTEM_APPROVAL_TEXT: 'stub' },
  './format_loader': { ENGINE_DEFAULTS: { evidence: { min_snippet_chars: 20 } }, TIER_RANK: {} },
  './router': { planOf() { return null; } },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  try { return origLoad.apply(this, arguments); }
  catch (e) { if (e && e.code === 'MODULE_NOT_FOUND' && STUBS[request]) return STUBS[request]; throw e; }
};
const { DatabaseSync } = require('node:sqlite');
const { callWithFallback, toProviderCallRow, DEFAULT_FALLBACK_STATUS, NETWORK_ERROR_STATUS, BAD_JSON_STATUS, TIMEOUT_STATUS } = require('./provider_fallback');
const { buildProviders, fetchGrounding, runResearcher } = require('./mission_chain');

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = [];
const T = (name, fn) => tests.push([name, fn]);
let passed = 0;
process.on('exit', (c) => { if (c === 0 && passed !== tests.length) { console.error(`FAIL: exited after ${passed}/${tests.length} tests (a hang?)`); process.exitCode = 1; } });

// ---- stubs -------------------------------------------------------------------------------------------------
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const geminiOk = (obj) => resp(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
const groqOk = (obj) => resp(200, { choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const netErr = (code) => { const c = Object.assign(new Error(code), { code }); return new TypeError('fetch failed', { cause: c }); };
const stall = (_url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason || new Error('aborted'))));
let calls, H;
function setFetch(handlers) {
  calls = []; H = handlers;
  global.fetch = async (url, opts) => {
    const which = url.includes('generativelanguage') ? 'gemini' : url.includes('api.groq.com') ? 'groq' : 'seed';
    calls.push(which);
    return H[which](url, opts);
  };
}
const KEYS = { gemini: 'k', groq: 'k' }, MODELS = { gemini: 'g', groq: 'q' };
const providers = () => buildProviders(KEYS, MODELS, '{"ok":boolean}');
const validate = (r) => !!r && r.ok === true;
const run = (policy) => callWithFallback({ prompt: 'p', validate }, providers(), policy);

// ---- A. provider_fallback.js with stubbed providers --------------------------------------------------------
const tagged = (code, status, msg = code, cause) => Object.assign(new Error(msg, { cause }), { code, status });
const okp = (name, v = { ok: true }) => { const p = { name, n: 0, call: async () => { p.n++; return v; } }; return p; };
const failp = (name, err) => { const p = { name, n: 0, call: async () => { p.n++; throw err; } }; return p; };

T('A1 tagged network error on primary falls back; original details observable', async () => {
  const cause = new Error('ECONNRESET');
  const g = failp('gemini', tagged('provider_network_error', NETWORK_ERROR_STATUS, 'gemini network error: fetch failed', cause)), q = okp('groq');
  const r = await callWithFallback({ prompt: 'x' }, [g, q]);
  assert.strictEqual(r.providerUsed, 'groq'); assert.strictEqual(r.fallbackTriggered, true);
  assert.strictEqual(r.attemptedStatusCode, 597);
  assert.deepStrictEqual(r.fallbackReasons, [{ provider: 'gemini', status: 597, code: 'provider_network_error', message: 'gemini network error: fetch failed' }]);
  assert.strictEqual(toProviderCallRow(r, { missionId: 'm', callSeq: 1, specialist: 's' }).attempted_status_code, 597);
});
T('A2 tagged bad-json error on primary falls back (596)', async () => {
  const r = await callWithFallback({ prompt: 'x' }, [failp('gemini', tagged('provider_bad_json', BAD_JSON_STATUS)), okp('groq')]);
  assert.strictEqual(r.providerUsed, 'groq'); assert.strictEqual(r.attemptedStatusCode, 596);
});
T('A3 untagged errors (bugs, unknown throws) do NOT fall back', async () => {
  const bug = new TypeError('x is not a function'); const q = okp('groq');
  await assert.rejects(callWithFallback({ prompt: 'x' }, [failp('gemini', bug), q]), (e) => e === bug);
  assert.strictEqual(q.n, 0);
  const q2 = okp('groq'); const syn = new SyntaxError('Unexpected token');   // a bare SyntaxError that was NOT tagged at source
  await assert.rejects(callWithFallback({ prompt: 'x' }, [failp('gemini', syn), q2]), (e) => e === syn);
  assert.strictEqual(q2.n, 0);
});
T('A4 HTTP 400/401/403/404 never fall back; same error object surfaces', async () => {
  for (const s of [400, 401, 403, 404]) {
    const err = Object.assign(new Error(`gemini http ${s}`), { status: s }); const q = okp('groq');
    await assert.rejects(callWithFallback({ prompt: 'x' }, [failp('gemini', err), q]), (e) => e === err && e.status === s);
    assert.strictEqual(q.n, 0, `groq must not be called for ${s}`);
  }
  assert.deepStrictEqual([...DEFAULT_FALLBACK_STATUS], [429, 500, 503, 504]);
});
T('A5 both fail: each provider called exactly once, last error surfaces with every attempt attached', async () => {
  const e1 = tagged('provider_network_error', 597, 'gemini network error: fetch failed'), e2 = tagged('provider_bad_json', 596, 'groq bad json: model output is not valid JSON');
  const g = failp('gemini', e1), q = failp('groq', e2);
  await assert.rejects(callWithFallback({ prompt: 'x' }, [g, q]), (e) => e === e2 && e.message === 'groq bad json: model output is not valid JSON' &&
    e.attempts.length === 2 && e.attempts[0].provider === 'gemini' && e.attempts[0].code === 'provider_network_error' && e.attempts[1].provider === 'groq' && e.attempts[1].status === 596);
  assert.strictEqual(g.n, 1); assert.strictEqual(q.n, 1);
  await sleep(30); assert.strictEqual(unhandled.length, 0);
});
T('A6 frozen error object does not break the throw path', async () => {
  const e = Object.freeze(Object.assign(new Error('frozen'), { status: 401 }));
  await assert.rejects(callWithFallback({ prompt: 'x' }, [failp('gemini', e), okp('groq')]), (x) => x === e);
});

// ---- B. real Gemini/Groq callers through buildProviders, global.fetch stubbed ------------------------------
T('B1 Gemini fetch throws (network): falls back to Groq; cause chain and reason observable', async () => {
  setFetch({ gemini: async () => { throw netErr('ECONNRESET'); }, groq: async () => groqOk({ ok: true }) });
  const r = await run();
  assert.strictEqual(r.providerUsed, 'groq'); assert.strictEqual(r.attemptedStatusCode, 597);
  assert.deepStrictEqual(calls, ['gemini', 'groq']);
  const fr = r.fallbackReasons[0];
  assert.strictEqual(fr.code, 'provider_network_error'); assert.match(fr.message, /gemini network error: fetch failed/);
});
T('B2 Gemini 200 with a non-JSON HTTP body: falls back (596)', async () => {
  setFetch({ gemini: async () => resp(200, '<html>upstream error</html>'), groq: async () => groqOk({ ok: true }) });
  const r = await run(); assert.strictEqual(r.providerUsed, 'groq'); assert.strictEqual(r.attemptedStatusCode, 596);
  assert.match(r.fallbackReasons[0].message, /gemini bad json: response body is not JSON/);
});
T('B3 Gemini envelope fine but model text is malformed JSON: falls back (596)', async () => {
  setFetch({ gemini: async () => resp(200, { candidates: [{ content: { parts: [{ text: '{"ok": tru' }] } }] }), groq: async () => groqOk({ ok: true }) });
  const r = await run(); assert.strictEqual(r.providerUsed, 'groq'); assert.strictEqual(r.attemptedStatusCode, 596);
  assert.match(r.fallbackReasons[0].message, /model output is not valid JSON/);
});
T('B4 Gemini body stream breaks mid-read: falls back as network error (597)', async () => {
  setFetch({ gemini: async () => ({ ok: true, status: 200, text: async () => { throw new Error('terminated'); } }), groq: async () => groqOk({ ok: true }) });
  const r = await run(); assert.strictEqual(r.providerUsed, 'groq'); assert.strictEqual(r.attemptedStatusCode, 597);
});
T('B5 Gemini HTTP 400/401/403/404 through the real caller: no fallback, Groq never contacted', async () => {
  for (const s of [400, 401, 403, 404]) {
    setFetch({ gemini: async () => resp(s, { error: 'x' }), groq: async () => groqOk({ ok: true }) });
    await assert.rejects(run(), (e) => e.status === s && e.message === `gemini http ${s}` && e.code === undefined);
    assert.deepStrictEqual(calls, ['gemini'], `status ${s}`);
  }
});
T('B6 Gemini 503 still falls back (unchanged) and 429 keeps its message', async () => {
  setFetch({ gemini: async () => resp(503, {}), groq: async () => groqOk({ ok: true }) });
  const r = await run(); assert.strictEqual(r.providerUsed, 'groq'); assert.strictEqual(r.attemptedStatusCode, 503);
});
T('B7 both providers fail at the transport level: 2 fetches total, no loop, last error + both attempts, no unhandled rejection', async () => {
  setFetch({ gemini: async () => { throw netErr('ECONNRESET'); }, groq: async () => resp(200, 'not json') });
  await assert.rejects(run(), (e) => e.code === 'provider_bad_json' && e.attempts.map((a) => a.provider + ':' + a.status).join() === 'gemini:597,groq:596');
  assert.deepStrictEqual(calls, ['gemini', 'groq']);
  await sleep(30); assert.strictEqual(unhandled.length, 0);
});
T('B8 provider timeout still works through the real callers (signal reaches fetch); late abort is not an unhandled rejection', async () => {
  setFetch({ gemini: stall, groq: async () => groqOk({ ok: true }) });
  const t0 = Date.now(); const r = await run(); const dt = Date.now() - t0;
  assert.strictEqual(r.providerUsed, 'groq'); assert.strictEqual(r.attemptedStatusCode, TIMEOUT_STATUS);
  assert.ok(dt >= 70 && dt < 600, `elapsed ${dt}`);
  await sleep(30); assert.strictEqual(unhandled.length, 0);
});
T('B9 Groq (last provider) network error surfaces; nothing after it', async () => {
  setFetch({ gemini: async () => resp(503, {}), groq: async () => { throw netErr('ETIMEDOUT'); } });
  await assert.rejects(run(), (e) => e.code === 'provider_network_error' && e.attempts.length === 2 && e.cause instanceof TypeError);
  assert.deepStrictEqual(calls, ['gemini', 'groq']);
});

// ---- C. fetchGrounding -------------------------------------------------------------------------------------
T('C1 success: content returned, not flagged as failed', async () => {
  setFetch({ seed: async () => resp(200, 'hello world') });
  const g = await fetchGrounding('https://seed.test/a'); assert.strictEqual(g.statusCode, 200); assert.strictEqual(g.content, 'hello world'); assert.ok(!g.fetchFailed);
});
T('C2 stalled connection: bounded by the timeout, flagged fetchFailed+timedOut', async () => {
  setFetch({ seed: stall });
  const t0 = Date.now(); const g = await fetchGrounding('https://seed.test/a', 50); const dt = Date.now() - t0;
  assert.ok(g.fetchFailed && g.timedOut && g.statusCode === 0 && g.bytes === 0 && g.content === '' && /timed out after 50ms/.test(g.error), JSON.stringify(g));
  assert.ok(dt >= 45 && dt < 500, `elapsed ${dt}`);
});
T('C3 stalled body read is also bounded', async () => {
  setFetch({ seed: async (_u, opts) => ({ ok: true, status: 200, text: () => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason))) }) });
  const g = await fetchGrounding('https://seed.test/a', 50); assert.ok(g.fetchFailed && g.timedOut);
});
T('C4 network failure: flagged fetchFailed, original message kept, not timedOut', async () => {
  setFetch({ seed: async () => { throw netErr('ENOTFOUND'); } });
  const g = await fetchGrounding('https://seed.test/a'); assert.ok(g.fetchFailed && !g.timedOut && g.error === 'fetch failed' && g.statusCode === 0);
});
T('C5 HTTP error page is NOT a fetch failure (behaviour unchanged: proceeds, never grounded)', async () => {
  setFetch({ seed: async () => resp(404, 'Not found page') });
  const g = await fetchGrounding('https://seed.test/a'); assert.ok(!g.fetchFailed && g.statusCode === 404 && g.error === 'http 404' && g.bytes > 0);
});

// json()-only response mocks (no text()): the grounding body reader must tolerate them without weakening fail-closed behaviour.
const jsonOnly = (status, val) => ({ ok: status >= 200 && status < 300, status, json: async () => val });
T('C6 json()-only mock: body read via json(), not flagged as failed', async () => {
  setFetch({ seed: async () => jsonOnly(200, { page: 'hello world' }) });
  const g = await fetchGrounding('https://seed.test/a');
  assert.ok(!g.fetchFailed && g.statusCode === 200 && g.error === null && g.content === '{"page":"hello world"}' && g.bytes === g.content.length, JSON.stringify(g));
});
T('C7 json()-only mock with malformed JSON: fails closed (fetchFailed, not timedOut, no content)', async () => {
  setFetch({ seed: async () => ({ ok: true, status: 200, json: async () => JSON.parse('{"page": tru') }) });
  const g = await fetchGrounding('https://seed.test/a');
  assert.ok(g.fetchFailed && !g.timedOut && g.statusCode === 0 && g.bytes === 0 && g.content === '' && /JSON/.test(g.error), JSON.stringify(g));
});
T('C8 text() body read failure (non-timeout): fails closed, classified as fetch failure not timeout', async () => {
  setFetch({ seed: async () => ({ ok: true, status: 200, text: async () => { throw new Error('terminated'); } }) });
  const g = await fetchGrounding('https://seed.test/a');
  assert.ok(g.fetchFailed && !g.timedOut && g.statusCode === 0 && g.content === '' && g.error === 'terminated', JSON.stringify(g));
});
T('C9 stalled json() body read is also bounded by the timeout', async () => {
  setFetch({ seed: async (_u, opts) => ({ ok: true, status: 200, json: () => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason))) }) });
  const t0 = Date.now(); const g = await fetchGrounding('https://seed.test/a', 50); const dt = Date.now() - t0;
  assert.ok(g.fetchFailed && g.timedOut && g.statusCode === 0 && g.content === '', JSON.stringify(g)); assert.ok(dt < 500, `elapsed ${dt}`);
});
T('C10 when both exist, text() is used and json() is never called (real-fetch behaviour preserved)', async () => {
  setFetch({ seed: async () => ({ ok: true, status: 200, text: async () => 'raw text body', json: async () => { throw new Error('json() must not be called'); } }) });
  const g = await fetchGrounding('https://seed.test/a'); assert.ok(!g.fetchFailed && g.content === 'raw text body');
});
T('C11 json()-only HTTP 404: still not a fetch failure (unchanged), never grounded', async () => {
  setFetch({ seed: async () => jsonOnly(404, 'Not found page') });
  const g = await fetchGrounding('https://seed.test/a'); assert.ok(!g.fetchFailed && g.statusCode === 404 && g.error === 'http 404' && g.bytes > 0);
});

// ---- D. runResearcher: fetch failure stops the mission before any model call -------------------------------
const SEED = 'https://seed.test/doc', NONCE = 'N0NCE', SNIP = 'The Chief of Staff refuses to execute anything without a human issued approval row in the decisions table.';
function newDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE fetch_log (mission_id, url, status_code, bytes, error, created_at);
    CREATE TABLE provider_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id, call_seq, specialist, provider_attempted, provider_used, fallback_triggered, attempted_status_code, injected_failure, schema_valid, raw_output, created_at);
    CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id, provider_call_id, text, source_url, evidence_snippet, confidence, fetch_match, poisoned, created_at);
    CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id, status, rationale, created_at);`);
  return db;
}
const research = (db) => runResearcher(db, { missionId: 'm1', callSeq: 1, requestText: 'q', nonce: NONCE, seedUrl: SEED, keys: KEYS, models: MODELS, persona: null, minSnippet: undefined, fx: undefined });
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
const goodModel = () => geminiOk({ claims: [{ text: `Approval is required [ref:${NONCE}]`, source_url: SEED, evidence_snippet: SNIP, confidence: 0.9 }], verification_token: NONCE });

T('D1 seed fetch fails (network): mission stops, no model call, no provider_calls/claims/RESEARCHED, failure logged', async () => {
  setFetch({ seed: async () => { throw netErr('ECONNRESET'); }, gemini: goodModel, groq: async () => groqOk({}) });
  const db = newDb();
  await assert.rejects(research(db), (e) => e.code === 'grounding_fetch_failed' && /no verified evidence/.test(e.message));
  assert.deepStrictEqual(calls, ['seed']);
  assert.strictEqual(count(db, 'provider_calls'), 0); assert.strictEqual(count(db, 'claims'), 0);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE status='RESEARCHED'`).get().n, 0);
  const fl = db.prepare('SELECT * FROM fetch_log').all(); assert.strictEqual(fl.length, 1); assert.strictEqual(fl[0].status_code, 0); assert.match(fl[0].error, /fetch failed/);
});
T('D2 seed fetch times out: mission stops with grounding_timeout, no model call', async () => {
  setFetch({ seed: stall, gemini: goodModel, groq: async () => groqOk({}) });
  const db = newDb(); const t0 = Date.now();
  await assert.rejects(research(db), (e) => e.code === 'grounding_timeout' && /timed out after 60ms/.test(e.message));
  assert.ok(Date.now() - t0 < 600); assert.deepStrictEqual(calls, ['seed']);
  assert.strictEqual(count(db, 'provider_calls'), 0); assert.strictEqual(count(db, 'claims'), 0);
  assert.match(db.prepare('SELECT error FROM fetch_log').get().error, /timed out/);
});
T('D3 control: healthy seed + healthy Gemini proceeds and the claim is grounded', async () => {
  setFetch({ seed: async () => resp(200, `Intro. ${SNIP} Outro.`), gemini: goodModel, groq: async () => groqOk({}) });
  const db = newDb(); const r = await research(db);
  assert.strictEqual(r.claimIds.length, 1); assert.strictEqual(db.prepare('SELECT fetch_match FROM claims').get().fetch_match, 1);
  assert.deepStrictEqual(calls, ['seed', 'gemini']); assert.strictEqual(r.tokenVerified, true);
});
T('D4 control: seed returns HTTP 404 page: still proceeds (unchanged), claim ungrounded (fetch_match 0)', async () => {
  setFetch({ seed: async () => resp(404, 'Not found'), gemini: goodModel, groq: async () => groqOk({}) });
  const db = newDb(); const r = await research(db);
  assert.strictEqual(r.claimIds.length, 1); assert.strictEqual(db.prepare('SELECT fetch_match FROM claims').get().fetch_match, 0);
  assert.strictEqual(db.prepare('SELECT status_code FROM fetch_log').get().status_code, 404);
});
T('D5 Gemini network failure inside runResearcher falls back to Groq and the mission continues', async () => {
  setFetch({ seed: async () => resp(200, `Intro. ${SNIP} Outro.`), gemini: async () => { throw netErr('ECONNRESET'); },
    groq: async () => groqOk({ claims: [{ text: `Approval is required [ref:${NONCE}]`, source_url: SEED, evidence_snippet: SNIP, confidence: 0.9 }], verification_token: NONCE }) });
  const db = newDb(); const r = await research(db);
  assert.strictEqual(r.fallbackTriggered, true); assert.strictEqual(r.providerUsed, 'groq');
  const row = db.prepare('SELECT * FROM provider_calls').get(); assert.strictEqual(row.fallback_triggered, 1); assert.strictEqual(row.attempted_status_code, 597);
});
T('D5b json()-only seed with malformed JSON: mission stops (grounding_fetch_failed), no model call, nothing persisted but the failure log', async () => {
  setFetch({ seed: async () => ({ ok: true, status: 200, json: async () => JSON.parse('{"x": ') }), gemini: goodModel, groq: async () => groqOk({}) });
  const db = newDb();
  await assert.rejects(research(db), (e) => e.code === 'grounding_fetch_failed' && /no verified evidence/.test(e.message));
  assert.deepStrictEqual(calls, ['seed']);
  assert.strictEqual(count(db, 'provider_calls'), 0); assert.strictEqual(count(db, 'claims'), 0);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE status='RESEARCHED'`).get().n, 0);
  const fl = db.prepare('SELECT * FROM fetch_log').all(); assert.strictEqual(fl.length, 1); assert.strictEqual(fl[0].status_code, 0);
});
T('D5c text() body read failure mid-stream: mission stops (grounding_fetch_failed, not grounding_timeout), no model call', async () => {
  setFetch({ seed: async () => ({ ok: true, status: 200, text: async () => { throw new Error('terminated'); } }), gemini: goodModel, groq: async () => groqOk({}) });
  const db = newDb();
  await assert.rejects(research(db), (e) => e.code === 'grounding_fetch_failed' && !/timed out/.test(e.message));
  assert.deepStrictEqual(calls, ['seed']); assert.strictEqual(count(db, 'provider_calls'), 0); assert.strictEqual(count(db, 'claims'), 0);
});
T('D5d json()-only seed that stalls: mission stops with grounding_timeout, no model call', async () => {
  setFetch({ seed: async (_u, opts) => ({ ok: true, status: 200, json: () => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason))) }), gemini: goodModel, groq: async () => groqOk({}) });
  const db = newDb();
  await assert.rejects(research(db), (e) => e.code === 'grounding_timeout');
  assert.deepStrictEqual(calls, ['seed']); assert.strictEqual(count(db, 'provider_calls'), 0); assert.strictEqual(count(db, 'claims'), 0);
});
T('D5e json()-only healthy seed: proceeds, claim grounded against the body as read', async () => {
  setFetch({ seed: async () => jsonOnly(200, `Intro. ${SNIP} Outro.`), gemini: goodModel, groq: async () => groqOk({}) });
  const db = newDb(); const r = await research(db);
  assert.strictEqual(r.claimIds.length, 1); assert.strictEqual(db.prepare('SELECT fetch_match FROM claims').get().fetch_match, 1);
  assert.deepStrictEqual(calls, ['seed', 'gemini']);
});
T('D6 no unhandled rejections anywhere in this file', async () => { await sleep(100); assert.strictEqual(unhandled.length, 0, String(unhandled[0])); });

// AbortSignal.timeout() timers are unref'd in Node: with a stubbed fetch nothing else keeps the loop alive,
// so hold it open ourselves (in production a real socket does this).
const keepAlive = setInterval(() => {}, 1000);
(async () => {
  for (const [name, fn] of tests) { await fn(); passed++; console.log('PASS', name); }
  clearInterval(keepAlive);
  console.log(`\n${passed}/${tests.length} passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });

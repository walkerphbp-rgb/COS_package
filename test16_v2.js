#!/usr/bin/env node
/**
 * Test 16 v2: tests the REAL provider_fallback.js (callWithFallback + toProviderCallRow),
 * not an inline copy. Providers are stubs shaped like mission_chain.js's buildProviders()
 * output ({name, model, call(prompt)}), so no network, no keys, no production edits.
 * Rows are written with the same INSERT mission_chain.js uses (runProviderCall).
 *
 * Statuses: PASS / FAIL. Items tagged [PINNED] record CURRENT behaviour that is a known
 * gap (e.g. no fallback on Gemini 503). They PASS when behaviour matches what is documented;
 * they are not endorsements. If you later add 503 fallback, expect V9/V13 to FAIL on purpose.
 *
 * Usage: node test16_v2.js   (Node 22.5+; files test16_schema.sql + provider_fallback.js alongside)
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { callWithFallback, toProviderCallRow } = require('./provider_fallback');

const DB_PATH = path.join(__dirname, 'test16_v2.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
let db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'test16_schema.sql'), 'utf8'));
const missionId = crypto.randomUUID();
db.prepare(`INSERT INTO missions (id, request_text, status, created_at) VALUES (?, 'Test 16 v2', 'PROPOSED', ?)`).run(missionId, new Date().toISOString());

const validate = (r) => !!r && Array.isArray(r.claims) && r.claims.length > 0 &&
  r.claims.every((c) => typeof c.text === 'string' && c.text && typeof c.confidence === 'number');
const GOOD = (who) => ({ claims: [{ text: `${who} claim`, confidence: 0.8 }] });
const BAD = { claims: [] };
const httpErr = (status) => Object.assign(new Error(`http ${status}`), { status });

// Stub provider with a call counter and a scripted behaviour.
function stub(name, behave) {
  const p = { name, model: name === 'groq' ? 'openai/gpt-oss-120b' : 'gemini-2.5-flash', calls: 0 };
  p.call = async (prompt) => { p.calls++; return behave(prompt); };
  return p;
}
const ok = (who) => () => GOOD(who);
const fail = (status) => () => { throw httpErr(status); };

// Same INSERT as mission_chain.js runProviderCall.
async function runCall(seq, providers, policy, v = validate) {
  const result = await callWithFallback({ prompt: `call ${seq}`, validate: v, meta: { missionId, callSeq: seq, specialist: 'researcher' } }, providers, policy);
  const row = toProviderCallRow(result, { missionId, callSeq: seq, specialist: 'researcher' });
  db.prepare(`INSERT INTO provider_calls
    (mission_id, call_seq, specialist, provider_attempted, provider_used, fallback_triggered, attempted_status_code, injected_failure, schema_valid, raw_output, created_at)
    VALUES (@mission_id, @call_seq, @specialist, @provider_attempted, @provider_used, @fallback_triggered, @attempted_status_code, @injected_failure, @schema_valid, @raw_output, @created_at)`).run(row);
  return { result, row };
}
async function expectThrow(fn) { try { await fn(); return null; } catch (e) { return e; } }

const R = [];
const rec = (id, pass, detail, tag = '') => R.push({ id, status: pass ? 'PASS' : 'FAIL', detail, tag });

(async () => {
  // V1 happy path: Gemini ok, Groq never called
  let g = stub('gemini', ok('gemini')), q = stub('groq', ok('groq'));
  let { row } = await runCall(1, [g, q]);
  rec('V1_happy_path_gemini_only', row.provider_used === 'gemini' && row.fallback_triggered === 0 && row.attempted_status_code === null && row.schema_valid === 1 && row.provider_attempted === 'gemini' && q.calls === 0,
    `used=${row.provider_used} fb=${row.fallback_triggered} status=${row.attempted_status_code} attempted=${row.provider_attempted} groq_calls=${q.calls}`);

  // V2 Gemini 429 -> Groq
  g = stub('gemini', fail(429)); q = stub('groq', ok('groq'));
  ({ row } = await runCall(2, [g, q]));
  rec('V2_429_falls_back_to_groq', row.provider_used === 'groq' && row.fallback_triggered === 1 && row.attempted_status_code === 429 && row.injected_failure === 0 && row.schema_valid === 1 && row.provider_attempted === 'gemini,groq' && g.calls === 1 && q.calls === 1,
    `used=${row.provider_used} fb=${row.fallback_triggered} status=${row.attempted_status_code} attempted=${row.provider_attempted} gemini_calls=${g.calls} groq_calls=${q.calls}`);

  // V3 not sticky: fresh provider list, next call starts at Gemini again
  g = stub('gemini', ok('gemini')); q = stub('groq', ok('groq'));
  ({ row } = await runCall(3, [g, q]));
  rec('V3_fallback_not_sticky', row.provider_used === 'gemini' && row.fallback_triggered === 0 && g.calls === 1 && q.calls === 0, `used=${row.provider_used} groq_calls=${q.calls}`);

  // V4 schema-invalid Gemini response falls through to Groq (status stays NULL)
  g = stub('gemini', () => BAD); q = stub('groq', ok('groq'));
  ({ row } = await runCall(4, [g, q]));
  rec('V4_schema_invalid_falls_through', row.provider_used === 'groq' && row.fallback_triggered === 1 && row.attempted_status_code === null && row.schema_valid === 1,
    `used=${row.provider_used} fb=${row.fallback_triggered} status=${row.attempted_status_code}`);

  // V5 both schema-invalid: returns schema_valid=0 (no throw), flagged
  g = stub('gemini', () => BAD); q = stub('groq', () => BAD);
  ({ row } = await runCall(5, [g, q]));
  rec('V5_both_invalid_returns_flagged_not_thrown', row.provider_used === 'groq' && row.schema_valid === 0 && row.fallback_triggered === 1, `used=${row.provider_used} schema_valid=${row.schema_valid}`);

  // V6 fresh-connection readback reconstructs the pattern from provider_calls alone
  db.close(); db = new DatabaseSync(DB_PATH);
  const rows = db.prepare(`SELECT call_seq, provider_used, fallback_triggered, schema_valid FROM provider_calls WHERE mission_id=? ORDER BY call_seq`).all(missionId);
  const pattern = rows.map((r) => `${r.call_seq}:${r.provider_used}:${r.fallback_triggered}:${r.schema_valid}`).join(',');
  const expected = '1:gemini:0:1,2:groq:1:1,3:gemini:0:1,4:groq:1:1,5:groq:1:0';
  rec('V6_fresh_readback_pattern', pattern === expected, `pattern=${pattern}`);

  // V7 429 on Gemini, 429 on Groq: throws Groq's 429 (nothing left), each called once
  g = stub('gemini', fail(429)); q = stub('groq', fail(429));
  let e = await expectThrow(() => runCall(90, [g, q]));
  rec('V7_both_429_throws', !!e && e.status === 429 && g.calls === 1 && q.calls === 1, `threw=${e && e.status} gemini_calls=${g.calls} groq_calls=${q.calls}`);

  // V8 Gemini 429, Groq 500: surfaces Groq's 500
  g = stub('gemini', fail(429)); q = stub('groq', fail(500));
  e = await expectThrow(() => runCall(91, [g, q]));
  rec('V8_gemini429_groq500_throws_500', !!e && e.status === 500, `threw=${e && e.status}`);

  // V9 [PINNED] Gemini 503 with Groq configured: NO fallback, throws 503, Groq untouched
  g = stub('gemini', fail(503)); q = stub('groq', ok('groq'));
  e = await expectThrow(() => runCall(92, [g, q]));
  rec('V9_gemini_503_no_fallback', !!e && e.status === 503 && q.calls === 0, `threw=${e && e.status} groq_calls=${q.calls}`, 'PINNED known gap: matches failed missions f4c9d7bd/8a4550e1');

  // V10 policy knob: fallbackOnStatus [429,503] makes 503 fall back (proves a fix is a policy change)
  g = stub('gemini', fail(503)); q = stub('groq', ok('groq'));
  ({ row } = await runCall(93, [g, q], { fallbackOnStatus: [429, 503] }));
  rec('V10_policy_can_enable_503_fallback', row.provider_used === 'groq' && row.attempted_status_code === 503, `used=${row.provider_used} status=${row.attempted_status_code}`);

  // V11 [PINNED] malformed JSON from Gemini (SyntaxError, no status): no fallback
  g = stub('gemini', () => JSON.parse('{not json')); q = stub('groq', ok('groq'));
  e = await expectThrow(() => runCall(94, [g, q]));
  rec('V11_malformed_json_no_fallback', !!e && e.name === 'SyntaxError' && q.calls === 0, `threw=${e && e.name} groq_calls=${q.calls}`, 'PINNED');

  // V12 [PINNED] Gemini schema-invalid then Groq throws: error surfaces, invalid Gemini response discarded
  g = stub('gemini', () => BAD); q = stub('groq', fail(500));
  e = await expectThrow(() => runCall(95, [g, q]));
  rec('V12_invalid_then_groq_error_throws', !!e && e.status === 500, `threw=${e && e.status}`, 'PINNED');

  // V13 single provider (no GROQ key): 429 throws, no fallback possible
  g = stub('gemini', fail(429));
  e = await expectThrow(() => runCall(96, [g]));
  rec('V13_single_provider_429_throws', !!e && e.status === 429 && g.calls === 1, `threw=${e && e.status}`);

  // V14 empty provider list throws
  e = await expectThrow(() => callWithFallback({ prompt: 'x', validate }, []));
  rec('V14_no_providers_throws', !!e && /no providers/.test(e.message), `threw=${e && e.message}`);

  // V15 injected failure: Gemini call() is NOT invoked, Groq used, injected_failure=1
  g = stub('gemini', ok('gemini')); q = stub('groq', ok('groq'));
  ({ row } = await runCall(97, [g, q], { injectFailureFor: (p, m) => p.name === 'gemini' && m.callSeq === 97 }));
  rec('V15_injected_failure_flagged', row.provider_used === 'groq' && row.injected_failure === 1 && row.attempted_status_code === 429 && g.calls === 0, `used=${row.provider_used} injected=${row.injected_failure} gemini_calls=${g.calls}`);

  // V16 no validate fn: treated as schema-valid
  g = stub('gemini', ok('gemini'));
  const r16 = await callWithFallback({ prompt: 'x' }, [g]);
  rec('V16_no_validate_means_valid', r16.schemaValid === 1, `schemaValid=${r16.schemaValid}`);

  // V17 circular response does not crash raw_output serialisation
  const circ = { claims: [{ text: 'c', confidence: 0.5 }] }; circ.self = circ;
  const r17 = await callWithFallback({ prompt: 'x', validate }, [stub('gemini', () => circ)]);
  rec('V17_circular_response_serialises', typeof r17.rawOutput === 'string', `raw_output type=${typeof r17.rawOutput}`);

  // ---- Report ----
  console.log('\nTest 16 v2 - real provider_fallback.js (stubbed providers, no network)');
  console.log('='.repeat(70));
  let pass = 0;
  for (const r of R) { if (r.status === 'PASS') pass++; console.log(`${r.status.padEnd(5)} ${r.id}${r.tag ? '  [' + r.tag + ']' : ''}\n      ${r.detail}`); }
  console.log('='.repeat(70));
  console.log(`${pass}/${R.length} passed`);
  db.close();
  process.exit(pass === R.length ? 0 : 1);
})().catch((err) => { console.error('Test 16 v2 crashed:', err); process.exit(2); });

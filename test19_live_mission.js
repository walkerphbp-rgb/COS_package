#!/usr/bin/env node
/**
 * TEST 19 — Real mission submitted from the phone actually executes,
 * AND independent Gemini usage confirms it.
 *
 * Two gates, both required for TEST19_FINAL result = PASS:
 *
 *   GATE A (automatic, HTTP-only): mission submitted -> backend receives it
 *   -> specialist chain runs -> a REAL Gemini call occurs -> response
 *   returns to the backend -> provider_used identifies the real
 *   provider/model -> result is written to SQLite -> mission status
 *   progresses -> audit trail records it -> a fresh GET /api/snapshot shows
 *   the same record, with the nonce present in the persisted claim text and
 *   echoed back by the provider itself (verification_token). This script
 *   talks HTTP only, exactly like the dashboard would on reload.
 *
 *   GATE B (independent, NOT satisfied by anything this script can see on
 *   its own): a human checks Google's own usage accounting — separate from
 *   this app and its backend — and confirms a real Generative Language API
 *   call happened in the right window. This script cannot automate that
 *   check away: doing so would mean trusting the same app we're trying to
 *   verify. It CAN surface the token-usage numbers Gemini returned inline
 *   with the response (supporting evidence, still routed through our own
 *   backend) as a secondary signal, but Gate B itself requires an explicit
 *   human confirmation of the separate Google dashboard before the test can
 *   report PASS.
 *
 * Usage:
 *   node test19_live_mission.js --host <backend URL> --token <COS_TOKEN>
 *     [--nonce LIVE_MISSION_XXXX] [--objective "..."]
 *     [--confirm-usage-count <N>]   non-interactive: N = the request count
 *                                   you saw in Google's usage dashboard for
 *                                   the relevant window (N >= 1 confirms;
 *                                   omit this flag to be prompted instead)
 *
 * Exit code 0 = PASS, 1 = FAIL (includes "Gate A passed, Gate B not yet
 * confirmed" — that is a FAIL, not a PASS-pending-review).
 */

const readline = require('node:readline');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, [])
);

const HOST = (args.host || '').replace(/\/$/, '');
const TOKEN = args.token;
if (!HOST || !TOKEN) {
  console.error('Usage: node test19_live_mission.js --host <backend URL> --token <COS_TOKEN> [--nonce LIVE_MISSION_XXXX] [--objective "..."] [--confirm-usage-count <N>]');
  process.exit(2);
}
const NONCE = args.nonce || `LIVE_MISSION_${Date.now()}`;
const OBJECTIVE = args.objective ||
  `Draft a one-paragraph summary of what this reference material covers, for a live plumbing test. Test nonce: ${NONCE}`;

function nowISO() { return new Date().toISOString(); }

async function req(method, pathName, body) {
  const res = await fetch(`${HOST}${pathName}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function runGateA() {
  const results = {};
  const criticalFailures = [];

  console.log('='.repeat(78));
  console.log('TEST 19 / GATE A — HTTP chain (automatic)');
  console.log(`host=${HOST}`);
  console.log(`nonce=${NONCE}`);
  console.log(`objective=${OBJECTIVE}`);
  console.log('='.repeat(78));

  const postStart = nowISO();
  console.log(`\n[${postStart}] POST /api/missions ...`);
  const post = await req('POST', '/api/missions', { objective: OBJECTIVE, nonce: NONCE });
  const postEnd = nowISO();
  const callTimeWindow = { start: postStart, end: postEnd };
  console.log(`  status=${post.status}`);
  console.log('  raw response:', JSON.stringify(post.json, null, 2));

  results.mission_submitted_and_accepted = { status: post.status === 201 ? 'PASS' : 'FAIL', detail: `HTTP ${post.status}` };
  if (post.status !== 201) {
    criticalFailures.push(`POST /api/missions returned ${post.status}: ${post.json && post.json.error}`);
    return { results, criticalFailures, callTimeWindow, missionId: null };
  }

  const missionId = post.json.missionId;
  results.provider_used_reported = {
    status: post.json.providerUsed && post.json.researcherProviderUsed ? 'PASS' : 'FAIL',
    detail: `providerUsed=${post.json.providerUsed} researcherProviderUsed=${post.json.researcherProviderUsed}`,
  };
  results.nonce_verified_in_provider_response = {
    status: post.json.nonceVerifiedInProviderResponse === true ? 'PASS' : 'FAIL',
    detail: 'Researcher\'s own JSON response echoed the nonce as verification_token.',
  };
  results.nonce_verified_in_artifact = {
    status: post.json.nonceVerifiedInArtifact === true ? 'PASS' : 'FAIL',
    detail: 'Creator artifact payload contains the nonce verbatim.',
  };
  results.mission_completed_low_risk = {
    status: (post.json.outcome === 'AUTO_COMPLETED' && post.json.riskTier === 'low') ? 'PASS' : 'FAIL',
    detail: `outcome=${post.json.outcome} risk_tier=${post.json.riskTier} critic_verdict=${post.json.criticVerdict}`,
  };
  const usage = post.json.tokenUsage || {};
  const usagePresent = ['researcher', 'analyst', 'creator'].some((k) => usage[k] && usage[k].total_tokens > 0);
  results.provider_token_usage_returned = {
    status: usagePresent ? 'PASS' : 'FAIL',
    detail: `tokenUsage=${JSON.stringify(usage)} (supporting signal only — relayed via our own backend, not a substitute for Gate B)`,
  };
  if (results.nonce_verified_in_provider_response.status === 'FAIL') criticalFailures.push('Nonce did not round-trip through the real provider response');
  if (results.provider_used_reported.status === 'FAIL') criticalFailures.push('provider_used missing');

  console.log(`\n[${nowISO()}] GET /api/snapshot (fresh read) ...`);
  const snap = await req('GET', '/api/snapshot');
  const mission = (snap.json.missions || []).find((m) => m.id === missionId);
  results.mission_visible_in_fresh_snapshot = { status: mission ? 'PASS' : 'FAIL', detail: mission ? `status=${mission.status}` : 'mission id not found in snapshot' };
  if (!mission) criticalFailures.push('Mission not found in a fresh /api/snapshot read');

  const providerCallsForMission = (snap.json.providers?.calls || []).filter((c) => c.mission_id === missionId);
  const usedProviders = [...new Set(providerCallsForMission.map((c) => c.used_provider))];
  results.provider_calls_persisted = {
    status: providerCallsForMission.length > 0 ? 'PASS' : 'FAIL',
    detail: `${providerCallsForMission.length} provider_calls row(s), providers used: ${usedProviders.join(', ') || 'none'}`,
  };

  const researchRows = (snap.json.research || []).filter((r) => r.mission_id === missionId);
  const nonceInResearch = researchRows.some((r) => (r.claim || '').includes(NONCE) || (r.snippet || '').includes(NONCE));
  results.nonce_visible_in_persisted_research = {
    status: nonceInResearch ? 'PASS' : 'FAIL',
    detail: nonceInResearch ? 'Nonce found in a persisted claim.' : 'Nonce not found in any persisted claim text for this mission.',
  };
  if (!nonceInResearch) criticalFailures.push('Nonce not present in the persisted mission record on a fresh read');

  const auditRows = (snap.json.audit || []).filter((a) => a.mission_id === missionId);
  results.audit_trail_recorded = { status: auditRows.length > 0 ? 'PASS' : 'FAIL', detail: `${auditRows.length} audit row(s)` };

  results.mission_status_completed_in_snapshot = {
    status: mission && mission.status === 'COMPLETED' ? 'PASS' : 'FAIL',
    detail: mission ? `status=${mission.status}` : 'n/a',
  };
  if (mission && mission.status !== 'COMPLETED') criticalFailures.push(`Mission status in fresh snapshot is ${mission.status}, expected COMPLETED`);

  console.log('  raw missions[this mission]:', JSON.stringify(mission, null, 2));
  console.log('  raw provider_calls[this mission]:', JSON.stringify(providerCallsForMission, null, 2));

  return { results, criticalFailures, callTimeWindow, missionId };
}

async function runGateB(callTimeWindow) {
  console.log('\n' + '='.repeat(78));
  console.log('TEST 19 / GATE B — independent Google Gemini usage confirmation');
  console.log('='.repeat(78));
  console.log('This gate is NOT satisfied by anything Gate A printed above — that all came');
  console.log('from our own backend, which is exactly what a bug or a faked result could also');
  console.log('produce. Check a source Google controls, separate from this app:');
  console.log('  Google AI Studio  -> https://aistudio.google.com/  -> "Usage" / API key page');
  console.log('  or Google Cloud Console -> APIs & Services -> Generative Language API -> Metrics');
  console.log(`Look for a request in the window ${callTimeWindow.start}  to  ${callTimeWindow.end}`);
  console.log('(the exact minute this script called POST /api/missions).');

  if (args['confirm-usage-count']) {
    const n = Number(args['confirm-usage-count']);
    const ok = Number.isFinite(n) && n >= 1;
    console.log(`\n--confirm-usage-count=${args['confirm-usage-count']} supplied non-interactively: ${ok ? 'accepted' : 'rejected (must be >= 1)'}`);
    return { status: ok ? 'PASS' : 'FAIL', detail: ok ? `operator-reported request count: ${n}` : `invalid --confirm-usage-count: ${args['confirm-usage-count']}` };
  }

  const answer = (await ask('\nHow many Generative Language API requests do you see for that window? (0 if none, or "skip" to leave unconfirmed): ')).trim().toLowerCase();
  if (answer === 'skip' || answer === '') {
    return { status: 'FAIL', detail: 'Left unconfirmed by operator — Gate B requires an explicit count, not a skip.' };
  }
  const n = Number(answer);
  const ok = Number.isFinite(n) && n >= 1;
  return { status: ok ? 'PASS' : 'FAIL', detail: ok ? `operator-reported request count: ${n}` : `operator reported ${answer} — no matching request found` };
}

async function main() {
  const gateA = await runGateA();

  if (!gateA.missionId) {
    return finish(gateA.results, gateA.criticalFailures, { status: 'SKIPPED', detail: 'Gate A failed before a call could have happened' });
  }

  const gateB = await runGateB(gateA.callTimeWindow);
  return finish(gateA.results, gateA.criticalFailures, gateB);
}

function finish(results, criticalFailures, gateB) {
  const allResults = { ...results, independent_gemini_usage_confirmed: gateB };
  const scored = Object.values(allResults).filter((r) => r.status !== 'SKIPPED');
  const passed = scored.filter((r) => r.status === 'PASS').length;
  const failed = scored.length - passed;
  const gateAPass = Object.entries(results).every(([, r]) => r.status === 'PASS');
  const gateBPass = gateB.status === 'PASS';

  const testFinal = {
    result: (gateAPass && gateBPass && criticalFailures.length === 0) ? 'PASS' : 'FAIL',
    gate_a_http_chain: gateAPass ? 'PASS' : 'FAIL',
    gate_b_independent_usage_confirmed: gateB.status,
    tests_run: scored.length, tests_passed: passed, tests_failed: failed,
    critical_failures: criticalFailures, nonce: NONCE,
  };

  console.log('\n' + '='.repeat(78));
  for (const [name, r] of Object.entries(allResults)) console.log(`${r.status.padEnd(8)} ${name}\n         ${r.detail}`);
  console.log('='.repeat(78));
  console.log('TEST19_FINAL', JSON.stringify(testFinal, null, 2));

  if (testFinal.result === 'FAIL') process.exitCode = 1;
  return testFinal;
}

main().catch((err) => { console.error('Test 19 runner crashed:', err); process.exit(1); });

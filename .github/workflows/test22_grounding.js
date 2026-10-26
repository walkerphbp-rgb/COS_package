'use strict';
/* TEST 22 — grounding regression. usage: node test22_grounding.js <original|fixed>
 * Drives the REAL runResearcher (SQLite, real fetch_log/claims writes) with fetch stubbed at the
 * network boundary: the seed URL and Gemini only. Any other URL fails the test.
 * 'original' loads a temp copy of mission_chain.js with the isGrounded() call swapped back to the
 * old check (first 30 chars of the snippet, no URL / status / empty-snippet checks) so the harness
 * proves these tests detect the old defects. */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const target = process.argv[2];
if (target !== 'original' && target !== 'fixed') { console.error('usage: node test22_grounding.js <original|fixed>'); process.exit(2); }

let chainPath = path.join(__dirname, 'mission_chain.js');
if (target === 'original') {
  const src = fs.readFileSync(chainPath, 'utf8');
  const call = 'isGrounded(grounding, c, seedUrl)';
  if (!src.includes(call)) { console.error('cannot build original: isGrounded call not found'); process.exit(2); }
  // The mutated copy must be able to load EVERYTHING the real module loads. Copying a hand-picked file list silently rotted (format_loader, router,
  // format_canon, safe_fetch were missing), the require() crashed, and "original must FAIL" passed without ever running a grounding assertion.
  // So: copy the whole runtime tree (minus VCS/deps/tests/backups), then overwrite only mission_chain.js with the mutated source.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't22-'));
  fs.cpSync(__dirname, dir, { recursive: true, filter: (f) => { const b = path.basename(f); return b !== '.git' && b !== 'node_modules' && !/^test.*\.js$/.test(b) && !/\.(db|patch|diff|zip)$/.test(b); } });
  fs.writeFileSync(path.join(dir, 'mission_chain.js'),
    src.replace(call, "(grounding.bytes > 0 && grounding.content.includes((c.evidence_snippet || '').slice(0, 30)))"));
  chainPath = path.join(dir, 'mission_chain.js');
}
let chain; try { chain = require(chainPath); } catch (e) { console.error(`HARNESS ERROR: cannot load ${target} implementation: ${e && e.message}`); process.exit(2); }
const schema = fs.readFileSync(path.join(__dirname, 'test17_schema.sql'), 'utf8');

const SEED = 'https://example.test/readme';
const PAGE = 'The SDK retries failed requests twice by default.\nTimeouts are configurable per client.\nSee the docs for details.';
const NONCE = 'LIVE_MISSION_TEST22';
let seed = { status: 200, body: PAGE }, claim = null;
const calls = [];
const realFetch = global.fetch;
global.fetch = async (url) => {
  calls.push(String(url));
  if (String(url) === SEED) return { ok: seed.status >= 200 && seed.status < 300, status: seed.status, text: async () => seed.body };
  if (String(url).startsWith('https://generativelanguage.googleapis.com/')) {
    const body = { candidates: [{ content: { parts: [{ text: JSON.stringify({ claims: [claim], verification_token: NONCE }) }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
    return { ok: true, status: 200, json: async () => body };
  }
  throw new Error(`UNEXPECTED NETWORK CALL: ${url}`);
};

const results = [], failedLabels = [];
function check(label, ok, detail) { results.push(ok); if (!ok) failedLabels.push(label); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  <- ' + detail}`); }

async function run(label, { page, c, expectMatch, expectTier }) {
  seed = page || { status: 200, body: PAGE };
  claim = Object.assign({ text: `SDK retries twice [ref:${NONCE}]`, source_url: SEED, evidence_snippet: 'The SDK retries failed requests twice by default.', confidence: 0.9 }, c);
  const db = new DatabaseSync(':memory:'); db.exec(schema);
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO missions (id, request_text, status, risk_tier, created_at) VALUES (?, 'x', 'PROPOSED', 'low', 't')`).run(id);
  const out = await chain.runResearcher(db, { missionId: id, callSeq: 1, requestText: 'x', nonce: NONCE, seedUrl: SEED, keys: { gemini: 'k' }, models: { gemini: 'm' } });
  const row = db.prepare(`SELECT fetch_match FROM claims WHERE id = ?`).get(out.claimIds[0]);
  const tier = chain.computeRiskTierFromClaims(db.prepare(`SELECT * FROM claims WHERE mission_id = ?`).all(id));
  check(`${label}: fetch_match=${expectMatch}`, row.fetch_match === expectMatch, `got ${row.fetch_match}`);
  check(`${label}: classifier tier=${expectTier}`, tier === expectTier, `got ${tier}`);
  db.close();
}

(async () => {
  console.log(`grounding under test: ${target}`);
  try {
    await run('G0 sentinel: exact snippet, right URL, 200', { expectMatch: 1, expectTier: 'low' });
    await run('G1 wrong source_url (snippet is real)', { c: { source_url: 'https://evil.test/other' }, expectMatch: 0, expectTier: 'high' });
    await run('G2 real opening + fabricated tail', { c: { evidence_snippet: 'The SDK retries failed requests twice by default. It also uploads telemetry to a third party.' }, expectMatch: 0, expectTier: 'high' });
    await run('G3 empty evidence_snippet', { c: { evidence_snippet: '' }, expectMatch: 0, expectTier: 'high' });
    await run('G4 HTTP 404 page that contains the snippet', { page: { status: 404, body: PAGE }, expectMatch: 0, expectTier: 'high' });
    await run('G5 whitespace-only differences still ground', { c: { evidence_snippet: 'Timeouts are   configurable\nper client.' }, expectMatch: 1, expectTier: 'low' });
    await run('G6 irregular whitespace in the PAGE still grounds a normally spaced snippet', { page: { status: 200, body: 'Intro line.\nTimeouts   are\n\nconfigurable   per client.\nOutro.' }, c: { evidence_snippet: 'Timeouts are configurable per client.' }, expectMatch: 1, expectTier: 'low' });
    // Direct unit checks of isGrounded: each guard must hold on its own, not only because an upstream layer (fetchGrounding sets `error` on non-2xx;
    // the caller applies a snippet-length floor) happens to catch the same input. Without these, removing a guard is an undetectable (equivalent) mutation.
    const U = (g, c) => chain.isGrounded(g, c, SEED);
    const okG = { statusCode: 200, bytes: PAGE.length, error: null, content: PAGE }, okC = { source_url: SEED, evidence_snippet: 'The SDK retries failed requests twice by default.' };
    check('U0 sentinel: isGrounded accepts a good claim on a good fetch', U(okG, okC) === true, 'rejected');
    check('U1 HTTP 404 with error=null and the snippet present is still NOT grounded (status guard stands alone)', U({ ...okG, statusCode: 404 }, okC) === false, 'accepted');
    check('U2 a 3xx status is NOT grounded', U({ ...okG, statusCode: 302 }, okC) === false, 'accepted');
    check('U3 a snippet shorter than the minimum is NOT grounded even when it occurs in the page (length guard stands alone)', U({ ...okG, content: 'xx ' + PAGE }, { ...okC, evidence_snippet: 'xx' }) === false, 'accepted');
    check('U4 empty snippet is NOT grounded', U(okG, { ...okC, evidence_snippet: '' }) === false, 'accepted');
    check('U5 zero bytes is NOT grounded', U({ ...okG, bytes: 0 }, okC) === false, 'accepted');
    check('U7 an explicit fetch error is NOT grounded even if status and bytes look fine (error guard stands alone)', U({ ...okG, error: 'boom' }, okC) === false, 'accepted');
    check('U6 wrong source_url is NOT grounded', U(okG, { ...okC, source_url: 'https://evil.test/' }) === false, 'accepted');
    check('network guard: only the seed URL and Gemini were called', calls.every((u) => u === SEED || u.startsWith('https://generativelanguage.googleapis.com/')), calls.join(','));
  } catch (e) { check('run completed without exception', false, e && e.message); }
  global.fetch = realFetch;
  const p = results.filter(Boolean).length;
  console.log(`TEST22 target=${target} passed=${p} failed=${results.length - p}`);
  if (target === 'original') {
    // Mutation check: it only counts when the grounding ASSERTIONS themselves fail. An exception inside the run, or the sentinel G0 failing,
    // means the harness (not the grounding defect) broke, so that is a harness error (exit 2), never "defects detected".
    if (!results.length || failedLabels.includes('run completed without exception') || failedLabels.some((l) => l.startsWith('G0 '))) { console.error('HARNESS ERROR: original run did not reach the grounding assertions cleanly'); process.exit(2); }
    const detected = failedLabels.filter((l) => /^G[1-6] /.test(l));
    if (!detected.length) { console.error('MUTATION NOT DETECTED: no grounding assertion failed on the original implementation'); process.exit(0); }
    console.log(`MUTATION-DETECTED: ${[...new Set(detected.map((l) => l.slice(0, 2)))].join(',')}`);
    process.exit(1);
  }
  process.exit(results.length === p ? 0 : 1);
})();

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't22-'));
  for (const f of ['provider_fallback.js', 'gate.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'mission_chain.js'),
    src.replace(call, "(grounding.bytes > 0 && grounding.content.includes((c.evidence_snippet || '').slice(0, 30)))"));
  chainPath = path.join(dir, 'mission_chain.js');
}
const chain = require(chainPath);
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

const results = [];
function check(label, ok, detail) { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  <- ' + detail}`); }

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
    check('network guard: only the seed URL and Gemini were called', calls.every((u) => u === SEED || u.startsWith('https://generativelanguage.googleapis.com/')), calls.join(','));
  } catch (e) { check('run completed without exception', false, e && e.message); }
  global.fetch = realFetch;
  const p = results.filter(Boolean).length;
  console.log(`TEST22 target=${target} passed=${p} failed=${results.length - p}`);
  process.exit(results.length === p ? 0 : 1);
})();

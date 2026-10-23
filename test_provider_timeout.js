'use strict';
// Timeout tests for provider_fallback.js (real file, stubbed providers). Run: node test_provider_timeout.js
const assert = require('assert');
const { callWithFallback, toProviderCallRow, DEFAULT_FALLBACK_STATUS, TIMEOUT_STATUS } = require('./provider_fallback');

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

const ok = (name, v = { ok: 1 }) => ({ name, call: async () => v });
const hang = (name, ms, extra = {}) => ({ name, timeoutMs: ms, call: () => new Promise(() => {}), ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
// A hung chain empties the event loop and Node exits 0 silently; make that a failure.
process.on('exit', (c) => { if (c === 0 && n !== 9) { console.error(`FAIL: exited after ${n}/9 tests (a hang?)`); process.exitCode = 1; } });
async function t(name, fn) { await fn(); n++; console.log('PASS', name); }

(async () => {
  await t('T1 hung primary falls back to secondary, marked 598/provider_timeout', async () => {
    const t0 = Date.now();
    const r = await callWithFallback({ prompt: 'x' }, [hang('gemini', 60), ok('groq')]);
    const dt = Date.now() - t0;
    assert.strictEqual(r.providerUsed, 'groq');
    assert.strictEqual(r.fallbackTriggered, true);
    assert.strictEqual(r.attemptedStatusCode, TIMEOUT_STATUS);
    assert.ok(dt >= 55 && dt < 400, `elapsed ${dt}`);
    assert.strictEqual(toProviderCallRow(r, { missionId: 'm', callSeq: 1, specialist: 's' }).attempted_status_code, 598);
  });

  await t('T2 response just under the timeout: no fallback', async () => {
    const slow = { name: 'gemini', timeoutMs: 150, call: async () => { await sleep(80); return { ok: 'gemini' }; } };
    const r = await callWithFallback({ prompt: 'x' }, [slow, ok('groq')]);
    assert.strictEqual(r.providerUsed, 'gemini');
    assert.strictEqual(r.fallbackTriggered, false);
    assert.strictEqual(r.attemptedStatusCode, null);
  });

  await t('T3 both providers hang: clean failure within ~sum of timeouts, no hang', async () => {
    const t0 = Date.now();
    await assert.rejects(callWithFallback({ prompt: 'x' }, [hang('gemini', 50), hang('groq', 50)]),
      (e) => e.code === 'provider_timeout' && e.status === 598 && /groq/.test(e.message));
    const dt = Date.now() - t0;
    assert.ok(dt >= 95 && dt < 500, `elapsed ${dt}`);
  });

  await t('T4 abort signal is fired on timeout (real fetch would be cancelled)', async () => {
    let aborted = false;
    const p = { name: 'gemini', timeoutMs: 40, call: (_p, { signal }) => new Promise((_, rej) => {
      signal.addEventListener('abort', () => { aborted = true; rej(new Error('AbortError')); });
    }) };
    const r = await callWithFallback({ prompt: 'x' }, [p, ok('groq')]);
    assert.strictEqual(aborted, true);
    assert.strictEqual(r.attemptedStatusCode, 598);   // timeout error wins over the abort error
  });

  await t('T5 no timeoutMs: behaviour unchanged (old stubs still work)', async () => {
    const r = await callWithFallback({ prompt: 'x' }, [{ name: 'g', call: async (p) => ({ echoed: p }) }]);
    assert.deepStrictEqual(r.response, { echoed: 'x' });
  });

  await t('T6 timeout falls back even when policy.fallbackOnStatus is overridden; fallbackOnTimeout:false stops it', async () => {
    const r = await callWithFallback({ prompt: 'x' }, [hang('g', 30), ok('q')], { fallbackOnStatus: [429] });
    assert.strictEqual(r.providerUsed, 'q');
    await assert.rejects(callWithFallback({ prompt: 'x' }, [hang('g', 30), ok('q')], { fallbackOnTimeout: false }),
      (e) => e.code === 'provider_timeout');
  });

  await t('T7 late rejection of an abandoned call is not an unhandledRejection', async () => {
    const late = { name: 'g', timeoutMs: 20, call: () => new Promise((_, rej) => setTimeout(() => rej(new Error('late boom')), 80)) };
    await callWithFallback({ prompt: 'x' }, [late, ok('q')]);
    await sleep(150);
    assert.strictEqual(unhandled.length, 0);
  });

  await t('T8 timer is cleared on success (no leaked handle keeps process alive)', async () => {
    await callWithFallback({ prompt: 'x' }, [{ name: 'g', timeoutMs: 60000, call: async () => ({ ok: 1 }) }]);
    // if the 60s timer leaked, the process would not exit on its own at the end of this script
  });

  await t('T9 default status list untouched; non-timeout errors unchanged', async () => {
    assert.deepStrictEqual([...DEFAULT_FALLBACK_STATUS], [429, 500, 503, 504]);
    const bad = { name: 'g', timeoutMs: 100, call: async () => { const e = new Error('nope'); e.status = 401; throw e; } };
    await assert.rejects(callWithFallback({ prompt: 'x' }, [bad, ok('q')]), (e) => e.status === 401);
  });

  console.log(`\n${n}/9 passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });

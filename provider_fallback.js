/**
 * provider_fallback.js
 *
 * RECONSTRUCTED FILE — the original was lost before this repo had a copy.
 * This was rebuilt from scratch to match, exactly, how mission_chain.js
 * calls it:
 *
 *   const { callWithFallback, toProviderCallRow } = require('./provider_fallback');
 *
 *   const result = await callWithFallback({ prompt, validate, meta }, providers);
 *   // result.response        -> parsed JSON from whichever provider succeeded
 *   // result.schemaValid      -> 1 | 0
 *   // result.fallbackTriggered -> boolean
 *   // result.providerUsed     -> 'gemini' | 'groq' | ...
 *
 *   const row = toProviderCallRow(result, { missionId, callSeq, specialist });
 *   // row.{mission_id, call_seq, specialist, provider_attempted, provider_used,
 *   //      fallback_triggered, attempted_status_code, injected_failure,
 *   //      schema_valid, raw_output, created_at}
 *
 * providers: array of { name, model, call(prompt) } in priority order
 * (built by mission_chain.js's buildProviders — Gemini first, Groq second).
 *
 * Behavior (matches the notes on Test 16 / Test 16 v2): try providers in
 * priority order, fall back on 429 by default (configurable via policy),
 * fallback is per-call (never sticky — each call starts again at provider[0]
 * since `providers` is rebuilt fresh per call), and if a response comes back
 * that fails the caller's `validate()` schema check, that also counts as a
 * reason to try the next provider rather than silently accepting bad JSON.
 *
 * NOTE: because this is a reconstruction, not your original tested code, run
 * a mock/dry sanity check after deploying (e.g. force a 429 and confirm it
 * falls to Groq, not sticky on the next call) before trusting it the way you
 * trusted the original Test 16 v2 result.
 */

'use strict';

/* Statuses that mean "this provider is temporarily unable", so trying the next provider is safe
 * (the calls are read-only generation, validated and Critic-checked downstream either way).
 * 429 rate limited, 500 internal error, 503 overloaded/unavailable, 504 gateway/deadline timeout.
 * Deliberately NOT included: 400/401/403/404 (our bug or bad key; Groq would not fix it and
 * falling back would hide it). Override per call with policy.fallbackOnStatus. */
const DEFAULT_FALLBACK_STATUS = Object.freeze([429, 500, 503, 504]);

/* A per-provider timeout (provider.timeoutMs) is reported as status 598 with code 'provider_timeout'.
 * 598 is a synthetic, non-HTTP marker so provider_calls.attempted_status_code tells a timeout apart
 * from a real 504 without a schema change. It is deliberately NOT in DEFAULT_FALLBACK_STATUS:
 * timeouts are matched by err.code below, so the status list (and its tests) stay as they were. */
const TIMEOUT_STATUS = 598;
/* Transport-level failures (no HTTP status from the provider) are tagged at the source in mission_chain.js
 * (err.code) and get their own synthetic markers, so provider_calls.attempted_status_code stays informative:
 *   597 provider_network_error  fetch itself failed (DNS, reset, TLS) or the body stream broke
 *   596 provider_bad_json       200 OK but the HTTP body, or the model's JSON text, would not parse
 * Untagged errors (programmer bugs, unknown throws) never fall back. */
const NETWORK_ERROR_STATUS = 597;
const BAD_JSON_STATUS = 596;
const DEFAULT_FALLBACK_ERROR_CODES = Object.freeze(['provider_timeout', 'provider_network_error', 'provider_bad_json']);

function defaultShouldFallback(err, policy) {
  if (err && DEFAULT_FALLBACK_ERROR_CODES.includes(err.code)) {
    if (err.code === 'provider_timeout' && policy && policy.fallbackOnTimeout === false) return false;
    return true;
  }
  const codes = (policy && policy.fallbackOnStatus) || DEFAULT_FALLBACK_STATUS;
  return codes.includes(err && err.status);
}

/**
 * Calls provider.call(prompt, { signal }). If provider.timeoutMs > 0, the attempt is abandoned after
 * that long: the signal is aborted (so a real fetch is cancelled) AND the call is raced, so a stub or
 * provider that ignores the signal still cannot hang the chain. No timeoutMs = old behaviour.
 */
function callWithTimeout(provider, prompt) {
  const ms = Number(provider.timeoutMs);
  if (!(ms > 0)) return provider.call(prompt, {});
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`provider "${provider.name}" timed out after ${ms}ms`);
      err.status = TIMEOUT_STATUS;
      err.code = 'provider_timeout';
      reject(err);   // reject first so the race settles with the timeout, not the abort error
      ac.abort();
    }, ms);
  });
  const call = Promise.resolve().then(() => provider.call(prompt, { signal: ac.signal }));
  call.catch(() => {});   // a late rejection from the abandoned call must not become an unhandledRejection
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {{prompt: any, validate?: (resp:any)=>boolean, meta?: object}} task
 * @param {{name:string, model?:string, call:(prompt:any)=>Promise<any>}[]} providers
 * @param {{fallbackOnStatus?: number[], fallbackOnTimeout?: boolean, injectFailureFor?: (provider, meta)=>boolean, injectStatus?: number}} [policy]
 */
async function callWithFallback(task, providers, policy) {
  const { prompt, validate, meta } = task || {};
  policy = policy || {};
  const shouldFallback = policy.shouldFallback || defaultShouldFallback;

  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('callWithFallback: no providers configured');
  }

  const attempted = [];
  let lastStatus = null;
  let injectedFailure = false;
  let lastSchemaInvalidResponse = null;
  // Every failed attempt, kept so a fallback (or a final failure) never hides why the earlier provider failed.
  const failures = [];

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const isLast = i === providers.length - 1;
    attempted.push(provider.name);

    try {
      // Optional injectable synthetic failure, for exercising fallback on
      // demand (mirrors the --inject-429=<call_seq> style test hook).
      if (typeof policy.injectFailureFor === 'function' && policy.injectFailureFor(provider, meta)) {
        injectedFailure = true;
        const err = new Error(`injected failure for provider "${provider.name}" (test mode)`);
        err.status = policy.injectStatus || 429;
        throw err;
      }

      const response = await callWithTimeout(provider, prompt);
      const valid = typeof validate === 'function' ? !!validate(response) : true;

      if (!valid) {
        lastSchemaInvalidResponse = response;
        failures.push({ provider: provider.name, status: null, code: 'schema_invalid', message: 'response failed validate()' });
        if (!isLast) {
          // Treat a schema-invalid response as a reason to try the next
          // provider, same as a thrown error would be.
          continue;
        }
        // No more providers left — return what we have, flagged invalid,
        // rather than throwing, so the caller can decide (matches
        // mission_chain.js reading result.schemaValid rather than a throw).
        return {
          response,
          providerUsed: provider.name,
          providerAttempted: attempted.slice(),
          fallbackTriggered: attempted.length > 1,
          attemptedStatusCode: lastStatus,
          injectedFailure,
          schemaValid: 0,
          rawOutput: safeStringify(response),
          fallbackReasons: failures.slice(),
        };
      }

      return {
        response,
        providerUsed: provider.name,
        providerAttempted: attempted.slice(),
        fallbackTriggered: attempted.length > 1,
        attemptedStatusCode: lastStatus,
        injectedFailure,
        schemaValid: 1,
        rawOutput: safeStringify(response),
        fallbackReasons: failures.slice(),
      };
    } catch (err) {
      lastStatus = (err && err.status) || lastStatus;
      failures.push({ provider: provider.name, status: (err && err.status) || null, code: (err && err.code) || null, message: String((err && err.message) || err) });
      const canFallback = !isLast && shouldFallback(err, policy);
      if (!canFallback) {
        // Nothing left to try (or policy says don't fall back for this
        // error) — surface the real error rather than fabricating success. Same error object and message as
        // before; err.attempts lists every provider's failure (including earlier ones) for observability.
        if (err && typeof err === 'object') { try { err.attempts = failures.slice(); } catch (e) { /* frozen error: leave it */ } }
        throw err;
      }
      // else: loop continues to the next provider
    }
  }

  // Should be unreachable (the loop above always returns or throws on the
  // last provider), but guard anyway.
  throw new Error('callWithFallback: all providers exhausted with no result');
}

/**
 * Maps a callWithFallback() result onto the provider_calls row shape used by
 * mission_chain.js's INSERT statement.
 */
function toProviderCallRow(result, { missionId, callSeq, specialist }) {
  return {
    mission_id: missionId,
    call_seq: callSeq,
    specialist,
    provider_attempted: (result.providerAttempted || []).join(','),
    provider_used: result.providerUsed,
    fallback_triggered: result.fallbackTriggered ? 1 : 0,
    attempted_status_code: result.attemptedStatusCode == null ? null : result.attemptedStatusCode,
    injected_failure: result.injectedFailure ? 1 : 0,
    schema_valid: result.schemaValid,
    raw_output: result.rawOutput,
    created_at: new Date().toISOString(),
  };
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch (e) { return String(value); }
}

module.exports = { callWithFallback, toProviderCallRow, DEFAULT_FALLBACK_STATUS, DEFAULT_FALLBACK_ERROR_CODES, TIMEOUT_STATUS, NETWORK_ERROR_STATUS, BAD_JSON_STATUS };

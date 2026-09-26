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

function defaultShouldFallback(err, policy) {
  const codes = (policy && policy.fallbackOnStatus) || [429];
  return codes.includes(err && err.status);
}

/**
 * @param {{prompt: any, validate?: (resp:any)=>boolean, meta?: object}} task
 * @param {{name:string, model?:string, call:(prompt:any)=>Promise<any>}[]} providers
 * @param {{fallbackOnStatus?: number[], injectFailureFor?: (provider, meta)=>boolean, injectStatus?: number}} [policy]
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

      const response = await provider.call(prompt);
      const valid = typeof validate === 'function' ? !!validate(response) : true;

      if (!valid) {
        lastSchemaInvalidResponse = response;
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
      };
    } catch (err) {
      lastStatus = (err && err.status) || lastStatus;
      const canFallback = !isLast && shouldFallback(err, policy);
      if (!canFallback) {
        // Nothing left to try (or policy says don't fall back for this
        // error) — surface the real error rather than fabricating success.
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

module.exports = { callWithFallback, toProviderCallRow };

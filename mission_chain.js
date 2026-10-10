/**
 * mission_chain.js
 *
 * The real (non-mock) Researcher -> Analyst -> Creator -> Critic -> approval
 * chain, extracted so cos_backend.js can run it per-request against a
 * phone-submitted mission (Test 19), instead of only reading rows a CLI
 * script already wrote.
 *
 * This deliberately mirrors test17_final_acceptance.js's live path
 * (callGeminiLive / callGroqLive / callWithFallback / the risk-classifier and
 * approval-gate logic) rather than reinventing it — same schema, same
 * fetch-then-generate grounding design, same "software risk tier is
 * authoritative" rule, same execute() that refuses without a genuine
 * APPROVED row. Nothing about the approval boundary changes for Test 19.
 *
 * Test 19's nonce requirement is handled two ways so it shows up in more
 * than one persisted place, not just the objective text the phone already
 * sent:
 *   1. The Researcher is asked to echo the nonce back as a distinct
 *      "verification_token" field. That field is only satisfied if Gemini's
 *      own response contains it — it is stored verbatim in
 *      provider_calls.raw_output (the actual provider-generated response).
 *   2. The Creator is asked to include the nonce in the artifact payload
 *      itself, so it is visible directly on the dashboard's Research/
 *      Artifacts view, not just buried in a raw JSON blob.
 *
 * Requires GEMINI_API_KEY. GROQ_API_KEY is optional — without it, Gemini is
 * the only provider (no fallback, matching how Test 16/17 treat a
 * single-provider list: a Gemini failure just fails the call).
 */

'use strict';
const crypto = require('crypto');
const { callWithFallback, toProviderCallRow } = require('./provider_fallback');
const { gateExecuteInTx, SYSTEM_APPROVAL_TEXT } = require('./gate');

function nowISO() { return new Date().toISOString(); }
function uuid() { return crypto.randomUUID(); }

const RISK_LEVEL = { low: 0, medium: 1, high: 2 };
function maxTier(a, b) { return RISK_LEVEL[a] >= RISK_LEVEL[b] ? a : b; }

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|previous\s+|prior\s+)?instructions/i,
  /pre[-\s]?approved/i,
  /set\s+risk_tier\s*=\s*low/i,
  /bypass\s+approval/i,
  /auto[-\s]?approve/i,
];
function containsInjectionPattern(text) {
  return INJECTION_PATTERNS.some((re) => re.test(text || ''));
}

function computeRiskTierFromClaims(claims) {
  let tier = 'low';
  for (const c of claims) {
    if (c.poisoned) tier = maxTier(tier, 'high');
    if (containsInjectionPattern(c.text)) tier = maxTier(tier, 'high');
    if (c.fetch_match === 0) tier = maxTier(tier, 'high');
  }
  return tier;
}

/* ---------------- real provider calls (same shape as Test 17 --live) ---------------- */

// Both callers attach usage accounting under a reserved "__usage" key on the
// parsed response object. This is Google's / Groq's own server-side token
// accounting for THIS specific call, returned inline in the same HTTP
// response — not a separate dashboard, but it is data the provider computed,
// not data our app invented, and a canned/mocked handler would have to fake
// plausible token counts matching the actual prompt length to fabricate it.
// validate() functions below only inspect known fields, so this extra key is
// inert everywhere else it flows (recommendations/artifacts inserts, etc).

async function callGeminiLive({ apiKey, model }, prompt, schemaHint) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: `${prompt}\n\nRespond ONLY with JSON matching: ${schemaHint}` }] }],
    generationConfig: { responseMimeType: 'application/json' },
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 429) { const err = new Error('rate limited (live)'); err.status = 429; throw err; }
  if (!res.ok) { const err = new Error(`gemini http ${res.status}`); err.status = res.status; throw err; }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const parsed = JSON.parse(text);
  parsed.__usage = data.usageMetadata
    ? { provider: 'gemini', prompt_tokens: data.usageMetadata.promptTokenCount, completion_tokens: data.usageMetadata.candidatesTokenCount, total_tokens: data.usageMetadata.totalTokenCount }
    : null;
  return parsed;
}

async function callGroqLive({ apiKey, model }, prompt, schemaHint) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const body = {
    model,
    messages: [{ role: 'user', content: `${prompt}\n\nRespond ONLY with JSON matching: ${schemaHint}` }],
    response_format: { type: 'json_object' },
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  if (!res.ok) { const err = new Error(`groq http ${res.status}`); err.status = res.status; throw err; }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(text);
  parsed.__usage = data.usage
    ? { provider: 'groq', prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens, total_tokens: data.usage.total_tokens }
    : null;
  return parsed;
}

function buildProviders(keys, models, schemaHint) {
  const list = [];
  if (keys.gemini) list.push({ name: 'gemini', model: models.gemini, call: (p) => callGeminiLive({ apiKey: keys.gemini, model: models.gemini }, p, schemaHint) });
  if (keys.groq) list.push({ name: 'groq', model: models.groq, call: (p) => callGroqLive({ apiKey: keys.groq, model: models.groq }, p, schemaHint) });
  if (!list.length) throw new Error('No provider API keys configured (need at least GEMINI_API_KEY)');
  return list;
}

const SCHEMA_HINTS = {
  researcher: '{"claims":[{"text":string,"source_url":string,"evidence_snippet":string,"confidence":number}],"verification_token":string}',
  analyst: '{"summary":string,"llm_self_tier":"low"|"medium"|"high"}',
  creator: '{"type":string,"payload":string}',
};

function validateResearcher(nonce) {
  return (resp) => resp && Array.isArray(resp.claims) && resp.claims.length > 0 &&
    resp.claims.every((c) => typeof c.text === 'string' && c.text.length > 0 &&
      typeof c.source_url === 'string' && typeof c.evidence_snippet === 'string' &&
      typeof c.confidence === 'number') &&
    resp.verification_token === nonce &&
    // Also require the nonce inside claims[0].text itself (not just the
    // separate verification_token field), since claims.text is what the
    // dashboard's Research view actually displays — this is what makes the
    // nonce visible in "the resulting record" on a fresh dashboard read,
    // not just buried in a raw_output blob.
    resp.claims[0].text.includes(nonce);
}
function validateAnalyst(resp) {
  return resp && typeof resp.summary === 'string' && resp.summary.length > 0 &&
    ['low', 'medium', 'high'].includes(resp.llm_self_tier);
}
function validateCreator(nonce) {
  return (resp) => resp && typeof resp.type === 'string' &&
    typeof resp.payload === 'string' && resp.payload.length > 0 &&
    resp.payload.includes(nonce);
}

/* ---------------- DB writes (identical shapes to test17_final_acceptance.js) ---------------- */

async function runProviderCall(db, { missionId, callSeq, specialist, prompt, validate, providers }) {
  const result = await callWithFallback({ prompt, validate, meta: { missionId, callSeq, specialist } }, providers);
  const row = toProviderCallRow(result, { missionId, callSeq, specialist });
  const ins = db.prepare(`
    INSERT INTO provider_calls
      (mission_id, call_seq, specialist, provider_attempted, provider_used, fallback_triggered, attempted_status_code, injected_failure, schema_valid, raw_output, created_at)
    VALUES (@mission_id, @call_seq, @specialist, @provider_attempted, @provider_used, @fallback_triggered, @attempted_status_code, @injected_failure, @schema_valid, @raw_output, @created_at)
  `).run(row);
  return { providerCallId: Number(ins.lastInsertRowid), result };
}

function recordDecision(db, missionId, status, rationale) {
  db.prepare(`INSERT INTO decisions (mission_id, status, rationale, created_at) VALUES (?, ?, ?, ?)`)
    .run(missionId, status, rationale, nowISO());
}

/**
 * Real, server-side fetch (no CORS, matches Test 17's fix). Grounds the
 * Researcher call in genuinely fetched content instead of trusting Gemini to
 * name a source_url after the fact.
 */
async function fetchGrounding(seedUrl) {
  try {
    const res = await fetch(seedUrl);
    const content = await res.text();
    return { statusCode: res.status, bytes: content.length, error: res.ok ? null : `http ${res.status}`, content };
  } catch (e) {
    return { statusCode: 0, bytes: 0, error: e.message, content: '' };
  }
}

/* Code-enforced grounding. A claim counts as grounded ONLY if all hold:
 *  1. the fetch succeeded (2xx, no error) and returned bytes: an HTTP error page is not evidence
 *  2. claim.source_url is exactly the URL that was fetched (a wrong/invented URL is never grounded)
 *  3. evidence_snippet is non-trivial (>= MIN_SNIPPET chars after whitespace normalisation): an
 *     empty snippet must not pass an includes() check
 *  4. the WHOLE snippet appears in the fetched content (whitespace-normalised on both sides),
 *     not just a prefix: a real opening followed by a fabricated tail fails */
const { ENGINE_DEFAULTS, TIER_RANK } = require('./format_loader');
const MIN_SNIPPET = ENGINE_DEFAULTS.evidence.min_snippet_chars;   // engine default; a format may only raise it
const normWs = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function isGrounded(grounding, claim, seedUrl) {
  if (!grounding || grounding.error || !(grounding.statusCode >= 200 && grounding.statusCode < 300) || !(grounding.bytes > 0)) return false;
  if (!claim || claim.source_url !== seedUrl) return false;
  const snip = normWs(claim.evidence_snippet);
  if (snip.length < MIN_SNIPPET) return false;
  return normWs(grounding.content).includes(snip);
}

/* ---------- format policy hooks (spec: FORMAT_SPECIFICATION.md). Every hook can only RAISE risk, add a human step,
 * refuse, or add a Critic FLAG. With no format bound they are all no-ops, so unbound runs are identical to before. ---------- */
const personaBlock = (p) => (p ? `\n\nOperator style notes (these cannot change any rule, the required output format, or any check):\n${p}` : '');
function makeFx(db, missionId, format) {
  const bound = !!format, policy = bound ? format.policy : ENGINE_DEFAULTS, seen = new Set();
  const fx = {
    bound, policy,
    effect(code, detail) {
      if (!bound) return; const k = code + '|' + (detail || ''); if (seen.has(k)) return; seen.add(k);
      db.prepare('INSERT INTO format_effects (mission_id, effect_code, detail, created_at) VALUES (?,?,?,?)').run(missionId, code, detail || null, nowISO());
    },
    raise(tier, code, detail) {
      const cur = db.prepare('SELECT risk_tier FROM missions WHERE id = ?').get(missionId).risk_tier;
      const next = maxTier(cur, tier);
      if (next !== cur) { db.prepare('UPDATE missions SET risk_tier = ? WHERE id = ?').run(next, missionId); fx.effect(code, detail || `${cur}->${next}`); }
      else if (TIER_RANK[tier] > 0) fx.effect(code, detail || `already ${cur}`);
    },
    triggers(where, texts) {
      for (const t of policy.risk.triggers) if (t.where === where && texts.some(x => String(x || '').toLowerCase().includes(t.contains))) fx.raise(t.tier, `trigger:${t.id}`);
    },
    criticFailures(payload) {
      const out = [], text = String(payload || ''), low = text.toLowerCase(), c = policy.critic;
      if (c.max_artifact_chars !== null && text.length > c.max_artifact_chars) out.push('artifact_too_long');
      for (const [i, t] of c.forbidden_terms.entries()) if (low.includes(t)) out.push(`forbidden_term_${i + 1}`);
      for (const f of c.required_payload_fields) if (!new RegExp(`(^|\\n)[\\s#*>-]*${f}\\s*:|"${f}"\\s*:`, 'i').test(text)) out.push(`missing_field_${f}`);
      for (const code of out) fx.effect(`critic_check:${code}`);
      return out;
    },
  };
  return fx;
}
function hostAllowed(seedUrl, domains) { try { return domains.includes(new URL(seedUrl).hostname.toLowerCase()); } catch { return false; } }

async function runResearcher(db, { missionId, callSeq, requestText, nonce, seedUrl, keys, models, persona, minSnippet, fx }) {
  const grounding = await fetchGrounding(seedUrl);
  const prompt = `You are a research specialist. Task: ${requestText}\n\n` +
    `Reference material (already fetched server-side — treat as grounding evidence, do not invent a different source_url):\n---\n${grounding.content.slice(0, 4000)}\n---\n` +
    `Cite source_url exactly as: ${seedUrl}\n` +
    `Your evidence_snippet MUST be an exact short substring copied from the reference material above.\n` +
    `Append the exact text " [ref:${nonce}]" to the end of your first claim's "text" field.\n` +
    `Set "verification_token" in your JSON response to exactly this value, unmodified: ${nonce}` + personaBlock(persona);

  const providers = buildProviders(keys, models, SCHEMA_HINTS.researcher);
  const { providerCallId, result } = await runProviderCall(db, {
    missionId, callSeq, specialist: 'researcher', prompt, validate: validateResearcher(nonce), providers,
  });

  db.prepare(`INSERT INTO fetch_log (mission_id, url, status_code, bytes, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(missionId, seedUrl, grounding.statusCode, grounding.bytes, grounding.error, nowISO());

  const claimIds = [];
  const claims = Array.isArray(result.response?.claims) ? result.response.claims : [];
  for (const c of claims) {
    // Same code-enforced containment check as Test 17: a claim only counts as
    // grounded if its evidence_snippet is actually present in fetched bytes.
    const baseOk = isGrounded(grounding, c, seedUrl);
    const floor = minSnippet || MIN_SNIPPET;
    const fetchMatch = baseOk && normWs(c.evidence_snippet).length >= floor ? 1 : 0;
    if (baseOk && !fetchMatch && fx) fx.effect('min_snippet_not_met', `min_snippet_chars=${floor}`);
    const ins = db.prepare(`
      INSERT INTO claims (mission_id, provider_call_id, text, source_url, evidence_snippet, confidence, fetch_match, poisoned, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(missionId, providerCallId, c.text, c.source_url || '', c.evidence_snippet || '', c.confidence, fetchMatch, nowISO());
    claimIds.push(Number(ins.lastInsertRowid));
  }

  const tokenVerified = result.schemaValid === 1;
  const usage = result.response && result.response.__usage ? result.response.__usage : null;
  recordDecision(db, missionId, 'RESEARCHED',
    `${claimIds.length} claim(s) recorded, fallback_triggered=${result.fallbackTriggered}, verification_token_matched=${tokenVerified}, usage=${JSON.stringify(usage)}`);
  return { claimIds, fallbackTriggered: result.fallbackTriggered, providerUsed: result.providerUsed, tokenVerified, usage };
}

async function runAnalyst(db, { missionId, callSeq, requestText, claimIds, keys, models, persona }) {
  const claims = claimIds.map((id) => db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id));
  let riskTier = computeRiskTierFromClaims(claims);

  const prompt = `You are an analyst. Summarize these grounded research claims for the task: ${requestText}\n\n` +
    `Claims:\n${claims.map((c) => `- ${c.text}`).join('\n')}` + personaBlock(persona);
  const providers = buildProviders(keys, models, SCHEMA_HINTS.analyst);
  const { providerCallId, result } = await runProviderCall(db, {
    missionId, callSeq, specialist: 'analyst', prompt, validate: validateAnalyst, providers,
  });

  if (containsInjectionPattern(result.response?.summary)) riskTier = maxTier(riskTier, 'high');

  const ins = db.prepare(`
    INSERT INTO recommendations (mission_id, provider_call_id, claim_ids, summary, llm_self_tier, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(missionId, providerCallId, JSON.stringify(claimIds), result.response.summary, result.response.llm_self_tier, nowISO());
const cur = db.prepare(`SELECT risk_tier FROM missions WHERE id = ?`).get(missionId).risk_tier;
riskTier = maxTier(cur, riskTier);
  db.prepare(`UPDATE missions SET risk_tier = ? WHERE id = ?`).run(riskTier, missionId);
  const usage = result.response && result.response.__usage ? result.response.__usage : null;
  recordDecision(db, missionId, 'ANALYZED',
    `risk_tier=${riskTier} llm_self_tier=${result.response.llm_self_tier} fallback_triggered=${result.fallbackTriggered} usage=${JSON.stringify(usage)}`);
  return { recommendationId: Number(ins.lastInsertRowid), riskTier, fallbackTriggered: result.fallbackTriggered, usage };
}

async function runCreator(db, { missionId, callSeq, requestText, nonce, recommendationId, keys, models, persona }) {
  const prompt = `You are a creator. Draft a short artifact for the task: ${requestText}\n\n` +
    `The artifact's "payload" text MUST include this exact token verbatim, so it can be verified: ${nonce}` + personaBlock(persona);
  const providers = buildProviders(keys, models, SCHEMA_HINTS.creator);
  const { providerCallId, result } = await runProviderCall(db, {
    missionId, callSeq, specialist: 'creator', prompt, validate: validateCreator(nonce), providers,
  });

  const existingCount = db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE recommendation_id = ? AND type = ?`)
    .get(recommendationId, result.response.type).n;
  const version = existingCount + 1;
  const ins = db.prepare(`
    INSERT INTO artifacts (mission_id, recommendation_id, provider_call_id, type, payload, version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(missionId, recommendationId, providerCallId, result.response.type, result.response.payload, version, nowISO());

  const nonceInPayload = typeof result.response.payload === 'string' && result.response.payload.includes(nonce);
  const usage = result.response && result.response.__usage ? result.response.__usage : null;
  recordDecision(db, missionId, 'ARTIFACT_DRAFTED',
    `type=${result.response.type} version=${version} fallback_triggered=${result.fallbackTriggered} nonce_in_payload=${nonceInPayload} usage=${JSON.stringify(usage)}`);
  return { artifactId: Number(ins.lastInsertRowid), fallbackTriggered: result.fallbackTriggered, nonceInPayload, usage };
}

// Deterministic — not an LLM call, same as Test 17's scenario-defined Critic.
function runCritic(db, { missionId, artifactId, claims, grounded, nonceInPayload, extraFailures }) {
  const extra = extraFailures || [];
  const injected = claims.some((c) => containsInjectionPattern(c.text));
  const allGrounded = grounded && claims.every((c) => c.fetch_match === 1);
  const verdict = (!injected && allGrounded && nonceInPayload && !extra.length) ? 'PASS' : 'FLAG';
  const rationale = verdict === 'PASS'
    ? 'All claims grounded, no injection patterns detected, nonce verified in artifact.'
    : `Held for review: injected=${injected} all_grounded=${allGrounded} nonce_in_payload=${nonceInPayload}` + (extra.length ? ` format_checks_failed=${extra.join(',')}` : '');

  db.prepare(`INSERT INTO critic_reviews (mission_id, target_type, target_id, verdict, rationale, created_at) VALUES (?, 'artifact', ?, ?, ?, ?)`)
    .run(missionId, artifactId, verdict, rationale, nowISO());

  if (verdict !== 'PASS') {
    const current = db.prepare(`SELECT risk_tier FROM missions WHERE id = ?`).get(missionId).risk_tier;
    db.prepare(`UPDATE missions SET risk_tier = ? WHERE id = ?`).run(maxTier(current, 'high'), missionId);
  }
  recordDecision(db, missionId, 'ARTIFACT_VERIFIED', `critic_verdict=${verdict}`);
  return verdict;
}

// The approval boundary — same function shape as cos_backend.js's gateExecute.
// Only place EXECUTED is written; re-reads APPROVED from the DB.

/**
 * Runs one full live mission through the real chain. Throws on any hard
 * failure (missing keys, schema validation failure after fallback exhausted,
 * etc.) rather than silently degrading — a caller that wants a "demo" result
 * must not be able to get one from this function.
 *
 * @returns full result object including every id, so the caller (backend
 *          route) can reply with something the phone can immediately check
 *          against a GET /api/snapshot read, without re-deriving anything.
 */
async function runLiveMission(db, { requestText, nonce, seedUrl, keys, models, format }) {
  if (!keys || !keys.gemini) throw new Error('GEMINI_API_KEY is not configured on the server — cannot run a live mission');
  const missionId = uuid();
  const fx = makeFx(db, missionId, format);
  if (format) db.prepare(`INSERT INTO missions (id, request_text, status, risk_tier, created_at, format_id, format_version, manifest_hash) VALUES (?, ?, 'PROPOSED', 'low', ?, ?, ?, ?)`)
    .run(missionId, requestText, nowISO(), format.id, format.version, format.hash);
  else db.prepare(`INSERT INTO missions (id, request_text, status, risk_tier, created_at) VALUES (?, ?, 'PROPOSED', 'low', ?)`)
    .run(missionId, requestText, nowISO());
  recordDecision(db, missionId, 'PROPOSED', requestText);
try {
  if (format) {   // restrict-only policy that applies before any model call
    fx.effect('format_bound', `${format.id}@${format.version}`);
    fx.raise(fx.policy.risk.floor, 'floor_applied');
    if (format.missionType) fx.raise(format.missionType.floor, `mission_type:${format.missionType.id}`);
    fx.triggers('objective', [requestText]);
    if (fx.policy.evidence.source_domains.length && !hostAllowed(seedUrl, fx.policy.evidence.source_domains)) {
      fx.effect('domain_refused');
      throw new Error('seed source host is not allowed by this format (source_domains); refused before any model call');
    }
  }
  const persona = fx.policy.persona;
  const research = await runResearcher(db, { missionId, callSeq: 1, requestText, nonce, seedUrl, keys, models, persona: persona.researcher, minSnippet: fx.policy.evidence.min_snippet_chars, fx });
  const claims = research.claimIds.map((id) => db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id));
  if (format) {
    if (claims.length < fx.policy.evidence.min_claims) fx.raise('high', 'min_claims_not_met', `${claims.length}<${fx.policy.evidence.min_claims}`);
    fx.triggers('claim', claims.map((c) => c.text));
  }
  const analysis = await runAnalyst(db, { missionId, callSeq: 2, requestText, claimIds: research.claimIds, keys, models, persona: persona.analyst });
  if (format) fx.triggers('summary', [db.prepare('SELECT summary FROM recommendations WHERE id = ?').get(analysis.recommendationId).summary]);
  const creation = await runCreator(db, { missionId, callSeq: 3, requestText, nonce, recommendationId: analysis.recommendationId, keys, models, persona: persona.creator });
  let extraFailures = [];
  if (format) {
    const payload = db.prepare('SELECT payload FROM artifacts WHERE id = ?').get(creation.artifactId).payload;
    fx.triggers('artifact', [payload]);
    extraFailures = fx.criticFailures(payload);
  }
  const criticVerdict = runCritic(db, {
    extraFailures,
    missionId, artifactId: creation.artifactId, claims,
    grounded: claims.length > 0, nonceInPayload: creation.nonceInPayload,
  });

  const riskTier = db.prepare(`SELECT risk_tier FROM missions WHERE id = ?`).get(missionId).risk_tier;
  const forceHuman = fx.policy.approval.human_required_for_all;
  if (forceHuman) fx.effect('human_required_for_all');
  const autoEligible = riskTier === 'low' && criticVerdict === 'PASS' && !forceHuman;

  let outcome;
  if (autoEligible) {
    // Approval + execution in ONE transaction through the canonical gate. If the gate refuses,
    // nothing is written and the mission fails closed to a human.
    let gateErr = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      recordDecision(db, missionId, 'APPROVED', SYSTEM_APPROVAL_TEXT);
      gateExecuteInTx(db, missionId, nowISO());
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} gateErr = e; }
    if (gateErr) {
      recordDecision(db, missionId, 'AWAITING_APPROVAL', `gate refused system approval: ${String(gateErr.message).slice(0, 300)}`);
      outcome = 'AWAITING_APPROVAL';
    } else outcome = 'AUTO_COMPLETED';
  } else {
    recordDecision(db, missionId, 'AWAITING_APPROVAL', `risk_tier=${riskTier} critic_verdict=${criticVerdict}` + (forceHuman ? ' format_requires_human_approval' : ''));
    outcome = 'AWAITING_APPROVAL';
  }

  return {
    missionId,
    riskTier,
    criticVerdict,
    outcome,
    format: format ? { id: format.id, version: format.version, hash: format.hash } : null,
    providerUsed: creation.fallbackTriggered ? 'groq' : research.providerUsed,
    researcherProviderUsed: research.providerUsed,
    fallbackTriggered: research.fallbackTriggered || analysis.fallbackTriggered || creation.fallbackTriggered,
    nonceVerifiedInProviderResponse: research.tokenVerified,
    nonceVerifiedInArtifact: creation.nonceInPayload,
    claimCount: claims.length,
    // Server-side token accounting returned inline by each provider for this
    // specific call (see callGeminiLive/callGroqLive) — supporting evidence
    // for "independent" confirmation, though it still arrives via our own
    // backend rather than Google's separate usage dashboard.
    tokenUsage: { researcher: research.usage, analyst: analysis.usage, creator: creation.usage },
  };
  } catch (e) { e.missionId = missionId; throw e; }
}

module.exports = { runLiveMission, runAnalyst, runResearcher, isGrounded, computeRiskTierFromClaims, containsInjectionPattern };
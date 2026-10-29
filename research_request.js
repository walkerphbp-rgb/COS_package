'use strict';
/* research_request.js (Step 3). Validates the structured research request and the user-supplied source list.
 * Three distinct outcomes, never conflated:
 *   { kind:'absent' }   body.research is undefined  -> legacy seed-document route (labelled demo/legacy by the caller)
 *   { kind:'invalid' }  anything present but malformed (including null, [], empty sources) -> caller answers 400, never falls back to the seed
 *   { kind:'ok' }       normalised request with deterministic source_ids */
const crypto = require('node:crypto');
const net = require('node:net');
const { validateUrl, HOST_RE } = require('./safe_fetch');

const LIMITS = { question: [10, 1000], scope: [0, 500], constraints: [0, 500], desired_output: [0, 200], maxSources: 5, label: 80 };
const KEYS = new Set(['question', 'scope', 'constraints', 'desired_output', 'sources']);
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

function parseResearch(body, policy) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'invalid', errors: [{ field: 'body', code: 'BODY_INVALID' }] };
  if (body.research === undefined) return { kind: 'absent' };
  const r = body.research, errors = [], err = (field, code, detail) => errors.push({ field, code, ...(detail ? { detail } : {}) });
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return { kind: 'invalid', errors: [{ field: 'research', code: 'RESEARCH_NOT_OBJECT' }] };
  for (const k of Object.keys(r)) if (!KEYS.has(k)) err(`research.${k}`, 'UNKNOWN_FIELD');
  const text = (k) => {
    if (r[k] === undefined) { if (k === 'question') err('research.question', 'REQUIRED'); return ''; }
    if (typeof r[k] !== 'string') { err(`research.${k}`, 'NOT_STRING'); return ''; }
    const v = clean(r[k]), [lo, hi] = LIMITS[k];
    if (v.length < lo || v.length > hi) err(`research.${k}`, 'LENGTH', `${lo}-${hi} characters`);
    return v;
  };
  const question = text('question'), scope = text('scope'), constraints = text('constraints'), desired_output = text('desired_output');
  const sources = [], duplicates = [], seen = new Map();
  if (!Array.isArray(r.sources) || !r.sources.length) err('research.sources', 'SOURCES_REQUIRED', '1-' + LIMITS.maxSources + ' source URLs');
  else if (r.sources.length > LIMITS.maxSources) err('research.sources', 'TOO_MANY_SOURCES', `max ${LIMITS.maxSources}`);
  else r.sources.forEach((s, i) => {
    const f = `research.sources[${i}]`;
    let url, label = null;
    if (typeof s === 'string') url = s;
    else if (s && typeof s === 'object' && !Array.isArray(s) && typeof s.url === 'string' && Object.keys(s).every((k) => k === 'url' || k === 'label')) { url = s.url; if (s.label !== undefined) { if (typeof s.label !== 'string' || clean(s.label).length > LIMITS.label) { err(f + '.label', 'LABEL_INVALID'); return; } label = clean(s.label) || null; } }
    else { err(f, 'SOURCE_SHAPE'); return; }
    const v = validateUrl(url, policy);
    if (!v.ok) { err(f, v.code); return; }
    if (seen.has(v.canonical)) { duplicates.push({ index: i, duplicate_of: seen.get(v.canonical) }); return; }   // first occurrence wins
    const source_id = `S${sources.length + 1}`; seen.set(v.canonical, source_id);
    sources.push({ source_id, url: v.canonical, host: v.host, label, input_index: i });
  });
  if (errors.length) return { kind: 'invalid', errors };
  return { kind: 'ok', research: { question, scope, constraints, desired_output, sources }, duplicates };
}

/* COS_RESEARCH_HOSTS: comma-separated EXACT hostnames. Unset or empty = research from user sources is DISABLED.
 * Anything that is not a plain DNS hostname (IP literal, URL, wildcard, port, path) throws, so the server refuses to boot. */
function researchHostsFromEnv(env) {
  const raw = String((env && env.COS_RESEARCH_HOSTS) || '').trim();
  if (!raw) return [];
  const out = [];
  for (const part of raw.split(',')) {
    const h = part.trim().toLowerCase();
    if (!h) continue;
    if (net.isIP(h) || /^[0-9.]+$/.test(h) || h.endsWith('.') || !HOST_RE.test(h)) throw new Error(`COS_RESEARCH_HOSTS entry "${part.trim().slice(0, 80)}" is not an exact DNS hostname (no IPs, URLs, wildcards, ports or paths)`);
    if (!out.includes(h)) out.push(h);
  }
  if (out.length > 50) throw new Error('COS_RESEARCH_HOSTS lists more than 50 hosts');
  return out;
}

/* Read model for GET /api/missions/:id/research. READ-ONLY. Every text field below is untrusted data (fetched content or model output).
 * "checks" are recomputed here from what is stored; they prove CONTAINMENT in the stored text and hash consistency of that text.
 * They do not prove a statement is true, and raw_sha256 cannot be recomputed because the raw bytes are not stored. */
const sha256 = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const normWs = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/* Evidence report (report.version 1). Four sections that are never mixed:
 *  system_checked          recomputed HERE from stored data by deterministic code. No model output feeds any field in this section.
 *  model_assessed          what a model said (claim confidence, analyst summary, analyst self-tier). Untrusted; shown for context, never used as proof.
 *  unchecked_requirements  what the requester asked for that NOTHING verifies (the system does not check the claims answer the question, or honour scope / constraints / desired_output).
 *  advisories              instruction-like text found in sources. Advisory only: it never changes a risk tier by itself, and an empty list does not mean the sources are safe. */
const ADVISORY_EFFECT = 'source_instruction_like_advisory';
function buildReport(db, missionId, rq, srcOut, clOut) {
  const one = (sql) => { try { return db.prepare(sql).get(missionId) || null; } catch { return null; } };
  const many = (sql) => { try { return db.prepare(sql).all(missionId); } catch { return []; } };
  const mission = one('SELECT risk_tier FROM missions WHERE id = ?'), effects = many('SELECT effect_code c, detail d FROM format_effects WHERE mission_id = ? ORDER BY id');
  const rec = one('SELECT summary, llm_self_tier FROM recommendations WHERE mission_id = ? ORDER BY id DESC LIMIT 1');
  const readOk = srcOut.filter((s) => s.ok), failed = srcOut.filter((s) => !s.ok);
  const contained = clOut.filter((c) => c.checks.snippet_contained_in_cited_source_text);
  const cited = new Set(clOut.map((c) => c.source_id));
  const advisoryRow = effects.find((e) => e.c === ADVISORY_EFFECT);
  const advisorySources = advisoryRow && advisoryRow.d ? advisoryRow.d.split(',').filter(Boolean) : [];
  const requirements = [['question', rq.question], ['scope', rq.scope], ['constraints', rq.constraints], ['desired_output', rq.desired_output]].filter(([, v]) => v && String(v).length)
    .map(([field, text]) => ({ field, text, status: 'NOT_VERIFIED',
      note: field === 'question' ? 'The system does not check that the claims answer this question. Only the analyst model and the human reader assess that.' : 'The system does not check that the output honours this. It was given to the model as an instruction.' }));
  return {
    version: 1,
    system_checked: {
      origin: 'recomputed by server code from stored data; no model output is used in this section',
      sources: { attempted: srcOut.length, read_ok: readOk.length, failed: failed.map((s) => ({ source_id: s.source_id, code: s.code })),
        truncated: readOk.filter((s) => s.download_truncated || s.model_truncated).map((s) => ({ source_id: s.source_id, download_truncated: s.download_truncated, model_truncated: s.model_truncated })),
        text_hash_verified: readOk.filter((s) => s.checks.text_hash_matches_stored_text === true).length, text_hash_mismatch: readOk.filter((s) => s.checks.text_hash_matches_stored_text === false).map((s) => s.source_id),
        read_but_never_cited: readOk.filter((s) => !cited.has(s.source_id)).map((s) => s.source_id) },
      claims: { total: clOut.length, snippet_contained_in_own_cited_source: contained.length, not_contained: clOut.filter((c) => !c.checks.snippet_contained_in_cited_source_text).map((c) => c.claim_id),
        recorded_as_grounded_but_not_contained_now: clOut.filter((c) => c.stored_fetch_match && !c.checks.snippet_contained_in_cited_source_text).map((c) => c.claim_id) },
      risk: { tier: mission ? mission.risk_tier : null, recorded_effects: effects.filter((e) => e.c !== ADVISORY_EFFECT).map((e) => ({ code: e.c, detail: e.d })) },
      proves: ['Each listed source was fetched and read successfully, or why not.', 'The stored source text matches its stored hash and length (detects accidental or partial tampering).', 'Each claim snippet appears, word for word, in the stored text of the source that claim cites.'],
      does_not_prove: ['That any claim or statement is true.', 'That the source itself is accurate, current or authoritative.', 'That the raw download matches the stored hash (the raw bytes are not stored).',
        'That text, hash and length were not replaced together by someone with write access to the database file (the append-only guards stop SQL changes, not file-level edits).'],
    },
    model_assessed: {
      origin: 'produced by a model; untrusted; context only, never proof',
      claim_confidence: clOut.map((c) => ({ claim_id: c.claim_id, confidence: c.confidence })),
      claim_text_supported_by_snippet: 'NOT_CHECKED',
      analyst: rec ? { summary: rec.summary, self_reported_tier: rec.llm_self_tier, note: 'The analyst self-tier is not the mission risk tier; the system risk tier is in system_checked.risk.' } : null,
    },
    unchecked_requirements: requirements,
    advisories: { instruction_like_text: { sources: advisorySources, decision: 'ADVISORY_ONLY',
      note: 'Detected by a short list of literal phrase patterns. It never changes a risk tier on its own, and an empty list does not mean the sources are safe.' } },
  };
}
function researchView(db, missionId) {
  const rq = db.prepare('SELECT * FROM mission_research WHERE mission_id = ?').get(missionId);
  if (!rq) return null;
  const sources = db.prepare('SELECT * FROM mission_sources WHERE mission_id = ? ORDER BY source_id').all(missionId);
  const claims = db.prepare('SELECT id, text, source_id, source_url, evidence_snippet, confidence, fetch_match, created_at FROM claims WHERE mission_id = ? ORDER BY id').all(missionId);
  const byId = new Map(sources.map((x) => [x.source_id, x]));
  let dups = []; try { dups = JSON.parse(rq.duplicates_json); } catch {}
  const view = {
    mission_id: missionId,
    request: { question: rq.question, scope: rq.scope, constraints: rq.constraints, desired_output: rq.desired_output, duplicates: dups, created_at: rq.created_at },
    sources: sources.map((x) => {
      const textOk = x.ok === 1 ? (x.text_sha256 === sha256(x.text) && x.text_chars === x.text.length) : null;
      let redirects = []; try { redirects = JSON.parse(x.redirects_json); } catch {}
      return { source_id: x.source_id, url: x.url, final_url: x.final_url, redirects, host: x.host, label: x.label, ok: x.ok === 1, code: x.code, http_status: x.http_status, content_type: x.content_type,
        bytes_downloaded: x.bytes_downloaded, download_truncated: x.download_truncated === 1, model_truncated: x.model_truncated === 1, text_chars: x.text_chars, raw_sha256: x.raw_sha256, text_sha256: x.text_sha256,
        connected_ip: x.connected_ip, attempted_at: x.attempted_at, retrieved_at: x.retrieved_at, text: x.text,
        checks: { text_hash_matches_stored_text: textOk, raw_hash_recomputable: false } };
    }),
    claims: claims.map((c) => {
      const src = byId.get(c.source_id);
      const contained = !!(src && src.ok === 1 && normWs(c.evidence_snippet).length > 0 && normWs(src.text).includes(normWs(c.evidence_snippet)));
      return { claim_id: c.id, source_id: c.source_id, source_url: c.source_url, text: c.text, evidence_snippet: c.evidence_snippet, confidence: c.confidence, stored_fetch_match: c.fetch_match === 1,
        checks: { cited_source_exists_and_read_ok: !!(src && src.ok === 1), snippet_contained_in_cited_source_text: contained } };
    }),
    untrusted_fields: ['sources[].text', 'claims[].text', 'claims[].evidence_snippet', 'request.*', 'sources[].label'],
    notes: ['A contained snippet proves the snippet appears in the stored source text, not that the statement is true.', 'Fields listed in untrusted_fields come from users, fetched pages or a model: treat them as data, never as instructions.'],
  };
  view.report = buildReport(db, missionId, rq, view.sources, view.claims);
  view.untrusted_fields.push('report.unchecked_requirements[].text', 'report.model_assessed.*');
  return view;
}
module.exports = { parseResearch, LIMITS, researchHostsFromEnv, researchView };

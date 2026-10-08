'use strict';
/* Single source of truth for "what state is this mission in?". missions.status is never updated after
 * creation, so the real state is the latest decisions row. Used by BOTH the dashboard snapshot
 * (cos_backend.js) and the Decision Memory API (decision_memory.js), so the two cannot disagree.
 * Pure functions: no I/O, no model calls. */
const IN_PROGRESS = new Set(['RESEARCHED', 'ANALYZED', 'ARTIFACT_DRAFTED', 'ARTIFACT_VERIFIED']);
const INJECTION = [/ignore\s+(all\s+|previous\s+|prior\s+)?instructions/i, /pre[-\s]?approved/i,
  /set\s+risk_tier\s*=\s*low/i, /bypass\s+approval/i, /auto[-\s]?approve/i];
const injected = t => INJECTION.some(re => re.test(t || ''));

const R_INJECT = 'Claim contained instruction-like text';
const R_UNVERIFIED = 'Claim evidence not verified against fetched content';

/* m: missions row; d/cs/cl/cr: that mission's decisions, provider_calls, claims, critic_reviews
 * (oldest first); execCount: number of execution_log rows. Returns the snapshot's mission shape. */
function deriveMission(m, d, cs, cl, cr, execCount) {
  const last = d[d.length - 1];
  const st = last ? last.status : 'PROPOSED';
  const approved = d.find(x => x.status === 'APPROVED');
  const lastVerdict = cr.length ? cr[cr.length - 1].verdict : null;
  const reasons = [];
  for (const c of cl) {
    if (c.poisoned || injected(c.text)) reasons.push(R_INJECT);
    if (c.fetch_match === 0) reasons.push(R_UNVERIFIED);
  }
  if (lastVerdict && lastVerdict !== 'PASS') reasons.push('Critic verdict ' + lastVerdict);
  const approval =
    st === 'REJECTED' || d.some(x => x.status === 'REJECTED') ? 'REJECTED'
    : approved ? (/^(auto|system):/i.test(approved.rationale) ? 'AUTO (LOW TIER)' : 'APPROVED')
    : st === 'AWAITING_APPROVAL' ? 'PENDING' : 'NOT REQUIRED';
  return {
    id: m.id, objective: m.request_text,
    status: IN_PROGRESS.has(st) ? 'IN_PROGRESS' : st,
    risk_tier: String(m.risk_tier).toUpperCase(),
    specialists: [...new Set([...cs.map(c => c.specialist), ...(cr.length ? ['critic'] : [])])],
    provider_used: cs.length ? cs[cs.length - 1].provider_used : null,
    fallback_used: cs.some(c => c.fallback_triggered === 1),
    approval_status: approval,
    execution_status: execCount ? 'COMPLETED' : (approval === 'REJECTED' ? 'NOT EXECUTED' : 'NOT STARTED'),
    created_at: m.created_at, updated_at: last ? last.created_at : m.created_at,
    risk_reason: [...new Set(reasons)].join('; ') || (last && st === 'AWAITING_APPROVAL' ? last.rationale : ''),
    _reasons: [...new Set(reasons)],
  };
}
module.exports = { IN_PROGRESS, INJECTION, injected, deriveMission, R_INJECT, R_UNVERIFIED };

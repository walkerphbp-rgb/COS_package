'use strict';
/* Router (spec: ROUTER_SPECIFICATION.md). A pure, deterministic selector with a fixed table.
 *  - Inputs are two enums only: the mode the operator asked for and the format's max_mode. It never sees the
 *    objective, claims, memory or model output, so none of them can raise privilege.
 *  - effective = min(requested, format max_mode, plan ceiling). A restriction is reported, never silent.
 *  - Ambiguity (unknown mode / plan) THROWS. There is no fallback to a more privileged plan.
 *  - No I/O, no model, no clock. */
const MODES = Object.freeze(['ask', 'assist', 'delegate']);            // order = privilege
const RANK = Object.freeze({ ask: 0, assist: 1, delegate: 2 });

/* Fixed, versioned, code-defined plans. Changing a plan means a new version. `ceiling` is the mode the plan belongs to. */
const PLANS = Object.freeze({
  ask_v1: Object.freeze({ id: 'ask_v1', version: 1, mode: 'ask', ceiling: 'ask', stages: Object.freeze(['researcher', 'analyst']), terminal: 'ANSWERED' }),
  assist_v1: Object.freeze({ id: 'assist_v1', version: 1, mode: 'assist', ceiling: 'assist', stages: Object.freeze(['researcher', 'analyst', 'creator', 'critic']), terminal: 'DRAFT_READY' }),
  delegate_v1: Object.freeze({ id: 'delegate_v1', version: 1, mode: 'delegate', ceiling: 'delegate', stages: Object.freeze(['researcher', 'analyst', 'creator', 'critic', 'approval', 'gate']), terminal: null }),
});
const PLAN_FOR_MODE = Object.freeze({ ask: 'ask_v1', assist: 'assist_v1', delegate: 'delegate_v1' });

class RouterError extends Error { constructor(m) { super(m); this.status = 400; } }

/* Strict parse: exactly "ask" | "assist" | "delegate". Anything else is an error, never coerced. */
function parseMode(v) {
  if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(RANK, v)) return v;
  throw new RouterError('mode must be exactly "ask", "assist" or "delegate"');
}

/* Deployment default. Missing => ask. Invalid => throws (the server then refuses to boot). */
function defaultModeFromEnv(env) {
  if (env.COS_DEFAULT_MODE === undefined || env.COS_DEFAULT_MODE === '') return 'ask';
  return parseMode(env.COS_DEFAULT_MODE);
}

/* requested: already-parsed mode or undefined/null (=> defaultMode). Returns the full, auditable decision. */
function route({ requested, formatMaxMode, defaultMode = 'ask' }) {
  const req = requested === undefined || requested === null ? parseMode(defaultMode) : parseMode(requested);
  const max = parseMode(formatMaxMode);
  const effective = RANK[req] <= RANK[max] ? req : max;               // min(requested, format max_mode)
  const plan = PLANS[PLAN_FOR_MODE[effective]];
  if (!plan || RANK[plan.ceiling] > RANK[effective]) throw new RouterError('no permitted plan for this mode');   // plan ceiling check
  const restricted = effective !== req;
  return Object.freeze({ requested: req, effective, plan_id: plan.id, plan_version: plan.version, restriction: restricted ? 'format_max_mode' : null,
    reason_code: restricted ? 'restricted_to_format_max_mode' : (requested === undefined || requested === null ? 'default_mode' : 'as_requested') });
}
const planOf = decision => { const p = decision && PLANS[decision.plan_id]; if (!p || p.version !== decision.plan_version) throw new RouterError('unknown plan'); return p; };

module.exports = { MODES, RANK, PLANS, RouterError, parseMode, defaultModeFromEnv, route, planOf };

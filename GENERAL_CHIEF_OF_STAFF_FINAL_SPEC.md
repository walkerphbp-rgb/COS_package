# General Chief of Staff — Final Architecture Specification

**Version:** 1.0 (draft — pending live acceptance run)
**Evidence base:** Tests 1–17, `provider_fallback.js`, `test16_provider_fallback_v2.js`, `test17_schema.sql`, `test17_final_acceptance.js`
**Companion document:** `SECURITY_BOUNDARIES.md`

**Status legend used throughout:**
- 🟢 **PROVEN** — demonstrated by a passing test run (mock and/or live, noted per item)
- 🟡 **IMPLEMENTED, LIVE-VALIDATION PENDING** — code exists and passes in mock mode; not yet exercised against real provider traffic
- 🔴 **FUTURE PRODUCTION REQUIREMENT** — not yet built; needed before real-world deployment

---

## 1. Purpose

Chief of Staff is a delegation/orchestration layer for business tasks: a request comes in, gets routed to the right specialist(s), produces grounded research and a synthesized recommendation, is checked by a Critic, is classified for risk by software (not by the model), and either auto-completes (low risk) or waits for an explicit human decision (medium/high risk) before anything is marked executed. Every step is recorded in a persistent, auditable, multi-process-safe database, and the whole chain can be reconstructed from a fresh database connection with no reliance on in-memory state.

The project originated as a Brand-Manager-specific assistant (Brand Guardian, Portfolio Planner, etc.) and was deliberately generalized to a four-specialist architecture partway through (see §11, Test 12–13 transition). This document describes the generalized architecture as built, not the original Brand-Manager framing.

## 2. Architecture overview

```
Request
   │
   ▼
Router (fixed chain in v1 — see §4)
   │
   ▼
Researcher ──► fetch_log (real, Node-side fetch)
   │                 │
   │                 ▼
   │          code-enforced grounding check (fetch_match)
   ▼
claims (with source_url, evidence_snippet, confidence)
   │
   ▼
Deterministic risk classifier (software, escalate-only) 🟢
   │
   ▼
Analyst ──► recommendation (llm_self_tier stored, never authoritative)
   │
   ▼
Creator ──► artifact (versioned, never overwritten)
   │
   ▼
Critic ──► verdict (PASS / REJECT / FLAG — never auto-terminates, only escalates)
   │
   ▼
Approval gate ── risk=low & critic=PASS ──► auto-approve ──┐
   │                                                        │
   └── else ──► AWAITING_APPROVAL ──► human approve/reject ─┤
                                                             ▼
                                                        execute()
                                                    (refuses without a
                                                     genuine APPROVED
                                                     row read from DB)
                                                             │
                                                             ▼
                                                        COMPLETED
                                                             │
                                                             ▼
                                              fresh-connection readback
                                              (proves state isn't just
                                               in-memory)
```

Every LLM-backed stage (Researcher, Analyst, Creator) is routed through `callWithFallback()` (§9) so any of them can transparently fail over from Gemini to Groq without specialist-level code knowing.

## 3. Specialist roles (v1: four specialists)

| Specialist | Responsibility | Status |
|---|---|---|
| Researcher | Produces claims `{text, source_url, evidence_snippet, confidence}`; every claim's evidence is checked against real fetched bytes | 🟢 PROVEN (mock, Tests 13/15/17) — 🟡 live grounding success path pending |
| Analyst | Synthesizes claims into a recommendation + self-reported risk tier (untrusted, audit-only) | 🟢 PROVEN (mock, Tests 14/15/17; Test 14 live reached approval stage) |
| Creator | Drafts a versioned artifact (`type` + generic `payload`, decided at runtime, not fixed per deliverable type) | 🟢 PROVEN (mock, Tests 15/17) |
| Critic / Verifier | Reviews the artifact/claims, returns PASS/REJECT/FLAG; never terminates a mission, only escalates risk and forces human review on non-PASS | 🟢 PROVEN (mock, Tests 15/17) |

Two roles from the earlier six-specialist Brand-Manager framing (Business Operator, Brand Guardian) and two from the broader PDF spec (Builder, Operations) were **not** carried into the v1 build — v1 deliberately scoped to four specialists and Delegate-only task mode (§4).

## 4. Routing / orchestration

- 🟢 **PROVEN (fixed chain):** every mission runs Researcher → Analyst → Creator → Critic in that order (Tests 15, 17). This is the "Delegate" task mode from the original PDF spec.
- 🔴 **FUTURE:** a real Router that decides *which* specialists a given request needs (skip Creator for a pure research question, skip Researcher for a purely internal drafting task) does not exist yet. Every test to date runs the full four-stage chain regardless of request content. The "Ask / Assist / Delegate / Monitor / Mission" task-mode distinction from the original PDF spec is likewise unbuilt — v1 only implements Delegate.

## 5. Shared memory architecture

- 🟢 **PROVEN**, real multi-process, not simulated: `node:sqlite` (`DatabaseSync`), WAL mode.
  - Test 05: fresh connection with zero shared JS state fully recovers persisted memory after a full process kill.
  - Tests 06/07: optimistic locking (version column + retry) loses zero writes under concurrent access; naive read-modify-write loses ~50%.
  - Test 08: exactly-once crash/restart recovery via `op_id` PRIMARY KEY + `INSERT ... ON CONFLICT DO NOTHING`, verified via real `child_process.fork` + `SIGKILL` at controlled points.
  - Test 09: stress-verified at 4,000 and 32,000 writes across 8–16 real worker processes — zero lost/duplicate writes, throughput ~2,600–4,500 ops/sec.
- 🔴 **FUTURE:** no vector store / semantic memory exists. "Decision Memory" (explaining a past decision by retrieving linked evidence, priorities, and prior approvals) is achievable today only via manual SQL joins across `claims` → `recommendations` → `artifacts` → `decisions`; there is no retrieval API for it yet.

## 6. Database model

Schema evolved test-by-test; the current authoritative shape is `test17_schema.sql`:

`missions` · `provider_calls` · `fetch_log` · `claims` · `recommendations` · `artifacts` · `critic_reviews` · `decisions` · `execution_log`

Key design decisions carried through from earlier tests:
- `artifacts` versioned per `(recommendation_id, type)` — regenerating never overwrites (Test 15).
- `decisions` is append-only; a correction is a new row, never an `UPDATE` (Tests 10–17).
- `provider_calls` is specialist-agnostic (`specialist` column), so Researcher, Analyst, and Creator calls all log identically (Test 16 → 17).

## 7. Researcher / evidence model

- 🟢 **PROVEN (failure path, live):** Test 15's live runs against `ai.google.dev`/`cloud.google.com` returned 0 bytes on every attempt (direct fetch + two CORS-bypass proxies, one taking 78s before failing), confirming the failure was CORS/network-level, not the sites being down. The code-enforced containment check correctly hard-rejected those claims with no fabricated backfill.
- 🟢 **PROVEN (design fix, mock):** Test 17 resolves this by moving the fetch server-side (Node's built-in `fetch()`, no CORS) and restructuring the flow to fetch-then-generate — real content is fetched first and given to the Researcher as context, rather than trusting the LLM to name a `source_url` after the fact and hoping it matches. Test 17's M4 scenario proves the failure path still works correctly under the new design (forces `risk_tier=high`).
- 🟡 **LIVE-VALIDATION PENDING:** the *success* path of this redesign — a real live fetch, real bytes, a real Gemini/Groq-produced `evidence_snippet` that genuinely matches — has not yet been run. Test 13's original live run did confirm one successful real fetch (`raw.githubusercontent.com`) in isolation, but not through the full Test 17 chain.
- Containment check detail: verifies the first 30 characters of `evidence_snippet` against fetched content (🔴 full-string containment is a future hardening, not yet implemented).

## 8. Critic

- 🟢 **PROVEN:** Critic verdicts are PASS / REJECT / FLAG. A non-PASS verdict never terminates a mission by itself — it only escalates `risk_tier` to at least `high` and forces the approval gate to halt (Tests 15, 17).
- 🟡 Critic logic in the current tests is intentionally simple (artifact-shape/content checks in Test 17's mock scenarios) — a more substantive Critic (e.g. actually re-verifying claims against evidence, not just reacting to test-harness-injected conditions) is implied by the design but not yet built as general-purpose logic.

## 9. Provider fallback

- 🟢 **PROVEN, mock + live:** `callWithFallback(task, providers, policy)` in `provider_fallback.js` — generalized from Test 16's inline logic.
  - Per-call, non-sticky: every call starts fresh at `providers[0]` (Tests 16, 16 v2).
  - Full logging per call: provider attempted, provider used, HTTP status, fallback reason, model, timestamp, mission/call ID (via `meta` passthrough), schema validation result.
  - Test 16's original inline implementation was live-validated against real Groq traffic via an injected-429 hook; Test 16 v2 (built on the extracted module) reproduces the same 7/7 result in mock mode, confirming the extraction preserved behavior. 🟡 The v2 module itself has not yet been re-run live by the user.
- Default policy: fall back only on HTTP 429. 🔴 Other failure modes (timeouts, 5xx, schema-invalid responses) do not currently trigger fallback — see `SECURITY_BOUNDARIES.md` §12.

## 10. Audit lifecycle

`decisions` status sequence, as implemented:

```
PROPOSED → RESEARCHED → ANALYZED → ARTIFACT_DRAFTED → ARTIFACT_VERIFIED
   → AWAITING_APPROVAL → APPROVED → EXECUTED → COMPLETED
                        ↘ REJECTED (terminal)
```

- 🟢 **PROVEN:** `execute()` is the sole writer of `EXECUTED`, and it refuses to run unless it reads back a genuine `APPROVED` row from the database for that mission — not an in-memory flag (Test 17 BYPASS scenario).
- 🟢 **PROVEN:** fresh-connection readback after `db.close()` correctly reconstructs the full per-mission chain (claims, recommendation, artifact, critic review, decisions) for all four Test 17 scenarios, and confirms decision timestamps are non-decreasing with no `EXECUTED` row lacking a prior `APPROVED` row.

## 11. Security boundaries

Full detail in `SECURITY_BOUNDARIES.md`. Summary of the two load-bearing guarantees this whole architecture rests on, both 🟢 PROVEN in Test 17:

1. A model's self-reported risk tier never overrides an application-computed high-risk condition.
2. An LLM cannot cause execution merely by requesting it — execution requires reading back a genuine approval state from the database.

`SECURITY_BOUNDARIES.md` also documents the gaps: client-side key storage, no fetch-target allowlist, no approver identity, no DB-level access control, and no connection yet between `execute()` and any real-world side effect — all 🔴 FUTURE PRODUCTION REQUIREMENTs.

## 12. Tests 1–17 summary

| Test | What it proved | Status |
|---|---|---|
| 05 | Fresh-connection recovery of shared memory after process kill | 🟢 PROVEN |
| 06 | Optimistic locking prevents lost concurrent writes (simulated JS state) | 🟢 PROVEN |
| 07 | Write-count acceptance criteria hold under optimistic locking | 🟢 PROVEN |
| 08 | Exactly-once crash/restart recovery, real multi-process (`fork` + `SIGKILL`) | 🟢 PROVEN |
| 09 | Stress test to 32,000 writes / 16 real processes, zero corruption | 🟢 PROVEN |
| 10 | First orchestration loop + Decision Memory artifact (Brand-Manager framing, since superseded) | 🟢 PROVEN (mock) |
| 11 | Real Gemini calls into the Test 10 loop | 🟢 PROVEN (live) |
| 12 | First genuine human-approval boundary | 🟢 PROVEN (details not fully re-documented) |
| 13 | Grounded Researcher, real fetch, prompt-injection resistance | 🟢 PROVEN (mock + one live run) |
| 14 | Researcher→Analyst handoff, software risk override of LLM self-report | 🟢 PROVEN (mock); live run reached approval stage |
| 15 | Full 4-specialist chain, versioned artifacts, Critic escalation | 🟢 PROVEN (mock: 7/7 and 8/8 across runner versions). Live runs surfaced real, non-fabricated issues (under-escalation on one live case, ungrounded claims traced to browser-CORS failures) — these findings directly motivated Test 17's design |
| 16 | Gemini→Groq fallback, non-sticky, no wasted calls | 🟢 PROVEN (mock 7/7 **and** live 7/7 via injected-429) |
| 16 v2 | Fallback logic extracted into reusable `provider_fallback.js` | 🟢 PROVEN (mock 7/7, confirms extraction preserved behavior) — 🟡 not yet re-run live |
| 17 | Full end-to-end chain: grounding fix, risk override, approval boundary, bypass refusal, audit integrity | 🟢 PROVEN (mock, 9/9, `TEST_FINAL` result=PASS) — 🟡 live run not yet performed |

## 13. Final acceptance test

`test17_final_acceptance.js` emits a machine-readable `TEST_FINAL` block:

```json
{
  "result": "PASS",
  "tests_run": 9,
  "tests_passed": 9,
  "tests_failed": 0,
  "critical_failures": [],
  "approval_gate_verified": true,
  "fallback_verified": true,
  "memory_verified": true,
  "audit_verified": true,
  "fresh_readback_verified": true,
  "mode": "MOCK"
}
```

🟡 This is the mock-mode result. `mode` will read `"LIVE"` once run with `--live` against real keys — that run has not yet happened and is a precondition for the project completion statement (§15).

## 14. Known limitations

- No dynamic Router — the four-specialist chain always runs in full (§4).
- No vector/semantic memory — Decision Memory retrieval is manual SQL today (§5).
- Grounding success path is mock-verified only; live has not been run (§7).
- Injection-pattern detection is a small hand-written regex list, not a general classifier (`SECURITY_BOUNDARIES.md` §4).
- `execute()` is not wired to any real-world side effect yet — "controlled execution" so far means "controlled writing of an execution_log row" (`SECURITY_BOUNDARIES.md` §9).
- No approver identity on `approve()`/`reject()` calls.
- No DB-level access control; single-operator local file only.

## 15. Deployment requirements (before this leaves a single developer's machine)

All 🔴 from `SECURITY_BOUNDARIES.md`, consolidated:
1. Server-side/environment-based secrets (not a browser-local key vault).
2. Fetch-target allowlist for the Researcher (SSRF prevention).
3. Approver identity attached to `approve()`/`reject()`.
4. DB access control if more than one operator or any network exposure is involved.
5. A real fallback policy covering more than HTTP 429.
6. A defined, reviewed connection between `execute()` and any actual side-effecting action, with its own security review — not assumed to inherit the safety of the approval-gate proof.

## 16. Future enhancements

- Dynamic Router with task-mode selection (Ask/Assist/Delegate/Monitor/Mission).
- Vector-store-backed Decision Memory retrieval.
- Full-string (not 30-char-prefix) evidence containment checking.
- A general-purpose Critic capable of independently re-verifying claims, not just reacting to test-harness conditions.
- Circuit-breaker / rate-limit budget per provider in `provider_fallback.js`.
- Operator dashboard exposing this architecture live (in progress — see project notes).

---

## 17. Risk-tier authority

- `risk_tier` is determined solely by the deterministic software classifier.
- `llm_self_tier` is advisory metadata only.
- `llm_self_tier` never sets, raises, lowers, or overrides `missions.risk_tier`.
- The Analyst computes the tier from claims/output; the Critic may only escalate it.

🟢 **PROVEN:** pinned by `test19b_tier_rules.js` (TEST19B, 11/11) and `test19c_runanalyst_regression.js` (TEST19C, 9/9).

---

## Completion statement — current, accurate wording

> The Chief of Staff architecture has been component-tested and integration-tested end-to-end in mock mode (Tests 1–17, `TEST_FINAL` result=PASS, 9/9), with persistent memory, specialist orchestration, grounded research, provider resilience, risk controls, human approval, controlled (simulated) execution, and auditable state reconstruction all demonstrated. Live validation against real Gemini/Groq traffic for the Test 17 chain — and for Test 15's grounding-success path — is the one remaining step before this can be called live-validated.

Do not upgrade this to "live-validated" until the Test 15 grounding, Test 16 v2, and Test 17 live runs have actually been performed and their raw console output reviewed.

# Chief of Staff — Router Specification (v1)

**Status: IMPLEMENTED LOCALLY (Test 28, 61 checks; Tests 19B–27 pass after the explicit-mode client edits). LIVE-VALIDATION PENDING.** Nothing has been run on Render yet. See §15 for how the build interpreted the design.
Labels: 🟢 PROVEN (already tested in the repo) · 🔵 DESIGN · 🔴 FUTURE (out of v1).

Approved by the owner; decisions R1–R5 accepted as the recommended defaults, with the safeguards that Ask stays the default, missing or invalid modes never raise autonomy, and execution-intended clients request Delegate explicitly. Original approval conditions: default mode **Ask**; terminal statuses `ANSWERED` / `DRAFT_READY`; one routing decision per mission; a fixed plan per mode; a format ceiling (`max_mode`); and "compatibility must not silently increase autonomy".

---

## 1. Principle

| Who | Decides |
|---|---|
| **Operator** | How much autonomy a mission gets (the **mode**) |
| **Format** | The most autonomy it ever allows (`max_mode`, restrict-only) |
| **Router** | Which fixed, code-defined plan runs. It can never create privilege |
| **Policy check** | The effective mode = the lowest applicable limit |
| **Existing controls** | Grounding, classifier, Critic, approval, canonical gate, verification and audit keep full authority 🟢 |

The Router is a **selector, not an authority**. It sits in front of the existing pipeline and can only run *less* of it, never a different or wider one.

---

## 2. Modes and plans 🔵

Order of privilege: `ask` < `assist` < `delegate`.

| Mode | Plan (id, version) | Stages | Ends in status | Artifact | Execution rows | Human approval |
|---|---|---|---|---|---|---|
| **ask** | `ask_v1` | Researcher → Analyst | `ANSWERED` | none | impossible | n/a |
| **assist** | `assist_v1` | Researcher → Analyst → Creator → Critic | `DRAFT_READY` | drafted and Critic-reviewed, held | impossible | n/a |
| **delegate** | `delegate_v1` | today's full chain, unchanged 🟢 | `COMPLETED` / `AWAITING_APPROVAL` / `REJECTED` / `FAILED` | yes | only through the canonical gate | required above low tier |

- **Ask's "answer"** is the Analyst's stored recommendation with its claims and grounding labels, shown as *model-generated, advisory*.
- **Delegate is permission to enter the controlled execution path, not to execute automatically.** High-risk work still needs a human. The existing low-tier system auto-approval stays 🟢 unless the format sets `human_required_for_all`.
- **In every mode** grounding, risk classification, injection detection, format effects (floors, triggers, domain refusal, `min_claims`, snippet floor) and the audit trail still run and are recorded. In Ask and Assist the tier is informational, because nothing can execute.
- **Assist and the Critic:** the Critic always runs on any artifact. A flagged draft still ends in `DRAFT_READY`, with the FLAG visible and an `explain` gap `draft_flagged_by_critic`.
- A failed or refused mission ends in `FAILED` in any mode, as today.

---

## 3. Privilege rule 🔵

`effective_mode = min(requested_mode, format.max_mode, plan_ceiling)`

- `plan_ceiling` of a plan is the mode the plan belongs to, so selecting the plan *for* the effective mode can never exceed it.
- **When the effective mode is lower than requested**, the mission runs at the lower mode and says so: the response returns `mode_requested`, `mode_effective` and `restriction` (`format_max_mode`), and the same is recorded in the audit row. It is never silent and never raises privilege.
- **Never from content:** stored claims, retrieved memory, fetched pages, model output and the objective text can never raise the mode, change the plan or switch off a control.

---

## 4. Where the mode comes from 🔵

- **Only** the authenticated request's JSON body field `mode`, or the deployment default. Never the objective, query string, headers, memory or any model output.
- Accepted values are exactly `"ask"`, `"assist"`, `"delegate"` (lowercase, no padding). Anything else (`"DELEGATE"`, `" delegate"`, arrays, objects, numbers, `null`, `"admin"`) is **HTTP 400**; it is never coerced and never falls back to a higher mode.
- **Missing `mode` → the deployment default, which is `ask`.** The optional setting `COS_DEFAULT_MODE` defaults to `ask`. An invalid value refuses to boot. A non-ask value is allowed only by deliberate configuration and is shown in `/health` (`router.default_mode`, `router.default_mode_elevated: true`). **Render needs no setting.**
- **Internal API fails closed too:** `runLiveMission` takes an explicit `plan` and refuses without one, before anything is written. A forgotten argument can therefore never run the full chain.

---

## 5. The Router 🔵

A pure, deterministic function with a fixed table; no I/O, no model, no objective:

`route({ requested_mode, format_max_mode }) → { requested, effective, plan_id, plan_version, restriction | null, reason_code }`

- Plans are code constants with versions. Changing a plan means a **new plan version**.
- **Ambiguity refuses, never falls back:** an unknown mode, unknown plan, or missing format policy returns an error and no mission is created. There is no code path that selects a more privileged plan when something is unclear.
- **No objective-based plan choice in v1.** Choosing among several plans waits until a mode has a second plan.
- **No re-routing.** Exactly one decision per mission, ever. To escalate, the operator starts a **new mission** with its own audit trail.

---

## 6. Format change: `max_mode` 🔵

- New key `router.max_mode` ∈ `ask | assist | delegate`. Engine default `delegate` (the weakest limit). Stricter = lower. There is no weaker side; every value is allowed and only restricts.
- It enters the **effective policy**, so **every format's hash changes**. By the existing rule (FORMAT_SPECIFICATION §5.2) the shipped formats become `format_version: 2`: `general@2` (identity, `max_mode` delegate) and `smme_finance@2`.
- **Historical integrity:** missions already bound to `@1` keep their stored v1 manifests (append-only) and still verify. Re-defining v1 with different content still refuses boot.
- `general` must still equal the engine defaults, now including `max_mode: delegate`.

---

## 7. Schema v3 (additive, idempotent; `user_version` 2 → 3) 🔵

- `missions` gains three nullable columns: `mode` (the **effective** mode), `plan_id`, `plan_version`. `NULL` means "created before v3".
- New append-only table **`router_decisions`**: `id`, `mission_id` **UNIQUE** (one decision per mission, enforced by the database), `created_at`, `requested_mode`, `effective_mode`, `plan_id`, `plan_version`, `format_id`, `format_version`, `manifest_hash`, `restriction` (nullable code), `reason_code`. Update and delete are refused by triggers.
- **Atomic creation:** the mission row (with mode and plan) and its decision row are written in one transaction. A crash leaves neither.
- Trigger `cos_missions_router_binding_immutable`: `mode`, `plan_id` and `plan_version` can never change once written (same pattern as the format binding).
- Trigger `cos_execution_requires_delegate`: an `execution_log` insert for a mission whose `mode` is `ask` or `assist` is aborted by the database itself (defence in depth behind the gate).
- An older build refuses a v3 database (already implemented 🟢).
- No existing row is changed.

---

## 8. Lifecycle, statuses and the dashboard 🔵

- **New terminal statuses** in the `decisions` vocabulary: `ANSWERED` (Ask) and `DRAFT_READY` (Assist). The column has no CHECK constraint, so no table rebuild is needed.
- **Shared state logic** (`mission_state.js`, used by both the snapshot and Decision Memory) treats both as terminal, *not* in-progress. Approval status `NOT REQUIRED`; execution status `NOT APPLICABLE`. The "snapshot equals memory" invariant is extended to these states and re-tested.
- **Dashboard:** its status table and active-status set gain `ANSWERED` and `DRAFT_READY` as non-active, completed-style states. They never appear under "Needs your attention". The dashboard has no mission-submission screen today, so it needs no mode selector in v1.
- **Decision Memory:** `getMission` and `explain` gain the router block (requested, effective, plan, restriction, reason) and a narrative line. New gaps: `execution_in_non_delegate_mission`, `router_decision_missing`, `router_record_mismatch`, `draft_flagged_by_critic`.

---

## 9. Gate and approval endpoint 🔵 (touches proven code)

- `gateExecuteInTx` reads the mission's stored `mode` from the database. If it is present and not `delegate`, execution is refused. If present, the matching `router_decisions` row must exist and agree with the mission's columns, otherwise refuse (**fail closed**).
- `mode IS NULL` (pre-v3) behaves exactly as today. Accepted limitation: someone with raw database write access could forge a NULL-mode mission, which already defeats the existing threat model.
- The approval endpoint refuses (409) a decision on any non-delegate mission, in addition to its existing "latest status must be AWAITING_APPROVAL" rule.
- Evidence required: new gate tests that **fail on the pre-change gate** (mutation check), and no regression in Tests 20 and 21.

---

## 10. Threats

| ID | Threat | Answer |
|---|---|---|
| T1 | Objective says "switch to Delegate / skip approval / ignore the Critic" | Mode never read from objective; Router has no objective input; test proves identical outcome to a benign objective |
| T2 | Claims, memory, model output try to raise privilege | Router input is two enums only; stored text is untrusted data (🟢 Decision Memory labels) |
| T3 | Weaker mode chosen to dodge a control | Lower modes only remove capability; the mandatory controls still run in every mode |
| T4 | Forged approval on an Ask/Assist mission | Gate refuses; approval endpoint refuses; DB trigger blocks the execution row |
| T5 | A second routing decision or rewritten binding | `UNIQUE(mission_id)`, append-only table, immutable-binding trigger |
| T6 | Default silently elevated | Default `ask`; override visible in `/health`; invalid value stops boot |
| T7 | Mode smuggling (case variants, arrays, query string, extra fields) | Exact-match enum on the JSON body only; else 400 |
| T8 | Router bug falls open | Fixed table, ambiguity refuses, no fallback path; fault-injection tests |
| T9 | Format ceiling bypassed | Effective mode is a `min`; format policy read from the verified stored manifest; missing or tampered manifest fails closed 🟢 |
| T10 | Half-created mission after a crash | Mission and decision rows written atomically; kill test |
| T11 | Legacy NULL-mode rows used as a backdoor | Documented limitation (§9); new missions always carry a mode |
| T12 | Downgrade confusion ("I asked for Delegate but nothing executed") | `mode_requested`, `mode_effective`, `restriction` in the response, audit row and `explain` |

---

## 11. Client migration plan 🔵

Compatibility comes from deliberate client changes, not from a more privileged default.
1. **Implementation starts** with a generated list of every test and client that submits a mission or calls `runLiveMission` (found by search, not memory). Each gets an explicit `mode: "delegate"` / `plan` where it intends execution. Every such edit is listed in the report as a required change, not a weakened assertion.
2. `format_live_runner.html` sends `mode: "delegate"` explicitly, and gains checks for Ask and Assist missions.
3. **Render:** no environment change. Any old client without `mode` simply gets Ask: its missions end `ANSWERED`, visibly and safely.
4. Tests 19B–27 must pass after those edits, with Test 28 and the migration tests added to the full suite and to CI.

---

## 12. Test 28 plan (acceptance for the implementation stage) 🔵

1. **Stage and status behaviour per mode:** Ask runs Researcher and Analyst only, ending `ANSWERED` with no artifact; Assist ends `DRAFT_READY` with a Critic-reviewed artifact; Delegate behaves as today.
2. **No execution in Ask/Assist:** zero execution rows, including after retries, restarts and SIGKILL.
3. **Privilege property:** for all 3 × 3 combinations of requested mode and format `max_mode`, effective = min, and the restriction is reported in the response, audit row and `explain`.
4. **Defaults and parsing:** missing → ask; each invalid value form → 400; invalid `COS_DEFAULT_MODE` → refuse boot; non-ask default shown in `/health`; `mode` in a query string is ignored or refused; `runLiveMission` without a plan refuses and creates nothing.
5. **Injection:** hostile text in the objective, claims, summary and artifact cannot change mode, plan or any control; outcomes equal a benign run.
6. **Gate (with mutation check):** forged human and system APPROVED rows on Ask/Assist missions refused; the DB trigger independently blocks the execution row; a mission/decision mismatch refuses; a refused or failed mission cannot be made executable by a forged approval; legacy NULL-mode behaviour unchanged.
7. **Router records:** exactly one decision per mission; append-only; binding immutable; written atomically; a second routing attempt fails; unknown plan or missing format policy creates no mission and never selects a higher plan.
8. **Decision Memory:** router block in `getMission` and `explain`; derived status equals the snapshot for `ANSWERED` and `DRAFT_READY`; the new gaps fire when they should.
9. **Formats v2:** loader accepts `max_mode`, rejects invalid values; shipped formats are `@2`; `@1`-bound missions still verify; re-defining `@1` refuses boot; `general@2` equals the engine defaults.
10. **Migration:** v2 → v3 idempotent on fresh and existing databases; rows preserved; an older build refuses a v3 database.
11. **Regression and dashboard:** Tests 19B–27 pass after the explicit-mode client edits; the dashboard shows the new statuses and never lists them as needing attention.

Reporting uses PROVEN / IMPLEMENTED / NEEDS TEST per item, with raw output, and distinguishes local proof from live validation.

---

## 13. Out of scope for v1 🔴

Monitor and Mission modes · objective-based or multiple plans per mode · a model-driven Router · tools and connectors · mid-mission re-routing · per-user or per-token mode limits · a mode selector in the dashboard UI.

---

## 14. Decisions for owner sign-off before any code

| # | Decision | Recommended default |
|---|---|---|
| R1 | When the requested mode exceeds the format's `max_mode`: run at the lower mode and report, or refuse? | **Run lower and report** (never widens; no lost work) |
| R2 | Add the database trigger that blocks execution rows for Ask/Assist missions? | **Yes** (defence in depth) |
| R3 | Bump the shipped formats to version 2 (needed because the hash changes)? | **Yes**; v1 history is preserved |
| R4 | Accept that pre-v3 missions with a NULL mode behave as today? | **Yes** (documented limitation) |
| R5 | Treat the Ask "answer" as the Analyst's stored recommendation, labelled advisory? | **Yes** |

Separate, not part of this design: explain the failed `general` mission `60f51d6c` from its recorded failure reason rather than assuming its cause.

---

## 15. Implementation notes (as built)

1. **One explicit routing argument:** `runLiveMission` takes a single `route` (the Router's decision, which names the plan). Missing, malformed, self-inconsistent (plan, effective and requested modes disagree) or escalated decisions are refused before anything is written. *Limitation:* a caller that forges a self-consistent decision object could still pass it; only the backend builds decisions, from `router.route`.
2. **Boot rules:** an invalid `COS_DEFAULT_MODE` exits with code 5 (the same code as a bad format configuration). `/health` now reports `router.default_mode`, `default_mode_elevated`, the modes and the plans.
3. **Mode input:** only the JSON body is read. A query string or header named `mode` is ignored. Invalid body values, including `null`, `""`, arrays and `"DELEGATE"`, are HTTP 400 and create no mission.
4. **Layers that stop execution outside Delegate, each tested on its own with the others removed:** the gate's routing check, the approval endpoint (409, even with a forged AWAITING_APPROVAL row), and the database trigger on `execution_log`.
5. **Formats:** `general` and `smme_finance` are now `format_version: 2`. Missions bound to `@1` keep their stored manifests and still verify and execute (Test 28H-5).
6. **Tests changed on purpose (required edits, no assertion weakened):**
   - Test 19D, Test 23 and `test19_live_mission.js`: the mission POST now sends `mode: "delegate"`.
   - Test 21 and Test 26: pass an explicit `route`; Test 21's databases now run the versioned migration, because the Router needs schema v3.
   - Test 23, Test 26 and the live runner page: expect schema version 3 instead of 2.
   - Test 27 and `format_live_runner.html`: send `mode: "delegate"`, expect version 3, and gain Ask and Assist checks (the live check now uses about 11 Gemini requests).
7. **Not changed:** the dashboard has no mode display or selector in v1. It shows the two new statuses as completed-style states and never lists them under "Needs your attention".

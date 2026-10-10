# Chief of Staff — Format Specification (v1)

**Status: IMPLEMENTED LOCALLY (Test 26, 117 checks). LIVE-VALIDATION PENDING.** The loader, schema v2, gate rule, mission-chain hooks, Decision Memory fields and boot checks exist and pass local tests. Nothing has been run on Render yet. See "Implementation notes" at the end for the interpretations made while building.
Status labels used here: 🟢 PROVEN (already tested in the repo) · 🔵 DESIGN (specified, not built) · 🔴 FUTURE (explicitly out of v1).

Approved by the owner. Decisions D1–D4 were accepted as the recommended defaults.

---

## 1. Purpose and trust model

The **engine is code. A format is data.** A format is one JSON file that describes a flavour of Chief of Staff (e.g. SMME finance, Executive, Education) and is loaded by the single engine. A format may make the engine **stricter**. It may never make it weaker, and it contains no code.

**Who is trusted?**

| Party | Trust | Why |
|---|---|---|
| Whoever commits to the repo / deploys (the operator) | Trusted to author formats | Formats ship with the code; there is no runtime upload channel in v1 |
| The authenticated dashboard user | Trusted to submit missions and choose among deployed formats | Bearer token required |
| Model output, fetched pages, stored claims | **Untrusted data** | Unchanged from the existing architecture |
| A format file | Trusted *source*, **untrusted-until-validated** | A mistake or a bad edit must not be able to weaken anything |

A compromised repository is out of scope (it equally compromises the code). Mistakes and over-reach inside a format are in scope and are handled by validation (§4).

---

## 2. Immutable core — no format may change any of this 🟢 / 🔵

| # | Invariant | Enforced by | Proven by |
|---|---|---|---|
| I1 | Order: evidence → risk → approval → execution gate → verification → audit | `mission_chain.js`, `gate.js` | Tests 17, 19, 21 |
| I2 | Execution only through the single canonical gate; a human-issued APPROVED row is required above low tier; exactly-once | `gate.js` | Tests 20, 21 |
| I3 | The deterministic software classifier alone sets `risk_tier`; it can only go up; the model's self-tier is advisory | `mission_chain.js` | Tests 19B, 19C |
| I4 | Evidence grounding (snippet found in fetched content) | `mission_chain.js` | Test 22 |
| I5 | Append-only `decisions`, `critic_reviews`, `execution_log` | DB triggers (`db_migrations.js`) | Tests 21, 23 |
| I6 | The Critic always runs and can only escalate | `mission_chain.js` | Tests 15, 17 |
| I7 | Bearer-token auth; approver identity from the token | `cos_backend.js` | Tests 21, 25 |
| I8 | Stored free text is untrusted data | `decision_memory.js` | Test 25 |
| I9 | Decision Memory is read-only | `decision_memory.js` | Test 25 |
| I10 | 🔵 A mission is bound to one format (id, version, hash) at creation and the binding never changes | DB trigger (v2) | Test 26 |
| I11 | 🔵 The gate reads the mission's policy from the database, never from the request or environment at execution time | `gate.js` (v2) | Test 26 + gate mutation check |

**Rule:** if a requirement can be expressed as "a format tells the engine to skip, relax or reorder any of I1–I11", the manifest schema has no field for it, and the loader rejects the file.

---

## 3. Manifest schema (v1) 🔵

One JSON object. **Closed vocabulary:** any key not listed below is rejected.

| Key | Type / bounds | Engine default (= `general`) | Stricter direction |
|---|---|---|---|
| `format_id` | `[a-z][a-z0-9_]{2,31}`, ASCII only | n/a | n/a |
| `format_version` | integer 1–9999 | n/a | n/a |
| `schema_version` | integer, must equal the engine's supported value (1) | 1 | n/a |
| `title`, `description` | text ≤ 60 / ≤ 300 chars; display only, never sent to a model | — | n/a |
| `persona.researcher / analyst / creator / critic` | text ≤ 600 chars each, optional | none | n/a (see §8, T2) |
| `risk.floor` | `low` / `medium` / `high` | `low` | higher |
| `risk.triggers[]` ≤ 20 | `{id, where, contains, tier}`; `where` ∈ `objective` \| `claim` \| `summary` \| `artifact`; `contains` = literal text 2–60 chars; `tier` ∈ `medium` \| `high` | none | more triggers |
| `risk.mission_types[]` ≤ 10 | `{id, label, floor}` | none | floor only goes up |
| `approval.human_required_for_all` | boolean | `false` | `true` |
| `evidence.min_claims` | integer 0–10 | 0 | higher |
| `evidence.min_snippet_chars` | integer 10–200 | 10 | higher |
| `evidence.source_domains[]` ≤ 20 | hostnames (lowercase ASCII) | none (any) | non-empty allowlist |
| `critic.max_artifact_chars` | integer 200–100000 | none | lower |
| `critic.forbidden_terms[]` ≤ 30 | literal text 2–60 chars | none | more terms |
| `critic.required_payload_fields[]` ≤ 10 | field names `[a-z_]{1,32}` | none | more fields |
| `limits.objective_max_chars` | integer 10–2000 | 2000 | lower |

There is **no `extends`/inheritance** in v1, no regular expressions, no URLs to fetch, no secret or environment references, and no way to name code.

Only the values above are in v1. `min_distinct_sources` is deliberately absent: the engine fetches one seed URL today, so it could not be satisfied (🔴 FUTURE).

---

## 4. Restrict-only rules 🔵

**4.1 Combination.** The engine computes an *effective policy* = for every key, the stricter of (format value, engine default). A value on the weaker side of the default (e.g. `min_snippet_chars: 5`, `limits.objective_max_chars: 5000`, `risk.floor` below `low`) is a **load error**, not a silent clamp, so authors see the mistake.

**4.2 What each rule does when it applies.** Nothing is ever silently waved through, and nothing is silently rejected without a record.

| Rule | Effect |
|---|---|
| `risk.floor`, mission-type floor | Tier is raised to at least the floor (`maxTier`, same function as today) |
| `risk.triggers` match | Tier raised to the trigger's tier. `objective` matches the operator's text; `claim`/`summary`/`artifact` match untrusted text. Because matches can only **raise** the tier, gaming untrusted text can only make things stricter |
| `approval.human_required_for_all` | A low-tier mission halts at AWAITING_APPROVAL; the gate refuses a system-class approval |
| `evidence.min_claims` / `min_snippet_chars` not met | Tier raised to `high`, halt at AWAITING_APPROVAL, reason recorded |
| `evidence.source_domains` | If the deployment's seed host is not in the list, the mission is refused **before any model call** and recorded as FAILED with a reason (fail closed, no quota spent) |
| `critic.*` checks | A failed check yields a FLAG verdict (the Critic's existing escalation path) with a stable reason code |
| `limits.objective_max_chars` | HTTP 400 at submission |

**4.3 Matching.** Literal, case-insensitive substring matching only. No regular expressions (rules out ReDoS), bounded list sizes, bounded lengths.

**4.4 Monotonicity guarantee (the property Test 26 enforces).** For every fixture mission, running under *any valid format* yields an outcome that is **at least as strict** as `general` on three measures: final risk tier, whether a human approval is required, and whether the mission proceeds to execution. A format can never produce a more permissive outcome than `general` for the same input.

*Clarification found during implementation:* a mission refused before any model call (a `source_domains` refusal) never reaches classification, so it has no meaningful final tier. For such missions the measure is that they **can never execute**, even if someone later records a forged human approval (the gate requires a preceding AWAITING_APPROVAL, which a refused mission never has). Test 26E checks this.

---

## 5. Binding, hashing and provenance 🔵

**5.1 Schema v2 (additive migration, `PRAGMA user_version` 1 → 2).**
- `missions` gains three nullable columns: `format_id`, `format_version`, `manifest_hash` (older rows stay NULL = "pre-format").
- New append-only table `format_manifests` (`hash` primary key, `format_id`, `format_version`, `manifest_json`, `effective_policy_json`, `registered_at`), protected by the same update/delete triggers as the audit tables.
- New append-only table `format_effects` (`id`, `mission_id`, `effect_code`, `detail`, `created_at`): one row for each policy effect that applied to a mission (e.g. `floor_applied`, `trigger:<id>`, `min_claims_not_met`, `domain_refused`). This is what `explain` reads. Nothing about format effects is inferred after the fact.
- A trigger forbids changing `format_id`, `format_version` or `manifest_hash` on an existing `missions` row once set (I10).
- An older build refuses a version-2 database (already implemented in `migrateVersioned`).

**5.2 Hash.** `manifest_hash` = SHA-256 (lowercase hex) of the **canonical** JSON of `{manifest, effective_policy}`: keys sorted, no whitespace, UTF-8, strings NFC-normalised, integers only (floats rejected), arrays kept in authored order. Hashing the effective policy too means: if the engine's own defaults are later hardened, the same file produces a new hash and **must get a new `format_version`**. This is intentional: no past mission can be described by a policy that did not govern it.

**5.3 Boot registration.** At boot the loader validates every file in `formats/`, computes hashes, and inserts into `format_manifests`. If `(format_id, format_version)` already exists with a **different** hash, the server refuses to start ("bump the version"). A format file that fails validation stops the boot; it never falls back to another format.

**5.4 Deleted or edited files.** Missions keep their stored manifest by hash, so a later edit or deletion of a file changes nothing about past missions or their `explain`.

---

## 6. Selection and authority 🔵

- Missions may carry optional `format_id` and `mission_type`. If absent, the deployment default applies (`COS_DEFAULT_FORMAT`, default `general`).
- `COS_ALLOWED_FORMATS` (comma list; default: all loaded) limits what an authenticated user may select. Unknown or disallowed format → HTTP 400.
- **Downgrade risk, stated plainly:** `general` is the weakest format, so a user who may select it can always choose it. A deployment that must never run `general` removes it from `COS_ALLOWED_FORMATS`; at least one format must remain.
- No runtime upload or editing of formats in v1; changing a format means a code deployment.

---

## 7. Gate and Decision Memory integration 🔵

**Gate (touches proven code, so it carries its own tests).** `gateExecuteInTx` additionally loads the mission's bound policy from `format_manifests` by `manifest_hash` and refuses execution if `human_required_for_all` is true and the approval row is system-class. If a mission has a hash but no stored manifest row, the gate **fails closed**. Missions with no format (pre-v2) behave exactly as today. Required evidence: Test 20 additions that fail on the pre-change gate, and no regression in Tests 20/21.

**Decision Memory.** `explain` gains the mission's `format_id@version`, the manifest hash, and its `format_effects` rows, with provenance. These are system-generated codes, not free text. Manifest text is returned only through the stored `format_manifests` row.

---

## 8. Security boundaries (threats and answers)

| ID | Threat | Answer |
|---|---|---|
| T1 | A manifest weakens a control | Closed vocabulary (no field for any invariant); weaker-than-default values rejected at load; monotonicity property test (§4.4) |
| T2 | Persona text acts as a prompt-injection channel | Persona is trusted-operator text but: ≤ 600 chars, printable only, checked at load against the injection patterns the engine already uses, placed in a delimited block **after** the engine's fixed instructions, and never sent to the classifier or gate. Controls are code, so persona text cannot change a tier, an approval or an execution. A test proves that the same objective gives the same tier and gate outcome with and without a hostile persona |
| T3 | Weaker format chosen at submit time | §6 allowlist; I10 binding; gate reads policy from the DB (I11) |
| T4 | Stored manifest or hash tampered with | `format_manifests` is append-only (triggers); hash covers manifest + effective policy; `explain` re-hashes and reports a mismatch |
| T5 | Manifest used to exfiltrate secrets or fetch content | No URL, secret or environment fields exist; the loader reads only `formats/*.json` from the deployed image |
| T6 | Denial of service through patterns or sizes | Literal matching only; caps on list sizes, string lengths and file size (≤ 16 KB, ≤ 50 files) |
| T7 | JSON tricks (duplicate keys, `__proto__`, `constructor`, deep nesting) | Strict parser pass: duplicate keys rejected, forbidden key names rejected, depth limit, plain-object parsing only |
| T8 | Unicode confusables, bidi or control characters | IDs ASCII-only; all text NFC-normalised, with control, bidi and zero-width characters rejected |
| T9 | Version confusion or rollback | Same id+version with a different hash refuses boot; missions pin their hash (I10) |
| T10 | A format flag bypasses the gate | Flags only add refusals; the gate keeps all existing checks first, and policy can only add more |
| T11 | An over-strict format blocks work | Accepted: strictness fails safe (halts or refuses with a recorded reason) |
| T12 | A future Router skips controls | Out of scope here; the Router may only choose among what the format allows and must pass the same invariants (separate spec and test) |

---

## 9. Ambiguities in the earlier proposal — and how they are resolved

| # | Ambiguity | Resolution |
|---|---|---|
| A1 | "Stricter" was undefined for non-numeric settings | Per-key table with explicit direction and bounds (§3) |
| A2 | "Choose specialists" implied subsets, but v1 runs a fixed four-stage chain with no Router | v1 formats cannot remove or reorder specialists; they only add constraints and persona. Subset selection waits for the Router |
| A3 | "Base-role ceilings" were vague | A role's ceiling is its fixed output schema and validator in code; formats cannot alter either |
| A4 | Keyword floors did not say what text they match | `where` field: operator text (`objective`) or untrusted stored text, both raise-only |
| A5 | "Minimum sources" could not be satisfied (one seed URL today) | Removed from v1; `min_claims` and a domain allowlist instead |
| A6 | Critic "extra checks" had no definition | A closed set: forbidden terms, required payload fields, max artifact size. Each can only produce FLAG |
| A7 | What happens on a policy violation was unstated | §4.2 table: escalate, halt, refuse or 400, always with a recorded reason |
| A8 | Who may pick a format, and can a user pick a weaker one | §6: allowlist and default; the downgrade is stated and controllable |
| A9 | How the hash is computed, and what it covers | §5.2: canonical JSON of manifest + effective policy |
| A10 | What if the engine's defaults change later | §5.2/5.3: the hash changes, a new version is mandatory, past missions keep their stored policy |
| A11 | How policy effects reach `explain` without inference | `format_effects` rows written at the time (§5.1) |
| A12 | Does the gate trust the request's format | No: it reads the bound policy from the DB (I11) |
| A13 | Do formats compose or inherit | No `extends` in v1: one standalone, fully validated manifest per format |

---

## 10. Test 26 plan (acceptance for the loader stage)

1. **Rejection suite:** every weakening attempt (each key on its weak side, unknown keys, duplicate keys, `__proto__`, floats, oversize, bad unicode, ids with uppercase or non-ASCII, persona with injection text) fails to load, and a failed file stops the boot.
2. **Monotonicity property test:** for all valid manifests in a generated set (plus mutations of them) and all fixture missions, the outcome is never more permissive than `general` (§4.4).
3. **`general` is the identity:** with `general`, Tests 19B–25 pass unchanged and the effective policy equals the engine defaults in code (single source of truth).
4. **Strict example (`smme_finance`):** human approval for all, `min_claims`, a domain allowlist, floors and triggers all escalate or refuse as specified, each with a `format_effects` row.
5. **Binding and hashing:** hash is stable across whitespace and key order; the mission binding cannot be updated; the same id+version with different content refuses boot; a tampered manifest row is detected by `explain`.
6. **Gate:** forged or system approval on a `human_required_for_all` mission is refused; a missing manifest row fails closed. These tests must **fail on the pre-change gate** (mutation check).
7. **Hostile persona:** identical tier and gate outcome with and without hostile persona text.
8. **Migration:** v1 → v2 is idempotent on fresh and existing databases; an older build refuses a v2 database.
9. **Selection:** disallowed or unknown `format_id` / `mission_type` → 400; defaults apply when omitted.
10. **Packaging:** the Dockerfile ships every new module and the `formats/` folder.

Reporting uses PROVEN / IMPLEMENTED / NEEDS TEST for each item, with raw output.

---

## 11. Out of scope for v1 🔴

Router and specialist selection · Ask/Assist/Delegate/Monitor/Mission task modes · multi-source fetching and `min_distinct_sources` · runtime format upload or editing · format inheritance (`extends`) · per-token format restrictions · semantic or vector memory · formats that add new specialists.

---

## 12. Decisions needing owner sign-off before any loader code

| # | Decision | Recommended default |
|---|---|---|
| D1 | Include capped persona text in v1? | **Yes**, ≤ 600 chars, load-time injection check (T2); the alternative is no persona text until a later version |
| D2 | Who selects a format? | **Operator chooses per mission**, limited by a deployment allowlist; the alternative is one pinned format per deployment |
| D3 | Record policy effects in a `format_effects` table? | **Yes** (v2 adds 3 columns and 2 append-only tables); the alternative is encoding effects in decision text |
| D4 | Keep multi-source evidence (`min_distinct_sources`) out of v1? | **Yes**, out until the engine can fetch more than one source |

---

## 13. Implementation notes (as built)

Where building required an interpretation, it is recorded here so it can be reviewed.

1. **`critic.required_payload_fields`:** the Creator's payload is free text, so a "field" is satisfied when the text contains a labelled line `<field>:` (optionally after `#`, `*`, `-` or `>`), or a JSON key `"<field>":`. Matching is case-insensitive and literal. *Owner to confirm this reading.*
2. **`persona.critic` is accepted but has no effect in v1:** the Critic is deterministic code, not a model, so there is no prompt for it to join. A test proves it appears in no prompt.
3. **`evidence.min_claims` above 1** is the only useful range today: the Researcher's validator already rejects a response with zero claims.
4. **Boot behaviour:** formats are validated at every boot, including read-only mode (which validates but does not register). Any problem exits with code 5 and the server never listens.
5. **Reason strings:** policy effects store stable codes (`floor_applied`, `trigger:<id>`, `min_claims_not_met`, `min_snippet_not_met`, `domain_refused`, `critic_check:<code>`, `human_required_for_all`, `format_bound`). Critic rationales carry only `format_checks_failed=<codes>`. No stored free text is used in any sentence the system writes.
6. **Gate:** besides the new `human_required_for_all` refusal, the existing rule "a system approval is refused once a human gate was raised" already blocks forged approvals in the normal flow. The new rule matters for the case where no gate was raised; Test 26 (26G-2b, 26G-8) constructs exactly that case and includes a mutation check.
7. **Dashboard:** unchanged. The format appears in Decision Memory (`getMission`, `explain`) and in the mission submission response.
8. **Shipped formats:** `general` (identity) and `smme_finance` (example). `smme_finance` allows only `raw.githubusercontent.com` as a source host, so it refuses missions on any deployment whose seed URL is elsewhere; that is intended behaviour for the example.
9. **Existing tests changed on purpose:** Test 23 now expects schema version 2 (four assertions); Test 25's dependency check (25A-4) now also allows the pure `format_canon.js`, with a new check (25A-4b) that this module is pure.

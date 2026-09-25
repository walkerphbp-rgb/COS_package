-- Test 17 / FINAL ACCEPTANCE — End-to-End Chief of Staff
-- Self-contained schema. Reuses the provider_calls shape from Test 16 verbatim
-- (specialist column already generic) and adds the rest of the validated
-- Test 13-15 chain: grounded claims, deterministic risk classification,
-- recommendations, versioned artifacts, critic reviews, the full
-- PROPOSED->APPROVED->EXECUTED->COMPLETED / REJECTED decision lifecycle,
-- and an execution_log that only ever gets a row via the enforced approval check.

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  request_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED',
  risk_tier TEXT NOT NULL DEFAULT 'low',   -- low | medium | high, escalate-only over the mission's life
  created_at TEXT NOT NULL
);

-- One row per specialist call attempt (Researcher, Analyst, or Creator), regardless
-- of which provider ultimately answered. Identical shape to Test 16.
CREATE TABLE provider_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  call_seq INTEGER NOT NULL,
  specialist TEXT NOT NULL,          -- 'researcher' | 'analyst' | 'creator'
  provider_attempted TEXT NOT NULL,
  provider_used TEXT NOT NULL,
  fallback_triggered INTEGER NOT NULL DEFAULT 0,
  attempted_status_code INTEGER,
  injected_failure INTEGER NOT NULL DEFAULT 0,
  schema_valid INTEGER NOT NULL DEFAULT 0,
  raw_output TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

-- Real fetch attempts backing Researcher claims (Node-side fetch, no CORS —
-- closes the open item from Test 15 where browser-side fetch to Google's
-- domains failed via direct request and two CORS-bypass proxies).
CREATE TABLE fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  url TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

-- Grounded claims: fetch_match is the code-enforced containment check
-- (evidence_snippet must actually appear in fetched bytes), not a prompted rule.
CREATE TABLE claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  provider_call_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  source_url TEXT,
  evidence_snippet TEXT,
  confidence REAL,
  fetch_match INTEGER NOT NULL DEFAULT 0,  -- 1 = evidence_snippet verified present in fetched bytes
  poisoned INTEGER NOT NULL DEFAULT 0,     -- 1 = test harness deliberately injected adversarial content
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id),
  FOREIGN KEY (provider_call_id) REFERENCES provider_calls(id)
);

-- Analyst synthesis. llm_self_tier is stored for audit only; risk_tier on the
-- mission row is always the software classifier's value and is never set from
-- llm_self_tier, even when llm_self_tier is lower.
CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  provider_call_id INTEGER NOT NULL,
  claim_ids TEXT NOT NULL,          -- JSON array of claims.id this recommendation is based on
  summary TEXT NOT NULL,
  llm_self_tier TEXT NOT NULL,      -- what the Analyst itself claimed (untrusted)
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id),
  FOREIGN KEY (provider_call_id) REFERENCES provider_calls(id)
);

-- Creator output. Versioned per (recommendation_id, type) — regenerating never
-- overwrites a prior version, so a past decision's basis is never silently lost.
CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  recommendation_id INTEGER NOT NULL,
  provider_call_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id),
  FOREIGN KEY (recommendation_id) REFERENCES recommendations(id),
  FOREIGN KEY (provider_call_id) REFERENCES provider_calls(id)
);

-- Critic never auto-terminates a mission. A REJECT/FLAG verdict here only
-- escalates the mission's risk_tier and forces a human decision point.
CREATE TABLE critic_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  target_type TEXT NOT NULL,   -- 'claim' | 'artifact'
  target_id INTEGER NOT NULL,
  verdict TEXT NOT NULL,       -- PASS | REJECT | FLAG
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

-- Full audit trail. Every lifecycle transition gets a row here, in order,
-- with a real timestamp. Nothing in this table is ever rewritten — a
-- correction is a new row, never an UPDATE.
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  status TEXT NOT NULL,        -- PROPOSED | RESEARCHED | ANALYZED | ARTIFACT_DRAFTED |
                                -- ARTIFACT_VERIFIED | AWAITING_APPROVAL | APPROVED |
                                -- REJECTED | EXECUTED | COMPLETED
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

-- Only ever written by execute(), and execute() refuses to run unless it can
-- read back a genuine APPROVED row for this mission from the database first —
-- this table existing with a row for a mission is itself the proof the
-- approval boundary was not bypassed.
CREATE TABLE execution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

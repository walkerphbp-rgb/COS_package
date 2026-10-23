-- Test 16: Provider Fallback (Gemini primary -> Groq fallback on rate limit)
-- Self-contained schema, independent of Tests 05-15's DB file.

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  request_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED',
  created_at TEXT NOT NULL
);

-- One row per specialist call attempt, regardless of which provider ultimately answered.
CREATE TABLE provider_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  call_seq INTEGER NOT NULL,        -- order within the mission (1st call, 2nd call, ...)
  specialist TEXT NOT NULL,         -- e.g. 'researcher'
  provider_attempted TEXT NOT NULL, -- provider tried first for this call ('gemini')
  provider_used TEXT NOT NULL,      -- provider that actually produced the response
  fallback_triggered INTEGER NOT NULL DEFAULT 0, -- 0/1
  attempted_status_code INTEGER,    -- status code from the attempted provider (e.g. 429), NULL if it succeeded
  injected_failure INTEGER NOT NULL DEFAULT 0, -- 1 if the 429 was deliberately injected by the test harness, 0 if organic
  schema_valid INTEGER NOT NULL DEFAULT 0, -- 0/1, does the response match the required JSON shape
  raw_output TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id)
);

CREATE TABLE claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  provider_call_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id),
  FOREIGN KEY (provider_call_id) REFERENCES provider_calls(id)
);

CREATE TABLE critic_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  claim_id INTEGER NOT NULL,
  verdict TEXT NOT NULL,   -- PASS / REJECT / FLAG
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id),
  FOREIGN KEY (claim_id) REFERENCES claims(id)
);

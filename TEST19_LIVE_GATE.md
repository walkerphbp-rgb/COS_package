# TEST 19-LIVE-GATE: Live mission on the integrated gate

Repo: COS_package (main, 31 commits, 0981996)
Target: https://cos-package.onrender.com (v1.2.0, mode LIVE)

## Purpose
Test 19 was closed on the pre-integration code. This re-runs it against the
deployed canonical gate (gate.js via cos_backend.js and mission_chain.js, with
migrations at boot) to prove the live path still works end to end.

## Status legend
PROVEN / IMPLEMENTED / NEEDS TEST / DESIGN ONLY

| Item | Status |
|---|---|
| Canonical gate wired into backend + mission_chain | PROVEN (local: 19B/C/D, 20, 21 green on fresh clone) |
| Render DB guards active | PROVEN (/health db.guards ok:true, missing:[]) |
| Live Gemini mission on new gate | NEEDS TEST (this test) |
| Persistent audit storage | NEEDS TEST (Render free plan = ephemeral DB) |

## Preconditions
1. Render deploy is Live at 0981996 or later; GEMINI_API_KEY, COS_TOKEN, COS_MODE=LIVE set.
2. GET /health shows version 1.2.0, mode LIVE, db.guards ok:true, missing:[].
3. Do NOT redeploy or restart between submission and read-back (free plan wipes the DB).
4. Runner: test19_mission_runner.html (standalone file, not a published page).

## Procedure
1. Open the runner, enter backend URL and operator token, generate a fresh nonce (LIVE_MISSION_<epoch>).
2. Record local submission time (SAST and UTC).
3. POST /api/missions {objective, nonce}.
4. Independently GET /api/snapshot and inspect the mission, provider calls, audit, decisions.
5. Re-POST a decision on the same mission (repeat attempt).
6. Gate B: read request count from Google AI Studio usage (Last Hour view) for the window.

## Gate A: acceptance criteria (automatic, HTTP)
- A1 POST returns HTTP 201.
- A2 providerUsed = gemini for Researcher, Analyst, Creator (3 calls, all 200, schema_valid true).
- A3 riskTier = low, criticVerdict = PASS, outcome = AUTO_COMPLETED.
- A4 Nonce present in the provider response, claims[0].text, and the Creator artifact payload.
- A5 Approval text on the auto-completed mission is "system: auto-approved (low risk tier + critic PASS)" and no human gate was raised.
- A6 Snapshot re-read shows the mission, memory.fresh_readback.status = VERIFIED.
- A7 Audit: MISSION_SUBMITTED has violation:false; timestamps monotonic; no EXECUTED without a prior APPROVED.
- A8 Exactly one execution row for the mission.
- A9 Repeat decision on the completed mission returns 409 and adds no execution or decision row.

## Gate B: independent provider confirmation
Human-entered count of Generative Language API requests for the call window
from Google AI Studio. Expected: 3. "skip" or no answer = FAIL.

## Result
TEST19_LIVE_GATE result = PASS only if all of A1-A9 pass AND Gate B count matches
the run's own window (not an earlier mission's window).

## Evidence to capture
Raw runner JSON, snapshot excerpt (mission, provider calls, audit), /health output
before the run, mission id, nonce, UTC window, AI Studio count.

## Known limits
- DB is ephemeral on Render free plan; this test proves the live path, not audit durability.
- Persistence check (separate, after Starter + Disk at /data): redeploy twice, confirm /health init.result is "not_needed" and an earlier mission still shows.
- A failure run (provider error) is covered by 19D, not repeated here.

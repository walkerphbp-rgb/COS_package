'use strict';
/* Canonical execution gate (fixed). The ONLY writer of EXECUTED/COMPLETED.
 * Refuses unless, read from the DB inside one transaction:
 *  1. mission exists and has not already been executed (exactly-once, checked FIRST)
 *  2. latest decision is not REJECTED, and no REJECTED follows the APPROVED row
 *  3. an APPROVED row exists for THIS mission
 *  4. that APPROVED row is human-issued ("human: approved by ...")
 *  5. that APPROVED row follows an AWAITING_APPROVAL row (cannot be inserted cold)
 * Limits: a writer with raw DB access can still fabricate all of the above;
 * append-only triggers (step 3) are the backstop for that. */
const HUMAN_RE = /^human: approved by \S/;
const SYSTEM_RE = /^system: auto-approved \(low risk tier \+ critic PASS\)/;
/* Core checks + writes. Caller MUST already hold an open transaction (BEGIN IMMEDIATE).
 * Two approval classes: HUMAN (must follow AWAITING_APPROVAL) and SYSTEM (deterministic low-risk
 * path: mission tier is low, critic verdicts all PASS, and NO human gate was ever raised). */
function gateExecuteInTx(db, missionId, ts) {
  ts = ts || new Date().toISOString();
  const refuse = (why) => { throw new Error(`BOUNDARY VIOLATION BLOCKED: mission ${missionId} ${why} — execution refused`); };
  {
    if (!db.prepare(`SELECT 1 FROM missions WHERE id = ?`).get(missionId)) refuse('does not exist');
    if (db.prepare(`SELECT 1 FROM execution_log WHERE mission_id = ?`).get(missionId) ||
        db.prepare(`SELECT 1 FROM decisions WHERE mission_id = ? AND status IN ('EXECUTED','COMPLETED')`).get(missionId))
      refuse('already executed (exactly-once)');
    const ap = db.prepare(`SELECT id, rationale FROM decisions WHERE mission_id = ? AND status = 'APPROVED' ORDER BY id DESC LIMIT 1`).get(missionId);
    if (!ap) refuse('has no APPROVED decision row');
    if (db.prepare(`SELECT 1 FROM decisions WHERE mission_id = ? AND id > ? AND status = 'REJECTED'`).get(missionId, ap.id)) refuse('was rejected after approval');
    const raised = db.prepare(`SELECT 1 FROM decisions WHERE mission_id = ? AND status = 'AWAITING_APPROVAL'`).get(missionId);
    if (HUMAN_RE.test(ap.rationale)) {
      if (!db.prepare(`SELECT 1 FROM decisions WHERE mission_id = ? AND id < ? AND status = 'AWAITING_APPROVAL'`).get(missionId, ap.id)) refuse('APPROVED row has no preceding AWAITING_APPROVAL');
    } else if (SYSTEM_RE.test(ap.rationale)) {
      if (raised) refuse('system approval refused: a human approval gate was raised for this mission');
      const m = db.prepare(`SELECT risk_tier FROM missions WHERE id = ?`).get(missionId);
      if (m.risk_tier !== 'low') refuse(`system approval refused: risk_tier=${m.risk_tier}, not low`);
      const v = db.prepare(`SELECT COUNT(*) n, SUM(verdict = 'PASS') p FROM critic_reviews WHERE mission_id = ?`).get(missionId);
      if (!v.n || v.p !== v.n) refuse('system approval refused: critic verdicts are not all PASS');
    } else refuse('APPROVED row is neither human-issued nor a valid system approval');
    const d = `executed under decision id=${ap.id}`;
    db.prepare(`INSERT INTO execution_log (mission_id, detail, created_at) VALUES (?,?,?)`).run(missionId, d, ts);
    db.prepare(`INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES (?,?,?,?)`).run(missionId, 'EXECUTED', d, ts);
    db.prepare(`INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES (?,?,?,?)`).run(missionId, 'COMPLETED', 'mission complete', ts);
  }
}
/* Standalone entry: owns its own transaction. */
function gateExecute(db, missionId, ts) {
  db.exec('BEGIN IMMEDIATE');
  try { gateExecuteInTx(db, missionId, ts); db.exec('COMMIT'); }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
module.exports = { gateExecute, gateExecuteInTx, SYSTEM_APPROVAL_TEXT: 'system: auto-approved (low risk tier + critic PASS)' };

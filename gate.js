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
function gateExecute(db, missionId, ts) {
  ts = ts || new Date().toISOString();
  const refuse = (why) => { throw new Error(`BOUNDARY VIOLATION BLOCKED: mission ${missionId} ${why} — execution refused`); };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare(`SELECT 1 FROM missions WHERE id = ?`).get(missionId)) refuse('does not exist');
    if (db.prepare(`SELECT 1 FROM execution_log WHERE mission_id = ?`).get(missionId) ||
        db.prepare(`SELECT 1 FROM decisions WHERE mission_id = ? AND status IN ('EXECUTED','COMPLETED')`).get(missionId))
      refuse('already executed (exactly-once)');
    const ap = db.prepare(`SELECT id, rationale FROM decisions WHERE mission_id = ? AND status = 'APPROVED' ORDER BY id DESC LIMIT 1`).get(missionId);
    if (!ap) refuse('has no APPROVED decision row');
    if (db.prepare(`SELECT 1 FROM decisions WHERE mission_id = ? AND id > ? AND status = 'REJECTED'`).get(missionId, ap.id)) refuse('was rejected after approval');
    if (!/^human: approved by \S/.test(ap.rationale)) refuse('APPROVED row is not human-issued');
    if (!db.prepare(`SELECT 1 FROM decisions WHERE mission_id = ? AND id < ? AND status = 'AWAITING_APPROVAL'`).get(missionId, ap.id)) refuse('APPROVED row has no preceding AWAITING_APPROVAL');
    const d = `executed under decision id=${ap.id}`;
    db.prepare(`INSERT INTO execution_log (mission_id, detail, created_at) VALUES (?,?,?)`).run(missionId, d, ts);
    db.prepare(`INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES (?,?,?,?)`).run(missionId, 'EXECUTED', d, ts);
    db.prepare(`INSERT INTO decisions (mission_id,status,rationale,created_at) VALUES (?,?,?,?)`).run(missionId, 'COMPLETED', 'mission complete', ts);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
module.exports = { gateExecute };

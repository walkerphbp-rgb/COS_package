'use strict';
/* FROZEN pre-hardening baseline execute(). TEST FIXTURE ONLY: never require this from production code.
 * Exists so the Test 20 mutation harness can prove the tests detect the original defects. */
const nowISO = () => new Date().toISOString();
function recordDecision(db, missionId, status, rationale) {
  db.prepare(`INSERT INTO decisions (mission_id, status, rationale, created_at) VALUES (?, ?, ?, ?)`).run(missionId, status, rationale, nowISO());
}
function execute(db, missionId) {
  const row = db.prepare(`SELECT id FROM decisions WHERE mission_id = ? AND status = 'APPROVED' ORDER BY id DESC LIMIT 1`).get(missionId);
  if (!row) throw new Error(`BOUNDARY VIOLATION BLOCKED: mission ${missionId} has no APPROVED decision row — execution refused`);
  const ts = nowISO();
  db.prepare(`INSERT INTO execution_log (mission_id, detail, created_at) VALUES (?, ?, ?)`)
    .run(missionId, `executed under decision id=${row.id}`, ts);
  recordDecision(db, missionId, 'EXECUTED', `executed under decision id=${row.id}`);
  recordDecision(db, missionId, 'COMPLETED', 'mission complete');
}
module.exports = { execute };

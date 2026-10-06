'use strict';
/* Idempotent migrations: append-only protection for the audit tables.
 * Safe to run on every boot against an existing DB (CREATE ... IF NOT EXISTS,
 * additive only: no table rebuilds, no data touched, no schema columns changed).
 * Never throws: returns a report so the caller can boot and surface "degraded". */
const APPEND_ONLY = ['decisions', 'critic_reviews', 'execution_log'];

function migrate(db) {
  const r = { applied: [], present: [], skipped: [], warnings: [], ok: true };
  const has = (type, name) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type=? AND name=?`).get(type, name);
  for (const t of APPEND_ONLY) {
    if (!has('table', t)) { r.warnings.push(`table ${t} missing; guard skipped`); r.ok = false; continue; }
    for (const op of ['UPDATE', 'DELETE']) {
      const name = `cos_append_only_${t}_${op.toLowerCase()}`;
      if (has('trigger', name)) { r.present.push(name); continue; }
      try {
        db.exec(`CREATE TRIGGER ${name} BEFORE ${op} ON ${t} BEGIN SELECT RAISE(ABORT, 'append-only: ${op} on ${t} is not allowed'); END;`);
        r.applied.push(name);
      } catch (e) { r.warnings.push(`${name}: ${e.message}`); r.ok = false; }
    }
  }
  // Hard DB-level exactly-once backstop for execution (only if existing data allows it).
  const idx = 'cos_ux_execution_once';
  if (has('table', 'execution_log')) {
    if (has('index', idx)) r.present.push(idx);
    else {
      const dup = db.prepare(`SELECT mission_id, COUNT(*) c FROM execution_log GROUP BY mission_id HAVING c > 1`).all();
      if (dup.length) { r.skipped.push(`${idx}: ${dup.length} mission(s) already have duplicate execution_log rows (not modified; review manually)`); r.ok = false; }
      else try { db.exec(`CREATE UNIQUE INDEX ${idx} ON execution_log(mission_id)`); r.applied.push(idx); }
      catch (e) { r.warnings.push(`${idx}: ${e.message}`); r.ok = false; }
    }
  }
  return r;
}

/* Read-only check, for /health. */
function guardStatus(db) {
  const want = [];
  for (const t of APPEND_ONLY) for (const op of ['update', 'delete']) want.push(['trigger', `cos_append_only_${t}_${op}`]);
  want.push(['index', 'cos_ux_execution_once']);
  const missing = want.filter(([ty, n]) => !db.prepare(`SELECT 1 FROM sqlite_master WHERE type=? AND name=?`).get(ty, n)).map(x => x[1]);
  return { ok: missing.length === 0, missing };
}

/* ---- Schema versioning (PRAGMA user_version) ----
 * v0 = a DB that predates versioning (every DB created before this change, including production).
 * v1 = base test17 schema + the append-only guards from migrate(). Stamping v0 -> v1 changes no data.
 * A DB stamped NEWER than this code understands is refused (an older build must not run on a newer
 * schema). A migration that throws, or that cannot create a required table/trigger, is FATAL.
 * A legacy-duplicate execution_log index skip stays non-fatal (documented in Test 21D-7). */
const SCHEMA_VERSION = 1;
const CORE_TABLES = ['missions', 'decisions', 'execution_log', 'critic_reviews'];

function migrateVersioned(db) {
  const out = { schema_version: SCHEMA_VERSION, version_before: null, version_after: null, fatal: false, errors: [], report: null };
  const getV = () => Number(Object.values(db.prepare('PRAGMA user_version').get())[0]);
  try {
    out.version_before = getV();
    if (out.version_before > SCHEMA_VERSION) {
      out.fatal = true; out.errors.push(`database schema version ${out.version_before} is newer than this build supports (${SCHEMA_VERSION}); refusing to run an older build on a newer schema`);
      out.version_after = out.version_before; return out;
    }
    const missing = CORE_TABLES.filter(t => !db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t));
    if (missing.length) { out.fatal = true; out.errors.push(`core table(s) missing: ${missing.join(', ')}; refusing to run on an incompatible schema`); out.version_after = out.version_before; return out; }
    out.report = migrate(db);
    if (out.report.warnings.length) { out.fatal = true; out.errors.push(...out.report.warnings); }
    if (!out.fatal && out.version_before < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    out.version_after = getV();
  } catch (e) { out.fatal = true; out.errors.push(`migration failed: ${e.message}`); }
  return out;
}
module.exports = { migrate, guardStatus, APPEND_ONLY, SCHEMA_VERSION, CORE_TABLES, migrateVersioned };

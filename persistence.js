'use strict';
/* Persistence configuration + production guard. Deployment-neutral: nothing here knows about Render.
 *
 *   COS_DB_PATH              SQLite file. Falls back to the legacy COS_DB, then ./cos.db beside the code.
 *   COS_REQUIRE_PERSISTENT   1 = fail closed unless the DB provably lives under COS_PERSISTENT_ROOT.
 *   COS_PERSISTENT_ROOT      directory the platform persists (e.g. /data on a Render Persistent Disk).
 *
 * The guard never asks "does the DB file exist?": a fresh persistent disk legitimately has none yet.
 * It asks: is the path under the persistent root, does the root exist, can we write beside the DB.
 * Symlinks are resolved so /data/cos.db -> /tmp/x cannot pass. */
const fs = require('node:fs');
const path = require('node:path');

function resolveConfig(env, baseDir) {
  const raw = env.COS_DB_PATH || env.COS_DB || '';
  const source = env.COS_DB_PATH ? 'COS_DB_PATH' : env.COS_DB ? 'COS_DB (legacy)' : 'default';
  return {
    dbPath: path.resolve(raw || path.join(baseDir, 'cos.db')),
    dbPathSource: source,
    requirePersistent: env.COS_REQUIRE_PERSISTENT === '1',
    persistentRoot: env.COS_PERSISTENT_ROOT ? path.resolve(env.COS_PERSISTENT_ROOT) : null,
  };
}

const isInside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };

/* Read-only facts (no writes): used by /health and by the guard. */
function inspect(cfg) {
  const dir = path.dirname(cfg.dbPath);
  const rootReal = cfg.persistentRoot ? real(cfg.persistentRoot) : null;
  const dirReal = real(dir);
  const fileExists = fs.existsSync(cfg.dbPath);
  const fileReal = fileExists ? real(cfg.dbPath) : null;
  // Where the DB bytes will physically live (follows symlinks on the file and on the directory).
  const physical = fileReal || (dirReal ? path.join(dirReal, path.basename(cfg.dbPath)) : null);
  let writable = false;
  try { fs.accessSync(dir, fs.constants.W_OK); writable = true; } catch {}
  let separateFs = null;
  try { if (rootReal) separateFs = fs.statSync(rootReal).dev !== fs.statSync(path.parse(rootReal).root).dev; } catch {}
  return {
    db_path: cfg.dbPath,
    db_path_source: cfg.dbPathSource,
    require_persistent: cfg.requirePersistent,
    persistent_root: cfg.persistentRoot,
    persistent_root_exists: !!rootReal,
    db_file_exists: fileExists,
    db_dir_exists: !!dirReal,
    db_dir_writable: writable,
    // lexical AND physical (symlink-resolved) containment; null when no root is configured
    db_path_inside_root: cfg.persistentRoot ? (isInside(cfg.persistentRoot, cfg.dbPath) && !!rootReal && !!physical && isInside(rootReal, physical)) : null,
    // Evidence only (not enforced): a real mounted disk is normally a different filesystem from "/".
    root_on_separate_filesystem: separateFs,
    wal_sidecars: `${cfg.dbPath}-wal, ${cfg.dbPath}-shm (beside the DB file)`,
  };
}

/* Boot guard. Returns { ok, errors[], info }. Performs one tiny write probe (boot only). */
function checkGuard(cfg, { readonly = false } = {}) {
  const info = inspect(cfg);
  const errors = [];
  if (!cfg.requirePersistent) return { ok: true, errors, info, required: false };
  if (!cfg.persistentRoot) errors.push('COS_REQUIRE_PERSISTENT=1 but COS_PERSISTENT_ROOT is not set, so persistence cannot be verified');
  else {
    if (!info.persistent_root_exists) errors.push(`persistent root does not exist: ${cfg.persistentRoot} (is the disk attached and mounted there?)`);
    else if (path.parse(real(cfg.persistentRoot)).root === real(cfg.persistentRoot)) errors.push('persistent root must not be the filesystem root');
    if (!info.db_path_inside_root) errors.push(`database path ${cfg.dbPath} is outside the persistent root ${cfg.persistentRoot} (it would live on ephemeral storage)`);
  }
  if (!info.db_dir_exists) errors.push(`database directory does not exist: ${path.dirname(cfg.dbPath)}`);
  else if (!readonly) {
    const probe = path.join(path.dirname(cfg.dbPath), `.cos_write_probe_${process.pid}`);
    try { fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe); }
    catch (e) { errors.push(`database directory is not writable: ${path.dirname(cfg.dbPath)} (${e.code || e.message})`); }
  }
  return { ok: errors.length === 0, errors, info, required: true };
}

const BUSY_TIMEOUT_MS = 5000;

/* WAL is stored in the DB file header, so setting it once at boot is enough; every connection
 * still gets a busy timeout. Evidence (read-only) mode never changes the journal mode. */
function bootPragmas(db, { readonly = false } = {}) {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  if (!readonly) db.exec('PRAGMA journal_mode = WAL;');
  return String(Object.values(db.prepare('PRAGMA journal_mode').get())[0]).toLowerCase();
}

module.exports = { resolveConfig, inspect, checkGuard, bootPragmas, BUSY_TIMEOUT_MS, isInside };

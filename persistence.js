'use strict';
/* Persistence configuration + production guard. Deployment-neutral: nothing here knows about Render.
 *
 *   COS_DB_PATH              SQLite file. Falls back to the legacy COS_DB, then ./cos.db beside the code.
 *   COS_REQUIRE_PERSISTENT   1 = fail closed unless the DB provably lives under COS_PERSISTENT_ROOT.
 *   COS_PERSISTENT_ROOT      directory the platform persists (e.g. /data on a Render Persistent Disk).
 *   COS_REQUIRE_MOUNT        1 (with the two above) = ALSO refuse unless that root is on its own mount point,
 *                            i.e. a real disk is attached rather than a folder inside the image.
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
    requireMount: env.COS_REQUIRE_MOUNT === '1',
  };
}

/* Which mount point holds this directory? Parsed from /proc/self/mountinfo (Linux). A real disk/volume appears
 * as its own mount point (e.g. /data); a directory that merely exists inside the container image does not, and
 * resolves to "/". (st_dev comparison was tried first and proved unreliable on Render: it reported a
 * separate filesystem on a Free instance that cannot have a disk.) Returns null when it cannot be determined. */
const unescapeMount = x => x.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
function containingMount(dir, mountinfoPath = '/proc/self/mountinfo') {
  let txt; try { txt = fs.readFileSync(mountinfoPath, 'utf8'); } catch { return null; }
  const points = txt.split('\n').map(l => l.split(' ')[4]).filter(Boolean).map(unescapeMount);
  if (!points.length) return null;
  let best = null;
  for (const m of points) if ((m === '/' || dir === m || dir.startsWith(m.endsWith('/') ? m : m + '/')) && (!best || m.length > best.length)) best = m;
  return best;
}

const isInside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };

/* Read-only facts (no writes): used by /health and by the guard. */
function inspect(cfg, { mountinfoPath } = {}) {
  const dir = path.dirname(cfg.dbPath);
  const rootReal = cfg.persistentRoot ? real(cfg.persistentRoot) : null;
  const dirReal = real(dir);
  const fileExists = fs.existsSync(cfg.dbPath);
  const fileReal = fileExists ? real(cfg.dbPath) : null;
  // Where the DB bytes will physically live (follows symlinks on the file and on the directory).
  const physical = fileReal || (dirReal ? path.join(dirReal, path.basename(cfg.dbPath)) : null);
  let writable = false;
  try { fs.accessSync(dir, fs.constants.W_OK); writable = true; } catch {}
  const mount = rootReal ? containingMount(rootReal, mountinfoPath) : null;
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
    // Evidence: is the persistent root on a mount of its own (a real disk/volume), or just a folder inside the
    // container image? true = own mount, false = part of the container's root filesystem (ephemeral), null = unknown.
    root_mount_point: mount,
    root_on_dedicated_mount: mount === null ? null : mount !== '/',
    wal_sidecars: `${cfg.dbPath}-wal, ${cfg.dbPath}-shm (beside the DB file)`,
  };
}

/* Boot guard. Returns { ok, errors[], info }. Performs one tiny write probe (boot only). */
function checkGuard(cfg, { readonly = false, mountinfoPath } = {}) {
  const info = inspect(cfg, { mountinfoPath });
  const errors = [];
  if (!cfg.requirePersistent) return { ok: true, errors, info, required: false };
  if (cfg.requireMount && cfg.persistentRoot) {   // opt-in: COS_REQUIRE_MOUNT=1
    if (info.root_on_dedicated_mount === false) errors.push(`persistent root ${cfg.persistentRoot} is not on a dedicated mount (it is part of the container filesystem, so a redeploy would erase it); is the disk attached and mounted there?`);
    else if (info.root_on_dedicated_mount === null) errors.push('COS_REQUIRE_MOUNT=1 but the mount table could not be read, so the disk mount cannot be verified');
  }
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

module.exports = { resolveConfig, inspect, containingMount, checkGuard, bootPragmas, BUSY_TIMEOUT_MS, isInside };

'use strict';
/* Container entrypoint (no extra packages, no wrapper process: it becomes the server).
 *
 * Why: hosts such as Render mount a fresh persistent disk root-owned, while the app should not run as
 * root. Nothing in the image build can fix that (the disk is not attached at build time), so it is done
 * once at container start:
 *   1. if started as root, chown ONLY the persistent directory itself (non-recursive) and the existing DB
 *      files (cos.db, -wal, -shm, -journal) to the app user; symlinks are never followed or chowned;
 *   2. drop to the app user (setgroups, setgid, setuid) and VERIFY the drop, or exit 1;
 *   3. require the real server, which then runs unprivileged and still applies its own persistence guard.
 * If already started as a non-root user (e.g. docker run --user), step 1-2 are skipped. */
const fs = require('node:fs');
const path = require('node:path');
const { resolveConfig } = require('./persistence');

const UID = Number(process.env.COS_RUN_UID || 1000), GID = Number(process.env.COS_RUN_GID || 1000);
const die = m => { console.error(`ENTRYPOINT REFUSING TO START: ${m}`); process.exit(1); };

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  if (!Number.isInteger(UID) || !Number.isInteger(GID) || UID <= 0 || GID <= 0) die(`COS_RUN_UID/COS_RUN_GID must be positive integers (got ${process.env.COS_RUN_UID}/${process.env.COS_RUN_GID}); refusing to keep running as root`);
  const cfg = resolveConfig(process.env, __dirname);
  const dir = path.dirname(cfg.dbPath);
  const targets = [dir, ...['', '-wal', '-shm', '-journal'].map(x => cfg.dbPath + x)];
  const changed = [];
  if (dir === path.parse(dir).root) console.warn('ENTRYPOINT: DB directory is the filesystem root; not chowning anything');
  else for (const t of targets) {
    try {
      const st = fs.lstatSync(t);
      if (st.isSymbolicLink()) { console.warn(`ENTRYPOINT: not chowning symlink ${t}`); continue; }
      if (st.uid !== UID || st.gid !== GID) { fs.chownSync(t, UID, GID); changed.push(t); }
    } catch (e) { if (e.code !== 'ENOENT') console.warn(`ENTRYPOINT: could not chown ${t}: ${e.code || e.message}`); }
  }
  try { process.setgroups([]); process.setgid(GID); process.setuid(UID); }
  catch (e) { die(`could not drop privileges to ${UID}:${GID}: ${e.message}`); }
  if (process.getuid() !== UID || process.geteuid() !== UID || process.getgid() !== GID) die('privilege drop did not take effect');
  try { process.setuid(0); die('privilege drop is reversible'); } catch { /* expected: cannot regain root */ }
  console.log(`ENTRYPOINT: chowned ${changed.length} path(s) [${changed.join(', ') || 'none needed'}]; now running as uid=${process.getuid()} gid=${process.getgid()}`);
}
require('./cos_backend.js');

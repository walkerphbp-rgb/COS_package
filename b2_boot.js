'use strict';
/* Boot-time B2 step, run by cos_backend.js BEFORE the database is created or opened (it is a separate process so the
 * server's synchronous boot sequence is unchanged). It restores the database from B2 ONLY if the local file is missing,
 * then claims the single-writer lease. Exit codes: 0 = ok (including "nothing to do"), 7 = refuse to start.
 * stdout carries exactly one line: COS_B2_BOOT_RESULT <json> (no credentials). Diagnostics go to stderr. */
const { loadConfig, clientFor, restoreIfNeeded, claimLease, scrubWith, BackupConfigError, RestoreError } = require('./b2_backup');
const persistence = require('./persistence');
const { SCHEMA_VERSION } = require('./db_migrations');
const out = o => process.stdout.write('COS_B2_BOOT_RESULT ' + JSON.stringify(o) + '\n');

(async () => {
  let cfg;
  try { cfg = loadConfig(process.env); } catch (e) { process.stderr.write(`B2 BACKUP CONFIG ERROR: ${e.message}\n`); process.exit(e instanceof BackupConfigError ? 7 : 1); }
  if (!cfg.enabled) { out({ enabled: false }); return; }
  const scrub = scrubWith(cfg), dbPath = persistence.resolveConfig(process.env, __dirname).dbPath, s3 = clientFor(cfg);
  let restore;
  try { restore = await restoreIfNeeded({ s3, cfg, dbPath, maxSchema: SCHEMA_VERSION }); }
  catch (e) { process.stderr.write(`B2 RESTORE REFUSED: ${scrub(e.message)}\n`); process.exit(7); }
  let lease = { ok: false, reason: 'not attempted' };
  try { lease = await claimLease(s3, cfg); } catch (e) { process.stderr.write(`B2 lease not claimed at boot (will retry): ${scrub(e.message)}\n`); lease = { ok: false, reason: 'unreachable' }; }
  process.stderr.write(`B2 backup: ${restore.performed ? `restored ${restore.key.split('/').pop()} (${restore.bytes} bytes${restore.fallback ? ', FALLBACK to an older snapshot' : ''})` : `no restore (${restore.reason})`}; lease ${lease.ok ? 'epoch ' + lease.epoch : 'pending'}\n`);
  out({ enabled: true, restore, lease: lease.ok ? { ok: true, writerId: lease.writerId, epoch: lease.epoch } : { ok: false } });
})().catch(e => { process.stderr.write(`B2 boot error: ${String(e && e.message).slice(0, 200)}\n`); process.exit(7); });

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
  process.stderr.write(`B2 target: endpoint=${cfg.endpointHost} region=${cfg.region} bucket=${cfg.bucket} prefix=${cfg.prefix || '(none)'} key-id-length=${cfg.keyId.length}\n`);   // no secret; lets a typo be spotted from the log
  const HINTS = [[/InvalidAccessKeyId/, 'Backblaze did not recognise the key id on this endpoint. Check that COS_B2_KEY_ID is the application key\'s keyID (not the account ID or the key name), that COS_B2_ENDPOINT is exactly the bucket\'s S3 endpoint (the region must match the bucket), and that the key has not been deleted.'],
    [/SignatureDoesNotMatch/, 'The key id was recognised but the application key does not match it. Re-enter COS_B2_APP_KEY (it is shown only once when the key is created; create a new key if it was lost).'],
    [/NoSuchBucket/, 'Check COS_B2_BUCKET for spelling, and that this key is allowed to access that bucket.'],
    [/AccessDenied/, 'The key lacks a permission or is restricted to another bucket. It needs listFiles, readFiles, writeFiles and deleteFiles on this bucket.']];
  const hint = m => { const h = HINTS.find(([re]) => re.test(m)); return h ? `HINT: ${h[1]}\n` : ''; };
  const scrub = scrubWith(cfg), dbPath = persistence.resolveConfig(process.env, __dirname).dbPath, s3 = clientFor(cfg);
  let restore;
  try { restore = await restoreIfNeeded({ s3, cfg, dbPath, maxSchema: SCHEMA_VERSION }); }
  catch (e) { process.stderr.write(`B2 RESTORE REFUSED: ${scrub(e.message)}\n${hint(e.message)}`); process.exit(7); }
  let lease = { ok: false, reason: 'not attempted' };
  try { lease = await claimLease(s3, cfg); } catch (e) { process.stderr.write(`B2 lease not claimed at boot (will retry): ${scrub(e.message)}\n`); lease = { ok: false, reason: 'unreachable' }; }
  process.stderr.write(`B2 backup: ${restore.performed ? `restored ${restore.key.split('/').pop()} (${restore.bytes} bytes${restore.fallback ? ', FALLBACK to an older snapshot' : ''})` : `no restore (${restore.reason})`}; lease ${lease.ok ? 'epoch ' + lease.epoch : 'pending'}\n`);
  out({ enabled: true, restore, lease: lease.ok ? { ok: true, writerId: lease.writerId, epoch: lease.epoch } : { ok: false } });
})().catch(e => { process.stderr.write(`B2 boot error: ${String(e && e.message).slice(0, 200)}\n`); process.exit(7); });

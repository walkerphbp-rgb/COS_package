'use strict';
/* Backblaze B2 backup / restore for the SQLite database (opt-in: COS_B2_BACKUP=1).
 *
 * WHAT THIS IS: verified point-in-time SNAPSHOTS of the database file, kept in object storage, plus restore-if-missing at boot.
 * WHAT THIS IS NOT: B2 is object storage, not a filesystem or a transactional database. SQLite keeps running on the local file exactly
 * as before. Writes made after the last verified snapshot are lost if the process dies hard (SIGKILL / crash / OOM). A graceful stop
 * (SIGTERM, which is what a Render redeploy or idle spin-down sends) uploads a final snapshot first.
 *
 * Safety rules:
 *  - snapshot via SQLite's own VACUUM INTO (a consistent, transactional copy; writers are not blocked)
 *  - a snapshot is only uploaded if it passes PRAGMA integrity_check and has the core tables
 *  - after upload the object is DOWNLOADED, re-hashed and re-opened (integrity_check) BEFORE latest.json is advanced, so
 *    latest.json can only ever point at an object that has been proven restorable
 *  - restore happens ONLY when the local database file is missing; ambiguity (network/auth/5xx, corrupt manifest, nothing valid)
 *    REFUSES TO START instead of booting empty and later overwriting good history
 *  - a single-writer lease (best effort; object storage has no compare-and-swap) stops a superseded instance from uploading
 *  - credentials are read from environment variables by the caller, only used to sign requests, never logged or returned */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { makeS3, S3Error, sha256hex } = require('./b2_s3');

class BackupConfigError extends Error {}
class RestoreError extends Error {}
class VerifyError extends Error {}
const CORE_TABLES = ['missions', 'decisions', 'execution_log', 'critic_reviews'];
const MANIFEST_FORMAT = 'cos-b2-snapshot-1';
const quote = s => "'" + String(s).replace(/'/g, "''") + "'";

function loadConfig(env) {
  if (env.COS_B2_BACKUP !== '1') return { enabled: false };
  const need = ['COS_B2_ENDPOINT', 'COS_B2_BUCKET', 'COS_B2_KEY_ID', 'COS_B2_APP_KEY'], missing = need.filter(n => !env[n]);
  if (missing.length) throw new BackupConfigError(`COS_B2_BACKUP=1 but required environment variable(s) are not set: ${missing.join(', ')}`);
  let u; try { u = new URL(env.COS_B2_ENDPOINT); } catch { throw new BackupConfigError('COS_B2_ENDPOINT is not a valid URL'); }
  const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) throw new BackupConfigError('COS_B2_ENDPOINT must be https (plain http is allowed only for a loopback test endpoint)');
  const m = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(u.hostname), region = env.COS_B2_REGION || (m && m[1]);
  if (!region || !/^[a-z0-9-]{2,30}$/.test(region)) throw new BackupConfigError('cannot determine the region: use a https://s3.<region>.backblazeb2.com endpoint or set COS_B2_REGION');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,62}$/.test(env.COS_B2_BUCKET)) throw new BackupConfigError('COS_B2_BUCKET has an invalid name');
  let prefix = env.COS_B2_PREFIX === undefined ? 'cos/' : env.COS_B2_PREFIX;
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  if (prefix.length > 64 || !/^([A-Za-z0-9._-]+\/){0,8}$/.test(prefix) || prefix.includes('..')) throw new BackupConfigError('COS_B2_PREFIX may contain only letters, digits . _ - and / (no leading slash, no ..)');
  const int = (v, d, lo, hi, n) => { if (v === undefined || v === '') return d; const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) throw new BackupConfigError(`${n} must be an integer ${lo}-${hi}`); return x; };
  return { enabled: true, endpoint: u.origin, endpointHost: u.host, region, bucket: env.COS_B2_BUCKET, prefix, keyId: env.COS_B2_KEY_ID, appKey: env.COS_B2_APP_KEY,
    minIntervalSec: int(env.COS_B2_MIN_INTERVAL_SEC, 15, 1, 3600, 'COS_B2_MIN_INTERVAL_SEC'), keep: int(env.COS_B2_KEEP, 48, 3, 1000, 'COS_B2_KEEP') };
}
const clientFor = (cfg, extra = {}) => makeS3({ endpoint: cfg.endpoint, bucket: cfg.bucket, keyId: cfg.keyId, appKey: cfg.appKey, region: cfg.region, ...extra });
const scrubWith = cfg => s => String(s).split(cfg.keyId).join('[key-id]').split(cfg.appKey).join('[secret]');

/* ---- local database verification (used before upload, after upload, and before restore) ---- */
function verifyDbFile(file, maxSchema) {
  const errors = []; let userVersion = null, counts = null, d;
  try {
    d = new DatabaseSync(file); d.exec('PRAGMA query_only = ON');
    const ic = Object.values(d.prepare('PRAGMA integrity_check').get())[0]; if (ic !== 'ok') errors.push(`integrity_check: ${String(ic).slice(0, 80)}`);
    for (const t of CORE_TABLES) if (!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)) errors.push(`core table missing: ${t}`);
    userVersion = Number(Object.values(d.prepare('PRAGMA user_version').get())[0]);
    if (maxSchema !== undefined && userVersion > maxSchema) errors.push(`schema version ${userVersion} is newer than this build supports (${maxSchema})`);
    if (!errors.length) counts = { missions: d.prepare('SELECT COUNT(*) c FROM missions').get().c, decisions: d.prepare('SELECT COUNT(*) c FROM decisions').get().c, execution_log: d.prepare('SELECT COUNT(*) c FROM execution_log').get().c };
  } catch (e) { errors.push(`cannot open as a SQLite database: ${e.message}`.slice(0, 160)); } finally { try { d && d.close(); } catch {} }
  return { ok: errors.length === 0, errors, userVersion, counts };
}
/* A consistent copy using SQLite's own VACUUM INTO. */
function snapshotDb(dbPath, outFile) {
  const d = new DatabaseSync(dbPath);
  try { d.exec('PRAGMA busy_timeout = 10000'); d.exec(`VACUUM INTO ${quote(outFile)}`); } finally { d.close(); }
}

/* ---- lease (best effort single writer) ---- */
async function readLease(s3, cfg) {
  try { return JSON.parse((await s3.get(cfg.prefix + 'lease.json')).body.toString('utf8')); }
  catch (e) { if (e instanceof S3Error && e.status === 404) return null; if (e instanceof SyntaxError) return null; throw e; }
}
async function claimLease(s3, cfg, now = () => new Date()) {
  const prev = await readLease(s3, cfg), epoch = (prev && Number.isInteger(prev.epoch) ? prev.epoch : 0) + 1, writerId = crypto.randomBytes(8).toString('hex');
  await s3.put(cfg.prefix + 'lease.json', JSON.stringify({ writer_id: writerId, epoch, claimed_at: now().toISOString() }), { contentType: 'application/json' });
  const back = await readLease(s3, cfg);
  return back && back.writer_id === writerId ? { ok: true, writerId, epoch } : { ok: false, reason: 'another instance claimed the lease at the same time' };
}

/* ---- upload one verified snapshot ---- */
async function uploadVerified({ s3, cfg, dbPath, maxSchema, writerId, epoch, now = () => new Date(), tmpRoot = os.tmpdir() }) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'cos-snap-')); const local = path.join(dir, 'snap.db'), back = path.join(dir, 'back.db');
  try {
    snapshotDb(dbPath, local);
    const v = verifyDbFile(local, maxSchema); if (!v.ok) throw new VerifyError(`local snapshot failed verification, NOT uploaded: ${v.errors.join('; ')}`);
    const buf = fs.readFileSync(local), sha = sha256hex(buf), stamp = now().toISOString().replace(/[-:.]/g, ''), key = `${cfg.prefix}snapshots/${stamp}-e${epoch}-${sha.slice(0, 8)}.db`;
    await s3.put(key, buf, { metadata: { sha256: sha, 'user-version': String(v.userVersion) } });
    const got = (await s3.get(key)).body;                                    // proof of recoverability, step 1: the bytes in B2 are the bytes we sent
    if (got.length !== buf.length || sha256hex(got) !== sha) throw new VerifyError('uploaded object does not match the snapshot (size or hash); latest.json NOT advanced');
    fs.writeFileSync(back, got); const v2 = verifyDbFile(back, maxSchema);   // step 2: the downloaded copy opens and passes integrity_check
    if (!v2.ok) throw new VerifyError(`downloaded snapshot failed verification; latest.json NOT advanced: ${v2.errors.join('; ')}`);
    const manifest = { format: MANIFEST_FORMAT, key, sha256: sha, bytes: buf.length, created_at: now().toISOString(), epoch, writer_id: writerId, user_version: v.userVersion, counts: v.counts };
    await s3.put(cfg.prefix + 'latest.json', JSON.stringify(manifest), { contentType: 'application/json' });
    return manifest;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
async function prune(s3, cfg, keepKey) {
  const all = (await s3.list(cfg.prefix + 'snapshots/')).map(o => o.key).filter(k => k.endsWith('.db')).sort().reverse();
  let deleted = 0; for (const k of all.slice(cfg.keep)) { if (k === keepKey) continue; try { await s3.del(k); deleted++; } catch { /* retention is best effort */ } }
  return deleted;
}

/* ---- restore (ONLY when the local database file is missing) ---- */
async function restoreIfNeeded({ s3, cfg, dbPath, maxSchema }) {
  if (fs.existsSync(dbPath)) return { performed: false, reason: 'local_database_present' };
  for (const ext of ['-wal', '-shm', '-journal']) fs.rmSync(dbPath + ext, { force: true });   // sidecars of a lost database would corrupt a restored file
  let manifest;
  try { manifest = JSON.parse((await s3.get(cfg.prefix + 'latest.json')).body.toString('utf8')); }
  catch (e) {
    if (e instanceof S3Error && e.status === 404) return { performed: false, reason: 'no_snapshot_in_bucket' };
    throw new RestoreError(e instanceof SyntaxError ? 'latest.json is not valid JSON; refusing to start empty' : `cannot read the snapshot manifest (${e.message}); refusing to start empty`);
  }
  if (!manifest || manifest.format !== MANIFEST_FORMAT || typeof manifest.key !== 'string' || !manifest.key.startsWith(cfg.prefix + 'snapshots/') || !/^[0-9a-f]{64}$/.test(manifest.sha256 || '') || !Number.isInteger(manifest.bytes))
    throw new RestoreError('latest.json is malformed; refusing to start empty');
  const candidates = [{ key: manifest.key, sha: manifest.sha256, bytes: manifest.bytes, created_at: manifest.created_at }];
  try { for (const o of (await s3.list(cfg.prefix + 'snapshots/')).map(x => x.key).filter(k => k.endsWith('.db') && k !== manifest.key).sort().reverse().slice(0, 4)) candidates.push({ key: o }); }
  catch (e) { throw new RestoreError(`cannot list snapshots (${e.message}); refusing to start empty`); }
  const skipped = [], tmp = `${dbPath}.restore-${process.pid}`;
  for (const c of candidates) {
    try {
      const r = await s3.get(c.key), body = r.body, sha = sha256hex(body), want = c.sha || (r.headers && r.headers.get && r.headers.get('x-amz-meta-sha256'));
      if (!want || sha !== want) throw new VerifyError('hash does not match');
      if (c.bytes !== undefined && body.length !== c.bytes) throw new VerifyError('size does not match');
      if (!c.sha && !c.key.includes(`-${sha.slice(0, 8)}.db`)) throw new VerifyError('object name does not match its content');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true }); fs.writeFileSync(tmp, body);
      const v = verifyDbFile(tmp, maxSchema); if (!v.ok) throw new VerifyError(v.errors.join('; '));
      fs.renameSync(tmp, dbPath);                                            // atomic: either the whole verified snapshot is in place or nothing is
      return { performed: true, key: c.key, sha256: sha, bytes: body.length, created_at: c.created_at || null, user_version: v.userVersion, counts: v.counts, fallback: skipped.length > 0, skipped };
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (e instanceof S3Error && e.status !== 404) throw new RestoreError(`cannot download ${c.key} (${e.message}); refusing to start empty`);   // never fall back to OLDER data because of a transient failure
      skipped.push({ key: c.key, reason: String(e.message).slice(0, 160) });
    }
  }
  throw new RestoreError(`no snapshot could be restored (tried ${candidates.length}): ${skipped.map(s => `${s.key.split('/').pop()}: ${s.reason}`).join(' | ')}`);
}

/* ---- running manager: snapshot on change (throttled), final snapshot on graceful stop ---- */
class BackupManager {
  constructor({ cfg, dbPath, s3, maxSchema, lease, restore, log = () => {}, now = () => new Date(), tmpRoot }) {
    Object.assign(this, { cfg, dbPath, s3, maxSchema, log, now, tmpRoot });
    this.scrub = scrubWith(cfg); this.writerId = lease && lease.ok ? lease.writerId : null; this.epoch = lease && lease.ok ? lease.epoch : 0;
    this.restore = restore || { performed: false }; this.dirty = true; this.busy = false; this.superseded = false; this.failures = 0; this.nextAt = 0;
    this.st = { last_attempt_at: null, last_success_at: null, last_verified_at: null, last_key: null, last_bytes: null, last_error: null, snapshots_uploaded: 0, pruned: 0 };
    this.mon = null; this.lastVersion = null; this.timer = null;
  }
  _version() { if (!this.mon) { this.mon = new DatabaseSync(this.dbPath); this.mon.exec('PRAGMA busy_timeout = 5000'); } return Number(Object.values(this.mon.prepare('PRAGMA data_version').get())[0]); }
  start() {
    try { this.lastVersion = this._version(); } catch (e) { this.st.last_error = this.scrub(`monitor: ${e.message}`); }
    this.timer = setInterval(() => this._tick(), Math.max(200, Math.min(2000, this.cfg.minIntervalSec * 500))); if (this.timer.unref) this.timer.unref();
    setImmediate(() => this._tick());
  }
  _tick() {
    try { const v = this._version(); if (this.lastVersion !== null && v !== this.lastVersion) this.dirty = true; this.lastVersion = v; } catch { try { this.mon && this.mon.close(); } catch {} this.mon = null; }
    if (this.dirty && !this.busy && !this.superseded && Date.now() >= this.nextAt) this.snapshotNow('changes').catch(() => {});
  }
  async snapshotNow(reason) {
    if (this.busy || this.superseded) return false; this.busy = true; const before = this.lastVersion;
    try {
      this.st.last_attempt_at = this.now().toISOString();
      if (!this.writerId) { const l = await claimLease(this.s3, this.cfg, this.now); if (!l.ok) throw new Error(`could not claim the writer lease (${l.reason})`); this.writerId = l.writerId; this.epoch = l.epoch; }
      const cur = await readLease(this.s3, this.cfg);
      if (cur && cur.writer_id !== this.writerId) { this.superseded = true; this.log(`B2 backup: superseded by another instance (epoch ${cur.epoch}); this instance will not upload`); return false; }
      const m = await uploadVerified({ s3: this.s3, cfg: this.cfg, dbPath: this.dbPath, maxSchema: this.maxSchema, writerId: this.writerId, epoch: this.epoch, now: this.now, tmpRoot: this.tmpRoot });
      Object.assign(this.st, { last_success_at: this.now().toISOString(), last_verified_at: this.now().toISOString(), last_key: m.key, last_bytes: m.bytes, last_error: null }); this.st.snapshots_uploaded++;
      this.failures = 0; this.nextAt = Date.now() + this.cfg.minIntervalSec * 1000;
      try { const v = this._version(); this.dirty = v !== before && before !== null; this.lastVersion = v; } catch { this.dirty = true; }
      try { this.st.pruned += await prune(this.s3, this.cfg, m.key); } catch {}
      return true;
    } catch (e) {
      this.st.last_error = this.scrub(e && e.message || e); this.failures++; this.nextAt = Date.now() + Math.min(300000, this.cfg.minIntervalSec * 1000 * 2 ** Math.min(this.failures, 8)); this.dirty = true;
      this.log(`B2 backup failed (${reason}): ${this.st.last_error}`); return false;
    } finally { this.busy = false; }
  }
  /* Graceful stop: wait for an in-flight snapshot, then upload a final one if anything changed. */
  async flush(timeoutMs = 10000) {
    const end = Date.now() + timeoutMs; while (this.busy && Date.now() < end) await new Promise(r => setTimeout(r, 50));
    try { const v = this._version(); if (this.lastVersion !== null && v !== this.lastVersion) { this.dirty = true; this.lastVersion = v; } } catch {}
    if (!this.dirty || this.superseded) return { flushed: false, reason: this.superseded ? 'superseded' : 'nothing_changed' };
    this.nextAt = 0; const ok = await Promise.race([this.snapshotNow('shutdown'), new Promise(r => setTimeout(() => r(false), Math.max(500, end - Date.now())))]);
    return { flushed: !!ok };
  }
  stop() { clearInterval(this.timer); try { this.mon && this.mon.close(); } catch {} this.mon = null; }
  status() {
    try { const v = this._version(); if (this.lastVersion !== null && v !== this.lastVersion) this.dirty = true; this.lastVersion = v; } catch { /* monitor unavailable: report what we know */ }   // live, not up to one poll interval stale
    return { enabled: true, endpoint_host: this.cfg.endpointHost, bucket: this.cfg.bucket, prefix: this.cfg.prefix, writer_id: this.writerId ? this.writerId.slice(0, 8) : null, epoch: this.epoch, superseded: this.superseded,
      restore: { performed: !!this.restore.performed, reason: this.restore.reason || null, key: this.restore.key ? this.restore.key.split('/').pop() : null, fallback: !!this.restore.fallback, created_at: this.restore.created_at || null },
      pending_changes: this.dirty, min_interval_sec: this.cfg.minIntervalSec, ...this.st, last_error: this.st.last_error ? this.scrub(this.st.last_error).slice(0, 300) : null };
  }
}
module.exports = { loadConfig, clientFor, verifyDbFile, snapshotDb, claimLease, readLease, uploadVerified, prune, restoreIfNeeded, BackupManager, BackupConfigError, RestoreError, VerifyError, MANIFEST_FORMAT, scrubWith };

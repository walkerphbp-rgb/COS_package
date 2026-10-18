# Backblaze B2 backup and recovery (opt-in)

**Status: IMPLEMENTED LOCALLY (Test 29). NOT validated against the real Backblaze service. NOT deployed. Persistence is NOT proven until the live test in §6 passes.**

## 1. What this is, and what it is not

B2 is **object storage**. It cannot hold a live SQLite database (no file locking, no atomic partial writes, no transactions). So this feature does not replace SQLite and does not make B2 "the database":

- SQLite keeps running on the local file exactly as before (same schema, triggers, WAL, migrations, gate, audit).
- A separate, **opt-in** layer copies the database to B2 as **verified snapshots**, and **restores the newest verified snapshot only when the local database file is missing** at boot (for example after a Render restart or redeploy on an instance with no disk).

**This is backup and restore, not continuous replication.** Consequences, stated plainly:

| Situation | What happens |
|---|---|
| Graceful stop (SIGTERM: redeploy, idle spin-down, "Manual deploy") | A final verified snapshot is uploaded first. Nothing is lost (Test 29E-12). |
| Hard crash (SIGKILL, out-of-memory, host failure) | Everything committed after the **last verified snapshot** is lost (default: up to about 15 seconds of activity). Test 29E-11 proves and documents this. |
| Two instances overlap during a deploy | Best-effort single-writer lease. The older instance is told it was superseded and stops uploading; anything it wrote after the new instance restored is lost, and `/health` shows `backup.superseded: true`. Object storage has no compare-and-swap, so this cannot be made perfect. |
| B2 unreachable, local database present | Keeps serving. `/health` shows `backup.last_error` and `pending_changes: true`. Retries with backoff. |
| B2 unreachable or confusing, local database MISSING | **Refuses to start (exit 7)** instead of booting empty (which would later overwrite good history). |

A disk is stronger than this (one writer, no data-loss window, no overlap). This feature is the cheaper alternative with those trade-offs.

## 2. Safety rules (all tested)

- Snapshots use SQLite's own `VACUUM INTO`: a transactionally consistent copy while the server keeps writing.
- A snapshot is uploaded only if it passes `PRAGMA integrity_check` and has the core tables.
- After upload the object is **downloaded, re-hashed and re-opened** before `latest.json` is advanced, so the manifest can only point at an object proven restorable.
- Restore verifies the manifest, size, SHA-256, object name, `integrity_check`, core tables and that the schema is not newer than the build. It writes a temp file then renames it atomically.
- A corrupt newest snapshot falls back to the previous verified one (reported in `/health`). A **transient** failure (network, 5xx, auth) never falls back to older data; it refuses.
- Stale `-wal`/`-shm` files from a lost database are removed before restoring.
- No credential is ever in source, a browser page, a URL, a log, `/health`, or a stored object. Errors are scrubbed.
- Default is OFF. With `COS_B2_BACKUP` unset the system behaves exactly as before and makes no network calls.

## 3. Configuration (server-side environment variables only)

| Variable | Meaning |
|---|---|
| `COS_B2_BACKUP=1` | Turns the feature on |
| `COS_B2_ENDPOINT` | `https://s3.<region>.backblazeb2.com` (shown on the bucket page) |
| `COS_B2_BUCKET` | Bucket name (private bucket) |
| `COS_B2_KEY_ID`, `COS_B2_APP_KEY` | A Backblaze application key. Store as Render **secret** environment variables. Never commit them |
| `COS_B2_PREFIX` | Optional folder, default `cos/` |
| `COS_B2_REGION` | Only if it cannot be derived from the endpoint |
| `COS_B2_MIN_INTERVAL_SEC` | Minimum seconds between snapshots, default 15 (lower = smaller loss window) |
| `COS_B2_KEEP` | Snapshots to keep, default 48 |

Any missing or invalid value, with the feature on, stops the server at boot (exit 7) and names the variable (never its value).

## 4. Setting up Backblaze

1. Create a **private** bucket. Turn on **Server-Side Encryption (SSE-B2)** for it (snapshots contain mission text and audit data).
2. Create an **Application Key** restricted to that one bucket with read, write, list and delete access. Copy the key id and key once.
3. Note the bucket's S3 endpoint (for example `s3.us-west-004.backblazeb2.com`).
4. In Render, add the variables above (key id and key as secrets) and redeploy.

## 5. What `/health` shows

`backup`: `enabled`, `bucket`, `prefix`, `restore` (performed, snapshot name, fallback), `last_success_at`, `last_verified_at`, `pending_changes`, `snapshots_uploaded`, `superseded`, `last_error`. No credentials.

## 6. The live test (required before claiming persistence)

A successful upload is not proof of recoverability. On Render, with the variables set:

1. Run `format_live_runner.html` (or any missions), note the mission ids and, in the dashboard, one approved and executed mission.
2. Wait until `/health` shows `backup.pending_changes: false` and a recent `last_verified_at`. Save that `/health` JSON.
3. **Redeploy** (Manual Deploy). On a free instance this erases the local database.
4. Open `/health`: expect `backup.restore.performed: true`, `init.result: "not_needed"`, `db.guards.ok: true`.
5. Open the dashboard: the same missions, the approval and the execution must still be there, and Decision Memory `explain` must return the same result.
6. Repeat once more (a second redeploy) to prove it is repeatable.

Only then may this be called PROVEN on Render. Until then it is IMPLEMENTED / LIVE-VALIDATION PENDING.

## 7. Manual recovery (if ever needed)

Snapshots are ordinary SQLite files at `<prefix>snapshots/<timestamp>-e<epoch>-<sha8>.db`; `<prefix>latest.json` names the newest. Download one, check its SHA-256 against the manifest, stop the service, place it at `COS_DB_PATH`, and start. The server migrates it forward as usual.

## 8. Known limits

- Not continuous: see §1. Lower `COS_B2_MIN_INTERVAL_SEC` (minimum 1) to shrink the window; each snapshot is a full copy.
- Not verified against the real Backblaze service yet (the tests use a fake S3 server that verifies AWS Signature V4, and the signer matches AWS's published example).
- No client-side encryption (rely on a private bucket plus SSE-B2).
- Overlapping instances during a deploy can lose the older instance's last writes (§1).

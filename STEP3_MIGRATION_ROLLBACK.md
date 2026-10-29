# Step 3: schema v4 migration and rollback

**Status: written for the scratch branch `step3-research`. Migration proven on COPIES of a v3 database (Test 33 H, 20/20). NOT run against production. Nothing here authorizes a deploy.**

## 1. What changes
Schema v3 to v4 (`db_migrations.js`, `migrateV4`): new tables `mission_research` and `mission_sources` (append-only triggers) and a nullable `claims.source_id`. It is additive and idempotent: existing rows are untouched and legacy missions keep working. The migration runs automatically at backend boot, and `/health` then reports schema 4.

## 2. What is proven, and what is not
- Proven (Test 33 H, on copies): the original file stays byte-identical when migrating a copy; legacy rows are untouched; running twice changes nothing; the baseline build `6542e37` refuses a v4 database; the B2 verifier refuses a v4 file when `maxSchema` is 3.
- Not proven: any run on the real Render database, a real B2 snapshot restore into the v4 build, and the old-build rollback below (read from the code of `b2_backup.js`, not executed).

## 3. Before deploying (required)
1. Take a baseline at rest (no missions in flight), as in `B2_BACKUP.md`.
2. Confirm `/health` shows a recent verified snapshot (`backup.last_verified_at`, `pending_changes: false`).
3. Copy that snapshot AND `latest.json` to a location outside `<COS_B2_PREFIX>snapshots/` (default `cos/snapshots/`) (another prefix or bucket, or download both files). Retention (`COS_B2_KEEP`, default 48) deletes the oldest objects under `<COS_B2_PREFIX>snapshots/` (default `cos/snapshots/`), so a copy left there is not safe.
4. Verify the copy: SHA-256 equals the manifest value, the file opens, `PRAGMA integrity_check` returns ok, `PRAGMA user_version` is 3.
5. Only then deploy. After the first boot, check `/health`: schema 4/4, guards ok, restore performed with no fallback, and the research flag matches what you set.

## 4. Rollback (restore the pre-migration data)
Never run an old build against a v4 database; it refuses, by design.
1. Stop the service (a graceful stop uploads a final v4 snapshot: keep it, it holds everything written after the migration).
2. Save a copy of the newest v4 snapshot outside `<COS_B2_PREFIX>snapshots/` (default `cos/snapshots/`) first. Post-migration missions exist only there.
3. Put the verified pre-migration v3 snapshot back as the newest object and point `latest.json` at it (key, sha256, bytes must all match), or restore the file into place on an instance with a disk.
4. Redeploy the old commit (`6542e37`) and confirm `/health` schema 3, restore performed, no fallback.
5. Data created after the migration is NOT in the v3 database. Recover it only from the saved v4 snapshot, with a v4 build.

## 5. Trap: an old build can silently restore older data
`restoreIfNeeded` (reported at `/health` as `backup.restore`) tries `latest.json` and then up to four older snapshots. An old build (`maxSchema` 3) rejects each v4 snapshot as "newer than this build supports" and moves on, so it can restore an older v3 snapshot and report `fallback: true`. Then it uploads v3 snapshots, `latest.json` moves to v3, and retention eventually deletes the v4 ones. Rule: if `/health` shows `backup.restore.fallback: true` after a rollback or a bad deploy, stop and do step 2 of section 4 immediately.

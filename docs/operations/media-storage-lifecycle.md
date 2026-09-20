# Media storage policy and recovery

Migration `20261014_media_storage_quota.sql` adds atomic stored-byte counters for each user, project and the whole database. Every `media_assets` insert/update/delete, including upload, AI output and legal rendering, updates the counters in the same transaction. PostgreSQL payloads count the greater of declared and actual bytes. Existing rows are counted during migration. Object rows count the declared uploaded payload size. These are logical payload limits; PostgreSQL indexes, TOAST overhead, WAL, replicas, backups and pending object uploads require separate capacity monitoring.

There is deliberately no production byte budget in the migration. An absent policy blocks storage growth, while reads and deletion remain available. The owner must approve three positive byte limits before release; existing usage is the minimum possible policy. Test fixtures use their own explicit small limits and are not a production recommendation.

Inventory (read only):

```sql
select scope, count(*) as entities, max(bytes_used) as largest_entity_bytes,
       sum(bytes_used) as scope_bytes from media_storage_usage group by scope;
select pg_database_size(current_database()) as database_bytes,
       pg_total_relation_size('media_assets') as media_relation_bytes;
select wal_bytes, wal_records, stats_reset from pg_stat_wal;
select count(*) as pending_objects, min(created_at) as oldest_pending
  from media_object_orphans where deleted_at is null;
```

`configureMediaStorageLimits` serializes policy changes with quota acquisition and rejects limits below existing usage. `scripts/configure-media-storage-limits.mjs` reads only the explicit `MEDIA_QUOTA_DATABASE_URL` and `MEDIA_USER_MAX_BYTES`, `MEDIA_PROJECT_MAX_BYTES`, `MEDIA_GLOBAL_MAX_BYTES`. Default is dry-run; `--apply` is restricted to a named disposable localhost `aurora_*_test` database. It never loads an application env file. Approved production configuration remains a separate reviewed external action.

## Object upload failure handling

Generated object uploads now create a durable cleanup intent before PUT. A session advisory lock covers upload and asset transaction persistence. PUT has a 60-second cancellation deadline. Cleanup checks that lock and skips active uploads. The initial five-minute cleanup delay gives an interrupted bounded upload time to settle after a connection/process failure; it is an operational grace period, not the owner's retention policy. Receipt loss, failed quota checks, failed DB transactions and completed-generation no-ops leave a known cleanup key. A successfully stored asset protects its object. The existing asset-delete trigger reopens the cleanup intent when that asset is removed.

A timed-out object-store PUT can have an uncertain remote result. Cleanup is idempotent deletion, never a repeat upload. Synthetic tests exercise this contract with a fake object store; production S3 semantics, bucket versioning/retention and remote orphan inventory still require the approved real environment. Do not claim physical storage is bounded solely by `media_assets` counters. Monitor pending intents and provider bytes as well.

## Retention maintenance

No retention age is assumed. After the owner selects one, run `scripts/cleanup-unused-media.mjs` with explicit `MEDIA_RETENTION_DATABASE_URL` and `MEDIA_RETENTION_CREATED_BEFORE` (past ISO timestamp). Optional `MEDIA_RETENTION_BATCH_SIZE` is 1–100 (default 25); continue using returned `nextCursor` as `MEDIA_RETENTION_AFTER_ASSET_ID`. Default is read-only. `--apply` is restricted to a disposable localhost `aurora_*_test` database.

The scanner conservatively retains every FK to an asset id and JSON/text references using supported media keys or `/api/media/assets/<id>` URLs across discovered public tables. This includes drafts, approved revision snapshots, publication operations, published posts, legal snapshots and generations. Future opaque/encrypted media-reference formats must be added explicitly before retention can support them. Over-retention is safer than discarding historical publication media.

Apply takes table locks on possible reference writers and the asset table in one transaction, with a five-second lock timeout and a 30-second statement timeout. Thus a concurrent JSON reference cannot appear between inspection and deletion. Failure rolls back. This is bounded maintenance, not an online background sweep at arbitrary production load. Object asset deletion only enqueues object cleanup; it does not invoke a provider. `media:cleanup-orphans` remains an explicit mutating command and must not be run against real objects without the corresponding authorization.

## Verification and restore

- `test:media-quota:integration`: 48 concurrent attempts; per-user/project/global caps; rollback and delete accounting; absent-policy failure; rejected underreported payload; policy cannot undercut usage.
- `test:media-lifecycle:integration`: draft/revision/published/FK/URL protection, dry-run, accounting, JSON-writer lock race, synthetic lost object receipt/transaction failure/no-op, active upload locking and preservation of successful objects.
- `test:restored-publications:integration`: fresh synthetic source, actual pg_dump/pg_restore, PostgreSQL media digest and counters, encrypted synthetic provider token, successful receipts, durable unknown state, quarantine and denied old/current job claims.

The restore test requires explicit isolated source/target DB URLs and `AURORA_OUTBOUND_DISABLED=1`; it never loads app env files. Source can be `aurora_restore_source_test` or `aurora_s02_test`; target must be `aurora_*_restore_test`. Both schemas are reset intentionally. It uses no real provider credentials. Its small synthetic timing is a rehearsal measurement, not production RPO/RTO or production media-backup evidence. Follow `docs/production-delivery-recovery.md`; outbound remains stopped until externally approved reconciliation.

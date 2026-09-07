# Delivery and storage release actions

This packet covers O02/O03 and D04/D05. It prepares concrete external work; it does not authorize deployment, production mutation, real publishing, key rotation, paid calls or deletion. The final release commit and final gate table must come from `IMPLEMENTATION-RESULT.md`. The old target `2161d5d0ba7b73143a3a353565015f68bb1a7fa4` is explicitly unsafe for active rollback.

## Decisions to supply before release

| Owner decision/evidence | Exact value required | Why the release depends on it |
| --- | --- | --- |
| Storage policy | Positive approved user/project/global stored-byte limits | Migration14 deliberately has no budget default; without policy, new media storage fails closed. |
| Capacity envelope | Current DB/object bytes, growth baseline, WAL/replica/backup overhead and approved alert thresholds | Logical media counters do not bound total physical storage. |
| Retention | Approved age/cutoff, retained classes, maintenance window and responsible operator | No production retention age or permission to delete real media is inferred. |
| Recovery | Approved RPO/RTO and actual backup identifier/time/checksum | Small synthetic restore timings cannot certify production recovery. |
| Key custody | Required token key ids and separately secured access to their existing keys | DB ciphertext alone is not a usable restore; keys must not be copied into ordinary evidence or the DB dump. |
| Object recovery | Bucket/versioning/backup inventory for every referenced object key | PostgreSQL media was restored synthetically; used production object files need independent proof. |
| Incident authority | Named stop/reconcile/resume owners and approved communication/alert destination | An unknown send needs accountable resolution; no application automatic retry proves absence. |
| Rollback target | A distinct safety-preserving build, or an explicit forward-repair decision | The exact old build passes catalog checks but reproduces duplicate effects and ignores the new outbound hold. |

## Read-only preflight

Use a separately supplied explicit connection and a read-only role/session. Never let a shell, migration or worker load the working application's `.env.local`. Save counts, object/key ids and timestamps in restricted evidence; do not print token envelopes, credentials, user content or key material.

The following queries are read-only after the corresponding migrations exist:

```sql
select current_database(), now() as observed_at;
select current_setting('server_version_num') as server_version_num,
       current_setting('server_encoding') as server_encoding;
select collname, collprovider from pg_collation
 where oid=to_regcollation('pg_catalog.pg_c_utf8');
select name, checksum from schema_migrations order by name;
select scope, count(*) as entities, max(bytes_used) as largest_entity_bytes,
       sum(bytes_used) as scope_bytes from media_storage_usage group by scope;
select pg_database_size(current_database()) as database_bytes,
       pg_total_relation_size('media_assets') as media_relation_bytes;
select wal_bytes, wal_records, stats_reset from pg_stat_wal;
select storage_backend, count(*) as assets, sum(bytes) as declared_bytes
  from media_assets group by storage_backend;
select count(*) as pending_orphans, min(created_at) as oldest_pending
  from media_object_orphans where deleted_at is null;
select split_part(vk_token, ':', 2) as key_id, count(*)
  from channels where vk_token is not null group by 1;
select split_part(credentials, ':', 2) as key_id, count(*)
  from site_destinations where credentials is not null group by 1;
select status, count(*) from posts group by status;
select status, outcome, count(*) from site_article_publications group by status,outcome;
select send_status, count(*) from publication_parts group by send_status;
```

The tested export runtime requires PostgreSQL 17, UTF8 and the built-in
`pg_catalog.pg_c_utf8` collation (provider `b`). After the catalog check succeeds,
verify `select lower('Опубликован' collate pg_catalog.pg_c_utf8);` returns
`опубликован`. Missing capability is a release blocker; do not change an existing
database's locale to make the check pass. New SQL-selected export snapshots use
V2; persisted V1 snapshots and their request/content hashes remain unchanged.
Deploy the new web and project-export worker together, after draining/stopping
the old consumers. An old V1-only renderer must not consume V2 operations: it can
repeat the obsolete JavaScript filter and omit selected rows. Pending V1 jobs
remain readable by the new worker. Once V2 jobs exist, rollback requires a worker
that understands V2, or a reviewed hold/forward-repair plan; do not rewrite their
stored snapshots or hashes to make an old worker accept them.

The editorial validation receipt also has a shared reader/writer contract: its
topic can contain up to 1800 UTF-16 code units, and clipping must preserve complete
surrogate pairs. No SQL migration or rewrite of existing receipts is needed.
The former 500-unit reader rejects valid new receipts above that limit, so deploy
services consuming `DraftAiValidation` with the matching contract. A rollback to
that reader is not fully compatible once longer receipts exist; it can block
result recovery or draft binding. Preserve the complete receipt and its hashes,
and use a compatible rollback target or reviewed forward repair.

Hosted pages now use the exact revision referenced by the last confirmed hosted receipt, not the mutable article row or WordPress's state. Inventory any missing/structurally invalid historical snapshot before rollout:

```sql
select publication.id as publication_id, publication.article_id, publication.article_version
  from site_article_publications publication
  join site_destinations destination on destination.id=publication.destination_id
  left join site_article_revisions revision on revision.article_id=publication.article_id
    and revision.version=publication.article_version
 where destination.kind='site_hosted' and publication.status='published'
   and publication.outcome='success' and publication.reconcile_state='confirmed'
   and publication.action in ('publish','update')
   and (revision.id is null
     or jsonb_typeof(revision.snapshot->'title') is distinct from 'string'
     or jsonb_typeof(revision.snapshot->'bodyMarkdown') is distinct from 'string');
```

The read service also validates the stored snapshot content hash. Missing or corrupt snapshots are not repaired from newer unapproved text. Restore the exact revision from verified history/backup, or prepare a separately reviewed owner-approved correction. The preflight must record affected ids and disposition, not silently omit them from release scope.

## Storage configuration and retention rehearsal

`configureMediaStorageLimits` checks current usage, serializes policy changes with growth, and refuses a new cap below usage. `scripts/configure-media-storage-limits.mjs` accepts explicit `MEDIA_QUOTA_DATABASE_URL`, `MEDIA_USER_MAX_BYTES`, `MEDIA_PROJECT_MAX_BYTES`, `MEDIA_GLOBAL_MAX_BYTES`; default is dry-run, `--apply` accepts only disposable localhost `aurora_*_test` databases. Present the proposed numbers and output for approval before any production policy write. Test fixture values are not production recommendations.

`cleanup-unused-media.mjs` likewise defaults to read-only and requires `MEDIA_RETENTION_DATABASE_URL` plus an explicit past `MEDIA_RETENTION_CREATED_BEFORE`. Continue returned `nextCursor` through `MEDIA_RETENTION_AFTER_ASSET_ID`; batch size is1–100. The script's mutating mode is restricted to disposable localhost test DBs. Its maintenance locks protect concurrent draft/JSON references. Production execution requires the separately approved target and reviewed procedure; do not bypass the guard ad hoc.

Before deleting real object data, compare the dry-run ids against all database references and the provider's actual object/version inventory. The existing `media:cleanup-orphans` command is mutating and loads `.env.local`; it was exercised only through its helper with fake object storage during this task. Do not run it casually in a working checkout. The asset delete trigger journals objects; external deletion is a distinct operational effect.

## Isolated recovery rehearsal

1. Obtain the approved backup and its original capture timestamp. Inventory referenced media objects and required token key ids. Keep key material separate from the dump and logs. The baseline, restoration duration and verification duration are measurements; compare them with the actual approved RPO/RTO after the run.
2. Create isolated PostgreSQL/object storage/queues and use explicitly named connections. Do not attach an old production Redis queue or restore worker offsets into a connected bot.
3. Stop consumers, schedulers and web mutation entry points, and enforce outbound network denial independently of the application. Set `AURORA_OUTBOUND_DISABLED=1` before any current worker startup. Readiness is not permission to consume queues.
4. Restore the DB and all referenced media into isolation, supply separately controlled matching decryption keys, and verify table counts, receipt states, media digests, object contents and token decryption without logging plaintext. Record missing objects or keys as failures.
5. Run the restore quarantine dry-run, then its explicitly guarded apply on the disposable copy. Canonical mutations are in `scripts/prepare-restored-publications.mjs`; successful receipts remain, uncertain or previously queued external actions are held. Repeating quarantine must change nothing. Recreate clients/worker runtime under the hold and prove old/current revision claims remain denied.
6. Reconcile the entire gap between backup capture and stopped production consumers, including ordinary posts, successful multipart parts, bot replies/update offsets, Sites, follow-up comments, audience delivery and reminders. A provider's missing acknowledgement or absent slug is not proof that no effect occurred.
7. Present a row-level disposition and exact stop/resume action packet for approval. Preserve unknown whenever the provider cannot prove the outcome. No automatic production resume is included in this rehearsal.

The standalone synthetic regression can be run as follows **only against newly created disposable databases**:

```sh
AURORA_OUTBOUND_DISABLED=1 \
MIGRATION_TEST_DATABASE_URL=postgres://TEST_USER@127.0.0.1:TEST_PORT/aurora_restore_source_test \
RESTORE_DATABASE_URL=postgres://TEST_USER@127.0.0.1:TEST_PORT/aurora_s02_restore_test \
node scripts/test-restored-publications-integration.mjs
```

Replace `TEST_USER`/`TEST_PORT` with the actual isolated runtime; they are not production access details. This command deliberately resets both fixture schemas. The recorded local run used an870432-byte synthetic dump: dump131ms, restore537ms, total1333ms. It preserved a PostgreSQL media digest/counter, an encrypted synthetic token with its separately supplied fixture key, successful receipts and durable unknown states; four queued posts could not reclaim old/current leases. Real provider calls were0. These are regression observations, not a production recovery SLO.

## Rollback and resume boundary

The exact2161d5d code accepts the newer additive schema and rejects restored quarantined job claims, but it has no `AURORA_OUTBOUND_DISABLED` guard. Its original publication functions produce two fake provider effects after two attempts with a lost acknowledgement. Ordinary writable web rollback would also reintroduce authorization defects. Thus neither a green schema probe nor the presence of new DB receipt tables makes that build safe.

The exact `9fe2c9961e5d01056c5f420d765f56b43c690e68` target was also rehearsed against a synthetic restore with all 11 forward migrations through `20261021`. Its catalog probe accepted the schema and quarantined job claims were denied, but its original publication functions returned `deliveryUnknown: false` twice and caused two fake provider effects after a lost acknowledgement. The safety oracle failed; no old consumers or real providers were started. This target is also unsafe for automatic writable rollback. Its RSS writers still use `ON CONFLICT(user_id,url)`, which does not match the new project-scoped uniqueness. Do not attest a rollback pair based solely on a successful catalog probe or synthetic restore. Before merging a release that can auto-deploy, require the exact compatible rollback build or an explicitly reviewed cutover and forward-repair procedure that keeps old consumers and mutation entry points stopped.

Prefer a forward fix that retains the safety code. If a rollback is needed, prepare a different exact commit retaining actor verification, current permission/project guards, durable unknown receipts, telemetry sanitization, action-aware Sites reconciliation and outbound hold. Rehearse its web/worker/outbox behavior against the restored newer schema before requesting deployment approval. Do not unapply migrations, clear receipts, reset unknown states to pending, or rebuild an old live queue to make old code start.

WordPress unknown create cannot be automatically confirmed from a matching or missing slug. Update/unpublish reconciliation uses the known destination id and the expected revision/state; uncertainty remains if the result cannot be established. Per-destination successful parts remain successful and are never resent as part of a bulk retry. Resume requires explicit row-level reconciliation and the named release/incident owner's decision.

Related implementation evidence: `D04-D05.md`, `Q01-restore-standalone.md`, `O03-rollback.md`, `N09-sites-delivery.md`, and `N09-hosted-projection.md` in the audit's implementation evidence directory. The final report supplies the release SHA and mandatory full QA results.

## Current publication authority and legacy Sites queues (N14)

A saved social schedule belongs to `posts.user_id`, the publisher who requested it.
The author, reviewer and channel connector can be different people. Removing an
unrelated author's membership does not cancel an authorized publisher's approved
schedule. A new provider admission requires the requesting publisher to remain an
active owner/publisher in an unarchived project, with an unblocked account and an
active channel. Every Telegram part repeats that admission; an already successful
part remains a receipt and is never resent. A request admitted before revocation
may already be in flight and cannot be recalled. A later part cannot use that
previous part's admission.

Sites publication migration `20261017_site_publication_authority.sql` adds the
actual `requested_by_user_id`. Historical receipts remain intact, and the migration
does not invent this actor for old rows. A legacy pending row without its publisher
is held by the worker. A successful historical receipt still serves the exact
hosted revision; missing publisher identity is not a reason to rewrite history or
re-send an existing publication.

Before release, inventory held work with an explicitly selected read-only database
connection. These queries return identifiers and reasons, never credentials:

```sql
select publication.id, publication.article_id, publication.destination_id,
       publication.article_version, publication.status, publication.attempts
  from site_article_publications publication
 where publication.requested_by_user_id is null
   and publication.status in ('pending','publishing','published_unverified')
 order by publication.id;

select post.id, post.project_id, post.user_id as requesting_publisher,
       post.status, post.schedule_revision, channel.status as channel_status,
       member.status as membership_status, member.role,
       project.is_archived, actor.blocked_at is not null as account_blocked
  from posts post
  join projects project on project.id = post.project_id
  join users actor on actor.id = post.user_id
  join channels channel on channel.id = post.channel_id
  left join project_members member
    on member.project_id = post.project_id and member.user_id = post.user_id
 where post.status in ('scheduled','failed_retry','publishing')
   and (project.is_archived or actor.blocked_at is not null
     or not channel.is_active or channel.status <> 'active'
     or member.status is distinct from 'active'
     or member.role is null or member.role not in ('owner','publisher'))
 order by post.project_id, post.id;
```

The owner must select the actual current publisher and each intended article,
revision, destination and action. Record the intended decision and provider evidence
before any separately authorized production change. Previously started or unknown
operations require provider reconciliation and must never be reassigned or reset to
pending. For an unsent legacy operation, prepare an explicit publication through
the application's permission and revision guards; if the old idempotency record
cannot be safely reauthorized, create a reviewed new article revision using the
existing edit/approve/publish flow. Do not mass-fill the actor column from
`article.user_id`, `approved_by` or the site connector, and do not clear successful
receipts. Account/membership/channel recovery alone is not evidence that an
unknown provider operation failed.

## WordPress destination replacement (N17)

A WordPress numeric post ID belongs to its original installation. Reconnecting a
new host or provider account into the same destination must not make old update or
unpublish receipts address a different site's post with the same number.

The application now rejects identity replacement with
`destination_identity_in_use` (409) while that destination has queued, in-flight,
unknown or still-published articles. This guard also serializes with concurrent
publication creation. A rotation is permitted when the canonical installation URL
and the numeric account ID returned by WordPress verification match the stored
verified identity. A username or a new password alone does not prove continuity.
Another authorized project owner may rotate the same account's application password;
the credential envelope keeps the stable site-owner context used by the worker.

Before a separately authorized replacement, list the destination's active and
unresolved publication receipts, reconcile unknown outcomes against the original
installation, and unpublish the still-live articles through the existing permission
and receipt guards. Only confirmed unpublication of all articles releases the old
identity for replacement. Historical rows remain available. If the old installation
or an authoritative legacy account identity is unavailable, retain the hold and
prepare a specific owner decision; do not overwrite the identity or clear receipts
with SQL to bypass it. New publication to the replacement installation requires the
normal reviewed revision and publication flow.

## Research collection authority and legacy sources (N21)

Competitor sources and niche alerts are read in their selected project through
current membership. Research edits require the existing content create/edit roles;
an authorized author can manage shared project sources without taking ownership of
the original creator's private ideas. A radar run/result additionally retains its
existing creator restriction and cannot be copied from a revoked/other project.

Migration `20261021_competitor_collection_authority.sql` adds the distinct
`competitors.collection_requested_by_user_id`. New sources and explicit refresh or
resume actions record their actual requester; periodic collection uses that actor
and rechecks current membership, role, project/channel state and account access.
The original `user_id` remains unchanged. Returning provider data is checked again
before persistence; a committed revocation during collection prevents saving it.

Legacy null actors and old queued research jobs without explicit actor/project
context are held. The migration does not invent a requester or backfill from the
creator. Read-only inventory before rollout:

```sql
select source.id, source.channel_id, channel.project_id, source.status,
       source.user_id as original_creator,
       source.collection_requested_by_user_id as collection_actor
  from competitors source
  join channels channel on channel.id=source.channel_id
 where source.is_active and source.collection_requested_by_user_id is null
 order by source.id;
```

Present this list to authorized project participants. For a source they intend to
continue collecting, use the existing explicit refresh/resume action in the correct
project; review actual paid-provider caps before any enabled AI follow-up. Do not
mass-change creator IDs or replay old jobs with an inferred actor. The existing
20-source channel limit now serializes concurrent additions and counts every
network; it is not an approved monetary/storage budget.

## Background Telegram receipts after restore (N25)

Migration20 adds `telegram_background_deliveries` for stable project/user/event/part
identities. Restore quarantine also holds its `sending` and `rejected` rows as
`unknown`; successful, already unknown and positively pre-send `cancelled` states
are preserved. A restored rejection cannot prove that an effect was not sent after
the backup capture. Repeating quarantine and reopening the DB client must not make
these rows eligible for blind resend. The standalone fixture checks this with a
real dump/restore; it still reports `resumeAllowed:false` and does not measure
production RPO/RTO.

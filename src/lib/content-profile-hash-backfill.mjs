import { contentProfileHash, readContentProfileHash } from "./content-profile-hash.mjs";

// The projection the profile hash used before `updated_at` was dropped from it. Rows that still
// carry this digest were consistent with their project at the moment they were written, so the
// formula change alone must not turn them stale. Keep the column list and ordering frozen: the
// digest depends on both.
export const LEGACY_CONTENT_PROFILE_HASH_SELECT = `
  select channel_id, niche, audience, rubrics, formats, author_role, goal, cta, taboo,
         profile_answers, quality, ready, source, updated_at
    from content_brief
   where project_id = $1
   order by channel_id`;

async function readLegacyProfileHash(db, projectId) {
  const result = await db.query(LEGACY_CONTENT_PROFILE_HASH_SELECT, [projectId]);
  return contentProfileHash(result?.rows ?? []);
}

function affected(result) {
  return Number(result?.rowCount ?? 0);
}

/**
 * Moves one project's monthly campaigns, plans and queued regenerations from the legacy digest
 * to the current one. Only rows matching the legacy digest exactly are touched, so genuinely
 * stale rows keep their staleness and repeated runs are no-ops. Plan versions stay untouched:
 * this is a re-baseline, not an edit, and bumping them would break open tabs.
 */
export async function rebaseProjectProfileHashes(client, projectId) {
  const legacyHash = await readLegacyProfileHash(client, projectId);
  const currentHash = await readContentProfileHash(client, projectId);
  if (legacyHash === currentHash) {
    return { projectId, legacyHash, currentHash, campaigns: 0, plans: 0, operations: 0, skipped: true };
  }
  const campaigns = await client.query(
    `update monthly_campaigns set profile_hash = $3, updated_at = now()
      where project_id = $1 and profile_hash = $2`,
    [projectId, legacyHash, currentHash],
  );
  const plans = await client.query(
    `update monthly_campaign_plans set source_profile_hash = $3, updated_at = now()
      where project_id = $1 and source_profile_hash = $2`,
    [projectId, legacyHash, currentHash],
  );
  const operations = await client.query(
    `update monthly_campaign_regeneration_operations
        set base_profile_hash = $3, updated_at = now()
      where project_id = $1 and base_profile_hash = $2
        and status in ('pending', 'processing', 'retryable_failed')`,
    [projectId, legacyHash, currentHash],
  );
  return {
    projectId,
    legacyHash,
    currentHash,
    campaigns: affected(campaigns),
    plans: affected(plans),
    operations: affected(operations),
    skipped: false,
  };
}

export async function listProjectsWithMonthlyCampaigns(db) {
  const result = await db.query(
    "select distinct project_id from monthly_campaigns order by project_id",
    [],
  );
  return (result?.rows ?? []).map((row) => Number(row.project_id));
}

/**
 * One transaction per project so a campaign and its plans never end up on different digests.
 */
export async function rebaseLegacyProfileHashes({ pool, onProject }) {
  const projectIds = await listProjectsWithMonthlyCampaigns(pool);
  const totals = { projects: projectIds.length, rebased: 0, campaigns: 0, plans: 0, operations: 0 };
  for (const projectId of projectIds) {
    const client = await pool.connect();
    try {
      await client.query("begin", []);
      const report = await rebaseProjectProfileHashes(client, projectId);
      await client.query("commit", []);
      if (report.campaigns || report.plans || report.operations) totals.rebased += 1;
      totals.campaigns += report.campaigns;
      totals.plans += report.plans;
      totals.operations += report.operations;
      onProject?.(report);
    } catch (error) {
      await client.query("rollback", []).catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return totals;
}

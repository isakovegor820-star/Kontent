export const RECON_REFRESH_HOURS = 2;
export const RECON_CRON_PATTERN = "0 */2 * * *";

/** Returns every due active source across all projects and channels, without a page limit. */
export async function selectDueCompetitorSources(pool) {
  return (
    await pool.query(
      `select id, user_id, channel_id, network, handle, title, is_active from competitors
        where network in ('tg','instagram') and is_active
          and (status in ('pending','refreshing') or collected_at is null
               or collected_at < now() - interval '${RECON_REFRESH_HOURS} hours')`,
    )
  ).rows;
}

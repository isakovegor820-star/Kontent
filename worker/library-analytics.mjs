import {
  LIBRARY_FORMULA_VERSION,
  scoreLibraryCohorts,
} from "../src/lib/library-scoring.mjs";

/**
 * Recomputes one competitor's comparable cohorts and persists the exact formula version.
 * The caller remains responsible for idea generation after this deterministic step.
 */
export async function persistCompetitorLibraryAnalytics({
  pool,
  channelId,
  sourceId,
  posts,
  now = new Date(),
}) {
  await pool.query(
    `update competitor_posts
        set is_hit = false,
            hit_ratio = null,
            analytics_lift = null,
            analytics_er_bayes = null,
            analytics_velocity = null,
            analytics_velocity_z = null,
            analytics_freshness = null,
            analytics_score = null,
            analytics_formula_version = $2,
            analytics_quality = null,
            analytics_maturity = null,
            analytics_computed_at = now()
      where competitor_id = $1`,
    [sourceId, LIBRARY_FORMULA_VERSION],
  );
  const scored = scoreLibraryCohorts(
    (Array.isArray(posts) ? posts : []).map((post) => ({
      ...post,
      channelId,
      sourceId,
      postedAt: post.posted_at ?? post.postedAt,
    })),
    { now },
  );
  for (const item of scored) {
    await pool.query(
      `update competitor_posts
          set is_hit = $2,
              hit_ratio = $3,
              analytics_lift = $3,
              analytics_er_bayes = $4,
              analytics_velocity = $5,
              analytics_velocity_z = $6,
              analytics_freshness = $7,
              analytics_score = $8,
              analytics_formula_version = $9,
              analytics_quality = $10,
              analytics_maturity = $11,
              analytics_computed_at = now()
        where id = $1`,
      [
        item.id,
        item.isHit,
        item.lift,
        item.erBayes,
        item.velocity,
        item.velocityZ,
        item.freshness,
        item.score,
        LIBRARY_FORMULA_VERSION,
        item.dataQuality,
        item.dataMaturity,
      ],
    );
  }
  return scored;
}

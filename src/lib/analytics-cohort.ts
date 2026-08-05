export interface AnalyticsCohortPost {
  status: string;
  verification_state: string | null;
  views: number | null;
  reactions?: number | null;
}

export interface AnalyticsCohortSummary<T extends AnalyticsCohortPost> {
  verifiedPosts: T[];
  withMetrics: (T & { views: number })[];
  missing: number;
  unverified: number;
  totalViews: number;
  avgViews: number | null;
}

export type AnalyticsConfidence = "insufficient" | "low" | "medium" | "high";

export function analyticsConfidence(sampleSize: number): AnalyticsConfidence {
  const size = Math.max(0, Math.floor(Number(sampleSize) || 0));
  if (size < 2) return "insufficient";
  if (size < 5) return "low";
  if (size < 10) return "medium";
  return "high";
}

/** One auditable cohort powers totals, averages, best-post conclusions and table rows. */
export function summarizeAnalyticsCohort<T extends AnalyticsCohortPost>(
  posts: readonly T[],
): AnalyticsCohortSummary<T> {
  const verifiedPosts = posts.filter(
    (post) => post.status === "published" && post.verification_state === "verified",
  );
  const withMetrics = verifiedPosts.filter(
    (post): post is T & { views: number } => Number.isFinite(post.views),
  );
  const totalViews = withMetrics.reduce((sum, post) => sum + post.views, 0);

  return {
    verifiedPosts,
    withMetrics,
    missing: posts.filter(
      (post) => post.status === "missing" || post.status === "deleted_external",
    ).length,
    unverified: posts.filter(
      (post) => post.status === "published_unverified" || post.verification_state === "unverified",
    ).length,
    totalViews,
    avgViews: withMetrics.length ? Math.round(totalViews / withMetrics.length) : null,
  };
}

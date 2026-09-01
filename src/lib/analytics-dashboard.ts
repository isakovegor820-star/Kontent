import { analyticsConfidence, summarizeAnalyticsCohort } from "./analytics-cohort";

export const ANALYTICS_PERIODS = [7, 30, 90, 365] as const;
export type AnalyticsPeriodDays = (typeof ANALYTICS_PERIODS)[number];

export type DashboardPost = {
  status: string;
  verification_state: string | null;
  views: number | null;
  reactions: number | null;
};

export type SubscriberPoint = {
  snapshot_date: string;
  subscribers: number;
};

export function parseAnalyticsPeriodDays(value: string | null): AnalyticsPeriodDays {
  const parsed = Number(value);
  return ANALYTICS_PERIODS.includes(parsed as AnalyticsPeriodDays)
    ? parsed as AnalyticsPeriodDays
    : 30;
}

export function analyticsPercentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export function median(values: readonly number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? Math.round((finite[middle - 1] + finite[middle]) / 2)
    : Math.round(finite[middle]);
}

export function subscriberGrowth(series: readonly SubscriberPoint[]): number | null {
  if (series.length < 2) return null;
  return series[series.length - 1].subscribers - series[0].subscribers;
}

export function summarizeDashboardPeriod<T extends DashboardPost>(
  currentPosts: readonly T[],
  previousPosts: readonly T[],
) {
  const current = summarizeAnalyticsCohort(currentPosts);
  const previous = summarizeAnalyticsCohort(previousPosts);
  const engagement = current.withMetrics.filter(
    (post): post is T & { views: number; reactions: number } => Number.isFinite(post.reactions),
  );
  const previousEngagement = previous.withMetrics.filter(
    (post): post is T & { views: number; reactions: number } => Number.isFinite(post.reactions),
  );
  const engagementViews = engagement.reduce((sum, post) => sum + post.views, 0);
  const engagementReactions = engagement.reduce((sum, post) => sum + post.reactions, 0);
  const previousEngagementViews = previousEngagement.reduce((sum, post) => sum + post.views, 0);
  const previousEngagementReactions = previousEngagement.reduce((sum, post) => sum + post.reactions, 0);
  const engagementRate = engagementViews > 0
    ? Number(((engagementReactions / engagementViews) * 100).toFixed(1))
    : null;
  const previousEngagementRate = previousEngagementViews > 0
    ? Number(((previousEngagementReactions / previousEngagementViews) * 100).toFixed(1))
    : null;

  return {
    current,
    previous,
    medianViews: median(current.withMetrics.map((post) => post.views)),
    totalReactions: engagementReactions,
    engagementRate,
    confidence: analyticsConfidence(current.withMetrics.length),
    comparisons: {
      averageViewsPercent: analyticsPercentChange(current.avgViews, previous.avgViews),
      engagementPoints: engagementRate != null && previousEngagementRate != null
        ? Number((engagementRate - previousEngagementRate).toFixed(1))
        : null,
      publishedPercent: analyticsPercentChange(current.verifiedPosts.length, previous.verifiedPosts.length),
    },
  };
}

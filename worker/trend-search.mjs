import { median } from "../src/lib/radar-search.mjs";

export const TREND_SEARCH_MAX_CHANNELS = 18;
export const TREND_SEARCH_MAX_PAGES = 12;
export const TREND_SEARCH_DEADLINE_MS = 120_000;

export function matureTrendBaseline(posts, measuredAt = Date.now()) {
  const counts = posts.filter((post) => {
    const published = Date.parse(String(post.postedAt || ""));
    return post.views != null && Number.isFinite(Number(post.views)) && Number(post.views) >= 0
      && published <= measuredAt - 48 * 3_600_000 && published >= measuredAt - 90 * 86_400_000;
  }).map((post) => Number(post.views));
  return { medianViews: counts.length >= 5 ? median(counts) : null, baselinePosts: counts.length };
}

/** A threshold is a classification; only this measured ratio may be displayed. */
export function matureTrendRatio(post, baseline, measuredAt = Date.now()) {
  const published = Date.parse(String(post?.postedAt || ""));
  if (post?.views == null || !Number.isFinite(Number(post.views)) || Number(post.views) < 0
    || !Number.isFinite(published) || published > measuredAt - 48 * 3_600_000
    || baseline.baselinePosts < 5 || !(baseline.medianViews > 0)) return null;
  return Number(post.views) / baseline.medianViews;
}

export function trendHistoryBoundary(posts, since) {
  const timestamps = posts.map((post) => Date.parse(String(post.postedAt || ""))).filter(Number.isFinite);
  return timestamps.length > 0 && Math.min(...timestamps) <= since;
}

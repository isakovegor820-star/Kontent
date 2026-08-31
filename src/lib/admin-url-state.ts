export function adminSystemSelection(
  search: string | URLSearchParams,
  componentIds: readonly string[],
): string | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const selected = params.get("system");
  return selected && componentIds.includes(selected) ? selected : null;
}

export function adminSystemHref(currentUrl: string, componentId: string | null): string {
  const url = new URL(currentUrl, "http://localhost");
  if (componentId) url.searchParams.set("system", componentId);
  else url.searchParams.delete("system");
  url.hash = "system";
  return `${url.pathname}${url.search}${url.hash}`;
}

export const ADMIN_ANALYTICS_QUERY_KEYS = [
  "range", "from", "to", "project", "segment", "tenure", "device",
  "version", "release", "analyticsSection", "analyticsTab",
] as const;

export type AdminAnalyticsUrlChange = Partial<Record<(typeof ADMIN_ANALYTICS_QUERY_KEYS)[number], string | null>>;

export function adminAnalyticsHref(currentUrl: string, changes: AdminAnalyticsUrlChange): string {
  const url = new URL(currentUrl, "http://localhost");
  for (const [key, value] of Object.entries(changes)) {
    if (!ADMIN_ANALYTICS_QUERY_KEYS.includes(key as (typeof ADMIN_ANALYTICS_QUERY_KEYS)[number])) continue;
    if (value == null || value === "" || value === "all") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  url.hash = "aurora-analytics";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function adminAnalyticsQuery(search: string | URLSearchParams): URLSearchParams {
  const source = typeof search === "string" ? new URLSearchParams(search) : search;
  const result = new URLSearchParams();
  for (const key of ADMIN_ANALYTICS_QUERY_KEYS) {
    const value = source.get(key);
    if (value) result.set(key, value);
  }
  return result;
}

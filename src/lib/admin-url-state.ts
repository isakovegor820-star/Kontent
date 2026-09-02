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

export const ADMIN_USERS_QUERY_KEYS = ["q", "status", "network", "sort", "page", "user"] as const;
export type AdminUsersUrlKey = (typeof ADMIN_USERS_QUERY_KEYS)[number];
export type AdminUsersUrlChange = Partial<Record<AdminUsersUrlKey, string | number | null>>;

const ADMIN_USERS_DEFAULTS: Readonly<Record<AdminUsersUrlKey, string>> = Object.freeze({
  q: "", status: "all", network: "all", sort: "activity_desc", page: "1", user: "",
});

/** Users section state lives in the query string so filters, paging and the open card survive reload/back. */
export function adminUsersHref(currentUrl: string, changes: AdminUsersUrlChange): string {
  const url = new URL(currentUrl, "http://localhost");
  for (const [key, value] of Object.entries(changes)) {
    if (!ADMIN_USERS_QUERY_KEYS.includes(key as AdminUsersUrlKey)) continue;
    const normalized = value == null ? "" : String(value);
    if (normalized === "" || normalized === ADMIN_USERS_DEFAULTS[key as AdminUsersUrlKey]) url.searchParams.delete(key);
    else url.searchParams.set(key, normalized);
  }
  url.hash = "users";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function adminUsersQuery(search: string | URLSearchParams): Record<AdminUsersUrlKey, string> {
  const source = typeof search === "string" ? new URLSearchParams(search) : search;
  const result = { ...ADMIN_USERS_DEFAULTS };
  for (const key of ADMIN_USERS_QUERY_KEYS) {
    const value = source.get(key);
    if (value) result[key] = value;
  }
  return result;
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

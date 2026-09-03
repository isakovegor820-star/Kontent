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
  "version", "release", "analyticsSection", "analyticsTab", "analyticsView",
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

export const ADMIN_PROJECTS_QUERY_KEYS = ["prq", "prstatus", "prnetwork", "prsort", "prpage", "prid"] as const;
export type AdminProjectsUrlKey = (typeof ADMIN_PROJECTS_QUERY_KEYS)[number];
export type AdminProjectsUrlChange = Partial<Record<AdminProjectsUrlKey, string | number | null>>;

const ADMIN_PROJECTS_DEFAULTS: Readonly<Record<AdminProjectsUrlKey, string>> = Object.freeze({
  prq: "", prstatus: "all", prnetwork: "all", prsort: "activity_desc", prpage: "1", prid: "",
});

export function adminProjectsHref(currentUrl: string, changes: AdminProjectsUrlChange): string {
  const url = new URL(currentUrl, "http://localhost");
  for (const [key, value] of Object.entries(changes)) {
    if (!ADMIN_PROJECTS_QUERY_KEYS.includes(key as AdminProjectsUrlKey)) continue;
    const normalized = value == null ? "" : String(value);
    if (normalized === "" || normalized === ADMIN_PROJECTS_DEFAULTS[key as AdminProjectsUrlKey]) url.searchParams.delete(key);
    else url.searchParams.set(key, normalized);
  }
  url.hash = "projects";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function adminProjectsQuery(search: string | URLSearchParams): Record<AdminProjectsUrlKey, string> {
  const source = typeof search === "string" ? new URLSearchParams(search) : search;
  const result = { ...ADMIN_PROJECTS_DEFAULTS };
  for (const key of ADMIN_PROJECTS_QUERY_KEYS) {
    const value = source.get(key);
    if (value) result[key] = value;
  }
  return result;
}

export const ADMIN_AUDIT_QUERY_KEYS = ["aq", "aproject", "aactor", "aarea", "apage"] as const;
export type AdminAuditUrlKey = (typeof ADMIN_AUDIT_QUERY_KEYS)[number];
export type AdminAuditUrlChange = Partial<Record<AdminAuditUrlKey, string | number | null>>;

const ADMIN_AUDIT_DEFAULTS: Readonly<Record<AdminAuditUrlKey, string>> = Object.freeze({
  aq: "", aproject: "", aactor: "", aarea: "", apage: "1",
});

export function adminAuditHref(currentUrl: string, changes: AdminAuditUrlChange): string {
  const url = new URL(currentUrl, "http://localhost");
  for (const [key, value] of Object.entries(changes)) {
    if (!ADMIN_AUDIT_QUERY_KEYS.includes(key as AdminAuditUrlKey)) continue;
    const normalized = value == null ? "" : String(value);
    if (normalized === "" || normalized === ADMIN_AUDIT_DEFAULTS[key as AdminAuditUrlKey]) url.searchParams.delete(key);
    else url.searchParams.set(key, normalized);
  }
  url.hash = "audit";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function adminAuditQuery(search: string | URLSearchParams): Record<AdminAuditUrlKey, string> {
  const source = typeof search === "string" ? new URLSearchParams(search) : search;
  const result = { ...ADMIN_AUDIT_DEFAULTS };
  for (const key of ADMIN_AUDIT_QUERY_KEYS) {
    const value = source.get(key);
    if (value) result[key] = value;
  }
  return result;
}

export const ADMIN_PUBLICATIONS_QUERY_KEYS = ["pq", "pstatus", "pnetwork", "pproject", "perror", "psort", "ppage"] as const;
export type AdminPublicationsUrlKey = (typeof ADMIN_PUBLICATIONS_QUERY_KEYS)[number];
export type AdminPublicationsUrlChange = Partial<Record<AdminPublicationsUrlKey, string | number | null>>;

const ADMIN_PUBLICATIONS_DEFAULTS: Readonly<Record<AdminPublicationsUrlKey, string>> = Object.freeze({
  pq: "", pstatus: "attention", pnetwork: "all", pproject: "", perror: "", psort: "recent", ppage: "1",
});

/** Publications filters are prefixed with `p` so they coexist with users/analytics state in one URL. */
export function adminPublicationsHref(currentUrl: string, changes: AdminPublicationsUrlChange): string {
  const url = new URL(currentUrl, "http://localhost");
  for (const [key, value] of Object.entries(changes)) {
    if (!ADMIN_PUBLICATIONS_QUERY_KEYS.includes(key as AdminPublicationsUrlKey)) continue;
    const normalized = value == null ? "" : String(value);
    if (normalized === "" || normalized === ADMIN_PUBLICATIONS_DEFAULTS[key as AdminPublicationsUrlKey]) url.searchParams.delete(key);
    else url.searchParams.set(key, normalized);
  }
  url.hash = "publications";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function adminPublicationsQuery(search: string | URLSearchParams): Record<AdminPublicationsUrlKey, string> {
  const source = typeof search === "string" ? new URLSearchParams(search) : search;
  const result = { ...ADMIN_PUBLICATIONS_DEFAULTS };
  for (const key of ADMIN_PUBLICATIONS_QUERY_KEYS) {
    const value = source.get(key);
    if (value) result[key] = value;
  }
  return result;
}

/** Maps the prefixed URL keys onto the API query string of `/api/admin/publications`. */
export function adminPublicationsApiParams(state: Record<AdminPublicationsUrlKey, string>): URLSearchParams {
  return new URLSearchParams({
    q: state.pq,
    status: state.pstatus,
    network: state.pnetwork,
    project: state.pproject,
    error: state.perror,
    sort: state.psort,
    page: state.ppage,
  });
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

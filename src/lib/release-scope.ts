/**
 * Stable release boundary. Every authenticated product section is part of Aurora's
 * production surface. The preview flag is reserved for legacy/public design variants;
 * it must never make the signed-in application look partially empty.
 */

export const STABLE_RELEASE_CAPABILITIES = Object.freeze([
  "authentication",
  "projects",
  "onboarding",
  "telegram",
  "calendar",
  "composer",
  "sources-and-evidence",
  "editorial-approval",
  "publication",
  "operation-history",
  "basic-analytics",
  "settings",
  "today",
  "studio",
  "autopilot",
  "trends-and-recon",
  "opportunities",
  "site-analysis",
  "growth",
  "knowledge",
] as const);

export const EXPERIMENTAL_APP_PATH_PREFIXES = Object.freeze([] as const);

export const EXPERIMENTAL_PUBLIC_PATH_PREFIXES = Object.freeze([
  "/old",
  "/v2",
  "/v3",
  "/variants",
  "/scroll-test",
  "/finale",
  "/footer",
  "/cycle",
  "/memory",
  "/quality",
  "/reasons",
  "/how",
  "/bot",
  "/rss",
] as const);

export const EXPERIMENTAL_API_PATH_PREFIXES = Object.freeze([] as const);

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isExperimentalReleasePath(pathname: string): boolean {
  return [
    ...EXPERIMENTAL_APP_PATH_PREFIXES,
    ...EXPERIMENTAL_PUBLIC_PATH_PREFIXES,
    ...EXPERIMENTAL_API_PATH_PREFIXES,
  ]
    .some((prefix) => pathMatchesPrefix(pathname, prefix));
}

export function isExperimentalReleaseApiPath(pathname: string): boolean {
  return EXPERIMENTAL_API_PATH_PREFIXES.some((prefix) => pathMatchesPrefix(pathname, prefix));
}

export function experimentalRoutesEnabled(value: string | undefined): boolean {
  return value === "1";
}

export function stableReleaseRedirect(pathname: string): "/app/calendar" | "/" | null {
  if (EXPERIMENTAL_APP_PATH_PREFIXES.some((prefix) => pathMatchesPrefix(pathname, prefix))) {
    return "/app/calendar";
  }
  if (EXPERIMENTAL_PUBLIC_PATH_PREFIXES.some((prefix) => pathMatchesPrefix(pathname, prefix))) {
    return "/";
  }
  return null;
}

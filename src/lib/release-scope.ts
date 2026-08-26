/**
 * Stable release boundary. Experimental pages stay in the repository for controlled
 * development, but production does not expose them unless the release owner opts in
 * explicitly at build/runtime with NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES=1.
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
] as const);

export const EXPERIMENTAL_APP_PATH_PREFIXES = Object.freeze([
  "/app/today",
  "/app/studio",
  "/app/autopilot",
  "/app/trends",
  "/app/radar",
  "/app/recon",
  "/app/opportunities",
  "/app/site-analysis",
  "/app/growth",
  "/app/knowledge",
] as const);

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

export const EXPERIMENTAL_API_PATH_PREFIXES = Object.freeze([
  "/api/audience-assistant",
  "/api/audience-questions",
  "/api/autopilot",
  "/api/channels/connect-vk",
  "/api/channels/oauth",
  "/api/channels/tenchat",
  "/api/growth",
  "/api/ideas",
  "/api/knowledge",
  "/api/legal-video-scripts",
  "/api/legal-visuals",
  "/api/monthly-campaigns",
  "/api/opportunities",
  "/api/radar",
  "/api/site-analysis",
  "/api/studio",
  "/api/today",
  "/api/trends",
  "/api/typography",
] as const);

export const STABLE_API_PATH_EXCEPTIONS = Object.freeze([
  "/api/autopilot/brief",
  "/api/knowledge/extract-profile",
] as const);

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
  if (STABLE_API_PATH_EXCEPTIONS.includes(pathname as (typeof STABLE_API_PATH_EXCEPTIONS)[number])) {
    return false;
  }
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

import { getClientProjectId } from "./project-fetch";

/** Preserve the tab's project on native browser requests and persisted media URLs. */
export function projectNativeUrl(value: string, projectId: number | null = getClientProjectId()): string {
  if (!/^\/api\/(?:channels\/oauth\/start|media\/assets\/\d+|legal-video-scripts\/\d+\/production-brief|sites\/\d+\/reports\/\d+\/export|site-analysis\/\d+\/export|library\/exports\/\d+)(?:[?#]|$)/u.test(value)) return value;
  const url = new URL(value, "http://native.invalid");
  // An absent tab context must fail closed, never fall back to another tab's preference.
  url.searchParams.set("projectId", String(Number.isSafeInteger(projectId) && Number(projectId) > 0 ? projectId : 0));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function mediaAssetUrl(assetId: string | number, projectId: number): string {
  return projectNativeUrl(`/api/media/assets/${assetId}`, projectId);
}

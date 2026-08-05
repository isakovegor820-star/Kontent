import type { NextRequest } from "next/server";

export const OAUTH_STATE_COOKIE = "oauth_state";

/** Build the absolute OAuth callback URL from trusted proxy request headers. */
export function callbackUrlFromReq(req: NextRequest, network: string): string {
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const host =
    req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  return `${proto}://${host}/api/channels/oauth/callback?network=${network}`;
}

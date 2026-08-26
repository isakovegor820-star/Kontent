import type { NextRequest } from "next/server";

export const OAUTH_STATE_COOKIE = "oauth_state";

/** Build the absolute OAuth callback URL from the server-owned public application origin. */
export function callbackUrlFromReq(req: NextRequest, network: string): string {
  const configured = String(process.env.APP_URL || "").trim();
  let origin: string;
  if (configured) {
    const parsed = new URL(configured);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("APP_URL protocol is invalid");
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
      throw new Error("APP_URL must use HTTPS in production");
    }
    origin = parsed.origin;
  } else {
    if (process.env.NODE_ENV === "production") throw new Error("APP_URL is required in production");
    origin = new URL(req.url).origin;
  }
  const callback = new URL("/api/channels/oauth/callback", origin);
  callback.searchParams.set("network", network);
  return callback.toString();
}

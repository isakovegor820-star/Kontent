import type { NextRequest } from "next/server";

/**
 * Browser mutations require an explicit Origin and compare it with a server-owned
 * allowlist. X-Forwarded-* and Host are request metadata, not trust anchors. Non-browser
 * clients must use dedicated authenticated endpoints instead of bypassing CSRF checks.
 */
export function hasTrustedMutationOrigin(req: NextRequest): boolean {
  const fetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") return false;

  const supplied = req.headers.get("origin");
  if (!supplied || supplied === "null") {
    // Keep local CLI/dev tooling usable without weakening deployed browser mutations.
    // Production never gets this exception, even if an attacker forges Host/forwarded data.
    const localHost = ["localhost", "127.0.0.1", "::1"].includes(req.nextUrl.hostname);
    return process.env.NODE_ENV !== "production" && localHost;
  }

  try {
    const origin = new URL(supplied).origin;
    const configured = [
      process.env.APP_URL,
      process.env.NEXT_PUBLIC_APP_URL,
      ...String(process.env.AURORA_ALLOWED_ORIGINS || "").split(","),
    ].flatMap((value) => {
      try {
        const candidate = new URL(String(value || "").trim());
        if (process.env.NODE_ENV === "production" && candidate.protocol !== "https:") return [];
        return [candidate.origin];
      } catch {
        return [];
      }
    });
    // Local/test requests can use their actual URL. Production requires an explicit
    // deployment origin so an attacker-controlled Host cannot define the expected value.
    if (process.env.NODE_ENV !== "production") configured.push(req.nextUrl.origin);
    return new Set(configured).has(origin);
  } catch {
    return false;
  }
}

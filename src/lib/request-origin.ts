import type { NextRequest } from "next/server";

export interface MutationOriginOptions {
  /** Session-creating and token-consuming browser flows may not use the service-client exception. */
  requireBrowserOrigin?: boolean;
}

/**
 * Browser mutations compare Origin with the server-owned APP_URL. When a browser omits
 * Origin, Sec-Fetch-Site: same-origin is acceptable evidence because scripts cannot forge
 * that header. Cookie-bearing requests without either signal fail closed. Cookie-less
 * service clients remain eligible for their route-specific authentication.
 */
export function hasTrustedMutationOrigin(
  req: NextRequest,
  options: MutationOriginOptions = {},
): boolean {
  const fetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") return false;

  const supplied = req.headers.get("origin");
  if (!supplied || supplied === "null") {
    if (supplied === "null") return false;
    if (fetchSite === "same-origin") return true;
    if (fetchSite || options.requireBrowserOrigin) return false;
    // CSRF is relevant only when ambient browser credentials are present. Worker/service
    // endpoints authenticate cookie-less calls independently (for example with a bearer).
    return !req.headers.has("cookie");
  }

  try {
    const origin = new URL(supplied).origin;
    // `npm run dev` may choose the next free port. Browsers still provide an unforgeable
    // same-origin Fetch Metadata signal; accept that actual local origin only outside
    // production so mutations keep working on the fallback port.
    if (
      process.env.NODE_ENV !== "production"
      && fetchSite === "same-origin"
      && originFromRequest(req) === origin
    ) return true;
    const configured = new URL(String(process.env.APP_URL || "").trim());
    if (process.env.NODE_ENV === "production" && configured.protocol !== "https:") return false;
    return origin === configured.origin;
  } catch {
    // Tests and local development still have a deterministic expected origin even before
    // APP_URL is configured. Production never derives trust from Host/request metadata.
    return process.env.NODE_ENV !== "production" && originFromRequest(req) === supplied;
  }
}

function originFromRequest(req: NextRequest): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}

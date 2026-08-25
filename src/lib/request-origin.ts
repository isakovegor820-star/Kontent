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
    const parsedOrigin = new URL(supplied);
    const origin = parsedOrigin.origin;
    // `npm run dev` may choose the next free port. Browsers still provide an unforgeable
    // same-origin Fetch Metadata signal; accept that actual local origin only outside
    // production so mutations keep working on the fallback port.
    if (
      process.env.NODE_ENV !== "production"
      && fetchSite === "same-origin"
      && trustedDevelopmentRequestOrigin(req, parsedOrigin)
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

function trustedDevelopmentRequestOrigin(req: NextRequest, supplied: URL): boolean {
  if (!["http:", "https:"].includes(supplied.protocol) || !isLocalDevelopmentHostname(supplied.hostname)) {
    return false;
  }
  const host = req.headers.get("host")?.trim();
  if (!host || /[\s/@\\]/u.test(host)) return false;
  try {
    const actual = new URL(`${supplied.protocol}//${host}`);
    return isLocalDevelopmentHostname(actual.hostname) && actual.origin === supplied.origin;
  } catch {
    return false;
  }
}

function isLocalDevelopmentHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1") return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254);
}

function originFromRequest(req: NextRequest): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}

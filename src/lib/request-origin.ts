import type { NextRequest } from "next/server";

/**
 * Browser mutations rely on SameSite cookies and additionally reject an explicit
 * cross-origin request. Requests without browser origin metadata remain available to
 * trusted server-side clients (workers/bots); they still need normal authentication.
 */
export function hasTrustedMutationOrigin(req: NextRequest): boolean {
  const fetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") return false;

  const supplied = req.headers.get("origin");
  if (!supplied) return true;

  try {
    const origin = new URL(supplied).origin;
    const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const host = forwardedHost || req.headers.get("host")?.split(",")[0]?.trim();
    const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const proto = forwardedProto || req.nextUrl.protocol.replace(/:$/, "");
    const expected = host ? `${proto}://${host}` : req.nextUrl.origin;
    return origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

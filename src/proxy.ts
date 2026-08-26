import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { buildContentSecurityPolicy } from "@/lib/content-security-policy";
import {
  experimentalRoutesEnabled,
  isExperimentalReleaseApiPath,
  stableReleaseRedirect,
} from "@/lib/release-scope";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = buildContentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const experimentsEnabled = experimentalRoutesEnabled(
    process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES,
  );
  const experimentalApiBlocked = !experimentsEnabled
    && isExperimentalReleaseApiPath(request.nextUrl.pathname);
  const redirectTarget = experimentsEnabled ? null : stableReleaseRedirect(request.nextUrl.pathname);
  const response = experimentalApiBlocked
    ? NextResponse.json({ ok: false, error: "not_found" }, { status: 404 })
    : redirectTarget
      ? NextResponse.redirect(new URL(redirectTarget, request.url))
      : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

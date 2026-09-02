import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { buildContentSecurityPolicy } from "@/lib/content-security-policy";
import {
  experimentalRoutesEnabled,
  isExperimentalReleaseApiPath,
  stableReleaseRedirect,
} from "@/lib/release-scope";
import { hostedSlugFromHost } from "@/lib/site-destinations/hosted.mjs";

/**
 * Хостируемый раздел клиента живёт на <slug>.<AURORA_SITES_DOMAIN> и переписывается на
 * внутренние маршруты /hosted/<slug>/…; всё остальное на таком хосте — 404, чтобы
 * служебный поддомен не отдавал интерфейс продукта под чужим доменом.
 */
export function hostedSectionRewrite(request: NextRequest, requestHeaders?: Headers): NextResponse | null {
  const slug = hostedSlugFromHost(request.headers.get("host"));
  if (!slug) return null;
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico" || pathname === "/icon.svg") return null;
  if (pathname.startsWith("/hosted/") || pathname.startsWith("/api/") || pathname.startsWith("/app")) {
    return new NextResponse("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const url = request.nextUrl.clone();
  url.pathname = `/hosted/${slug}${pathname === "/" ? "" : pathname}`;
  return NextResponse.rewrite(url, requestHeaders ? { request: { headers: requestHeaders } } : undefined);
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = buildContentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const hosted = hostedSectionRewrite(request, requestHeaders);
  if (hosted) {
    hosted.headers.set("Content-Security-Policy", policy);
    return hosted;
  }

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

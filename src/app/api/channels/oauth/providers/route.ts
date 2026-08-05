import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getOAuthConfig } from "@/lib/social-providers.mjs";
import {
  getOAuthProviderCapability,
  OAUTH_PROVIDER_IDS,
} from "@/lib/oauth-capabilities";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    {
      ok: true,
      providers: Object.fromEntries(
        OAUTH_PROVIDER_IDS.map((network) => [
          network,
          getOAuthProviderCapability(network, Boolean(getOAuthConfig(network))),
        ]),
      ),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

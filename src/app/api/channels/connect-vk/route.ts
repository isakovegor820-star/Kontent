import { withProjectRoute } from "@/lib/project-route";
// Legacy connection stays closed until supported authorization and publication rights
// are proven. Token persistence below uses the saved channel identity atomically.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import {
  ProjectAccessError,
  requireSelectedProjectPermission,
} from "@/lib/project-permissions";
import { resolveGroupByToken } from "@/lib/vk";
import { saveVkChannelConnection } from "@/lib/vk-channel-connection";
import { resolveProviderLiveWriteBoundary } from "@/lib/provider-write-boundary.mjs";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

async function handlePOST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  let projectId: number;
  try {
    projectId = (await requireSelectedProjectPermission(pool, user.id, "project.manage")).projectId;
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    throw error;
  }

  const boundary = resolveProviderLiveWriteBoundary("vk");
  if (!boundary.allowed) {
    return NextResponse.json({ ok: false, error: boundary.code, message: boundary.message }, { status: 409 });
  }

  let body: unknown;
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const token = String((body as { token?: unknown })?.token ?? "").trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "empty" }, { status: 422 });
  }

  // Чувствительный роут (работа с чужими токенами): режем частые переборы по IP.
  const ip = clientIp(req);
  const byIp = await checkRateLimit(`connect-vk:ip:${ip}`, 10, 900, { failureMode: "closed" });
  if (!byIp.allowed) return rateLimitResponse(byIp);

  if (!process.env.TOKENS_MASTER_KEY) {
    console.error("[/api/channels/connect-vk] TOKENS_MASTER_KEY не задан — шифровать токен нечем");
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }

  // Metadata lookup is not publication authorization. This legacy flow remains
  // unreachable under the release registry; a supported auth adapter must replace it.
  const group = await resolveGroupByToken(token);
  if (!group) {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 422 });
  }

  try {
    const channel = await saveVkChannelConnection(pool, { userId: user.id, projectId, token, group });
    return NextResponse.json({ ok: true, channelId: channel.id, title: group.name });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ ok: false, error: "taken" }, { status: 409 });
    }
    console.error("[/api/channels/connect-vk]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export const POST = withProjectRoute(handlePOST);

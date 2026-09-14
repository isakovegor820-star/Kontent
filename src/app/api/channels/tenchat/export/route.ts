import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  createTenChatExportForProject,
  TenChatExportServiceError,
  type TenChatExportRequest,
} from "@/lib/tenchat-export-service";

export const runtime = "nodejs";
const TENCHAT_EXPORT_JSON_MAX_BYTES = 64 * 1024;
const TENCHAT_EXPORT_KEYS = new Set(["text", "scheduledAt", "assetIds", "draftId", "draftVersion"]);

type TenChatBodyResult =
  | { ok: true; body: TenChatExportRequest }
  | { ok: false; error: "tenchat_export_request_invalid" | "unsupported_media_type" | "payload_too_large" };

async function readTenChatExportBody(req: Request): Promise<TenChatBodyResult> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { ok: false, error: "unsupported_media_type" };
  try {
    const bytes = await readRequestBodyLimited(req.body, TENCHAT_EXPORT_JSON_MAX_BYTES);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "tenchat_export_request_invalid" };
    }
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some((key) => !TENCHAT_EXPORT_KEYS.has(key))) {
      return { ok: false, error: "tenchat_export_request_invalid" };
    }
    return { ok: true, body: body as TenChatExportRequest };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof BoundedBodyError && error.code === "too_large"
        ? "payload_too_large"
        : "tenchat_export_request_invalid",
    };
  }
}

function disposition(fileName: string) {
  const fallback = fileName.replace(/[^a-z0-9_.-]/giu, "-") || "aurora-tenchat-package.zip";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const [userRate, ipRate] = await Promise.all([
    checkRateLimit(`tenchat-export:user:${user.id}`, 30, 3_600, { failureMode: "closed" }),
    checkRateLimit(`tenchat-export:ip:${clientIp(req)}`, 60, 3_600, { failureMode: "closed" }),
  ]);
  if (!userRate.allowed) return rateLimitResponse(userRate);
  if (!ipRate.allowed) return rateLimitResponse(ipRate);

  const parsed = await readTenChatExportBody(req);
  if (!parsed.ok) {
    const status = parsed.error === "unsupported_media_type" ? 415
      : parsed.error === "payload_too_large" ? 413
        : 400;
    return NextResponse.json({ ok: false, error: parsed.error }, { status });
  }

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.publish");
    const result = await createTenChatExportForProject({
      pool,
      projectId: membership.projectId,
      actorUserId: user.id,
      requestId,
      body: parsed.body,
    });
    return new NextResponse(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": disposition(result.filename),
        "content-type": result.contentType,
        "x-content-type-options": "nosniff",
        "x-aurora-live-published": "false",
        "x-aurora-provider-mode": "export_only",
        "x-aurora-package-sha256": result.sha256,
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    if (error instanceof TenChatExportServiceError) {
      return NextResponse.json(
        { ok: false, error: error.code, livePublished: false },
        { status: error.status, headers: { "cache-control": "private, no-store" } },
      );
    }
    console.error("[tenchat-export-api]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json(
      { ok: false, error: "server", livePublished: false, retryable: true },
      { status: 500, headers: { "cache-control": "private, no-store" } },
    );
  }
}

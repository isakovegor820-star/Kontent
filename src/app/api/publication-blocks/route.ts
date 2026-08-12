import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  createProjectPublicationBlock,
  listProjectPublicationBlocks,
} from "@/lib/publication-settings-service";
import {
  publicationSettingsApiError,
  publicationSettingsJson,
  readPublicationSettingsBody,
} from "../publication-settings/_shared";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return publicationSettingsJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    const blocks = await listProjectPublicationBlocks(getPool(), user.id);
    return publicationSettingsJson({ ok: true, blocks }, 200, requestId);
  } catch (error) {
    return publicationSettingsApiError(error, requestId);
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return publicationSettingsJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return publicationSettingsJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`publication-blocks:user:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const body = await readPublicationSettingsBody(req, ["kind", "name", "body"]);
  if (!body) return publicationSettingsJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const block = await createProjectPublicationBlock({
      pool: getPool(),
      actorUserId: user.id,
      kind: body.kind,
      name: body.name,
      body: body.body,
      requestId,
    });
    return publicationSettingsJson({ ok: true, block }, 201, requestId);
  } catch (error) {
    return publicationSettingsApiError(error, requestId);
  }
}

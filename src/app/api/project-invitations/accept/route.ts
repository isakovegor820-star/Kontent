import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { acceptProjectInvitation } from "@/lib/project-team";
import { projectApiError, projectJson, readObjectBody } from "@/app/api/projects/_shared";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return projectJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const ipHash = createHash("sha256").update(clientIp(req), "utf8").digest("hex").slice(0, 32);
  const rate = await checkRateLimit(
    `project-invite:accept:user:${user.id}:ip:${ipHash}`,
    20,
    900,
    { failureMode: "closed" },
  );
  if (!rate.allowed) return rateLimitResponse(rate);
  const body = await readObjectBody(req);
  if (!body) return projectJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const membership = await acceptProjectInvitation({
      pool: getPool(), actorUserId: user.id, token: body.token, requestId,
    });
    return projectJson({ ok: true, membership }, 200, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}

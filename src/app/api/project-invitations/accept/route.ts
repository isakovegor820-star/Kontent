import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { acceptProjectInvitation } from "@/lib/project-team";
import { projectApiError, projectBodyFailure, projectJson, readProjectBody } from "@/app/api/projects/_shared";

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
  const parsed = await readProjectBody(req, ["token"]);
  if (!parsed.ok) return projectBodyFailure(parsed, requestId);
  const body = parsed.body;
  try {
    const membership = await acceptProjectInvitation({
      pool: getPool(), actorUserId: user.id, token: body.token, requestId,
    });
    return projectJson({ ok: true, membership }, 200, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}

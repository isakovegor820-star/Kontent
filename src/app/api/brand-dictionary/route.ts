import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import {
  createProjectBrandDictionaryEntry,
  getProjectBrandDictionary,
} from "@/lib/brand-dictionary-service";
import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { readTypographyBody, typographyApiError, typographyJson } from "../typography/_shared";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return typographyJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    const dictionary = await getProjectBrandDictionary(getPool(), user.id);
    return typographyJson({ ok: true, dictionary }, 200, requestId);
  } catch (error) {
    return typographyApiError(error, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) {
    return typographyJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(request);
  if (!user) return typographyJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`brand-dictionary:write:user:${user.id}`, 60, 3_600, {
    failureMode: "closed",
  });
  if (!rate.allowed) return rateLimitResponse(rate);
  const body = await readTypographyBody(request, [
    "expectedDictionaryVersion",
    "kind",
    "term",
    "replacement",
    "expansion",
    "caseSensitive",
  ]);
  if (!body) return typographyJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const result = await createProjectBrandDictionaryEntry({
      pool: getPool(),
      actorUserId: user.id,
      expectedDictionaryVersion: body.expectedDictionaryVersion,
      kind: body.kind,
      term: body.term,
      replacement: body.replacement,
      expansion: body.expansion,
      caseSensitive: body.caseSensitive,
      requestId,
    });
    return typographyJson({ ok: true, ...result }, 201, requestId);
  } catch (error) {
    return typographyApiError(error, requestId);
  }
}

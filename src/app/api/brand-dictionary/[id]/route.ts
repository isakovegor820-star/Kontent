import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import {
  deleteProjectBrandDictionaryEntry,
  updateProjectBrandDictionaryEntry,
} from "@/lib/brand-dictionary-service";
import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { readTypographyBody, typographyApiError, typographyJson } from "../../typography/_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

function routeId(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function authorizeMutation(request: NextRequest, requestId: string) {
  if (!hasTrustedMutationOrigin(request)) {
    return { response: typographyJson({ ok: false, error: "forbidden_origin" }, 403, requestId) };
  }
  const user = await getSessionUser(request);
  if (!user) return { response: typographyJson({ ok: false, error: "unauthorized" }, 401, requestId) };
  const rate = await checkRateLimit(`brand-dictionary:write:user:${user.id}`, 60, 3_600, {
    failureMode: "closed",
  });
  if (!rate.allowed) return { response: rateLimitResponse(rate) };
  return { user };
}

export async function PATCH(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  const auth = await authorizeMutation(request, requestId);
  if ("response" in auth) return auth.response;
  const entryId = routeId((await context.params).id);
  const body = await readTypographyBody(request, [
    "expectedEntryVersion",
    "expectedDictionaryVersion",
    "kind",
    "term",
    "replacement",
    "expansion",
    "caseSensitive",
  ]);
  if (!entryId || !body) return typographyJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const result = await updateProjectBrandDictionaryEntry({
      pool: getPool(),
      actorUserId: auth.user.id,
      entryId,
      expectedEntryVersion: body.expectedEntryVersion,
      expectedDictionaryVersion: body.expectedDictionaryVersion,
      kind: body.kind,
      term: body.term,
      replacement: body.replacement,
      expansion: body.expansion,
      caseSensitive: body.caseSensitive,
      requestId,
    });
    return typographyJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    return typographyApiError(error, requestId);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  const auth = await authorizeMutation(request, requestId);
  if ("response" in auth) return auth.response;
  const entryId = routeId((await context.params).id);
  const body = await readTypographyBody(request, ["expectedEntryVersion", "expectedDictionaryVersion"]);
  if (!entryId || !body) return typographyJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const result = await deleteProjectBrandDictionaryEntry({
      pool: getPool(),
      actorUserId: auth.user.id,
      entryId,
      expectedEntryVersion: body.expectedEntryVersion,
      expectedDictionaryVersion: body.expectedDictionaryVersion,
      requestId,
    });
    return typographyJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    return typographyApiError(error, requestId);
  }
}

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import {
  legalOpportunitySourceClientKey,
  parseLegalOpportunityPostVariant,
} from "@/lib/legal-opportunity-post";
import {
  createDraftForUser,
  DraftValidationError,
} from "@/lib/server-drafts";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ ok: false, error: "bad_item" }, { status: 400 });
  }
  const body = (await readJsonBodyValue(req).catch(() => null)) as {
    channelId?: unknown;
    variant?: unknown;
  } | null;
  const channelId = body?.channelId;
  if (typeof channelId !== "number" || !Number.isSafeInteger(channelId) || channelId <= 0) {
    return NextResponse.json({ ok: false, error: "bad_channel" }, { status: 422 });
  }
  const variant = parseLegalOpportunityPostVariant(body?.variant);
  if (body?.variant !== undefined && body.variant !== variant) {
    return NextResponse.json({ ok: false, error: "bad_variant" }, { status: 422 });
  }

  try {
    const result = await createDraftForUser(user.id, {
      clientKey: legalOpportunitySourceClientKey(itemId, channelId, variant),
      text: "Legal opportunity source context",
      media: null,
      scheduledAt: null,
      origin: "rss",
      sourceRef: { kind: "rss", id: String(itemId), label: "Юридический инфоповод" },
      channelIds: [channelId],
      aiValidation: null,
      generationResultId: null,
    });
    return NextResponse.json(
      { ok: true, draft: result.draft, created: result.created },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof DraftValidationError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 422 });
    }
    console.error("[/api/rss/items/:id/draft]", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

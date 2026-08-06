import { NextRequest, NextResponse } from "next/server";

import { hasTrustedMutationOrigin } from "@/lib/request-origin";
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
  const body = (await req.json().catch(() => null)) as { channelId?: unknown } | null;
  const channelId = body?.channelId;
  if (typeof channelId !== "number" || !Number.isSafeInteger(channelId) || channelId <= 0) {
    return NextResponse.json({ ok: false, error: "bad_channel" }, { status: 422 });
  }

  try {
    const result = await createDraftForUser(user.id, {
      clientKey: `rss_item_source:${itemId}`,
      text: "RSS source context",
      media: null,
      scheduledAt: null,
      origin: "rss",
      sourceRef: { kind: "rss", id: String(itemId), label: "RSS-источник" },
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

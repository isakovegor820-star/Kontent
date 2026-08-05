import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { assertLibraryItemOwnership } from "@/lib/library-registry";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const itemType = body.itemType;
  const itemId = Number(body.itemId);
  const channelId = Number(body.channelId);
  const rating = body.rating == null ? null : Number(body.rating);
  const viewed = body.viewed == null ? true : body.viewed === true;
  if (
    !["reference", "idea", "saved"].includes(String(itemType)) ||
    !Number.isSafeInteger(itemId) || itemId <= 0 ||
    !Number.isSafeInteger(channelId) || channelId <= 0 ||
    (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5))
  ) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 422 });
  }
  try {
    const owned = await assertLibraryItemOwnership(
      user.id,
      channelId,
      itemType as "reference" | "idea" | "saved",
      itemId,
    );
    if (!owned) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    const result = await getPool().query(
      `insert into library_item_states
         (user_id, channel_id, item_type, item_id, rating, viewed_at, updated_at)
       values ($1, $2, $3, $4, $5, case when $6 then now() else null end, now())
       on conflict (user_id, channel_id, item_type, item_id)
       do update set rating = excluded.rating,
                     viewed_at = case when $6 then coalesce(library_item_states.viewed_at, now()) else null end,
                     updated_at = now()
       returning rating, viewed_at`,
      [user.id, channelId, itemType, itemId, rating, viewed],
    );
    return NextResponse.json({ ok: true, state: result.rows[0] });
  } catch (error) {
    console.error("[/api/library/state] POST", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

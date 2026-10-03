import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { DATA_EXPORT_EXCLUDED, collectUserData, recordDataRequest } from "@/lib/personal-data";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const noStore = { "cache-control": "no-store" };

/**
 * Выгрузка персональных данных субъекта (ч. 7 ст. 14 152-ФЗ).
 *
 * Отдаём файлом JSON: человек вправе получить свои данные в машиночитаемом
 * виде, а не переписку по почте. Факт запроса записываем в `data_requests` —
 * по нему видно срок исполнения, если возникнет спор.
 */
export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized", requestId }, { status: 401, headers: noStore });
  }

  const rate = await checkRateLimit(`settings:data-export:${user.id}`, 5, 3600);
  if (!rate.allowed) return rateLimitResponse(rate);

  try {
    const pool = getPool();
    const data = await collectUserData(pool, user.id);
    await recordDataRequest(pool, {
      userId: user.id,
      kind: "export",
      state: "completed",
      result: {
        consents: data.consents.length,
        projects: data.projects.length,
        channels: data.channels.length,
        posts: data.posts.length,
        drafts: data.drafts.length,
      },
    });

    const payload = {
      ...data,
      excludedFromExport: [...DATA_EXPORT_EXCLUDED],
      notice:
        "Это выгрузка ваших персональных данных. Секреты подключений, хеш пароля и служебные журналы в неё не входят.",
    };

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        ...noStore,
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="aurora-personal-data-${user.id}.json"`,
      },
    });
  } catch (error) {
    console.error("[/api/settings/personal-data]", {
      requestId,
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "server", requestId }, { status: 500, headers: noStore });
  }
}

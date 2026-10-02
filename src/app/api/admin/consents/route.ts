import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { consentEvidenceCsv, findConsentEvidence, summarizeConsentState } from "@/lib/consent-evidence";
import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const noStore = { "cache-control": "no-store" };

/**
 * Доказательства согласий для поддержки и юриста.
 *
 * Доступ: только администратор. Возвращаем историю журнала, текущее состояние по
 * видам и заявку, если согласие пришло из лид-формы: человек мог оставить форму
 * без аккаунта, и тогда найти его можно только по контакту.
 *
 * `format=csv` отдаёт файл для таблицы — юрист и поддержка работают в Excel,
 * а не в JSON. Адрес запроса и клиентский агент в выгрузке не раскрываются:
 * видно только, зафиксированы ли они.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: noStore });
  if (!hasAuroraAdminAccess(user)) {
    return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403, headers: noStore });
  }

  const params = req.nextUrl.searchParams;
  const rawUserId = params.get("userId");
  const contact = params.get("contact");
  const userId = rawUserId && Number.isSafeInteger(Number(rawUserId)) && Number(rawUserId) > 0
    ? Number(rawUserId)
    : null;

  // Лимит на выгрузку: в ответе персональные данные, и массовое скачивание
  // журнала не должно выглядеть обычной работой поддержки.
  const rate = await checkRateLimit(`admin:consents:${user.id}`, 60, 3600);
  if (!rate.allowed) return rateLimitResponse(rate);

  if (userId === null && !contact?.trim()) {
    return NextResponse.json(
      { ok: false, error: "query_required", hint: "Укажите userId или contact" },
      { status: 422, headers: noStore },
    );
  }

  try {
    const evidence = await findConsentEvidence(getPool(), { userId, contact });
    const current = summarizeConsentState(evidence.rows);

    if (params.get("format") === "csv") {
      return new NextResponse(consentEvidenceCsv(evidence.rows), {
        status: 200,
        headers: {
          ...noStore,
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="consent-evidence-${
            userId ?? contact?.replace(/[^a-z0-9@._-]/giu, "_")
          }.csv"`,
        },
      });
    }

    return NextResponse.json({ ok: true, current, ...evidence }, { headers: noStore });
  } catch (error) {
    console.error("[/api/admin/consents]", {
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500, headers: noStore });
  }
}

// Д.1 — приём заявки с лендинга (ТЗ v3, раздел 13.3).
//
// Путь заявки: форма → POST /api/lead → проверка → строка в PostgreSQL (Neon)
//              → уведомление владельцу в Telegram-бот.
//
// Порядок важен: СНАЧАЛА база, ПОТОМ уведомление. Если Telegram недоступен —
// заявка всё равно сохранена (уведомление не критично).
//
// Секреты живут только в переменных окружения, в код не попадают:
//   DATABASE_URL  — строка подключения к базе Neon
//   TG_BOT_TOKEN  — токен бота от @BotFather
//   TG_CHAT_ID    — твой личный chat_id (куда бот шлёт заявки)

import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { parseContact } from "@/lib/leads";
import { notifyOwner, nowMoscow } from "@/lib/notify";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";

// Node-рантайм: драйвер базы работает в нём стабильно. Обработчик POST не кэшируется.
export const runtime = "nodejs";

export async function POST(request: Request) {
  // 1. Читаем тело запроса.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const data = (body ?? {}) as Record<string, unknown>;
  const rawContact = typeof data.contact === "string" ? data.contact : "";
  const source = (typeof data.source === "string" ? data.source : "landing").slice(0, 120);
  // Ловушка для ботов (honeypot): скрытое поле, которое люди не видят и не заполняют.
  const honeypot = typeof data.website === "string" ? data.website : "";

  // 2. Бот заполнил ловушку → тихо отбрасываем, но делаем вид, что всё хорошо.
  if (honeypot.trim() !== "") {
    return NextResponse.json({ ok: true, duplicate: false });
  }

  // 2.5. Потолок частоты: не больше 10 заявок с одного IP в час. Режет спам строками
  //      в базу в обход honeypot (honeypot ловит простых ботов, лимит — настойчивых).
  const byIp = await checkRateLimit(`lead:ip:${clientIp(request)}`, 10, 3600);
  if (!byIp.allowed) return rateLimitResponse(byIp);

  // 3. Проверяем контакт (той же логикой, что и на форме).
  const parsed = parseContact(rawContact);
  if (!parsed) {
    return NextResponse.json({ ok: false, error: "not_contact" }, { status: 422 });
  }

  // 4. База обязана быть настроена — иначе форма покажет запасной путь «напиши в Telegram».
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[/api/lead] DATABASE_URL не задан — заявку некуда писать");
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }

  const userAgent = request.headers.get("user-agent")?.slice(0, 400) ?? null;

  try {
    const pool = getPool();

    // 5. Пишем заявку. Дубликаты не создаются: contact уникален, повтор → do nothing.
    //    Вернулась строка → заявка новая; пусто → такой контакт уже был.
    const result = await pool.query<{ id: number }>(
      `insert into leads (contact, kind, source, user_agent)
       values ($1, $2, $3, $4)
       on conflict (contact) do nothing
       returning id`,
      [parsed.contact, parsed.kind, source, userAgent],
    );

    const isNew = (result.rowCount ?? 0) > 0;

    // 6. Теперь — уведомление. База уже записана, так что сбой бота ничего не теряет.
    const head = isNew ? "🔥 Новая заявка" : "🔁 Повторная заявка";
    await notifyOwner(
      `${head}\nКонтакт: ${parsed.contact}\nОткуда: ${source}\nКогда: ${nowMoscow()} МСК`,
    );

    return NextResponse.json({ ok: true, duplicate: !isNew });
  } catch (err) {
    console.error("[/api/lead] ошибка записи в базу:", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

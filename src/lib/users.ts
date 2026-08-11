// Пользователи Д.2. Один человек = одна строка. Вход любым способом ведёт в один
// аккаунт: нашли по tg_id/vk_id/email — привязываем недостающее; не нашли — создаём.
// При создании — связка с заявками: заявка того же контакта становится registered.

import { getPool } from "./db";
import { notifyOwner, nowMoscow } from "./notify";
import { ensureDefaultPersonalProjectInTransaction } from "./project-context";

export interface Identity {
  tg_id?: number | null;
  vk_id?: number | null;
  email?: string | null; // уже в нижнем регистре
  username?: string | null; // Telegram @username (без @) — для связки с заявкой
  name?: string | null;
  avatar?: string | null;
}

/** Находит или создаёт пользователя. Возвращает id и флаг «только что создан». */
export async function findOrCreateUser(idn: Identity): Promise<{ id: number; created: boolean }> {
  const pool = getPool();
  const tg_id = idn.tg_id ?? null;
  const vk_id = idn.vk_id ?? null;
  const email = idn.email ?? null;
  const name = idn.name ?? null;
  const avatar = idn.avatar ?? null;

  // Identity creation/linking and the personal project invariant commit together.
  // No login can observe a user row without its owner membership and server selection.
  const client = await pool.connect();
  let id = 0;
  let created = false;
  try {
    await client.query("begin");
    const found = await client.query<{ id: number | string }>(
      `select id from users
        where (tg_id is not null and tg_id = $1)
           or (vk_id is not null and vk_id = $2)
           or (email is not null and email = $3)
        limit 1
        for update`,
      [tg_id, vk_id, email],
    );

    if (found.rows[0]) {
      id = Number(found.rows[0].id);
      await client.query(
        `update users set
           tg_id  = coalesce(tg_id, $2),
           vk_id  = coalesce(vk_id, $3),
           email  = coalesce(email, $4),
           name   = coalesce(name, $5),
           avatar = coalesce(avatar, $6)
         where id = $1`,
        [id, tg_id, vk_id, email, name, avatar],
      );
    } else {
      const inserted = await client.query<{ id: number | string }>(
        `insert into users (tg_id, vk_id, email, name, avatar)
         values ($1, $2, $3, $4, $5) returning id`,
        [tg_id, vk_id, email, name, avatar],
      );
      id = Number(inserted.rows[0]?.id ?? 0);
      created = true;
    }
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("identity_creation_failed");
    await ensureDefaultPersonalProjectInTransaction(client, id);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // 4. Связка с заявками: контакт нового пользователя — почта и/или @username.
  if (created) {
    const contacts: string[] = [];
    if (email) contacts.push(email);
    if (idn.username) contacts.push("@" + idn.username.toLowerCase());
    await convertMatchingLeadAfterRegistration(contacts, name);
  }

  return { id, created };
}

/** Если заявка того же контакта ещё не registered — помечаем и сообщаем владельцу. */
export async function convertMatchingLeadAfterRegistration(
  contacts: string[],
  name: string | null,
  dependencies: {
    query?: Pick<ReturnType<typeof getPool>, "query">;
    notify?: typeof notifyOwner;
  } = {},
): Promise<{ converted: boolean; notified: boolean }> {
  const list = contacts.filter(Boolean).map((c) => c.toLowerCase());
  if (list.length === 0) return { converted: false, notified: false };

  let upd;
  try {
    upd = await (dependencies.query ?? getPool()).query<{ contact: string }>(
      `update leads set status = 'registered'
        where contact = any($1) and status <> 'registered'
        returning contact`,
      [list],
    );
  } catch (error) {
    console.warn("[registration_event]", {
      event: "lead_conversion_failed",
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
    });
    return { converted: false, notified: false };
  }

  if (upd.rowCount) {
    const who = name || upd.rows[0].contact;
    try {
      const notified = await (dependencies.notify ?? notifyOwner)(
        `🎉 Заявка сконвертировалась: ${who} вошёл в платформу\n` +
          `Контакт: ${upd.rows[0].contact}\nКогда: ${nowMoscow()} МСК`,
      );
      return { converted: true, notified };
    } catch {
      console.warn("[registration_event]", { event: "lead_notification_failed", code: "notify_failed" });
      return { converted: true, notified: false };
    }
  }
  return { converted: false, notified: false };
}

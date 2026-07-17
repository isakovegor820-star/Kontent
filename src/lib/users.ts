// Пользователи Д.2. Один человек = одна строка. Вход любым способом ведёт в один
// аккаунт: нашли по tg_id/vk_id/email — привязываем недостающее; не нашли — создаём.
// При создании — связка с заявками: заявка того же контакта становится registered.

import { getPool } from "./db";
import { notifyOwner, nowMoscow } from "./notify";

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

  // 1. Ищем по любому совпадению идентификатора.
  const found = await pool.query<{ id: number }>(
    `select id from users
      where (tg_id is not null and tg_id = $1)
         or (vk_id is not null and vk_id = $2)
         or (email is not null and email = $3)
      limit 1`,
    [tg_id, vk_id, email],
  );

  if (found.rowCount && found.rows[0]) {
    // 2. Нашли — дозаполняем пустые связи (вошёл вторым способом) и имя/аватар.
    await pool.query(
      `update users set
         tg_id  = coalesce(tg_id, $2),
         vk_id  = coalesce(vk_id, $3),
         email  = coalesce(email, $4),
         name   = coalesce(name, $5),
         avatar = coalesce(avatar, $6)
       where id = $1`,
      [found.rows[0].id, tg_id, vk_id, email, name, avatar],
    );
    return { id: found.rows[0].id, created: false };
  }

  // 3. Не нашли — создаём.
  const ins = await pool.query<{ id: number }>(
    `insert into users (tg_id, vk_id, email, name, avatar)
     values ($1, $2, $3, $4, $5) returning id`,
    [tg_id, vk_id, email, name, avatar],
  );
  const id = ins.rows[0].id;

  // 4. Связка с заявками: контакт нового пользователя — почта и/или @username.
  const contacts: string[] = [];
  if (email) contacts.push(email);
  if (idn.username) contacts.push("@" + idn.username.toLowerCase());
  await convertMatchingLead(contacts, name);

  return { id, created: true };
}

/** Если заявка того же контакта ещё не registered — помечаем и сообщаем владельцу. */
async function convertMatchingLead(contacts: string[], name: string | null): Promise<void> {
  const list = contacts.filter(Boolean).map((c) => c.toLowerCase());
  if (list.length === 0) return;

  const upd = await getPool().query<{ contact: string }>(
    `update leads set status = 'registered'
      where contact = any($1) and status <> 'registered'
      returning contact`,
    [list],
  );

  if (upd.rowCount) {
    const who = name || upd.rows[0].contact;
    await notifyOwner(
      `🎉 Заявка сконвертировалась: ${who} вошёл в платформу\n` +
        `Контакт: ${upd.rows[0].contact}\nКогда: ${nowMoscow()} МСК`,
    );
  }
}

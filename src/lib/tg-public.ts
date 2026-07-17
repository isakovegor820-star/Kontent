// Чтение ОТКРЫТОЙ страницы Telegram-канала t.me/s/<канал> — тексты последних постов.
// Bot API историю канала не отдаёт, поэтому берём то же, что видит любой прохожий
// в браузере. Только публичные каналы, только открытые данные (как в разведке Д.6).
// Нужно, чтобы платформа могла прочитать твой канал и предложить бриф (ТЗ Д.9).

export interface PublicChannel {
  ok: boolean;
  title: string | null;
  posts: string[]; // тексты, от свежих к старым
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return "";
      }
    })
    .replace(/&amp;/g, "&"); // последним, иначе «&amp;lt;» развернётся дважды
}

/** Последние посты открытого канала. Приватный/несуществующий → { ok: false }. */
export async function fetchPublicPosts(handle: string, limit = 15): Promise<PublicChannel> {
  const h = String(handle).replace(/^@/, "").trim();
  const out: PublicChannel = { ok: false, title: null, posts: [] };
  if (!/^[A-Za-z0-9_]{4,64}$/.test(h)) return out;

  try {
    const r = await fetch(`https://t.me/s/${h}`, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return out;
    const html = await r.text();

    const titM = html.match(/tgme_channel_info_header_title[^>]*><span[^>]*>([^<]+)/);
    if (titM) out.title = decodeEntities(titM[1]).trim() || null;

    const parts = html.split('data-post="');
    for (let i = 1; i < parts.length; i++) {
      const txtM = parts[i].match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
      if (!txtM) continue;
      const text = decodeEntities(
        txtM[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""),
      ).trim();
      if (text) out.posts.push(text);
    }
    out.posts.reverse(); // t.me отдаёт от старых к новым — нам нужны свежие первыми
    out.posts = out.posts.slice(0, limit);
    out.ok = true;
  } catch {
    /* сеть/таймаут — честно вернём ok: false, врать про канал не будем */
  }
  return out;
}

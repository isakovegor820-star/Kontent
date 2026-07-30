// RSS pipeline без глобального состояния. Зависимости передаются снаружи, чтобы поведение
// «один пользователь → только его feeds → scheduled post → publish queue» можно было
// проверить без запуска всего worker.mjs.

import { parseRss } from "./lib.mjs";

const RSS_USER_AGENT = "Aurora-RSS/1.0";
const RSS_FETCH_TIMEOUT_MS = 15_000;
const RSS_BATCH_SIZE = 20;
const POST_DELAY_MS = 5 * 60_000;

/**
 * `userId = null` — плановый cron для всех аккаунтов.
 * Числовой `userId` — ручной запуск, строго в границах одного владельца.
 */
export async function collectRssPipeline({
  pool,
  enqueuePost,
  summarize,
  userId = null,
  fetchFn = fetch,
  now = () => Date.now(),
  logger = console,
}) {
  const scoped = Number.isInteger(userId) && userId > 0;
  const feeds = (
    await pool.query(
      `select f.id, f.url, f.title, f.channel_id, f.user_id, f.ai_summarize, f.max_per_day,
              (select count(*)::int from rss_items i
                where i.feed_id = f.id
                  and i.fetched_at > now() - interval '24 hours'
                  and i.status = 'posted') as posted_today
         from rss_feeds f
        where f.is_active = true${scoped ? " and f.user_id = $1" : ""}
        order by f.id`,
      scoped ? [userId] : [],
    )
  ).rows;
  if (!feeds.length) return { feeds: 0, posts: 0 };

  let totalPosts = 0;
  for (const feed of feeds) {
    // Счётчик принадлежит конкретному feed. Глобальный счётчик ломает лимиты соседних
    // лент и других пользователей, особенно после ручного «Проверить сейчас».
    let postedThisRun = 0;
    try {
      const res = await fetchFn(feed.url, {
        signal: AbortSignal.timeout(RSS_FETCH_TIMEOUT_MS),
        headers: { "user-agent": RSS_USER_AGENT },
      });
      if (!res.ok) continue;
      const items = parseRss(await res.text()).slice(0, RSS_BATCH_SIZE);

      for (const item of items) {
        const ins = await pool.query(
          `insert into rss_items (feed_id, guid, title, link, summary, published_at)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (feed_id, guid) do nothing
           returning id`,
          [feed.id, item.guid, item.title, item.link, item.summary, item.publishedAt],
        );
        if (!ins.rowCount) continue;
        const itemId = ins.rows[0].id;

        if (Number(feed.posted_today) + postedThisRun >= Number(feed.max_per_day)) {
          await pool.query(`update rss_items set status = 'skipped' where id = $1`, [itemId]);
          continue;
        }

        let postText = `${item.title}\n\n${item.summary}`.trim();
        if (feed.ai_summarize && summarize) {
          try {
            const summarized = await summarize(item);
            if (summarized) postText = summarized;
          } catch {
            // ИИ вторичен: недоступен — публикуем исходное содержание feed.
          }
        }
        if (item.link) postText += `\n\n${item.link}`;

        const scheduledAt = new Date(now() + POST_DELAY_MS).toISOString();
        let postId;
        try {
          postId = await enqueuePost(
            Number(feed.user_id),
            Number(feed.channel_id),
            postText.slice(0, 16_384),
            scheduledAt,
          );
        } catch (err) {
          // GUID уже занял unique-ключ. Если очередь не приняла пост, удаляем именно
          // свежую RSS-запись, иначе следующий запуск увидит conflict и никогда не повторит её.
          await pool.query(`delete from rss_items where id = $1 and status = 'new'`, [itemId]);
          throw err;
        }

        await pool.query(
          `update rss_items set status = 'posted', post_id = $1 where id = $2`,
          [postId, itemId],
        );
        postedThisRun++;
        totalPosts++;
      }

      await pool.query(`update rss_feeds set last_fetched_at = now() where id = $1`, [feed.id]);
    } catch (err) {
      logger.error(`[rss] фид ${feed.id} (${feed.url}):`, err?.message);
    }
  }

  if (totalPosts) logger.log(`[rss] создано постов из лент: ${totalPosts}`);
  return { feeds: feeds.length, posts: totalPosts };
}

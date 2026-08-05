// RSS pipeline без глобального состояния. Зависимости передаются снаружи, чтобы поведение
// «один пользователь → только его feeds → scheduled post → publish queue» можно было
// проверить без запуска всего worker.mjs.

import { parseRss } from "./lib.mjs";
import { fetchPublicText } from "../src/lib/safe-http.mjs";

const RSS_USER_AGENT = "Aurora-RSS/1.0";
const RSS_FETCH_TIMEOUT_MS = 15_000;
const RSS_BATCH_SIZE = 20;
const POST_DELAY_MS = 5 * 60_000;
export const RSS_POST_SPACING_MS = 15 * 60_000;
export const RSS_IRRELEVANT_MARKER = "__AURORA_RSS_SKIP__";

/**
 * `userId = null` — плановый cron для всех аккаунтов.
 * Числовой `userId` — ручной запуск, строго в границах одного владельца.
 */
export async function collectRssPipeline({
  pool,
  enqueuePost,
  summarize,
  userId = null,
  channelId = null,
  fetchFn = fetchPublicText,
  now = () => Date.now(),
  logger = console,
}) {
  const userScoped = Number.isInteger(userId) && userId > 0;
  const channelScoped = Number.isInteger(channelId) && channelId > 0;
  if (channelScoped && !userScoped) throw new Error("RSS channel scope requires user scope");
  const scopeParams = [];
  const scopeConditions = ["f.is_active = true"];
  if (userScoped) {
    scopeParams.push(userId);
    scopeConditions.push(`f.user_id = $${scopeParams.length}`);
  }
  if (channelScoped) {
    scopeParams.push(channelId);
    scopeConditions.push(`f.channel_id = $${scopeParams.length}`);
  }
  const feeds = (
    await pool.query(
      `select f.id, f.url, f.title, f.channel_id, f.user_id, f.ai_summarize, f.max_per_day,
              f.last_fetched_at, f.publish_existing,
              c.title as channel_title,
              (select b.niche from content_brief b
                where b.user_id = f.user_id and b.channel_id = f.channel_id
                limit 1) as channel_niche,
              (select ks.raw_text from knowledge_sources ks
                where ks.user_id = f.user_id and ks.channel_id = f.channel_id
                  and ks.kind in ('profile_edit', 'profile')
                order by (ks.kind = 'profile_edit') desc, ks.added_at desc
                limit 1) as channel_profile,
              (select count(*)::int from rss_items i
                where i.feed_id = f.id
                  and i.fetched_at > now() - interval '24 hours'
                  and i.status = 'posted') as posted_today
         from rss_feeds f
         join channels c on c.id = f.channel_id and c.user_id = f.user_id
        where ${scopeConditions.join(" and ")}
        order by f.id`,
      scopeParams,
    )
  ).rows;
  if (!feeds.length) return { feeds: 0, posts: 0 };

  let totalPosts = 0;
  const scheduledByChannel = new Map();
  for (const feed of feeds) {
    // Счётчик принадлежит конкретному feed. Глобальный счётчик ломает лимиты соседних
    // лент и других пользователей, особенно после ручного «Проверить сейчас».
    let postedThisRun = 0;
    try {
      const res = await fetchFn(feed.url, {
        timeoutMs: RSS_FETCH_TIMEOUT_MS,
        maxBytes: 2 * 1024 * 1024,
        headers: { "user-agent": RSS_USER_AGENT },
      });
      if (!res.ok) continue;
      const items = parseRss(await res.text()).slice(0, RSS_BATCH_SIZE);

      for (const item of items) {
        const ins = await pool.query(
          `insert into rss_items (feed_id, guid, title, link, summary, published_at)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (feed_id, guid) do update
             set title = excluded.title, link = excluded.link, summary = excluded.summary,
                 published_at = excluded.published_at
             where rss_items.status = 'new'
           returning id`,
          [feed.id, item.guid, item.title, item.link, item.summary, item.publishedAt],
        );
        if (!ins.rowCount) continue;
        const itemId = ins.rows[0].id;

        if (!feed.last_fetched_at && feed.publish_existing !== true) {
          // Подключение источника не является согласием на публикацию его истории.
          // После обычной вставки фиксируем каждый текущий GUID как baseline; явный
          // publish_existing=true оставляет прежнее поведение для осознанного импорта.
          await pool.query(
            `update rss_items set status = 'skipped', skip_reason = 'baseline' where id = $1`,
            [itemId],
          );
          continue;
        }

        if (Number(feed.posted_today) + postedThisRun >= Number(feed.max_per_day)) {
          await pool.query(
            `update rss_items set status = 'skipped', skip_reason = 'limit' where id = $1`,
            [itemId],
          );
          continue;
        }

        let postText;
        let summaryUsage = null;
        if (feed.ai_summarize) {
          if (typeof summarize !== "function") {
            // Для лент с включённой ИИ-адаптацией сырой RSS-текст не является
            // безопасным fallback: освобождаем GUID, чтобы попробовать запись позже.
            logger.error(`[rss] ИИ-адаптация не выполнена: feed=${feed.id}, item=${itemId}, reason=unavailable`);
            continue;
          }

          try {
            const summarized = await summarize(item, feed);
            summaryUsage = summarized && typeof summarized === "object" ? summarized.usage ?? null : null;
            const summaryText = typeof summarized === "string" ? summarized : summarized?.text;
            if (typeof summaryText !== "string" || !summaryText.trim()) {
              await summaryUsage?.finish?.(false);
              logger.error(`[rss] ИИ-адаптация не выполнена: feed=${feed.id}, item=${itemId}, reason=empty`);
              continue;
            }
            const normalizedSummary = summaryText.trim();
            if (normalizedSummary === RSS_IRRELEVANT_MARKER) {
              await pool.query(
                `update rss_items set status = 'skipped', skip_reason = 'irrelevant' where id = $1`,
                [itemId],
              );
              const committed = summaryUsage ? await summaryUsage.commit() : true;
              await summaryUsage?.finish?.(committed);
              continue;
            }
            postText = normalizedSummary;
          } catch {
            // Не добавляем сюда текст записи или сообщение провайдера: они могут
            // содержать исходный материал. `new` + conflict-update сохраняют тот же GUID
            // и детерминированный quota key для следующей попытки.
            await summaryUsage?.finish?.(false);
            logger.error(`[rss] ИИ-адаптация не выполнена: feed=${feed.id}, item=${itemId}, reason=failed`);
            continue;
          }
        } else {
          postText = `${item.title}\n\n${item.summary}`.trim();
        }
        if (item.link) postText += `\n\n${item.link}`;

        // Несколько лент одного канала могут найти новости одновременно. Разносим
        // их, чтобы подписчик не получил пачку публикаций в одну минуту.
        const scheduleKey = `${feed.user_id}:${feed.channel_id}`;
        const positionInChannel = scheduledByChannel.get(scheduleKey) || 0;
        const scheduledAt = new Date(now() + POST_DELAY_MS + positionInChannel * RSS_POST_SPACING_MS).toISOString();
        let postId;
        try {
          const enqueued = await enqueuePost(
            Number(feed.user_id),
            Number(feed.channel_id),
            postText.slice(0, 16_384),
            scheduledAt,
            {
              rssItemId: Number(itemId),
              feedId: Number(feed.id),
              aiUsageReservationId: summaryUsage?.reservationId ?? null,
            },
          );
          postId = typeof enqueued === "object" && enqueued !== null ? enqueued.postId : enqueued;
          if (summaryUsage && enqueued?.aiUsageCommitted !== true) {
            throw new Error("RSS AI usage was not committed with the post");
          }
          await summaryUsage?.finish?.(true);
          // production enqueuePost связывает RSS-item и post в одной транзакции с
          // проверкой активности ленты. Числовой fallback сохраняет совместимость с
          // изолированными тестами и простыми внедрёнными реализациями.
          if (!(typeof enqueued === "object" && enqueued?.rssLinked)) {
            await pool.query(
              `update rss_items set status = 'posted', skip_reason = null, post_id = $1 where id = $2`,
              [postId, itemId],
            );
          }
        } catch (err) {
          // GUID уже занял unique-ключ. Если очередь не приняла пост, удаляем именно
          // свежую RSS-запись, иначе следующий запуск увидит conflict и никогда не повторит её.
          await summaryUsage?.finish?.(false);
          if (!summaryUsage) {
            await pool.query(`delete from rss_items where id = $1 and status = 'new'`, [itemId]);
          }
          throw err;
        }

        postedThisRun++;
        totalPosts++;
        scheduledByChannel.set(scheduleKey, positionInChannel + 1);
      }

      await pool.query(`update rss_feeds set last_fetched_at = now() where id = $1`, [feed.id]);
    } catch (err) {
      logger.error(`[rss] фид ${feed.id} (${feed.url}):`, err?.message);
    }
  }

  if (totalPosts) logger.log(`[rss] создано постов из лент: ${totalPosts}`);
  return { feeds: feeds.length, posts: totalPosts };
}

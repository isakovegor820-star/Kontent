import { plural } from "./lib.mjs";

/**
 * Собирает недельный отчёт только из данных одного проекта.
 * userId остаётся явным получателем сообщения, но не является tenant-фильтром: в общем
 * проекте отчёт обязан включать публикации всей команды, а не только автора запроса.
 */
export async function buildWeeklyReport(pool, { userId, projectId }) {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("weekly report: bad userId");
  }
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error("weekly report: bad projectId");
  }

  const week = (
    await pool.query(
      `select count(*)::int as posts,
              coalesce(sum(ps.views), 0)::int as views,
              coalesce(round(avg(ps.views)), 0)::int as avg_views
         from posts p
         join lateral (
           select views from post_stats where post_id = p.id order by snapshot_date desc limit 1
         ) ps on true
        where p.project_id = $1 and p.status = 'published'
          and p.published_at > now() - interval '7 days'`,
      [projectId],
    )
  ).rows[0];

  const best = (
    await pool.query(
      `select p.text, ps.views from posts p
         join lateral (
           select views from post_stats where post_id = p.id order by snapshot_date desc limit 1
         ) ps on true
        where p.project_id = $1 and p.status = 'published' and ps.views is not null
          and p.published_at > now() - interval '7 days'
        order by ps.views desc limit 1`,
      [projectId],
    )
  ).rows[0];

  const growth = (
    await pool.query(
      `select coalesce(sum(cs.subscribers_delta), 0)::int as g
         from channel_stats cs
         join channels c on c.id = cs.channel_id
        where c.project_id = $1 and cs.snapshot_date > (current_date - 7)`,
      [projectId],
    )
  ).rows[0];

  if (!week || week.posts === 0) {
    return "📊 Твоя неделя: постов пока не было. Как выйдет первый — пришлю цифры и совет.";
  }
  const vw = (n) => plural(n, "просмотр", "просмотра", "просмотров");
  const lines = [
    `📊 Твоя неделя: ${week.posts} ${plural(week.posts, "пост", "поста", "постов")}, ` +
      `суммарно ${week.views} ${vw(week.views)} (в среднем ${week.avg_views} ${vw(week.avg_views)} на пост).`,
  ];
  if (Number(growth?.g) !== 0) {
    lines.push(`Подписчиков за неделю: ${growth.g > 0 ? "+" : ""}${growth.g}.`);
  }
  if (best) {
    const snippet = best.text.replace(/\s+/g, " ").slice(0, 60);
    lines.push(`Лучший пост — «${snippet}…» (${best.views} ${vw(best.views)}).`);
    lines.push("Совет: повтори этот формат — у тебя он заходит лучше остальных.");
  }
  return lines.join("\n");
}

import { RECON_CRON_PATTERN } from "./reconnaissance-schedule.mjs";

// Shared registration contract; every pattern is interpreted in Europe/Moscow.
export const CRON_SCHEDULES = [
  { name: "stats",    pattern: "0 */6 * * *" },  // статистика каждые 6ч: один временный сбой не ломает весь день
  { name: "recon",    pattern: RECON_CRON_PATTERN }, // разведка конкурентов, каждые 2ч
  { name: "trend",    pattern: "15 */2 * * *" }, // насмотренность, каждые 2ч (сдвиг 15мин от recon)
  { name: "today-opportunities", pattern: "30 */2 * * *" }, // снимки возможностей, каждые 2ч
  { name: "knowledge-index", pattern: "*/5 * * * *" }, // восстановление pending-источников базы знаний
  { name: "discover", pattern: "0 4 * * *" },    // поиск соседей по нише, 04:00 МСК
  { name: "weekly",   pattern: "0 21 * * 0" },   // недельные планы, вс 21:00 МСК
  { name: "cleanup",  pattern: "0 3 * * *" },    // чистка протухших sessions/bot_links, 03:00 МСК
  { name: "rss",      pattern: "*/30 * * * *" }, // RSS-ленты, каждые 30 мин
  { name: "profile",  pattern: "0 5 * * 1" },   // переизвлечение профилей каналов, пн 05:00 МСК
  { name: "exports",  pattern: "* * * * *" },    // durable outbox и TTL экспортов, каждую минуту
  { name: "bot-digest", pattern: "*/15 * * * *" }, // сводки по локальному времени проекта
  { name: "site-daily", pattern: "20 5 * * *" },   // сайты: обновление профилей, план материалов, зонд видимости
  { name: "site-monthly", pattern: "0 7 1 * *" },  // сайты: ежемесячные отчёты с динамикой
];

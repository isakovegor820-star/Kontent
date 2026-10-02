/**
 * Публичная (индексируемая) поверхность продукта — единственный источник правды.
 *
 * Зачем один список: robots.txt, sitemap.xml, canonical и тесты должны читать одно и то
 * же, иначе адрес попадает в карту сайта, но закрыт в robots, или наоборот. Пока списки
 * живут в трёх местах, расхождение появляется на первом же релизе.
 *
 * В список попадают только страницы, которые отвечают на запрос человека. Всё, что
 * производится аутентификацией (/app, /admin) и служебными обработчиками (/api), в
 * индекс не идёт и не индексируется.
 */

export type PublicRoute = {
  readonly path: string;
  readonly changeFrequency: "daily" | "weekly" | "monthly" | "yearly";
  readonly priority: number;
};

/**
 * lastModified здесь намеренно отсутствует. Проставлять `new Date()` в момент запроса —
 * значит каждый раз сообщать поиску «страница только что изменилась», и через две недели
 * такой сигнал перестают учитывать. Дата обновления появится здесь тогда, когда у
 * страницы будет реальный источник даты (поле в базе или дата коммита контента).
 */
export const PUBLIC_ROUTES: readonly PublicRoute[] = Object.freeze([
  { path: "/", changeFrequency: "weekly", priority: 1 },
  { path: "/guide", changeFrequency: "weekly", priority: 0.8 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.2 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.2 },
]);

/**
 * Закрываем только то, за чем нет человеческого контента и что жжёт краулинговый бюджет.
 * /login, /register, /forgot-password, /reset-password, /confirm-email здесь НЕ закрыты
 * сознательно: на них стоит `robots: { index: false }`, а директива noindex работает
 * только если краулеру разрешено прочитать страницу. Disallow + noindex вместе дают
 * «проиндексировано, несмотря на блокировку» — это хуже, чем просто noindex.
 */
export const DISALLOWED_PATHS: readonly string[] = Object.freeze([
  "/app/",
  "/admin/",
  "/api/",
]);

/**
 * Origin продукта. В продакшене это единственный доверенный источник (та же переменная,
 * на которой стоит проверка Origin для мутаций), поэтому Host запроса здесь не читается:
 * иначе карта сайта и canonical начнут зависеть от подставленного заголовка.
 */
export function publicOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = String(env.APP_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

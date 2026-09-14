import type { AppNavRouteId } from "./app-routes";

export type NavChild = { href: string; label: string; preserveParams?: readonly string[] };

export const NAV_CHILDREN: Partial<Record<AppNavRouteId, readonly NavChild[]>> = {
  studio: [
    { href: "/app/studio?mode=chat", label: "Чат" },
    { href: "/app/studio/questions", label: "Запросы аудитории" },
    { href: "/app/studio?mode=media", label: "Изображения" },
  ],
  autopilot: [
    { href: "/app/autopilot", label: "Обзор" },
    { href: "/app/autopilot/month", label: "Месяц" },
  ],
  library: [
    { href: "/app/library?tab=hits", label: "Референсы", preserveParams: ["channel"] },
    { href: "/app/library?tab=posts", label: "Коллекция", preserveParams: ["channel"] },
  ],
  rss: [
    { href: "/app/rss", label: "Для вас", preserveParams: ["channel"] },
    { href: "/app/rss?view=saved", label: "Сохранённые", preserveParams: ["channel"] },
    { href: "/app/rss?view=used", label: "Использованные", preserveParams: ["channel"] },
    { href: "/app/rss?view=hidden", label: "Скрытые", preserveParams: ["channel"] },
  ],
  recon: [
    { href: "/app/competitors", label: "Конкуренты" },
    { href: "/app/trends", label: "Тренды" },
  ],
  settings: [
    { href: "/app/settings?section=profile", label: "Профиль" },
    { href: "/app/settings?section=content", label: "Контент и стиль" },
  ],
};

export function childHref(child: NavChild, searchParams: Pick<URLSearchParams, "get">): string {
  if (!child.preserveParams?.length) return child.href;
  const [path, query = ""] = child.href.split("?");
  const params = new URLSearchParams(query);
  for (const key of child.preserveParams) {
    const value = searchParams.get(key);
    if (value) params.set(key, value);
  }
  return `${path}${params.size ? `?${params.toString()}` : ""}`;
}

/** Match explicit tab URLs first; default URLs resolve to the actual first tab. */
export function activeChildHref(routeId: AppNavRouteId, pathname: string, search: string): string | null {
  const children = NAV_CHILDREN[routeId];
  if (!children) return null;
  const params = new URLSearchParams(search);
  const keys = new Set(children.flatMap(({ href }) => [...new URLSearchParams(href.split("?")[1]).keys()]));
  const exact = children.find(({ href }) => {
    const [path, query] = href.split("?");
    if (path !== pathname) return false;
    const expected = new URLSearchParams(query);
    return expected.size
      ? [...expected].every(([key, value]) => params.get(key) === value)
      : [...keys].every((key) => !params.has(key));
  });
  if (exact) return exact.href;
  if ([...keys].some((key) => params.has(key))) return null;
  return children.find(({ href }) => href.split("?")[0] === pathname)?.href ?? null;
}

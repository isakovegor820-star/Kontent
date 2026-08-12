export type AppPath = `/app${string}`;

type AppRouteDefinition = Readonly<{
  href: AppPath;
  label: string;
  mobileLabel?: string;
  tabLabel?: string;
  activeAliases: readonly AppPath[];
}>;

export const APP_ROUTES = {
  calendar: {
    href: "/app/calendar",
    label: "Календарь",
    activeAliases: ["/app/composer"],
  },
  composer: {
    href: "/app/composer",
    label: "Редактор",
    activeAliases: [],
  },
  studio: {
    href: "/app/studio",
    label: "Студия контента",
    mobileLabel: "Студия",
    activeAliases: [],
  },
  autopilot: {
    href: "/app/autopilot",
    label: "Автопилот",
    activeAliases: [],
  },
  library: {
    href: "/app/library",
    label: "Идеи и примеры",
    activeAliases: [],
  },
  rss: {
    href: "/app/rss",
    label: "Источники контента",
    activeAliases: [],
  },
  recon: {
    href: "/app/recon",
    label: "Конкуренты и тренды",
    mobileLabel: "Разведка",
    tabLabel: "Поиск",
    activeAliases: ["/app/competitors", "/app/trends", "/app/radar"],
  },
  siteAnalysis: {
    href: "/app/site-analysis",
    label: "Анализ сайта",
    activeAliases: [],
  },
  competitors: {
    href: "/app/competitors",
    label: "Конкуренты",
    activeAliases: [],
  },
  trends: {
    href: "/app/trends",
    label: "Тренды",
    activeAliases: [],
  },
  radar: {
    href: "/app/radar",
    label: "Поиск",
    activeAliases: [],
  },
  analytics: {
    href: "/app/analytics",
    label: "Результаты",
    activeAliases: [],
  },
  settings: {
    href: "/app/settings",
    label: "Настройки",
    activeAliases: [],
  },
} as const satisfies Record<string, AppRouteDefinition>;

export type AppRouteId = keyof typeof APP_ROUTES;

export const APP_NAV_GROUPS = [
  {
    id: "work",
    title: "Работа",
    routeIds: ["calendar", "studio", "autopilot", "library", "rss"],
  },
  {
    id: "market",
    title: "Рынок",
    routeIds: ["recon", "siteAnalysis"],
  },
  {
    id: "results",
    title: "Итоги",
    routeIds: ["analytics", "settings"],
  },
] as const satisfies readonly {
  id: string;
  title: string;
  routeIds: readonly AppRouteId[];
}[];

export type AppNavRouteId = (typeof APP_NAV_GROUPS)[number]["routeIds"][number];

export const APP_BOTTOM_NAV_ROUTE_IDS = [
  "calendar",
  "studio",
  "recon",
  "analytics",
] as const satisfies readonly AppNavRouteId[];

export const RECON_TAB_ROUTE_IDS = [
  "recon",
  "competitors",
  "trends",
] as const satisfies readonly AppRouteId[];

export type ReconTabRouteId = (typeof RECON_TAB_ROUTE_IDS)[number];

function isPathActive(pathname: string, href: AppPath): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isAppRouteActive(pathname: string, routeId: AppRouteId): boolean {
  const route = APP_ROUTES[routeId];
  return [route.href, ...route.activeAliases].some((href) => isPathActive(pathname, href));
}

export function appRouteLabel(
  routeId: AppRouteId,
  context: "desktop" | "mobile" | "tab" = "desktop",
): string {
  const route: AppRouteDefinition = APP_ROUTES[routeId];
  if (context === "mobile") return route.mobileLabel ?? route.label;
  if (context === "tab") return route.tabLabel ?? route.label;
  return route.label;
}

export function getActiveReconTabRouteId(pathname: string): ReconTabRouteId {
  if (isPathActive(pathname, APP_ROUTES.competitors.href)) return "competitors";
  if (isPathActive(pathname, APP_ROUTES.trends.href)) return "trends";
  return "recon";
}

type InternalActionDefinition = Readonly<{
  destination: "composer" | "studio";
  routeId: "composer" | "studio";
  intent?: "create" | "discuss";
}>;

export const APP_ACTIONS = {
  editor: { destination: "composer", routeId: "composer" },
  create: { destination: "studio", routeId: "studio", intent: "create" },
  discuss: { destination: "studio", routeId: "studio", intent: "discuss" },
  original: { destination: "external", routeId: null },
} as const satisfies Record<
  "editor" | "create" | "discuss",
  InternalActionDefinition
> & Record<"original", Readonly<{ destination: "external"; routeId: null }>>;

export type DraftBackedAppAction = Exclude<keyof typeof APP_ACTIONS, "original">;

export function appDraftActionHref(action: DraftBackedAppAction, draftId: number): string {
  if (!Number.isSafeInteger(draftId) || draftId <= 0) {
    throw new RangeError("draftId must be a positive safe integer");
  }
  const definition = APP_ACTIONS[action];
  const route = APP_ROUTES[definition.routeId];
  const params = new URLSearchParams({ draft: String(draftId) });
  const intent = "intent" in definition ? definition.intent : undefined;
  if (intent) params.set("intent", intent);
  return `${route.href}?${params.toString()}`;
}

export const COMPOSER_SOURCES = ["calendar", "studio", "autopilot-month", "studio-visuals"] as const;
export type ComposerSource = (typeof COMPOSER_SOURCES)[number];

export function composerSource(value: string | null): ComposerSource | null {
  return COMPOSER_SOURCES.includes(value as ComposerSource) ? value as ComposerSource : null;
}

export function composerReturnTarget(source: ComposerSource | null, draftId?: number | null) {
  if (source === "studio") return { href: "/app/studio", label: "Вернуться в Студию" } as const;
  if (source === "autopilot-month") {
    return { href: "/app/autopilot/month", label: "Вернуться к плану месяца" } as const;
  }
  if (source === "studio-visuals") {
    const suffix = Number.isSafeInteger(draftId) && Number(draftId) > 0 ? `?draft=${draftId}` : "";
    return { href: `/app/studio/visuals${suffix}`, label: "Вернуться к визуалам" } as const;
  }
  return { href: "/app/calendar", label: "Вернуться в календарь" } as const;
}

export function composerHydrationIdentity(input: {
  userId: number | null;
  projectId?: number | null;
  draftId: number | null;
  legacyId: string | null;
  channelId: number | null;
  date: string | null;
  time: string | null;
  fromMedia: boolean;
}): string {
  return [
    `user:${input.userId ?? "guest"}`,
    `project:${input.projectId ?? "none"}`,
    `draft:${input.draftId ?? "new"}`,
    `channel:${input.channelId ?? "default"}`,
    `legacy:${input.legacyId ?? "none"}`,
    `date:${input.date ?? "none"}`,
    `time:${input.time ?? "none"}`,
    `media:${input.fromMedia ? "generated" : "none"}`,
  ].join("|");
}

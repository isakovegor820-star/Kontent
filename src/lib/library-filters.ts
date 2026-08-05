export type LibraryFormat = "text" | "photo" | "video";
export type LibrarySavedFilter = "all" | "saved" | "unsaved";
export type LibraryViewedFilter = "all" | "new" | "viewed";
export type LibrarySort =
  | "score"
  | "freshness"
  | "views"
  | "reactions"
  | "lift"
  | "engagement_rate"
  | "velocity";
export type LibraryQuality = "low" | "medium" | "high";
export type LibraryMaturity = "collecting" | "mature";

export type LibraryFilters = {
  q: string;
  channelId: number | null;
  sourceIds: string[];
  periodFrom: string | null;
  periodTo: string | null;
  formats: LibraryFormat[];
  saved: LibrarySavedFilter;
  viewed: LibraryViewedFilter;
  ratingMin: number | null;
  ratingMax: number | null;
  viewsMin: number | null;
  viewsMax: number | null;
  reactionsMin: number | null;
  reactionsMax: number | null;
  liftMin: number | null;
  liftMax: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  qualities: LibraryQuality[];
  maturities: LibraryMaturity[];
  sort: LibrarySort;
  direction: "asc" | "desc";
  hitOnly: boolean;
  limit: number;
};

export type LibraryRegistryItem = {
  id: string;
  kind: "reference" | "idea" | "saved";
  channelId: number;
  channelTitle: string;
  sourceId: string | null;
  sourceTitle: string;
  sourceUrl: string | null;
  sourceData: string;
  text: string;
  postedAt: string;
  format: LibraryFormat;
  saved: boolean;
  viewedAt: string | null;
  userRating: number | null;
  views: number | null;
  reactions: number | null;
  lift: number | null;
  erBayes: number | null;
  velocity: number | null;
  velocityZ: number | null;
  freshness: number | null;
  analyticsScore: number | null;
  formulaVersion: string | null;
  dataQuality: LibraryQuality | null;
  dataMaturity: LibraryMaturity | null;
  isHit: boolean;
  explanation?: string;
};

type QueryLike = URLSearchParams | Record<string, unknown>;

function values(query: QueryLike, key: string): string[] {
  if (query instanceof URLSearchParams) return query.getAll(key).flatMap((value) => value.split(","));
  const value = query[key];
  return (Array.isArray(value) ? value : [value])
    .filter((item) => item != null)
    .flatMap((item) => String(item).split(","));
}

function first(query: QueryLike, key: string): string | null {
  return values(query, key)[0]?.trim() || null;
}

function boundedNumber(query: QueryLike, key: string, min: number, max: number): number | null {
  const raw = first(query, key);
  if (raw == null) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : null;
}

function dateOnly(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? value : null;
}

function enumList<T extends string>(query: QueryLike, key: string, allowed: readonly T[]): T[] {
  const allow = new Set<string>(allowed);
  return [...new Set(values(query, key).map((value) => value.trim()).filter((value) => allow.has(value)))] as T[];
}

export function parseLibraryFilters(query: QueryLike): LibraryFilters {
  const channel = boundedNumber(query, "channel", 1, Number.MAX_SAFE_INTEGER);
  const saved = first(query, "saved");
  const viewed = first(query, "viewed");
  const sort = first(query, "sort");
  const direction = first(query, "direction");
  return {
    q: (first(query, "q") ?? "").slice(0, 160),
    channelId: channel == null ? null : Math.trunc(channel),
    sourceIds: [...new Set(values(query, "source").map((value) => value.trim().slice(0, 160)).filter(Boolean))].slice(0, 50),
    periodFrom: dateOnly(first(query, "from")),
    periodTo: dateOnly(first(query, "to")),
    formats: enumList(query, "format", ["text", "photo", "video"] as const),
    saved: saved === "saved" || saved === "unsaved" ? saved : "all",
    viewed: viewed === "new" || viewed === "viewed" ? viewed : "all",
    ratingMin: boundedNumber(query, "ratingMin", 1, 5),
    ratingMax: boundedNumber(query, "ratingMax", 1, 5),
    viewsMin: boundedNumber(query, "viewsMin", 0, Number.MAX_SAFE_INTEGER),
    viewsMax: boundedNumber(query, "viewsMax", 0, Number.MAX_SAFE_INTEGER),
    reactionsMin: boundedNumber(query, "reactionsMin", 0, Number.MAX_SAFE_INTEGER),
    reactionsMax: boundedNumber(query, "reactionsMax", 0, Number.MAX_SAFE_INTEGER),
    liftMin: boundedNumber(query, "liftMin", 0, 1_000_000),
    liftMax: boundedNumber(query, "liftMax", 0, 1_000_000),
    scoreMin: boundedNumber(query, "scoreMin", 0, 100),
    scoreMax: boundedNumber(query, "scoreMax", 0, 100),
    qualities: enumList(query, "quality", ["low", "medium", "high"] as const),
    maturities: enumList(query, "maturity", ["collecting", "mature"] as const),
    sort: (["score", "freshness", "views", "reactions", "lift", "engagement_rate", "velocity"] as string[]).includes(sort ?? "")
      ? (sort as LibrarySort)
      : "score",
    direction: direction === "asc" ? "asc" : "desc",
    hitOnly: first(query, "hit") === "only",
    limit: Math.trunc(boundedNumber(query, "limit", 1, 500) ?? 100),
  };
}

function inRange(value: number | null, min: number | null, max: number | null) {
  if (min != null && (value == null || value < min)) return false;
  if (max != null && (value == null || value > max)) return false;
  return true;
}

function sortable(item: LibraryRegistryItem, sort: LibrarySort) {
  if (sort === "score") return item.analyticsScore;
  if (sort === "freshness") return item.freshness;
  if (sort === "views") return item.views;
  if (sort === "reactions") return item.reactions;
  if (sort === "lift") return item.lift;
  if (sort === "engagement_rate") return item.erBayes;
  return item.velocity;
}

export function filterAndSortLibraryItems(items: LibraryRegistryItem[], filters: LibraryFilters) {
  const needle = filters.q.toLocaleLowerCase("ru");
  const sources = new Set(filters.sourceIds.map((value) => value.toLocaleLowerCase("ru")));
  const from = filters.periodFrom ? new Date(`${filters.periodFrom}T00:00:00.000Z`).getTime() : null;
  const to = filters.periodTo ? new Date(`${filters.periodTo}T23:59:59.999Z`).getTime() : null;
  const filtered = items.filter((item) => {
    if (needle && !`${item.text} ${item.sourceTitle} ${item.channelTitle}`.toLocaleLowerCase("ru").includes(needle)) return false;
    if (sources.size && !sources.has(String(item.sourceId ?? "").toLocaleLowerCase("ru")) && !sources.has(item.sourceTitle.toLocaleLowerCase("ru"))) return false;
    const timestamp = new Date(item.postedAt).getTime();
    if (from != null && timestamp < from) return false;
    if (to != null && timestamp > to) return false;
    if (filters.formats.length && !filters.formats.includes(item.format)) return false;
    if (filters.saved === "saved" && !item.saved) return false;
    if (filters.saved === "unsaved" && item.saved) return false;
    if (filters.viewed === "new" && item.viewedAt) return false;
    if (filters.viewed === "viewed" && !item.viewedAt) return false;
    if (!inRange(item.userRating, filters.ratingMin, filters.ratingMax)) return false;
    if (!inRange(item.views, filters.viewsMin, filters.viewsMax)) return false;
    if (!inRange(item.reactions, filters.reactionsMin, filters.reactionsMax)) return false;
    if (!inRange(item.lift, filters.liftMin, filters.liftMax)) return false;
    if (!inRange(item.analyticsScore, filters.scoreMin, filters.scoreMax)) return false;
    if (filters.qualities.length && (!item.dataQuality || !filters.qualities.includes(item.dataQuality))) return false;
    if (filters.maturities.length && (!item.dataMaturity || !filters.maturities.includes(item.dataMaturity))) return false;
    if (filters.hitOnly && item.kind === "reference" && !item.isHit) return false;
    return true;
  });
  const direction = filters.direction === "asc" ? 1 : -1;
  filtered.sort((left, right) => {
    const a = sortable(left, filters.sort);
    const b = sortable(right, filters.sort);
    if (a == null && b == null) return right.postedAt.localeCompare(left.postedAt);
    if (a == null) return 1;
    if (b == null) return -1;
    if (a === b) return right.postedAt.localeCompare(left.postedAt);
    return (a - b) * direction;
  });
  return filtered.slice(0, filters.limit);
}

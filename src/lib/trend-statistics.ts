import { normalizeRadarQuery } from "./radar-search.mjs";

export const TREND_STAT_SOURCES = {
  own: {
    label: "Мои конкуренты",
    description: "Посты Telegram-каналов, которые ты добавил для выбранного канала.",
  },
  internet: {
    label: "Поиск по теме",
    description: "Публичные Telegram-публикации по твоему запросу.",
  },
  collection: {
    label: "Подборка Авроры",
    description: "Общая редакционная база проверенных публичных Telegram-каналов.",
  },
} as const;

export type TrendStatSource = keyof typeof TREND_STAT_SOURCES;

export const TREND_STAT_PERIODS = {
  day: {
    label: "24 часа",
    interval: "1 day",
    previousInterval: "2 days",
    bucket: "hour",
    step: "1 hour",
  },
  week: {
    label: "7 дней",
    interval: "7 days",
    previousInterval: "14 days",
    bucket: "day",
    step: "1 day",
  },
  month: {
    label: "30 дней",
    interval: "30 days",
    previousInterval: "60 days",
    bucket: "day",
    step: "1 day",
  },
  quarter: {
    label: "90 дней",
    interval: "90 days",
    previousInterval: "180 days",
    bucket: "week",
    step: "1 week",
  },
} as const;

export type TrendStatPeriod = keyof typeof TREND_STAT_PERIODS;

export function parseTrendStatSource(value: string | null | undefined): TrendStatSource {
  return value === "internet" || value === "collection" ? value : "own";
}

export function parseTrendStatPeriod(value: string | null | undefined): TrendStatPeriod {
  return value === "day" || value === "month" || value === "quarter" ? value : "week";
}

export function normalizeTrendTopic(value: unknown) {
  return normalizeRadarQuery(value);
}

export function trendPercentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export const TREND_PAGE_SIZE = 24;
export type TrendSort = "recent" | "views" | "ratio";
export function parseTrendSort(value: string | null | undefined): TrendSort {
  return value === "views" || value === "ratio" ? value : "recent";
}

export type TrendSearchRun = {
  id: number;
  query: string;
  status: "queued" | "running" | "ready" | "partial" | "failed";
  stage: string;
  progress: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  period: TrendStatPeriod;
};

export type TrendFeedItem = {
  id: number;
  competitorId: number;
  handle: string;
  competitorTitle: string | null;
  category: string | null;
  msgId: number;
  text: string | null;
  views: number | null;
  reactions: number | null;
  photoUrl: string | null;
  media: string | null;
  postedAt: string;
  measuredAt: string | null;
  median: number | null;
  baselinePosts: number;
  ratio: number | null;
  isMature: boolean;
  link: string;
  idea: {
    id: number;
    topic: string | null;
    hook: string | null;
    structure: string | null;
    why: string | null;
  } | null;
};

export type TrendStatsData = {
  source: TrendStatSource;
  sourceLabel: string;
  sourceDescription: string;
  period: TrendStatPeriod;
  periodLabel: string;
  topic: string;
  channelId: number | null;
  window: { from: string; to: string; timeZone: string };
  search: TrendSearchRun | null;
  summary: {
    posts: number;
    sources: number;
    views: number | null;
    reactions: number | null;
    avgViews: number | null;
    trends: number;
    postsWithViews: number;
    postsWithReactions: number;
  };
  coverage: {
    undatedPosts: number;
    futurePosts: number;
    oldestMeasurementAt: string | null;
    latestMeasurementAt: string | null;
    comparisonAvailable: false;
  };
  series: { bucket: string; until: string; posts: number; views: number | null; postsWithViews: number }[];
  topItems: TrendFeedItem[];
  items: TrendFeedItem[];
  pagination: { offset: number; limit: number; total: number; hasMore: boolean };
  status: {
    competitors: number;
    ready: number;
    pending: number;
    error: number;
    posts: number;
    periodPosts: number;
    lastCollectedAt: string | null;
    latestPostAt: string | null;
    refreshEveryHours: number;
    matureHours: number;
    minMature: number;
    waiting: number;
    niche: string | null;
  };
};

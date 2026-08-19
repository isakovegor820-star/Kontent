export const TREND_MATURE_HOURS = 48;
export const TREND_MIN_MATURE = 5;
export const TREND_BASELINE_DAYS = 90;

export const TREND_PERIODS = {
  today: {
    label: "Сегодня",
    description: "Публикации с начала сегодняшнего дня по Москве, сначала новые.",
    sort: "newest",
    limit: 48,
  },
  week: {
    label: "7 дней",
    description: "Все публикации за последние 7 дней, сначала новые.",
    sort: "newest",
    limit: 72,
  },
  hits: {
    label: "Залёты · 30 дней",
    description: "Проверенные посты за 30 дней, которые сравнимы с нормой своего канала.",
    sort: "ratio",
    limit: 24,
  },
} as const;

export type TrendPeriod = keyof typeof TREND_PERIODS;
export type TrendFeedScope = "niche" | "internet" | "global";

export function parseTrendPeriod(value: string | null | undefined): TrendPeriod {
  return value === "week" || value === "hits" ? value : "today";
}

export function parseTrendFeedScope(value: string | null | undefined): TrendFeedScope {
  return value === "internet" || value === "global" ? value : "niche";
}

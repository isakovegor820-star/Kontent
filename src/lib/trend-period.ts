export const TREND_MATURE_HOURS = 48;
export const TREND_MIN_MATURE = 5;
export const TREND_BASELINE_DAYS = 90;

export const TREND_PERIODS = {
  today: {
    label: "Сегодня",
    description: "Публикации с начала сегодняшнего дня по Москве, сначала новые.",
    sort: "newest",
    limit: 36,
  },
  week: {
    label: "7 дней",
    description: "Все публикации за последние 7 дней, сначала новые.",
    sort: "newest",
    limit: 48,
  },
  hits: {
    label: "Залёты · 30 дней",
    description: "Проверенные посты за 30 дней, которые сравнимы с нормой своего канала.",
    sort: "ratio",
    limit: 18,
  },
} as const;

export type TrendPeriod = keyof typeof TREND_PERIODS;

export function parseTrendPeriod(value: string | null | undefined): TrendPeriod {
  return value === "week" || value === "hits" ? value : "today";
}

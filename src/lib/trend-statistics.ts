export const TREND_STAT_SOURCES = {
  own: {
    label: "Своя база",
    description: "Посты добавленных конкурентов выбранного канала.",
  },
  internet: {
    label: "Интернет",
    description: "Проверенные публикации, найденные поиском по публичному Telegram.",
  },
  collection: {
    label: "Подборка",
    description: "Редакционная база проверенных публичных Telegram-каналов.",
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
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 100);
}

export function trendPercentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

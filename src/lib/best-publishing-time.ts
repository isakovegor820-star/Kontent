export interface PublishingMetric {
  published_at: string;
  views: number;
}

export interface BestPublishingTime {
  hour: number;
  sampleSize: number;
  totalSample: number;
  averageViews: number;
  confidence: "low" | "medium" | "high";
  timeZone: "Europe/Moscow";
}

function moscowParts(date: Date) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
  };
}

export function summarizeBestPublishingTime(
  posts: readonly PublishingMetric[],
): BestPublishingTime | null {
  if (posts.length < 3) return null;
  const byHour = new Map<number, number[]>();
  for (const post of posts) {
    const date = new Date(post.published_at);
    if (!Number.isFinite(date.getTime()) || !Number.isFinite(post.views)) continue;
    const hour = moscowParts(date).hour;
    const values = byHour.get(hour) ?? [];
    values.push(post.views);
    byHour.set(hour, values);
  }
  let best: { hour: number; values: number[]; average: number } | null = null;
  for (const [hour, values] of byHour) {
    const average = values.reduce((sum, views) => sum + views, 0) / values.length;
    if (!best || average > best.average || (average === best.average && values.length > best.values.length)) {
      best = { hour, values, average };
    }
  }
  if (!best) return null;
  const sampleSize = best.values.length;
  return {
    hour: best.hour,
    sampleSize,
    totalSample: posts.length,
    averageViews: Math.round(best.average),
    confidence: sampleSize >= 6 ? "high" : sampleSize >= 3 ? "medium" : "low",
    timeZone: "Europe/Moscow",
  };
}

/** Ближайшее наступление указанного часа МСК, возвращённое как реальный instant. */
export function nextMoscowPublishingSlot(hour: number, now = new Date()): Date {
  const safeHour = Math.min(23, Math.max(0, Math.round(hour)));
  const current = moscowParts(now);
  let timestamp = Date.UTC(current.year, current.month - 1, current.day, safeHour - 3, 0, 0, 0);
  if (timestamp <= now.getTime()) timestamp += 24 * 60 * 60 * 1_000;
  return new Date(timestamp);
}

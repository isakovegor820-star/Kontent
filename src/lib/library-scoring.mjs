export const LIBRARY_FORMULA_VERSION = "aurora-library-v1";

export const LIBRARY_FORMULA_DEFAULTS = Object.freeze({
  bayesK: 100,
  halfLifeHours: 168,
  windowHours: 90 * 24,
  maturityHours: 48,
  minCohortSize: 8,
  minMedianViews: 20,
  hitPercentile: 0.9,
  hitMinLift: 5,
  epsilon: 1e-9,
});

const SCORE_WEIGHTS = Object.freeze({
  lift: 0.4,
  velocity: 0.25,
  erBayes: 0.2,
  freshness: 0.15,
});

function finiteNumber(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : null;
}

export function libraryMedian(values) {
  const sorted = values
    .map(finiteNumber)
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function libraryQuantile(values, proportion) {
  const sorted = values
    .map(finiteNumber)
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const bounded = Math.min(1, Math.max(0, Number(proportion) || 0));
  const index = (sorted.length - 1) * bounded;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** Inclusive percentile rank in [0, 1], with ties receiving the same mid-rank. */
export function libraryPercentileRank(values, target) {
  const number = finiteNumber(target);
  const sorted = values
    .map(finiteNumber)
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  if (number == null || !sorted.length) return null;
  if (sorted.length === 1) return 1;
  let below = 0;
  let equal = 0;
  for (const value of sorted) {
    if (value < number) below += 1;
    else if (value === number) equal += 1;
  }
  return Math.min(1, Math.max(0, (below + Math.max(0, equal - 1) / 2) / (sorted.length - 1)));
}

export function normalizeLibraryFormat(media) {
  const value = String(media ?? "").toLocaleLowerCase("ru");
  if (value.includes("video")) return "video";
  if (value.includes("photo") || value.includes("image") || value.includes("picture")) return "photo";
  return "text";
}

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function cohortQuality(sampleSize, defaults) {
  if (sampleSize >= 20) return "high";
  if (sampleSize >= defaults.minCohortSize) return "medium";
  return "low";
}

function scoreOne(metric, distributions) {
  const values = {
    lift: metric.lift == null ? null : libraryPercentileRank(distributions.lift, metric.lift),
    velocity:
      metric.velocity == null ? null : libraryPercentileRank(distributions.velocity, metric.velocity),
    erBayes:
      metric.erBayes == null ? null : libraryPercentileRank(distributions.erBayes, metric.erBayes),
    freshness: metric.freshness,
  };
  let weighted = 0;
  let availableWeight = 0;
  const missing = [];
  for (const [name, weight] of Object.entries(SCORE_WEIGHTS)) {
    const value = values[name];
    if (value == null || !Number.isFinite(value)) {
      missing.push(name);
      continue;
    }
    weighted += weight * value;
    availableWeight += weight;
  }
  return {
    score: availableWeight > 0 ? 100 * (weighted / availableWeight) : null,
    percentiles: values,
    missingMetrics: missing,
    availableWeight,
  };
}

/**
 * Scores only comparable cohorts: same channel, source, format and fixed time window.
 * The input is deliberately provider-agnostic so this module can run in both Next and BullMQ.
 */
export function scoreLibraryCohorts(rows, options = {}) {
  const defaults = { ...LIBRARY_FORMULA_DEFAULTS, ...options };
  const now = isoDate(options.now ?? new Date()) ?? new Date();
  const windowTo = isoDate(options.windowTo ?? now) ?? now;
  const windowFrom =
    isoDate(options.windowFrom) ?? new Date(windowTo.getTime() - defaults.windowHours * 3_600_000);
  const groups = new Map();

  for (const source of Array.isArray(rows) ? rows : []) {
    const postedAt = isoDate(source.postedAt ?? source.posted_at);
    if (!postedAt || postedAt < windowFrom || postedAt > windowTo) continue;
    const format = normalizeLibraryFormat(source.format ?? source.media);
    const channelId = String(source.channelId ?? source.channel_id ?? "");
    const sourceId = String(source.sourceId ?? source.source_id ?? source.competitorId ?? source.competitor_id ?? "");
    if (!channelId || !sourceId) continue;
    const key = `${channelId}:${sourceId}:${format}:${windowFrom.toISOString()}:${windowTo.toISOString()}`;
    const item = {
      ...source,
      id: source.id,
      channelId,
      sourceId,
      format,
      postedAt,
      views: nonNegativeNumber(source.views),
      reactions: nonNegativeNumber(source.reactions),
    };
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const result = [];
  for (const [cohortKey, group] of groups) {
    const viewValues = group.map((item) => item.views).filter((value) => value != null);
    const medianViews = libraryMedian(viewValues);
    const rawErValues = group
      .filter((item) => item.views != null && item.views > 0 && item.reactions != null)
      .map((item) => item.reactions / item.views);
    const meanEr = rawErValues.length
      ? rawErValues.reduce((sum, value) => sum + value, 0) / rawErValues.length
      : null;

    const preliminary = group.map((item) => {
      const ageHours = Math.max((now.getTime() - item.postedAt.getTime()) / 3_600_000, 0);
      const velocity = item.views == null ? null : item.views / Math.max(ageHours, 1);
      return {
        item,
        ageHours,
        lift:
          item.views == null || medianViews == null ? null : (item.views + 1) / (medianViews + 1),
        erBayes:
          item.views == null || item.reactions == null || meanEr == null
            ? null
            : (item.reactions + defaults.bayesK * meanEr) / (item.views + defaults.bayesK),
        velocity,
        velocityLog: velocity == null ? null : Math.log1p(velocity),
        freshness: Math.pow(2, -ageHours / defaults.halfLifeHours),
      };
    });

    const velocityLogs = preliminary.map((item) => item.velocityLog).filter((value) => value != null);
    const velocityMedianLog = libraryMedian(velocityLogs);
    const velocityMad =
      velocityMedianLog == null
        ? null
        : libraryMedian(velocityLogs.map((value) => Math.abs(value - velocityMedianLog)));
    const distributions = {
      lift: preliminary.map((item) => item.lift).filter((value) => value != null),
      velocity: preliminary.map((item) => item.velocity).filter((value) => value != null),
      erBayes: preliminary.map((item) => item.erBayes).filter((value) => value != null),
    };
    const hitThreshold = libraryQuantile(viewValues, defaults.hitPercentile);
    const sampleSize = viewValues.length;
    const quality = cohortQuality(sampleSize, defaults);
    const cohortEligibleForHits =
      sampleSize >= defaults.minCohortSize &&
      medianViews != null &&
      medianViews >= defaults.minMedianViews;

    for (const metric of preliminary) {
      const velocityZ =
        metric.velocityLog == null || velocityMedianLog == null || velocityMad == null
          ? null
          : (metric.velocityLog - velocityMedianLog) /
            Math.max(1.4826 * velocityMad, defaults.epsilon);
      const scored = scoreOne(metric, distributions);
      const mature = metric.ageHours >= defaults.maturityHours;
      const isHit = Boolean(
        cohortEligibleForHits &&
          metric.item.views != null &&
          hitThreshold != null &&
          metric.item.views >= hitThreshold &&
          metric.lift != null &&
          metric.lift >= defaults.hitMinLift,
      );
      result.push({
        ...metric.item,
        postedAt: metric.item.postedAt.toISOString(),
        ageHours: metric.ageHours,
        medianViews,
        meanEr,
        lift: metric.lift,
        erBayes: metric.erBayes,
        velocity: metric.velocity,
        velocityZ,
        freshness: metric.freshness,
        score: scored.score,
        percentiles: scored.percentiles,
        missingMetrics: scored.missingMetrics,
        availableWeight: scored.availableWeight,
        formulaVersion: LIBRARY_FORMULA_VERSION,
        cohortKey,
        cohortSampleSize: sampleSize,
        cohortWindowFrom: windowFrom.toISOString(),
        cohortWindowTo: windowTo.toISOString(),
        dataQuality: quality,
        dataMaturity: mature ? "mature" : "collecting",
        hitThreshold,
        isHit,
      });
    }
  }
  return result;
}

export function explainLibraryScore(item) {
  if (!item || item.score == null) {
    return "Недостаточно сопоставимых данных для аналитической оценки.";
  }
  const missing = Array.isArray(item.missingMetrics) && item.missingMetrics.length
    ? " Часть показателей недоступна и не учитывалась."
    : "";
  return [
    `Оценка ${Math.round(item.score)} из 100 рассчитана внутри сопоставимой группы: один источник, формат ${item.format} и временное окно.`,
    `Прирост ${item.lift?.toFixed?.(2) ?? "—"}; скорректированная вовлечённость ${item.erBayes?.toFixed?.(4) ?? "—"}; скорость ${item.velocity?.toFixed?.(2) ?? "—"}; свежесть ${item.freshness?.toFixed?.(3) ?? "—"}.`,
    `Формула ${item.formulaVersion}.${missing}`,
  ].join(" ");
}

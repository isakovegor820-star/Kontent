import { formatPagesCount } from "../site-profile/profile.mjs";
import { SITE_REPORT_SEO_INTEGRATIONS, SITE_REPORT_VERSION, buildRecommendations } from "./initial-audit.mjs";

function delta(current, previous) {
  if (previous === null || previous === undefined || !Number.isFinite(Number(previous))) return null;
  const diff = Number(current) - Number(previous);
  return diff > 0 ? `+${diff}` : String(diff);
}

function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/**
 * Статусы рекомендаций: рекомендация прошлого отчёта считается выполненной, если её ключ
 * исчез из текущего набора (проблема или пробел больше не наблюдаются). Открытые переносятся
 * с датой первого появления.
 */
export function reconcileRecommendations(current, previousReport) {
  const previous = Array.isArray(previousReport?.payload?.recommendations) ? previousReport.payload.recommendations : [];
  const currentKeys = new Set(current.map((item) => item.key));
  const carried = new Map(previous.map((item) => [item.key, item]));
  const result = current.map((item) => {
    const before = carried.get(item.key);
    return Object.freeze({
      ...item,
      status: "open",
      sinceReportId: before?.sinceReportId ?? (before ? previousReport.id : null),
    });
  });
  const done = previous
    .filter((item) => item.status === "open" && !currentKeys.has(item.key))
    .map((item) => Object.freeze({ ...item, status: "done", doneInReport: true }));
  return Object.freeze({ items: Object.freeze([...result, ...done]), doneCount: done.length, openCount: result.length, carriedCount: result.filter((item) => item.sinceReportId).length });
}

export function buildMonthlySummary({ site, profile, period, publications, probe, previousProbe, recommendations }) {
  const sentences = [];
  const start = period.start.slice(0, 10);
  const end = period.end.slice(0, 10);
  sentences.push(`Отчёт по сайту ${site.confirmedDomain} за период ${start} — ${end}.`);
  sentences.push(`Опубликовано материалов: ${publications.published}${publications.published ? ` (${Object.entries(publications.byType).map(([type, count]) => `${type}: ${count}`).join(", ")})` : ""}; отклонено как дубли: ${publications.rejectedDuplicates}; ждут одобрения: ${publications.pendingReview}.`);
  if (probe) {
    const engines = probe.engines?.length || 0;
    if (probe.answers === 0 && probe.skipped > 0) {
      sentences.push("Зонд видимости в ИИ-ответах пропущен: исчерпан дневной лимит ИИ; сравнение с прошлым месяцем недоступно.");
    } else {
      sentences.push(`В ответах ${engines} ${plural(engines, "ИИ-движка", "ИИ-движков", "ИИ-движков")} на ${probe.questions} ${plural(probe.questions, "вопрос", "вопроса", "вопросов")} ниши бренд упомянут в ${probe.brandMentioned}, сайт процитирован в ${probe.siteCited}.`);
      if (probe.brandMentioned === 0) {
        const reason = profile.gaps.some((gap) => gap.key === "schema_missing:organization")
          ? "на сайте нет структурированных данных об организации и внешних упоминаний, на которые движки могли бы опереться"
          : "о компании мало внешних упоминаний, на которые движки могли бы опереться";
        sentences.push(`По вашему бренду в ответах ИИ пусто: ${reason}.`);
      }
      if (probe.competitorsTop?.length) {
        sentences.push(`Вместо вас движки называют: ${probe.competitorsTop.slice(0, 3).map((item) => `${item.name} (${item.mentions})`).join(", ")}.`);
      }
      if (previousProbe) {
        sentences.push(`Динамика к прошлому прогону: упоминания бренда ${delta(probe.brandMentioned, previousProbe.brandMentioned) ?? "—"}, цитирования сайта ${delta(probe.siteCited, previousProbe.siteCited) ?? "—"}.`);
      }
    }
  } else {
    sentences.push("Зонд видимости в ИИ-ответах не запускался: домен не подтверждён или прогон ещё не выполнялся.");
  }
  const strong = profile.topics.filter((topic) => topic.coverage === "strong").length;
  sentences.push(`Профиль сайта: проверено ${formatPagesCount(profile.technical.pagesChecked)}, тем ${profile.topics.length} (глубоко: ${strong}), пробелов ${profile.gaps.length}.`);
  sentences.push(`Из ${recommendations.openCount + recommendations.doneCount} рекомендаций выполнено ${recommendations.doneCount}, открыто ${recommendations.openCount}.`);
  sentences.push("Позиции в поиске и трафик не измерялись: интеграции Вебмастера и Search Console не подключены.");
  return sentences.join(" ");
}

/**
 * Ежемесячный отчёт: профиль + публикации за период + зонд + дельта к предыдущему отчёту.
 * Свободной генерации нет — формулировки собираются из шаблонов по данным.
 */
export function buildMonthlyReport({ site, profile, period, publications, probe = null, previousReport = null, generatedAt = null, kind = "monthly" } = {}) {
  if (!site?.confirmedDomain) throw new TypeError("site_report_site_required");
  if (!profile || profile.profileVersion !== "site-profile-v1") throw new TypeError("site_report_profile_required");
  if (!period?.start || !period?.end) throw new TypeError("site_report_period_required");
  const current = buildRecommendations(profile);
  const recommendations = reconcileRecommendations(current, previousReport);
  const previousProbe = previousReport?.payload?.geo?.probe?.status === "answered" ? previousReport.payload.geo.probe : null;
  const normalizedPublications = {
    published: Number(publications?.published || 0),
    byType: publications?.byType || {},
    rejectedDuplicates: Number(publications?.rejectedDuplicates || 0),
    pendingReview: Number(publications?.pendingReview || 0),
    failed: Number(publications?.failed || 0),
  };
  const probePayload = probe
    ? {
        status: probe.answers > 0 ? "answered" : probe.skipped > 0 ? "skipped_budget" : "failed",
        runKey: probe.runKey || null,
        checkedAt: probe.checkedAt || null,
        questions: probe.questions,
        engines: probe.engines || [],
        brandMentioned: probe.brandMentioned,
        siteCited: probe.siteCited,
        competitorsTop: probe.competitorsTop || [],
        deltaVsPrevious: previousProbe
          ? { brandMentioned: delta(probe.brandMentioned, previousProbe.brandMentioned), siteCited: delta(probe.siteCited, previousProbe.siteCited) }
          : null,
      }
    : { status: "not_run", reason: site.verificationState === "verified" ? "no_probe_yet" : "domain_unverified" };

  const previousContent = previousReport?.payload?.content || null;
  const payload = Object.freeze({
    reportVersion: SITE_REPORT_VERSION,
    kind,
    generatedAt: new Date(generatedAt || Date.now()).toISOString(),
    site: Object.freeze({ domain: site.confirmedDomain, canonicalUrl: site.canonicalUrl || null, verified: site.verificationState === "verified" }),
    period: Object.freeze({ start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString() }),
    previousReportId: previousReport?.id ?? null,
    analysis: Object.freeze({ profileVersion: profile.profileVersion, checkedAt: profile.checkedAt }),
    seo: Object.freeze({
      score: profile.technical.seoScore,
      status: profile.technical.seoStatus,
      pagesChecked: profile.technical.pagesChecked,
      failedPages: profile.technical.failedPages,
      issues: profile.technical.seoIssues,
      notChecked: profile.technical.notChecked,
      orphanCandidates: profile.technical.orphanCandidates,
      deltaVsPrevious: previousReport?.payload?.seo ? { score: delta(profile.technical.seoScore ?? 0, previousReport.payload.seo.score ?? null) } : null,
      requiredIntegrations: SITE_REPORT_SEO_INTEGRATIONS,
    }),
    geo: Object.freeze({
      score: profile.technical.geoScore,
      status: profile.technical.geoStatus,
      issues: profile.technical.geoIssues,
      probe: Object.freeze(probePayload),
    }),
    aeo: Object.freeze({
      pagesWithQuestions: profile.questions.pagesWithQuestions,
      answerPages: profile.questions.answeredPages,
      faqSchemaPages: profile.questions.faqSchemaPages,
      questionsWithoutAnswer: profile.questions.unansweredQuestions,
      deltaVsPrevious: previousReport?.payload?.aeo ? { questionsWithoutAnswer: delta(profile.questions.unansweredQuestions, previousReport.payload.aeo.questionsWithoutAnswer) } : null,
    }),
    content: Object.freeze({
      pageCount: profile.pageCount,
      publicationCount: profile.publicationCount,
      lastPublishedAt: profile.lastPublishedAt,
      pageTypeCounts: profile.pageTypeCounts,
      topics: Object.freeze({
        total: profile.topics.length,
        strong: profile.topics.filter((topic) => topic.coverage === "strong").length,
        thin: profile.topics.filter((topic) => topic.coverage === "thin").length,
        items: profile.topics,
        closedThisPeriod: previousContent ? Math.max(0, (previousContent.gaps || []).length - profile.gaps.length) : null,
      }),
      gaps: profile.gaps,
      linkablePages: profile.linkablePages.length,
    }),
    publications: Object.freeze(normalizedPublications),
    recommendations: recommendations.items,
    recommendationSummary: Object.freeze({ open: recommendations.openCount, done: recommendations.doneCount, carried: recommendations.carriedCount }),
    limitations: Object.freeze([
      "Позиции в поиске и трафик не измерялись: интеграции Яндекс.Вебмастер и Google Search Console не подключены.",
      "Зонд видимости опрашивает подключённые движки одинаковыми вопросами; это воспроизводимая динамика, а не замер реальной выдачи Perplexity или Яндекс-Нейро.",
      "Оценки относятся только к проверенному публичному срезу страниц.",
    ]),
  });
  const summaryRu = buildMonthlySummary({ site, profile, period: payload.period, publications: normalizedPublications, probe: probePayload.status === "not_run" ? null : { ...probe, engines: probePayload.engines, answers: probe.answers ?? probe.questions }, previousProbe, recommendations });
  return Object.freeze({ payload, summaryRu });
}

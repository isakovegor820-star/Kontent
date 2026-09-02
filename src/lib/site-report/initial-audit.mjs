import { formatPagesCount } from "../site-profile/profile.mjs";

export const SITE_REPORT_VERSION = "site-report-v1";
export const SITE_REPORT_KINDS = Object.freeze(["initial_audit", "monthly", "on_demand"]);

/** Интеграции, без которых Аврора не утверждает ничего о трафике и позициях. */
export const SITE_REPORT_SEO_INTEGRATIONS = Object.freeze(["yandex_webmaster", "google_search_console"]);

const GAP_PRIORITY = Object.freeze({ high: "P0", medium: "P1", low: "P2" });

function cleanText(value, max = 500) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);
}

function gapRecommendation(gap) {
  switch (gap.kind) {
    case "page_type_missing": {
      const type = String(gap.key).split(":")[1];
      const titles = {
        about: "Добавить страницу о компании с фактами, датами и реквизитами",
        offer: "Описать каждую услугу или продукт отдельной страницей",
        contact: "Добавить страницу контактов с адресом и способами связи",
        case: "Опубликовать кейсы или примеры работ с описанием вклада",
        team: "Представить команду и экспертов с должностями",
        article: "Открыть раздел статей или новостей и задать ритм публикаций",
      };
      return titles[type] || `Добавить страницы типа «${gap.label}»`;
    }
    case "schema_missing":
      return String(gap.key).endsWith(":organization")
        ? "Добавить JSON-LD Organization или LocalBusiness на главную и страницу о компании"
        : "Оформить ответы на вопросы аудитории с разметкой FAQPage";
    case "question_without_answer":
      return `Дать прямой ответ на вопрос «${cleanText(gap.label, 120)}» в первом абзаце страницы`;
    case "thin_topic":
      return `Собрать полный материал по теме «${cleanText(String(gap.key).split(":")[1], 80)}»`;
    default:
      return cleanText(gap.label, 200);
  }
}

export function buildRecommendations(profile) {
  const items = [];
  for (const issue of [...profile.technical.seoIssues, ...profile.technical.geoIssues]) {
    items.push(Object.freeze({
      key: `technical:${issue.id}`,
      source: profile.technical.seoIssues.includes(issue) ? "seo" : "geo",
      priority: issue.status === "critical" ? "P0" : "P1",
      title: issue.recommendation || issue.label,
      rationale: issue.detail,
      status: "open",
    }));
  }
  for (const gap of profile.gaps) {
    items.push(Object.freeze({
      key: `gap:${gap.key}`,
      source: "content",
      priority: GAP_PRIORITY[gap.severity] || "P2",
      title: gapRecommendation(gap),
      rationale: gap.detail,
      status: "open",
    }));
  }
  const order = { P0: 0, P1: 1, P2: 2 };
  const sourceOrder = { seo: 0, geo: 1, content: 2 };
  return items.sort((a, b) => order[a.priority] - order[b.priority]
    || sourceOrder[a.source] - sourceOrder[b.source]
    || a.key.localeCompare(b.key));
}

function scoreWord(score) {
  if (score === null || score === undefined) return "не измерена";
  if (score >= 85) return "сильная";
  if (score >= 60) return "средняя";
  return "слабая";
}

/**
 * Человеческие формулировки собираются из шаблонов по данным профиля.
 * Свободная генерация здесь запрещена: отчёт не должен обещать лишнего.
 */
export function buildInitialAuditSummary({ site, profile, recommendations }) {
  const sentences = [];
  const okPages = profile.technical.pagesChecked;
  sentences.push(`Стартовый аудит сайта ${site.confirmedDomain}: проверено ${formatPagesCount(okPages)}, публикаций найдено ${profile.publicationCount}.`);

  if (profile.publicationCount === 0) {
    sentences.push("Раздела новостей или статей нет — сайту нечего показывать поиску, кроме служебных страниц.");
  } else if (profile.lastPublishedAt) {
    sentences.push(`Последняя датированная публикация — ${profile.lastPublishedAt.slice(0, 10)}.`);
  }

  const seo = profile.technical.seoScore;
  const geo = profile.technical.geoScore;
  const criticalSeo = profile.technical.seoIssues.filter((issue) => issue.status === "critical").length;
  sentences.push(`Техническая база on-page SEO ${scoreWord(seo)}${seo !== null ? ` (${seo}/100)` : ""}${criticalSeo ? `, критичных проблем: ${criticalSeo}` : ""}.`);
  sentences.push(`Готовность к генеративному поиску ${scoreWord(geo)}${geo !== null ? ` (${geo}/100)` : ""}.`);

  const organizationGap = profile.gaps.find((gap) => gap.key === "schema_missing:organization");
  if (organizationGap) {
    sentences.push("Причина, по которой ИИ-движкам нечего сказать о компании: на сайте нет структурированных данных об организации.");
  }

  const questions = profile.questions;
  if (questions.unansweredQuestions > 0) {
    sentences.push(`Вопросов аудитории без прямого ответа на сайте: ${questions.unansweredQuestions}; страниц с FAQPage-разметкой: ${questions.faqSchemaPages}.`);
  } else if (questions.pagesWithQuestions === 0) {
    sentences.push("Страниц, отвечающих на вопросы аудитории, не найдено — блокам быстрых ответов нечего цитировать.");
  }

  const strong = profile.topics.filter((topic) => topic.coverage === "strong").length;
  sentences.push(profile.topics.length
    ? `Устойчивых тем: ${profile.topics.length}, глубоко раскрыто: ${strong}.`
    : "Устойчивых тем между страницами не найдено.");

  const p0 = recommendations.filter((item) => item.priority === "P0").length;
  sentences.push(`Рекомендаций: ${recommendations.length}${p0 ? `, из них первоочередных: ${p0}` : ""}.`);
  sentences.push("Позиции в поиске, трафик и реальные упоминания в ответах ИИ не измерялись: для этого нужны интеграции Вебмастера и Search Console и зонд видимости.");
  return sentences.join(" ");
}

export function buildInitialAuditReport({ site, profile, analysis = {}, generatedAt = null } = {}) {
  if (!site?.confirmedDomain) throw new TypeError("site_report_site_required");
  if (!profile || profile.profileVersion !== "site-profile-v1") throw new TypeError("site_report_profile_required");
  const recommendations = buildRecommendations(profile);
  const payload = Object.freeze({
    reportVersion: SITE_REPORT_VERSION,
    kind: "initial_audit",
    generatedAt: new Date(generatedAt || Date.now()).toISOString(),
    site: Object.freeze({
      domain: site.confirmedDomain,
      canonicalUrl: site.canonicalUrl || null,
      verified: site.verificationState === "verified",
    }),
    period: null,
    analysis: Object.freeze({
      analysisId: analysis.analysisId ?? null,
      runRevision: analysis.runRevision ?? null,
      snapshotHash: analysis.snapshotHash ?? null,
      profileVersion: profile.profileVersion,
      checkedAt: profile.checkedAt,
    }),
    seo: Object.freeze({
      score: profile.technical.seoScore,
      status: profile.technical.seoStatus,
      pagesChecked: profile.technical.pagesChecked,
      failedPages: profile.technical.failedPages,
      issues: profile.technical.seoIssues,
      notChecked: profile.technical.notChecked,
      orphanCandidates: profile.technical.orphanCandidates,
      requiredIntegrations: SITE_REPORT_SEO_INTEGRATIONS,
    }),
    geo: Object.freeze({
      score: profile.technical.geoScore,
      status: profile.technical.geoStatus,
      issues: profile.technical.geoIssues,
      probe: Object.freeze({ status: "not_run", reason: "visibility_probe_not_enabled" }),
    }),
    aeo: Object.freeze({
      pagesWithQuestions: profile.questions.pagesWithQuestions,
      answerPages: profile.questions.answeredPages,
      faqSchemaPages: profile.questions.faqSchemaPages,
      questionsWithoutAnswer: profile.questions.unansweredQuestions,
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
      }),
      gaps: profile.gaps,
      linkablePages: profile.linkablePages.length,
    }),
    recommendations: Object.freeze(recommendations),
    limitations: Object.freeze([
      "Позиции в поиске и трафик не измерялись: интеграции Яндекс.Вебмастер и Google Search Console не подключены.",
      "Упоминания бренда в ответах генеративных движков не проверялись: зонд видимости не запускался.",
      "Оценки относятся только к проверенному публичному срезу страниц; закрытые разделы и динамический контент не учитывались.",
    ]),
  });
  const summaryRu = buildInitialAuditSummary({ site, profile, recommendations });
  return Object.freeze({ payload, summaryRu });
}

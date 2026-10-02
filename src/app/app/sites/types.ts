// Типы раздела «Мои сайты». Держим их в одном месте: страница и панели должны
// говорить об одних и тех же данных, иначе DTO молча расходится с интерфейсом.

export type VerificationState = "unverified" | "verified" | "revoked";

export type SiteSummary = {
  id: number;
  confirmedDomain: string;
  canonicalUrl: string;
  verification: {
    state: VerificationState;
    method: "dns_txt" | "meta_tag" | null;
    verifiedAt: string | null;
    token: string;
    instructions: {
      dns: { recordName: string; recordType: string; recordValue: string };
      meta: { name: string; content: string; tag: string };
    };
  };
  publishingMode: "confirm" | "auto";
  approvedStreak: number;
  autoUnlockStreak: number;
  autoModeUnlocked: boolean;
  hostedSlug: string | null;
  hostedOrigin: string | null;
  brandName: string | null;
  latestProfileId: number | null;
  status: "active" | "paused" | "disconnected";
  createdAt: string | null;
};

export type SiteTab = "overview" | "audit" | "materials" | "publishing" | "reports";

export type SiteListItem = SiteSummary & {
  latestAnalysis: { status: string; progress: number } | null;
  profile: { summary: string | null; pageCount: number; gapCount: number } | null;
  reportCount: number;
};

export type AnalysisView = {
  id: number;
  status: string;
  stage: string;
  progress: number;
  detail: string | null;
  runRevision: number;
  maxPages?: number | null;
  error: { code: string; message: string; retryable: boolean } | null;
  completedAt: string | null;
};

export type Topic = { key: string; label: string; pageCount: number; coverage: "strong" | "thin" };
export type Gap = { key: string; kind: string; severity: "high" | "medium" | "low"; label: string; detail: string; evidenceUrls: string[] };
export type Issue = {
  id: string;
  label: string;
  status: "critical" | "warning";
  detail: string;
  recommendation: string;
  evidenceUrls?: string[];
};

export type ProfileView = {
  id: number;
  pageCount: number;
  publicationCount: number;
  topics: Topic[];
  gaps: Gap[];
  technical: {
    seoScore: number | null;
    geoScore: number | null;
    seoIssues: Issue[];
    geoIssues: Issue[];
    pagesChecked: number;
    failedPages?: number;
    clientRenderedPages?: number;
    questions?: { unansweredQuestions: number; faqSchemaPages: number };
  };
  linkablePages: Array<{ url: string; title: string; pageType: string }>;
  summary: string | null;
  refinedAt: string | null;
  aiClassification: { status: string; engine: string | null; pageTypeOverrides: number; topicClusters: number } | null;
  createdAt: string | null;
};

export type Interpretation = {
  summary: string;
  whatItMeans: string[];
  startWith: Array<{ key: string; title: string; priority: string | null; why: string }>;
  watchOut: string[];
  disclaimer: string;
  engine: string | null;
};

export type ReportRecommendation = {
  key: string;
  title: string;
  rationale: string;
  priority: string;
  source: string;
  status: "open" | "done";
  evidenceUrls: string[];
};

export type ReportView = {
  id: number;
  kind: "initial_audit" | "monthly" | "on_demand";
  status: string;
  summaryRu: string;
  interpretation: Interpretation | null;
  interpretationStatus: "pending" | "ready" | "skipped" | "failed";
  createdAt: string | null;
  period?: { start: string | null; end: string | null } | null;
  scores?: { seo: number | null; geo: number | null } | null;
  metrics?: {
    pageCount: number | null;
    gaps: number | null;
    published: number | null;
    pendingReview: number | null;
    openRecommendations: number;
    doneRecommendations: number;
  } | null;
  recommendations?: ReportRecommendation[];
  limitations?: string[];
};

export type ArticleStats = { total: number; pending: number; published: number };

export type SiteDetails = {
  site: SiteSummary;
  latestAnalysis: AnalysisView | null;
  profile: ProfileView | null;
  reports: ReportView[];
  articleStats?: ArticleStats | null;
};

export const REPORT_KIND_LABEL: Record<ReportView["kind"], string> = {
  initial_audit: "Стартовый аудит",
  monthly: "Ежемесячный отчёт",
  on_demand: "Повторный аудит",
};

export const SEVERITY_TONE = { high: "danger", medium: "fire", low: "neutral" } as const;
export const SEVERITY_LABEL = { high: "Критично", medium: "Важно", low: "Желательно" } as const;
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "crawling", "analyzing", "planning", "saving"]);

/** Русская форма слова по числу: 1 пробел, 2 пробела, 5 пробелов. */
export function plural(count: number, one: string, few: string, many: string) {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function siteCountLabel(count: number) {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} сайтов`;
  if (last === 1) return `${count} сайт`;
  if (last >= 2 && last <= 4) return `${count} сайта`;
  return `${count} сайтов`;
}

export function analysisLabel(status: string | null | undefined) {
  switch (status) {
    case "queued": return "В очереди";
    case "crawling": return "Читаем страницы";
    case "analyzing": return "Анализируем";
    case "planning": return "Собираем выводы";
    case "saving": return "Сохраняем";
    case "ready": return "Готово";
    case "failed": return "Ошибка";
    default: return "Не запускался";
  }
}

export function verificationReason(reason: string | undefined) {
  switch (reason) {
    case "dns_txt_missing": return "TXT-запись пока не найдена. DNS-изменения могут применяться до нескольких часов.";
    case "dns_txt_mismatch": return "TXT-запись найдена, но значение не совпадает с токеном.";
    case "dns_txt_unavailable": return "DNS не ответил. Попробуй ещё раз через минуту.";
    case "meta_tag_mismatch": return "Главная страница открылась, но подтверждающего meta-тега на ней нет.";
    case "meta_tag_unavailable": return "Не удалось загрузить главную страницу сайта для проверки meta-тега.";
    default: return "Подтверждение пока не найдено ни одним способом.";
  }
}

/** Заголовок страницы по адресу: chip-переключатель сайтов показывает домен, а не URL. */
export function displayUrl(value: string | null | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return String(value);
  }
}

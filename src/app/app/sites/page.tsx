"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileSearch,
  Globe2,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, Checkbox, EmptyState, Field, Input, Tabs } from "@/components/ui/primitives";
import { siteAnalysisErrorMessage, type SiteAnalysisStatus } from "@/lib/site-analysis-contract";
import { createSiteAnalysisUuid } from "@/lib/site-analysis-client-key";
import { cn } from "@/lib/utils";

import { ArticlesPanel } from "./articles-panel";
import { errorMessage, formatDate, requestJson } from "./client";
import { DestinationsPanel } from "./destinations-panel";
import { ProbePanel } from "./probe-panel";

type VerificationState = "unverified" | "verified" | "revoked";

type SiteSummary = {
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

type SiteTab = "profile" | "articles" | "publishing" | "visibility" | "reports";

type SiteListItem = SiteSummary & {
  latestAnalysis: { status: string; progress: number } | null;
  profile: { summary: string | null; pageCount: number; gapCount: number } | null;
  reportCount: number;
};

type AnalysisView = {
  id: number;
  status: SiteAnalysisStatus;
  stage: string;
  progress: number;
  detail: string | null;
  runRevision: number;
  error: { code: string; message: string; retryable: boolean } | null;
  completedAt: string | null;
};

type Topic = { key: string; label: string; pageCount: number; coverage: "strong" | "thin" };
type Gap = { key: string; kind: string; severity: "high" | "medium" | "low"; label: string; detail: string; evidenceUrls: string[] };
type Issue = { id: string; label: string; status: "critical" | "warning"; detail: string; recommendation: string };

type ProfileView = {
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
    questions?: { unansweredQuestions: number; faqSchemaPages: number };
  };
  linkablePages: Array<{ url: string; title: string; pageType: string }>;
  summary: string | null;
  refinedAt: string | null;
  aiClassification: { status: string; engine: string | null; pageTypeOverrides: number; topicClusters: number } | null;
  createdAt: string | null;
};

type Interpretation = {
  summary: string;
  whatItMeans: string[];
  startWith: Array<{ key: string; title: string; priority: string | null; why: string }>;
  watchOut: string[];
  disclaimer: string;
  engine: string | null;
};

type ReportView = {
  id: number;
  kind: "initial_audit" | "monthly" | "on_demand";
  status: string;
  summaryRu: string;
  interpretation: Interpretation | null;
  interpretationStatus: "pending" | "ready" | "skipped" | "failed";
  createdAt: string | null;
};

type SiteDetails = {
  site: SiteSummary;
  latestAnalysis: AnalysisView | null;
  profile: ProfileView | null;
  reports: ReportView[];
};

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "crawling", "analyzing", "planning", "saving"]);
const REPORT_FORMATS = [
  ["pdf", "PDF"],
  ["markdown", "Markdown"],
  ["html", "HTML"],
  ["json", "JSON"],
] as const;
const REPORT_KIND_LABEL: Record<ReportView["kind"], string> = {
  initial_audit: "Стартовый аудит",
  monthly: "Ежемесячный отчёт",
  on_demand: "Повторный аудит",
};
const SEVERITY_TONE = { high: "danger", medium: "fire", low: "neutral" } as const;
const SEVERITY_LABEL = { high: "Критично", medium: "Важно", low: "Желательно" } as const;

function analysisLabel(status: string | null | undefined) {
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

function verificationReason(reason: string | undefined) {
  switch (reason) {
    case "dns_txt_missing": return "TXT-запись пока не найдена. DNS-изменения могут применяться до нескольких часов.";
    case "dns_txt_mismatch": return "TXT-запись найдена, но значение не совпадает с токеном.";
    case "dns_txt_unavailable": return "DNS не ответил. Попробуй ещё раз через минуту.";
    case "meta_tag_mismatch": return "Главная страница открылась, но подтверждающего meta-тега на ней нет.";
    case "meta_tag_unavailable": return "Не удалось загрузить главную страницу сайта для проверки meta-тега.";
    default: return "Подтверждение пока не найдено ни одним способом.";
  }
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-sm bg-surface-inset px-2.5 py-1.5 text-[12px] text-text">{value}</code>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        }}
        aria-label={`Скопировать ${label}`}
      >
        {copied ? "Скопировано" : "Копировать"}
      </Button>
    </div>
  );
}

function InterpretationBlock({ interpretation, status, compact = false }: { interpretation: Interpretation | null; status: ReportView["interpretationStatus"]; compact?: boolean }) {
  if (!interpretation) {
    if (status === "pending") return <p className="type-caption mt-3 text-text-3">Интерпретация Авроры готовится…</p>;
    if (status === "failed") return <p className="type-caption mt-3 text-text-3">Интерпретация не удалась — цифры и рекомендации выше остаются в силе.</p>;
    return null;
  }
  return (
    <section className={cn("rounded-sm border border-brand/20 bg-info-soft/40 p-4", compact ? "mt-3" : "mt-5")} aria-label="Интерпретация Авроры">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">Интерпретация Авроры</Badge>
        {interpretation.engine && <span className="type-caption text-text-3">{interpretation.engine}</span>}
      </div>
      <p className="type-secondary mt-2 text-text">{interpretation.summary}</p>
      {interpretation.whatItMeans.length > 0 && (
        <ul className="mt-3 space-y-1">
          {interpretation.whatItMeans.map((item, index) => <li key={index} className="type-caption text-text-2">• {item}</li>)}
        </ul>
      )}
      {interpretation.startWith.length > 0 && (
        <div className="mt-3">
          <p className="type-label text-text">С чего начать</p>
          <ol className="mt-1 space-y-1.5">
            {interpretation.startWith.map((item, index) => (
              <li key={item.key} className="type-caption text-text-2">
                <span className="font-semibold text-text">{index + 1}. {item.title || item.key}</span>
                {item.priority && <Badge tone={item.priority === "P0" ? "danger" : item.priority === "P1" ? "fire" : "neutral"} className="ml-2">{item.priority}</Badge>}
                <span className="block text-text-3">{item.why}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {interpretation.watchOut.length > 0 && (
        <p className="type-caption mt-3 text-text-3">Ограничения: {interpretation.watchOut.join(" ")}</p>
      )}
      <p className="type-caption mt-2 text-text-3">{interpretation.disclaimer}</p>
    </section>
  );
}

function Score({ label, value }: { label: string; value: number | null }) {
  const tone = value === null ? "neutral" : value >= 85 ? "success" : value >= 60 ? "fire" : "danger";
  return (
    <div className="rounded-sm border border-line bg-surface-2 p-4">
      <p className="type-caption text-text-3">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[28px] font-semibold leading-none text-text">{value === null ? "—" : value}</span>
        <span className="type-caption text-text-3">/100</span>
        <Badge tone={tone} className="ml-auto">
          {value === null ? "не измерено" : value >= 85 ? "сильно" : value >= 60 ? "средне" : "слабо"}
        </Badge>
      </div>
    </div>
  );
}

export default function SitesPage() {
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [details, setDetails] = useState<SiteDetails | null>(null);

  const [url, setUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const connectKey = useRef(createSiteAnalysisUuid());

  const [verifying, setVerifying] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<SiteTab>("profile");
  const [destinationCount, setDestinationCount] = useState(0);
  const [reportRequested, setReportRequested] = useState(false);

  const loadSites = useCallback(async () => {
    try {
      const { status, body } = await requestJson<{ sites?: SiteListItem[]; error?: string }>("/api/sites");
      if (status !== 200 || !body.sites) throw Object.assign(new Error("list_failed"), { code: body.error });
      setListError(null);
      setSites(body.sites);
      return body.sites;
    } catch (error) {
      setListError(errorMessage((error as { code?: string }).code, "Не удалось загрузить список сайтов."));
      return [];
    }
  }, []);

  // Состояние обновляется только после ответа сервера — синхронных setState в эффектах нет.
  const loadDetails = useCallback(async (id: number) => {
    try {
      const { status, body } = await requestJson<SiteDetails & { error?: string }>(`/api/sites/${id}`);
      if (status !== 200 || !body.site) throw Object.assign(new Error("details_failed"), { code: body.error });
      setDetails({ site: body.site, latestAnalysis: body.latestAnalysis, profile: body.profile, reports: body.reports });
      void requestJson<{ destinations?: Array<{ status: string; readyToPublish: boolean }> }>(`/api/sites/${id}/destinations`).then((result) => {
        setDestinationCount((result.body.destinations || []).filter((item) => item.status === "active" && item.readyToPublish).length);
      });
      return body;
    } catch (error) {
      setActionError(errorMessage((error as { code?: string }).code, "Не удалось загрузить сайт."));
      return null;
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- state changes only after the request settles
  useEffect(() => { void loadSites(); }, [loadSites]);

  const activeId = selectedId ?? sites[0]?.id ?? null;
  const current = details && details.site.id === activeId ? details : null;
  const detailsLoading = activeId !== null && current === null;

  useEffect(() => {
    if (activeId === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadDetails updates state only after the request settles
    void loadDetails(activeId);
  }, [activeId, loadDetails]);

  const selectSite = useCallback((id: number) => {
    setVerifyMessage(null);
    setActionError(null);
    setTab("profile");
    setSelectedId(id);
  }, []);

  const refreshCurrent = useCallback(() => {
    if (activeId !== null) void loadDetails(activeId);
    void loadSites();
  }, [activeId, loadDetails, loadSites]);

  const requestReport = useCallback(async () => {
    if (activeId === null) return;
    setReportRequested(true);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${activeId}/reports`, { method: "POST", body: JSON.stringify({}) });
    if (status >= 400) {
      setActionError(errorMessage(body.error, "Не удалось запросить отчёт."));
      setReportRequested(false);
      return;
    }
    setTimeout(() => { void loadDetails(activeId); setReportRequested(false); }, 6000);
  }, [activeId, loadDetails]);

  const analysisActive = Boolean(current?.latestAnalysis && ACTIVE_STATUSES.has(current.latestAnalysis.status));
  useEffect(() => {
    if (!analysisActive || activeId === null) return;
    const timer = setInterval(() => {
      void loadDetails(activeId).then((loaded) => {
        if (loaded?.latestAnalysis && !ACTIVE_STATUSES.has(loaded.latestAnalysis.status)) void loadSites();
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [analysisActive, activeId, loadDetails, loadSites]);

  const submitConnect = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!consent) {
      setFormError("Подтверди, что у тебя есть право анализировать этот сайт.");
      return;
    }
    setSubmitting(true);
    const { status, body } = await requestJson<SiteDetails & { error?: string; analysisError?: string | null }>("/api/sites", {
      method: "POST",
      headers: { "idempotency-key": connectKey.current },
      body: JSON.stringify({ url: url.trim(), consent: true }),
    });
    setSubmitting(false);
    if (status !== 200 && status !== 201) {
      setFormError(errorMessage(body.error, "Не удалось подключить сайт."));
      return;
    }
    connectKey.current = createSiteAnalysisUuid();
    setUrl("");
    setConsent(false);
    await loadSites();
    setSelectedId(body.site.id);
    setDetails({ site: body.site, latestAnalysis: body.latestAnalysis, profile: body.profile, reports: body.reports });
    if (body.analysisError) setActionError(errorMessage(body.analysisError, "Сайт подключён, но анализ не запустился."));
  }, [consent, url, loadSites]);

  const verify = useCallback(async () => {
    if (!details) return;
    setVerifying(true);
    setVerifyMessage(null);
    const { status, body } = await requestJson<{ verified?: boolean; reason?: string; site?: SiteSummary; error?: string }>(
      `/api/sites/${details.site.id}/verify`,
      { method: "POST", body: JSON.stringify({ method: "auto" }) },
    );
    setVerifying(false);
    if (status !== 200) {
      setVerifyMessage({ tone: "danger", text: errorMessage(body.error, "Проверка не выполнена.") });
      return;
    }
    if (body.verified && body.site) {
      setVerifyMessage({ tone: "success", text: "Домен подтверждён." });
      setDetails((current) => (current ? { ...current, site: body.site as SiteSummary } : current));
      void loadSites();
    } else {
      setVerifyMessage({ tone: "danger", text: verificationReason(body.reason) });
    }
  }, [details, loadSites]);

  const reanalyze = useCallback(async () => {
    if (!details) return;
    setReanalyzing(true);
    setActionError(null);
    const { status, body } = await requestJson<{ analysis?: AnalysisView; error?: string }>(
      `/api/sites/${details.site.id}/analyze`,
      { method: "POST", headers: { "idempotency-key": createSiteAnalysisUuid() }, body: JSON.stringify({}) },
    );
    setReanalyzing(false);
    if ((status !== 202 && status !== 200) || !body.analysis) {
      setActionError(errorMessage(body.error, "Не удалось запустить анализ."));
      return;
    }
    setDetails((current) => (current ? { ...current, latestAnalysis: body.analysis as AnalysisView } : current));
  }, [details]);

  const selected = current?.site ?? null;
  const profile = current?.profile ?? null;
  const analysis = current?.latestAnalysis ?? null;
  const highGaps = useMemo(() => profile?.gaps.filter((gap) => gap.severity === "high") ?? [], [profile]);

  return (
    <AppShell
      title="Мои сайты"
      subtitle="Подключи сайт, подтверди домен и получи стартовый аудит: что уже есть на сайте, какие темы не закрыты и что мешает поиску и ИИ-движкам вас находить."
    >
      <div className="grid items-start gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
                <Globe2 className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <h2 className="type-h3 text-text">Подключить сайт</h2>
                <p className="type-secondary mt-1 text-text-2">Аврора прочитает публичные страницы и соберёт профиль сайта.</p>
              </div>
            </div>
            <form className="mt-5 space-y-4" onSubmit={submitConnect}>
              <Field label="Адрес сайта" htmlFor="site-url" required error={formError ?? undefined} messageId="site-url-message">
                <Input
                  id="site-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.ru"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  required
                  aria-describedby="site-url-message"
                />
              </Field>
              <Checkbox
                checked={consent}
                onChange={setConsent}
                label="У меня есть право анализировать этот сайт и публиковать на нём материалы"
              />
              <Button type="submit" disabled={submitting || !url.trim()} className="w-full">
                {submitting ? "Подключаем…" : "Подключить и запустить аудит"}
              </Button>
            </form>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <h2 className="type-body-strong text-text">Сайты проекта</h2>
            </div>
            {listError ? (
              <p role="alert" className="type-secondary p-5 text-danger-text">{listError}</p>
            ) : sites.length === 0 ? (
              <EmptyState icon={<FileSearch className="h-5 w-5" aria-hidden />} title="Сайтов пока нет" body="Подключи первый сайт — аудит займёт несколько минут." />
            ) : (
              <ul className="divide-y divide-line">
                {sites.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => selectSite(item.id)}
                      aria-current={item.id === activeId ? "true" : undefined}
                      className={cn(
                        "flex w-full flex-col gap-1.5 px-5 py-4 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
                        item.id === activeId && "bg-info-soft/60",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="type-body-strong truncate text-text">{item.confirmedDomain}</span>
                        {item.verification.state === "verified" ? (
                          <Badge tone="success"><ShieldCheck className="h-3 w-3" aria-hidden />домен подтверждён</Badge>
                        ) : (
                          <Badge tone="neutral">не подтверждён</Badge>
                        )}
                      </span>
                      <span className="type-caption text-text-3">
                        {item.latestAnalysis ? analysisLabel(item.latestAnalysis.status) : "Анализ не запускался"}
                        {item.profile ? ` · ${item.profile.pageCount} стр. · пробелов: ${item.profile.gapCount}` : ""}
                        {item.reportCount ? ` · отчётов: ${item.reportCount}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          {!selected ? (
            <Card>
              <EmptyState
                icon={<Globe2 className="h-5 w-5" aria-hidden />}
                title="Выбери сайт или подключи новый"
                body="Справа появятся подтверждение домена, профиль сайта и отчёты для скачивания."
              />
            </Card>
          ) : (
            <>
              {actionError && <p role="alert" className="type-secondary rounded-sm bg-danger-soft p-4 text-danger-text">{actionError}</p>}

              <Card className="p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="type-h3 truncate text-text">{selected.confirmedDomain}</h2>
                    <a href={selected.canonicalUrl} target="_blank" rel="noopener noreferrer" className="type-caption mt-1 inline-flex items-center gap-1 text-brand">
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden />{selected.canonicalUrl}
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">режим: {selected.publishingMode === "confirm" ? "с подтверждением" : "автомат"}</Badge>
                    <Button type="button" size="sm" variant="secondary" onClick={reanalyze} disabled={reanalyzing || analysisActive}>
                      <RefreshCw className={cn("h-4 w-4", (reanalyzing || analysisActive) && "animate-spin")} aria-hidden />
                      Обновить аудит
                    </Button>
                  </div>
                </div>

                <div className="mt-5 grid gap-4 md:grid-cols-2">
                  <section className="rounded-sm border border-line bg-surface-2 p-4" aria-labelledby="analysis-state">
                    <h3 id="analysis-state" className="type-label text-text-2">Анализ</h3>
                    <div className="mt-2 flex items-center gap-2">
                      {analysis?.status === "ready" ? <CheckCircle2 className="h-4 w-4 text-success-text" aria-hidden />
                        : analysis?.status === "failed" ? <XCircle className="h-4 w-4 text-danger-text" aria-hidden />
                          : <Clock3 className="h-4 w-4 text-text-3" aria-hidden />}
                      <span className="type-body-strong text-text">{analysisLabel(analysis?.status)}</span>
                      {analysis && ACTIVE_STATUSES.has(analysis.status) && <span className="type-caption text-text-3">{analysis.progress}%</span>}
                    </div>
                    {analysis && ACTIVE_STATUSES.has(analysis.status) && (
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-inset" role="progressbar" aria-valuenow={analysis.progress} aria-valuemin={0} aria-valuemax={100}>
                        <div className="h-full bg-brand transition-[width]" style={{ width: `${analysis.progress}%` }} />
                      </div>
                    )}
                    {analysis?.detail && ACTIVE_STATUSES.has(analysis.status) && <p className="type-caption mt-2 text-text-3">{analysis.detail}</p>}
                    {analysis?.status === "failed" && analysis.error && (
                      <p className="type-caption mt-2 text-danger-text">{siteAnalysisErrorMessage(analysis.error.code)}</p>
                    )}
                    {analysis?.status === "ready" && <p className="type-caption mt-2 text-text-3">Завершён {formatDate(analysis.completedAt)}, ревизия {analysis.runRevision}.</p>}
                  </section>

                  <section className="rounded-sm border border-line bg-surface-2 p-4" aria-labelledby="verification-state">
                    <h3 id="verification-state" className="type-label text-text-2">Владение доменом</h3>
                    {selected.verification.state === "verified" ? (
                      <div className="mt-2 flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-success-text" aria-hidden />
                        <span className="type-body-strong text-text">Подтверждено</span>
                        <span className="type-caption text-text-3">
                          {selected.verification.method === "dns_txt" ? "по DNS" : "по meta-тегу"} · {formatDate(selected.verification.verifiedAt)}
                        </span>
                      </div>
                    ) : (
                      <>
                        <p className="type-secondary mt-2 text-text-2">
                          Публикация на сайт откроется после подтверждения. Добавь один из вариантов и нажми «Проверить».
                        </p>
                        <details className="mt-3">
                          <summary className="type-caption cursor-pointer text-brand">Вариант 1 · TXT-запись в DNS</summary>
                          <div className="mt-2 space-y-2">
                            <p className="type-caption text-text-3">Имя записи</p>
                            <CopyValue value={selected.verification.instructions.dns.recordName} label="имя записи" />
                            <p className="type-caption text-text-3">Значение</p>
                            <CopyValue value={selected.verification.instructions.dns.recordValue} label="значение записи" />
                          </div>
                        </details>
                        <details className="mt-2">
                          <summary className="type-caption cursor-pointer text-brand">Вариант 2 · meta-тег на главной</summary>
                          <div className="mt-2">
                            <CopyValue value={selected.verification.instructions.meta.tag} label="meta-тег" />
                          </div>
                        </details>
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <Button type="button" size="sm" onClick={verify} disabled={verifying}>
                            {verifying ? "Проверяем…" : "Проверить"}
                          </Button>
                          {verifyMessage && (
                            <span role="status" className={cn("type-caption", verifyMessage.tone === "success" ? "text-success-text" : "text-danger-text")}>
                              {verifyMessage.text}
                            </span>
                          )}
                        </div>
                      </>
                    )}
                  </section>
                </div>
              </Card>

              <Tabs<SiteTab>
                value={tab}
                onChange={setTab}
                ariaLabel="Разделы сайта"
                items={[
                  { value: "profile", label: "Профиль" },
                  { value: "articles", label: "Материалы" },
                  { value: "publishing", label: "Публикация" },
                  { value: "visibility", label: "Видимость в ИИ" },
                  { value: "reports", label: "Отчёты" },
                ]}
              />

              {tab === "articles" && (
                <ArticlesPanel
                  siteId={selected.id}
                  verified={selected.verification.state === "verified"}
                  hasDestinations={destinationCount > 0}
                  hasProfile={Boolean(profile)}
                  onSiteChanged={refreshCurrent}
                />
              )}
              {tab === "publishing" && (
                <DestinationsPanel
                  siteId={selected.id}
                  verified={selected.verification.state === "verified"}
                  publishingMode={selected.publishingMode}
                  approvedStreak={selected.approvedStreak}
                  autoUnlockStreak={selected.autoUnlockStreak}
                  hostedOrigin={selected.hostedOrigin}
                  brandName={selected.brandName}
                  onChanged={refreshCurrent}
                />
              )}
              {tab === "visibility" && (
                <ProbePanel siteId={selected.id} verified={selected.verification.state === "verified"} hasProfile={Boolean(profile)} />
              )}

              {tab === "profile" && (detailsLoading ? (
                <Card className="p-6"><p className="type-secondary text-text-2">Загружаем профиль…</p></Card>
              ) : profile ? (
                <Card className="p-5 sm:p-6">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="type-h3 text-text">Профиль сайта</h3>
                    {profile.aiClassification?.status === "ready" && (
                      <Badge tone="brand">уточнён моделью{profile.aiClassification.topicClusters ? ` · тем объединено: ${profile.aiClassification.topicClusters}` : ""}</Badge>
                    )}
                    {profile.refinedAt === null && <Badge tone="neutral">уточнение моделью в очереди</Badge>}
                  </div>
                  <p className="type-secondary mt-2 text-text-2">{profile.summary}</p>
                  {current?.reports[0] && <InterpretationBlock interpretation={current.reports[0].interpretation} status={current.reports[0].interpretationStatus} />}
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <Score label="On-page SEO" value={profile.technical.seoScore} />
                    <Score label="Готовность к генеративному поиску (GEO)" value={profile.technical.geoScore} />
                  </div>
                  <dl className="mt-5 grid gap-3 sm:grid-cols-4">
                    <div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Страниц проверено</dt><dd className="type-body-strong text-text">{profile.technical.pagesChecked}</dd></div>
                    <div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Публикаций</dt><dd className="type-body-strong text-text">{profile.publicationCount}</dd></div>
                    <div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Вопросов без ответа</dt><dd className="type-body-strong text-text">{profile.technical.questions?.unansweredQuestions ?? 0}</dd></div>
                    <div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Страниц для перелинковки</dt><dd className="type-body-strong text-text">{profile.linkablePages.length}</dd></div>
                  </dl>

                  <section className="mt-6" aria-labelledby="topics-title">
                    <h4 id="topics-title" className="type-body-strong text-text">Темы сайта</h4>
                    {profile.topics.length ? (
                      <ul className="mt-3 flex flex-wrap gap-2">
                        {profile.topics.map((topic) => (
                          <li key={topic.key}>
                            <Badge tone={topic.coverage === "strong" ? "success" : "neutral"}>
                              {topic.label} · {topic.pageCount}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="type-secondary mt-2 text-text-2">Устойчивых тем между страницами не найдено.</p>
                    )}
                  </section>

                  <section className="mt-6" aria-labelledby="gaps-title">
                    <h4 id="gaps-title" className="type-body-strong text-text">
                      Пробелы · {profile.gaps.length}{highGaps.length ? ` (критичных: ${highGaps.length})` : ""}
                    </h4>
                    {profile.gaps.length ? (
                      <ul className="mt-3 space-y-2">
                        {profile.gaps.map((gap) => (
                          <li key={gap.key} className="rounded-sm border border-line bg-surface-2 p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <AlertTriangle className={cn("h-4 w-4", gap.severity === "high" ? "text-danger-text" : "text-fire-text")} aria-hidden />
                              <p className="type-label text-text">{gap.label}</p>
                              <Badge tone={SEVERITY_TONE[gap.severity]}>{SEVERITY_LABEL[gap.severity]}</Badge>
                            </div>
                            <p className="type-caption mt-1 text-text-2">{gap.detail}</p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="type-secondary mt-2 rounded-sm bg-success-soft p-3 text-success-text">Пробелов не найдено.</p>
                    )}
                  </section>

                  {(profile.technical.seoIssues.length > 0 || profile.technical.geoIssues.length > 0) && (
                    <details className="mt-6 rounded-sm border border-line bg-surface-2 p-4">
                      <summary className="type-body-strong cursor-pointer text-text">
                        Технические замечания · {profile.technical.seoIssues.length + profile.technical.geoIssues.length}
                      </summary>
                      <ul className="mt-3 space-y-2">
                        {[...profile.technical.seoIssues, ...profile.technical.geoIssues].map((issue) => (
                          <li key={issue.id} className={cn("rounded-sm p-3", issue.status === "critical" ? "bg-danger-soft text-danger-text" : "bg-fire-soft text-fire-text")}>
                            <p className="type-label">{issue.label}</p>
                            <p className="type-caption mt-1 opacity-90">{issue.detail}</p>
                            <p className="type-caption mt-1 font-semibold">{issue.recommendation}</p>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </Card>
              ) : analysis && ACTIVE_STATUSES.has(analysis.status) ? (
                <Card className="p-6">
                  <p className="type-secondary text-text-2">Профиль появится, как только анализ завершится.</p>
                </Card>
              ) : null)}

              {tab === "reports" && <Card className="p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h3 className="type-h3 text-text">Отчёты</h3>
                  <Button type="button" size="sm" variant="secondary" onClick={requestReport} disabled={reportRequested || !profile}>
                    {reportRequested ? "Собираем…" : "Отчёт за 30 дней"}
                  </Button>
                </div>
                <p className="type-caption mt-1 text-text-3">Ежемесячный отчёт с динамикой собирается автоматически 1-го числа; Markdown-версия попадает в базу знаний сайта.</p>
                {current?.reports.length ? (
                  <ul className="mt-4 space-y-3">
                    {current.reports.map((report) => (
                      <li key={report.id} className="rounded-sm border border-line bg-surface-2 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="type-body-strong text-text">{REPORT_KIND_LABEL[report.kind]}</p>
                          <span className="type-caption text-text-3">{formatDate(report.createdAt)}</span>
                        </div>
                        <p className="type-secondary mt-2 text-text-2">{report.summaryRu}</p>
                        <InterpretationBlock interpretation={report.interpretation} status={report.interpretationStatus} compact />
                        <div className="mt-3 flex flex-wrap gap-2">
                          {REPORT_FORMATS.map(([format, label]) => (
                            <a
                              key={format}
                              href={`/api/sites/${selected.id}/reports/${report.id}/export?format=${format}`}
                              download
                              className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-line px-2.5 py-1.5 text-[12px] font-semibold text-brand hover:border-brand/35 hover:bg-info-soft"
                            >
                              <Download className="h-3.5 w-3.5" aria-hidden />{label}
                            </a>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="type-secondary mt-2 text-text-2">Первый отчёт появится после завершения стартового аудита.</p>
                )}
              </Card>}
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}

"use client";
import { useProjectCall } from "@/lib/use-project-transport";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Globe2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, Card, Checkbox, EmptyState, Field, Input, Tabs } from "@/components/ui/primitives";
import { siteAnalysisErrorMessage } from "@/lib/site-analysis-contract";
import { createSiteAnalysisUuid } from "@/lib/site-analysis-client-key";
import { cn } from "@/lib/utils";

import { ArticlesPanel } from "./articles-panel";
import { AuditPanel } from "./audit-panel";
import { errorMessage, formatDate, requestJson as unscopedRequestJson } from "./client";
import { DestinationsPanel } from "./destinations-panel";
import { OverviewPanel } from "./overview-panel";
import { ReportsPanel } from "./reports-panel";
import {
  ACTIVE_STATUSES,
  analysisLabel,
  verificationReason,
  type ArticleStats,
  type SiteDetails,
  type SiteListItem,
  type SiteTab,
} from "./types";

const SITE_TABS: Array<{ value: SiteTab; label: string }> = [
  { value: "overview", label: "Обзор" },
  { value: "audit", label: "Аудит и видимость" },
  { value: "materials", label: "Материалы" },
  { value: "publishing", label: "Публикация" },
  { value: "reports", label: "Отчёты" },
];

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="type-caption min-w-0 flex-1 break-all rounded-sm bg-surface-inset px-2.5 py-1.5 text-text">{value}</code>
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

export default function SitesPage() {
  const requestJson = useProjectCall(unscopedRequestJson);
  const [sites, setSites] = useState<SiteListItem[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [details, setDetails] = useState<SiteDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const connectKey = useRef(createSiteAnalysisUuid());

  const [verifying, setVerifying] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [maxPages, setMaxPages] = useState(20);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<SiteTab>("overview");
  const [destinationCount, setDestinationCount] = useState(0);
  const [destinationsLoaded, setDestinationsLoaded] = useState(false);
  const [reportRequested, setReportRequested] = useState(false);
  const [retryingAi, setRetryingAi] = useState<string | null>(null);
  const [articleStats, setArticleStats] = useState<ArticleStats | null>(null);
  // Заготовка материала из пробела: тема и тип приходят из аудита, форма открывается сразу.
  const [materialDraft, setMaterialDraft] = useState<{ token: number; brief: string; type: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editUrl, setEditUrl] = useState("");
  const [siteBusy, setSiteBusy] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const detailsRequest = useRef(0);
  const activeSiteId = useRef<number | null>(null);

  const loadSites = useCallback(async () => {
    try {
      const { status, body } = await requestJson<{ sites?: SiteListItem[]; error?: string }>("/api/sites");
      if (status !== 200 || !body.sites) throw Object.assign(new Error("list_failed"), { code: body.error });
      setListError(null);
      setSites(body.sites);
      setSelectedId((currentId) => currentId !== null && body.sites!.some((site) => site.id === currentId) ? currentId : null);
      if (body.sites.length === 0) setConnectOpen(true);
      return body.sites;
    } catch (error) {
      setListError(errorMessage((error as { code?: string }).code, "Не удалось загрузить список сайтов."));
      return [];
    } finally {
      setListLoaded(true);
    }
  }, [requestJson]);

  // Состояние обновляется только после ответа сервера — синхронных setState в эффектах нет.
  const loadDetails = useCallback(async (id: number) => {
    if (id !== activeSiteId.current) return null;
    const request = ++detailsRequest.current;
    setDetailsLoading(true);
    setDetailsError(null);
    try {
      const { status, body } = await requestJson<SiteDetails & { error?: string }>(`/api/sites/${id}`);
      if (request !== detailsRequest.current) return null;
      if (status !== 200 || !body.site) throw Object.assign(new Error("details_failed"), { code: body.error });
      setDetails({ site: body.site, latestAnalysis: body.latestAnalysis, profile: body.profile, reports: body.reports, audits: body.audits ?? [], competitors: body.competitors ?? [] });
      if (body.articleStats) setArticleStats(body.articleStats);
      void requestJson<{ destinations?: Array<{ status: string; readyToPublish: boolean }> }>(`/api/sites/${id}/destinations`)
        .then((result) => {
          if (request !== detailsRequest.current) return;
          setDestinationsLoaded(true);
          if (result.status === 200 && result.body.destinations) {
            setDestinationCount(result.body.destinations.filter((item) => item.status === "active" && item.readyToPublish).length);
          }
        })
        .catch(() => {
          // Сбой запроса назначений не должен оставлять экран в вечном «Проверяем…».
          if (request === detailsRequest.current) {
            setDestinationsLoaded(true);
            setDestinationCount(0);
          }
        });
      return body;
    } catch (error) {
      if (request === detailsRequest.current) {
        setDetailsError(errorMessage((error as { code?: string }).code, "Не удалось загрузить сайт."));
      }
      return null;
    } finally {
      if (request === detailsRequest.current) setDetailsLoading(false);
    }
  }, [requestJson]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- state changes only after the request settles
  useEffect(() => { void loadSites(); }, [loadSites]);

  const activeId = selectedId ?? sites[0]?.id ?? null;
  const current = details && details.site.id === activeId ? details : null;

  useEffect(() => {
    activeSiteId.current = activeId;
    if (activeId === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- request state is fenced by the active site and request sequence
    void loadDetails(activeId);
    return () => { activeSiteId.current = null; detailsRequest.current += 1; };
  }, [activeId, loadDetails]);

  const selectSite = useCallback((id: number) => {
    activeSiteId.current = id;
    detailsRequest.current += 1;
    setDestinationCount(0);
    setDestinationsLoaded(false);
    setArticleStats(null);
    setDetailsLoading(true);
    setDetailsError(null);
    setVerifyMessage(null);
    setActionError(null);
    setActionNotice(null);
    setMenuOpen(false);
    setEditOpen(false);
    setTab("overview");
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
  }, [activeId, loadDetails, requestJson]);

  const retryAi = useCallback(async (target: "profile" | "report", reportId?: number) => {
    if (activeId === null || retryingAi) return;
    setRetryingAi(target === "profile" ? "profile" : `report:${reportId}`);
    setActionError(null);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${activeId}/ai/retry`, {
      method: "POST", body: JSON.stringify({ target, reportId }),
    });
    setRetryingAi(null);
    if (status >= 400 && activeSiteId.current === activeId) setActionError(errorMessage(body.error, "Не удалось повторить задачу."));
    await loadDetails(activeId);
  }, [activeId, retryingAi, loadDetails, requestJson]);

  const aiActive = Boolean(current?.profile && !current.profile.refinedAt && current.profile.aiClassification?.status !== "failed")
    || Boolean(current?.reports.some((report) => report.interpretationStatus === "pending"));
  const analysisActive = Boolean(current?.latestAnalysis && ACTIVE_STATUSES.has(current.latestAnalysis.status));
  useEffect(() => {
    if ((!analysisActive && !aiActive) || activeId === null) return;
    const timer = setInterval(() => {
      void loadDetails(activeId).then((loaded) => {
        if (loaded?.latestAnalysis && !ACTIVE_STATUSES.has(loaded.latestAnalysis.status)) void loadSites();
      });
    }, analysisActive ? 2000 : 5000);
    return () => clearInterval(timer);
  }, [analysisActive, aiActive, activeId, loadDetails, loadSites]);

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
    setConnectOpen(false);
    await loadSites();
    setSelectedId(body.site.id);
    setDetails({ site: body.site, latestAnalysis: body.latestAnalysis, profile: body.profile, reports: body.reports, audits: body.audits ?? [], competitors: body.competitors ?? [], articleStats: body.articleStats });
    if (body.articleStats) setArticleStats(body.articleStats);
    if (body.analysisError) setActionError(errorMessage(body.analysisError, "Сайт подключён, но анализ не запустился."));
  }, [consent, requestJson, url, loadSites]);

  const verify = useCallback(async () => {
    if (!details) return;
    setVerifying(true);
    setVerifyMessage(null);
    const { status, body } = await requestJson<{ verified?: boolean; reason?: string; site?: SiteDetails["site"]; error?: string }>(
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
      setDetails((value) => (value ? { ...value, site: body.site as SiteDetails["site"] } : value));
      void loadSites();
    } else {
      setVerifyMessage({ tone: "danger", text: verificationReason(body.reason) });
    }
  }, [details, loadSites, requestJson]);

  const revokeVerification = useCallback(async () => {
    if (!details) return;
    setSiteBusy("revoke");
    setActionError(null);
    const { status, body } = await requestJson<{ site?: SiteDetails["site"]; error?: string }>(
      `/api/sites/${details.site.id}/verify`,
      { method: "POST", body: JSON.stringify({ method: "revoke" }) },
    );
    setSiteBusy(null);
    setMenuOpen(false);
    if (status >= 400) {
      setActionError(errorMessage(body.error, "Не удалось отозвать подтверждение."));
      return;
    }
    if (body.site) setDetails((value) => (value ? { ...value, site: body.site as SiteDetails["site"] } : value));
    setActionNotice("Подтверждение отозвано: публикация и зонд снова закрыты до новой проверки.");
    void loadSites();
  }, [details, loadSites, requestJson]);

  const patchSite = useCallback(async (payload: Record<string, unknown>, key: string) => {
    if (!details) return;
    setSiteBusy(key);
    setActionError(null);
    setActionNotice(null);
    const { status, body } = await requestJson<{ site?: SiteDetails["site"]; domainChanged?: boolean; error?: string }>(
      `/api/sites/${details.site.id}`,
      { method: "PATCH", body: JSON.stringify(payload) },
    );
    setSiteBusy(null);
    if (status >= 400) {
      setActionError(errorMessage(body.error, payload.url ? "Не удалось изменить адрес сайта." : "Не удалось изменить состояние сайта."));
      return false;
    }
    if (body.site) setDetails((value) => (value ? { ...value, site: body.site as SiteDetails["site"] } : value));
    if (body.domainChanged) {
      setActionNotice("Адрес изменён. Подтверждение владения сброшено — пройдите проверку заново.");
      setVerificationOpen(true);
    }
    setEditOpen(false);
    setMenuOpen(false);
    void loadSites();
    return true;
  }, [details, loadSites, requestJson]);

  const deleteCurrentSite = useCallback(async () => {
    if (!details) return;
    setSiteBusy("delete");
    setActionError(null);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${details.site.id}`, { method: "DELETE" });
    setSiteBusy(null);
    if (status >= 400) {
      setActionError(errorMessage(body.error, "Не удалось удалить сайт."));
      setDeleteOpen(false);
      return;
    }
    setDeleteOpen(false);
    setDetails(null);
    setSelectedId(null);
    setActionNotice("Сайт удалён. Прошлые прогоны аудита остались в истории проекта.");
    await loadSites();
  }, [details, loadSites, requestJson]);

  const reanalyze = useCallback(async () => {
    if (!details) return;
    setReanalyzing(true);
    setActionError(null);
    const { status, body } = await requestJson<{ analysis?: SiteDetails["latestAnalysis"]; error?: string }>(
      `/api/sites/${details.site.id}/analyze`,
      { method: "POST", headers: { "idempotency-key": createSiteAnalysisUuid() }, body: JSON.stringify({ maxPages }) },
    );
    setReanalyzing(false);
    if ((status !== 202 && status !== 200) || !body.analysis) {
      setActionError(errorMessage(body.error, "Не удалось запустить анализ."));
      return;
    }
    setDetails((value) => (value ? { ...value, latestAnalysis: body.analysis ?? null } : value));
    void loadSites();
  }, [details, loadSites, maxPages, requestJson]);

  const handleArticleStats = useCallback((stats: ArticleStats) => setArticleStats(stats), []);

  const [competitorBusy, setCompetitorBusy] = useState(false);

  const addCompetitor = useCallback(async (url: string) => {
    if (!details || url.length === 0) return false;
    setCompetitorBusy(true);
    setActionError(null);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${details.site.id}/competitors`, {
      method: "PUT",
      body: JSON.stringify({ url }),
    });
    setCompetitorBusy(false);
    if (status >= 400) {
      setActionError(errorMessage(body.error, "Не удалось добавить конкурента."));
      return false;
    }
    await loadDetails(details.site.id);
    return true;
  }, [details, requestJson, loadDetails]);

  const removeCompetitor = useCallback(async (id: number) => {
    if (!details) return;
    setCompetitorBusy(true);
    setActionError(null);
    const { status, body } = await requestJson<{ error?: string }>(`/api/sites/${details.site.id}/competitors?id=${id}`, { method: "DELETE" });
    setCompetitorBusy(false);
    if (status >= 400) {
      setActionError(errorMessage(body.error, "Не удалось убрать конкурента."));
      return;
    }
    await loadDetails(details.site.id);
  }, [details, requestJson, loadDetails]);

  const selected = current?.site ?? null;
  const profile = current?.profile ?? null;
  const analysis = current?.latestAnalysis ?? null;
  const showConnectForm = connectOpen || (listLoaded && !listError && sites.length === 0);
  const pendingArticles = articleStats?.pending ?? 0;

  const tabItems = SITE_TABS.map((item) => ({
    ...item,
    badge: item.value === "materials" ? pendingArticles : item.value === "reports" ? (current?.reports.length ?? 0) : undefined,
  }));

  const analysisTone = analysis?.status === "ready" ? "success" : analysis?.status === "failed" ? "danger" : "neutral";

  return (
    <AppShell
      title="Мои сайты"
      subtitle="Подключи сайт, подтверди домен и получи стартовый аудит: что уже есть на сайте, какие темы не закрыты и что мешает поиску и ИИ-движкам вас находить."
      action={(
        <Button
          type="button"
          size="sm"
          variant={showConnectForm ? "secondary" : "primary"}
          onClick={() => { setConnectOpen((open) => !open); setFormError(null); }}
          aria-expanded={showConnectForm}
          aria-controls="connect-site-form"
        >
          <Plus className={cn("h-4 w-4 transition-transform", showConnectForm && "rotate-45")} aria-hidden />
          {showConnectForm ? "Скрыть форму" : "Добавить сайт"}
        </Button>
      )}
    >
      <ConfirmDialog
        open={deleteOpen}
        title="Удалить сайт?"
        description={selected
          ? `Сайт ${selected.confirmedDomain}, его профиль, материалы, отчёты и зонды будут удалены. Прошлые прогоны аудита останутся в истории проекта.`
          : ""}
        confirmLabel="Удалить сайт"
        confirmVariant="danger"
        busy={siteBusy === "delete"}
        error={actionError ?? undefined}
        onConfirm={() => void deleteCurrentSite()}
        onCancel={() => setDeleteOpen(false)}
      />

      <div className="space-y-4">
        {showConnectForm && (
          <Card id="connect-site-form" className="p-5 sm:p-6" as="section">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
                <Globe2 className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <h2 className="type-body-strong text-text">Подключить сайт</h2>
                <p className="type-caption mt-1 text-text-3">
                  Аврора прочитает только публичные страницы (по умолчанию 20, лимит можно поднять до 50 в аудите). Первый аудит обычно занимает несколько минут.
                </p>
              </div>
            </div>
            <form className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end" onSubmit={submitConnect}>
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
              <Button type="submit" disabled={submitting || !url.trim()}>
                {submitting ? "Подключаем…" : "Подключить и запустить аудит"}
              </Button>
              <div className="md:col-span-2">
                <Checkbox
                  checked={consent}
                  onChange={setConsent}
                  label="У меня есть право анализировать этот сайт и публиковать на нём материалы"
                />
              </div>
            </form>
          </Card>
        )}

        {/* Переключатель сайтов вместо левой колонки: раньше под двумя строками пустовала треть экрана */}
        {sites.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Сайты проекта">
            {sites.map((item) => {
              const active = item.id === activeId;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => selectSite(item.id)}
                  className={cn(
                    "inline-flex min-h-11 items-center gap-2.5 rounded-full border px-4 py-2 transition-colors",
                    "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
                    active ? "border-brand/40 bg-info-soft text-text shadow-soft" : "border-line bg-surface text-text hover:border-line-strong",
                  )}
                >
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", item.verification.state === "verified" ? "bg-success" : item.status !== "active" ? "bg-text-3" : "bg-fire")} aria-hidden />
                  <span className="type-body-strong">{item.confirmedDomain}</span>
                  <span className="type-caption text-text-3">
                    {item.profile ? `${item.profile.pageCount} стр.` : analysisLabel(item.latestAnalysis?.status)}
                    {item.profile && item.profile.gapCount ? ` · пробелов ${item.profile.gapCount}` : ""}
                    {item.status !== "active" ? " · на паузе" : ""}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => { setConnectOpen(true); setFormError(null); }}
              className="type-secondary inline-flex min-h-11 items-center gap-2 rounded-full border border-dashed border-line px-4 py-2 text-text-2 transition-colors hover:border-brand/40 hover:text-brand"
            >
              <Plus className="h-4 w-4" aria-hidden />Подключить ещё сайт
            </button>
          </div>
        )}

        {!listLoaded ? (
          <Card className="p-5"><p role="status" className="type-secondary text-text-2">Загружаем сайты…</p></Card>
        ) : listError ? (
          <Card className="p-5">
            <p role="alert" className="type-secondary text-danger-text">{listError}</p>
            <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => void loadSites()}>
              <RefreshCw className="h-4 w-4" aria-hidden />Повторить
            </Button>
          </Card>
        ) : activeId === null ? (
          <Card>
            <EmptyState
              icon={<Globe2 className="h-5 w-5" aria-hidden />}
              title="Здесь появится ваш первый сайт"
              body="Укажите адрес — Аврора прочитает публичные страницы, покажет темы и пробелы, предложит материалы и отчёт."
            />
          </Card>
        ) : !selected ? (
          <Card className="p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <span className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-sm",
                detailsError ? "bg-danger-soft text-danger-text" : "bg-info-soft text-brand",
              )}>
                {detailsError ? <XCircle className="h-5 w-5" aria-hidden /> : <Globe2 className="h-5 w-5" aria-hidden />}
              </span>
              <div className="min-w-0">
                <h2 className="type-h3 text-text">Сайт</h2>
                {detailsError ? (
                  <>
                    <p role="alert" className="type-secondary mt-1 text-danger-text">{detailsError}</p>
                    <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => activeId !== null && void loadDetails(activeId)}>
                      <RefreshCw className="h-4 w-4" aria-hidden />Повторить загрузку
                    </Button>
                  </>
                ) : (
                  <p role="status" className="type-secondary mt-1 text-text-2">
                    {detailsLoading ? "Загружаем данные сайта…" : "Открываем сайт…"}
                  </p>
                )}
              </div>
            </div>
          </Card>
        ) : (
          <>
            {actionError && <p role="alert" className="type-secondary rounded-sm bg-danger-soft p-4 text-danger-text">{actionError}</p>}
            {actionNotice && <p role="status" className="type-secondary rounded-sm bg-info-soft p-4 text-info-text">{actionNotice}</p>}

            {/* Карточка сайта: домен, состояние и действия в одной полосе */}
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-4 p-5 sm:p-6">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
                  <Globe2 className="h-6 w-6" aria-hidden />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="type-h2 truncate text-text">{selected.confirmedDomain}</h2>
                    {selected.verification.state === "verified" ? (
                      <Badge tone="success"><ShieldCheck className="h-3 w-3" aria-hidden />домен подтверждён</Badge>
                    ) : selected.verification.state === "revoked" ? (
                      <Badge tone="danger"><AlertTriangle className="h-3 w-3" aria-hidden />подтверждение отозвано</Badge>
                    ) : (
                      <Badge tone="fire">домен не подтверждён</Badge>
                    )}
                    <Badge tone="neutral">режим: {selected.publishingMode === "confirm" ? "с подтверждением" : "автомат"}</Badge>
                    {selected.status !== "active" && <Badge tone="neutral">{selected.status === "paused" ? "на паузе" : "отключён"}</Badge>}
                  </div>
                  <a
                    href={selected.canonicalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="type-caption mt-1 inline-flex items-center gap-1 text-brand hover:underline"
                  >
                    {selected.canonicalUrl}
                  </a>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={reanalyze} disabled={reanalyzing || analysisActive}>
                    <RefreshCw className={cn("h-4 w-4", (reanalyzing || analysisActive) && "animate-spin")} aria-hidden />
                    {analysisActive ? "Аудит идёт" : "Обновить аудит"}
                  </Button>
                  <div className="relative">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label="Действия с сайтом"
                      aria-expanded={menuOpen}
                      onClick={() => setMenuOpen((value) => !value)}
                    >
                      <MoreHorizontal className="h-4 w-4" aria-hidden />
                    </Button>
                    {menuOpen && (
                      <>
                        <button type="button" aria-label="Закрыть меню" className="fixed inset-0 z-40 cursor-default" onClick={() => setMenuOpen(false)} />
                        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-sm border border-line bg-surface p-1.5 shadow-card">
                          <button
                            type="button"
                            className="type-secondary block w-full rounded-sm px-3 py-2 text-left text-text hover:bg-surface-2"
                            onClick={() => { setEditUrl(selected.canonicalUrl); setEditOpen((value) => !value); setMenuOpen(false); }}
                          >
                            Изменить адрес сайта
                          </button>
                          {selected.verification.state === "verified" && (
                            <button
                              type="button"
                              className="type-secondary block w-full rounded-sm px-3 py-2 text-left text-text hover:bg-surface-2"
                              disabled={siteBusy === "revoke"}
                              onClick={() => void revokeVerification()}
                            >
                              Отозвать подтверждение домена
                            </button>
                          )}
                          <button
                            type="button"
                            className="type-secondary block w-full rounded-sm px-3 py-2 text-left text-text hover:bg-surface-2"
                            disabled={siteBusy === "status"}
                            onClick={() => void patchSite({ status: selected.status === "active" ? "paused" : "active" }, "status")}
                          >
                            {selected.status === "active" ? "Поставить на паузу" : "Возобновить работу"}
                          </button>
                          {selected.status !== "disconnected" && (
                            <button
                              type="button"
                              className="type-secondary block w-full rounded-sm px-3 py-2 text-left text-text hover:bg-surface-2"
                              disabled={siteBusy === "status"}
                              onClick={() => void patchSite({ status: "disconnected" }, "status")}
                            >
                              Отключить от Авроры
                            </button>
                          )}
                          <button
                            type="button"
                            className="type-secondary block w-full rounded-sm px-3 py-2 text-left text-danger-text hover:bg-danger-soft"
                            onClick={() => { setDeleteOpen(true); setMenuOpen(false); }}
                          >
                            Удалить сайт
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {editOpen && (
                <form
                  className="grid gap-3 border-t border-line bg-surface-2 px-5 py-4 sm:px-6 md:grid-cols-[minmax(0,1fr)_auto]"
                  onSubmit={(event) => { event.preventDefault(); void patchSite({ url: editUrl }, "domain"); }}
                >
                  <Field
                    label="Новый адрес сайта"
                    htmlFor="site-edit-url"
                    hint="Смена домена сбрасывает подтверждение владения: проверку нужно пройти заново. Профиль и отчёты останутся историей прежнего адреса."
                  >
                    <Input id="site-edit-url" type="url" value={editUrl} onChange={(event) => setEditUrl(event.target.value)} required />
                  </Field>
                  <div className="flex items-end gap-2">
                    <Button type="submit" size="sm" disabled={siteBusy === "domain" || editUrl.trim().length === 0}>
                      {siteBusy === "domain" ? "Сохраняем…" : "Сохранить адрес"}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditOpen(false)}>Отмена</Button>
                  </div>
                </form>
              )}

              {/* Полоса состояния: три равные ячейки, у каждой есть действие */}
              <dl className="grid border-t border-line sm:grid-cols-3 [&>div+div]:border-t sm:[&>div+div]:border-t-0 sm:[&>div+div]:border-l">
                <div className="flex items-center gap-3 border-line px-5 py-4">
                  <span className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-sm",
                    analysisTone === "success" ? "bg-success-soft text-success-text" : analysisTone === "danger" ? "bg-danger-soft text-danger-text" : "bg-surface-inset text-text-2",
                  )}>
                    {analysisTone === "success" ? <CheckCircle2 className="h-4 w-4" aria-hidden />
                      : analysisTone === "danger" ? <XCircle className="h-4 w-4" aria-hidden />
                        : <Clock3 className="h-4 w-4" aria-hidden />}
                  </span>
                  <span className="min-w-0">
                    <dt className="type-caption text-text-3">Аудит</dt>
                    <dd className="type-body-strong text-text">
                      {analysisLabel(analysis?.status)}
                      {analysis && ACTIVE_STATUSES.has(analysis.status) ? ` · ${analysis.progress}%` : ""}
                    </dd>
                    <dd className="type-caption text-text-3">
                      {analysis?.status === "ready"
                        ? `завершён ${formatDate(analysis.completedAt)}`
                        : analysis?.status === "failed" && analysis.error
                          ? siteAnalysisErrorMessage(analysis.error.code)
                          : profile ? `профиль от ${formatDate(profile.createdAt)}` : "профиля пока нет"}
                    </dd>
                  </span>
                  <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setTab("audit")}>
                    Открыть
                  </Button>
                </div>

                <div className="flex items-center gap-3 border-t border-line px-5 py-4 sm:border-t-0">
                  <span className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-sm",
                    selected.verification.state === "verified" ? "bg-success-soft text-success-text" : "bg-fire-soft text-fire-text",
                  )}>
                    <ShieldCheck className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <dt className="type-caption text-text-3">Владение доменом</dt>
                    <dd className="type-body-strong text-text">
                      {selected.verification.state === "verified" ? "Подтверждено" : selected.verification.state === "revoked" ? "Отозвано" : "Не подтверждён"}
                    </dd>
                    <dd className="type-caption text-text-3">
                      {selected.verification.state === "verified"
                        ? `${selected.verification.method === "dns_txt" ? "по DNS-записи" : "по meta-тегу"} · ${formatDate(selected.verification.verifiedAt)}`
                        : "публикация и зонд закрыты"}
                    </dd>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant={selected.verification.state === "verified" ? "ghost" : "secondary"}
                    className="ml-auto"
                    onClick={() => setVerificationOpen((value) => !value)}
                    aria-expanded={verificationOpen}
                  >
                    {selected.verification.state === "verified" ? "Подробнее" : "Подтвердить"}
                  </Button>
                </div>

                <div className="flex items-center gap-3 border-t border-line px-5 py-4 sm:border-t-0">
                  <span className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-sm",
                    destinationCount > 0 ? "bg-success-soft text-success-text" : "bg-surface-inset text-text-2",
                  )}>
                    <Globe2 className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <dt className="type-caption text-text-3">Публикация</dt>
                    <dd className="type-body-strong text-text">
                      {!destinationsLoaded ? "Проверяем…" : destinationCount > 0 ? "Готова" : "Назначение не подключено"}
                    </dd>
                    <dd className="type-caption text-text-3">
                      {!destinationsLoaded
                        ? "загружаем назначения"
                        : destinationCount > 0
                          ? destinationCount === 1 ? "подключено одно назначение" : `подключено назначений: ${destinationCount}`
                          : "материалы останутся в Авроре"}
                    </dd>
                  </span>
                  <Button type="button" size="sm" variant={destinationCount > 0 ? "ghost" : "secondary"} className="ml-auto" onClick={() => setTab("publishing")}>
                    {destinationCount > 0 ? "Настроить" : "Настроить"}
                  </Button>
                </div>
              </dl>
            </Card>

            {/* Подтверждение домена: те же два способа, что и раньше, но по кнопке */}
            {verificationOpen && (
              <Card className="p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="type-h3 text-text">Подтверждение владения доменом</h3>
                    <p className="type-caption mt-1 text-text-3">
                      Достаточно одного способа. DNS-изменения могут применяться до нескольких часов, meta-тег проверяется сразу.
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setVerificationOpen(false)}>Свернуть</Button>
                </div>

                {selected.verification.state === "verified" ? (
                  <div className="mt-4 flex flex-wrap items-center gap-3 rounded-sm bg-success-soft p-4">
                    <ShieldCheck className="h-5 w-5 text-success-text" aria-hidden />
                    <span className="type-secondary text-success-text">
                      Домен подтверждён {formatDate(selected.verification.verifiedAt)}
                      {selected.verification.method ? ` (${selected.verification.method === "dns_txt" ? "DNS-запись" : "meta-тег"})` : ""}.
                    </span>
                    <Button type="button" size="sm" variant="ghost" className="ml-auto" disabled={siteBusy === "revoke"} onClick={() => void revokeVerification()}>
                      Отозвать подтверждение
                    </Button>
                  </div>
                ) : (
                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <section className="rounded-sm border border-line bg-surface-2 p-4" aria-labelledby="verify-dns">
                      <h4 id="verify-dns" className="type-label text-text">Вариант 1 · TXT-запись в DNS</h4>
                      <p className="type-caption mt-2 text-text-3">Имя записи</p>
                      <CopyValue value={selected.verification.instructions.dns.recordName} label="имя записи" />
                      <p className="type-caption mt-3 text-text-3">Значение</p>
                      <CopyValue value={selected.verification.instructions.dns.recordValue} label="значение записи" />
                    </section>
                    <section className="rounded-sm border border-line bg-surface-2 p-4" aria-labelledby="verify-meta">
                      <h4 id="verify-meta" className="type-label text-text">Вариант 2 · meta-тег на главной</h4>
                      <p className="type-caption mt-2 text-text-3">Вставьте в &lt;head&gt; главной страницы</p>
                      <CopyValue value={selected.verification.instructions.meta.tag} label="meta-тег" />
                      <p className="type-caption mt-3 text-text-3">
                        Тег должен быть в первых 256 КБ HTML главной страницы. Если сайт закрыт защитой от ботов, используйте DNS-запись.
                      </p>
                    </section>
                    <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
                      <Button type="button" size="sm" onClick={verify} disabled={verifying}>
                        {verifying ? "Проверяем…" : "Проверить подтверждение"}
                      </Button>
                      {verifyMessage && (
                        <span role="status" className={cn("type-caption", verifyMessage.tone === "success" ? "text-success-text" : "text-danger-text")}>
                          {verifyMessage.text}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            )}

            {/* На телефоне полоса табов прокручивается, на широком экране делит ширину поровну. */}
            <div className="max-w-full overflow-x-auto pb-0.5">
              <Tabs<SiteTab>
                value={tab}
                onChange={setTab}
                fill
                className="min-w-[660px] whitespace-nowrap sm:min-w-0"
                ariaLabel="Разделы сайта"
                items={tabItems}
              />
            </div>

            {tab === "overview" && (
              <OverviewPanel
                site={selected}
                profile={profile}
                analysis={analysis}
                reports={current?.reports ?? []}
                articleStats={articleStats}
                destinationCount={destinationCount}
                destinationsLoaded={destinationsLoaded}
                reanalyzing={reanalyzing}
                analysisActive={analysisActive}
                retryingAi={retryingAi}
                onOpenVerification={() => setVerificationOpen(true)}
                onVerify={verify}
                onTab={setTab}
                onReanalyze={reanalyze}
                onRetryAi={retryAi}
              />
            )}

            {tab === "audit" && (
              <AuditPanel
                siteId={selected.id}
                retryingAi={retryingAi}
                onRetryAi={retryAi}
                verified={selected.verification.state === "verified"}
                profile={profile}
                analysis={analysis}
                reanalyzing={reanalyzing}
                analysisActive={analysisActive}
                maxPages={maxPages}
                audits={current?.audits ?? []}
                competitors={current?.competitors ?? []}
                competitorBusy={competitorBusy}
                onAddCompetitor={addCompetitor}
                onRemoveCompetitor={removeCompetitor}
                onMaxPagesChange={setMaxPages}
                onReanalyze={reanalyze}
                onCreateMaterial={(input) => {
                  setMaterialDraft({ token: Date.now(), brief: input.brief, type: input.type });
                  setTab("materials");
                }}
              />
            )}

            {tab === "materials" && (
              <ArticlesPanel
                key={materialDraft ? `${selected.id}:${materialDraft.token}` : `${selected.id}`}
                initialBrief={materialDraft}
                onDraftConsumed={() => setMaterialDraft(null)}
                siteId={selected.id}
                verified={selected.verification.state === "verified"}
                hasDestinations={destinationCount > 0}
                destinationsLoaded={destinationsLoaded}
                hasProfile={Boolean(profile)}
                onSiteChanged={refreshCurrent}
                onStats={handleArticleStats}
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
                onOpenVerification={() => { setVerificationOpen(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              />
            )}

            {tab === "reports" && (
              <ReportsPanel
                siteId={selected.id}
                profile={profile}
                reports={current?.reports ?? []}
                reportRequested={reportRequested}
                retryingAi={retryingAi}
                onRequestReport={requestReport}
                onRetryAi={retryAi}
                onTab={setTab}
              />
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

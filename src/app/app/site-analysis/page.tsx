"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileSearch,
  Globe2,
  Link2,
  RefreshCw,
  SearchCode,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, Input } from "@/components/ui/primitives";
import { siteAnalysisErrorMessage, type SiteAnalysisStatus } from "@/lib/site-analysis-contract";
import {
  acquireStableSiteAnalysisKey,
  bindStableSiteAnalysisKey,
  releaseStableSiteAnalysisKey,
  siteAnalysisIntentFingerprint,
  type StableSiteAnalysisKey,
} from "@/lib/site-analysis-client-key";
import { cn } from "@/lib/utils";

type Evidence = { url: string; label: string };
type Finding = {
  code?: string;
  severity?: "high" | "medium" | "low";
  title: string;
  description?: string;
  evidence?: Evidence[];
  confidence?: string;
};
type PlanTask = {
  title?: string;
  action?: string;
  rationale?: string;
  priority?: string;
  dueDays?: number;
  sources?: Evidence[];
  confidence?: string;
};
type PlanConclusion = {
  title?: string;
  description?: string;
  statement?: string;
  stage?: string;
  action?: string;
  channel?: string;
  reason?: string;
  kpi?: string;
  target?: string;
  sources?: Evidence[];
  confidence?: string;
};
type SiteReport = {
  policyVersion?: string;
  inventory?: Array<{ url: string; status: number; title?: string; words?: number; schemaTypes?: string[] }>;
  seoAudit?: Finding[];
  geoAudit?: Finding[];
  themes?: Array<{ theme: string; occurrences: number; evidence?: Evidence[]; confidence?: string }>;
  intents?: Array<{ id: string; label: string; pages: number; evidence?: Evidence[]; confidence?: string }>;
  internalLinking?: { totalLinks?: number; orphanCandidates?: Array<{ url: string }> };
  marketingPlan?: {
    goals?: PlanConclusion[];
    icp?: PlanConclusion;
    funnel?: PlanConclusion[];
    positioning?: PlanConclusion;
    contentGaps?: PlanTask[];
    seoTasks?: PlanTask[];
    geoTasks?: PlanTask[];
    promotionChannels?: PlanConclusion[];
    publicationBacklog?: PlanTask[];
    measurement?: Array<{ kpi: string; sourceNeeded: string; confidence: string }>;
  };
  limitations?: string[];
};
type Analysis = {
  id: number;
  requestId: string;
  targetUrl: string;
  confirmedDomain: string;
  status: SiteAnalysisStatus;
  stage: string;
  progress: number;
  detail: string | null;
  error: { code: string; message: string } | null;
  attempts: number;
  runRevision: number;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  result?: SiteReport | null;
};

const TERMINAL = new Set<SiteAnalysisStatus>(["ready", "failed"]);
const CREATE_KEY_SLOT = "aurora:site-analysis:create-key";
const retryKeySlot = (analysisId: number) => `aurora:site-analysis:retry-key:${analysisId}`;

function availableSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
const STAGE_LABELS: Record<string, string> = {
  queued: "В очереди",
  robots: "Проверка robots.txt",
  sitemap: "Чтение sitemap.xml",
  crawling: "Обход страниц",
  analyzing: "SEO/GEO-аудит",
  planning: "Маркетинговый план",
  ready: "Готово",
  failed: "Остановлено",
};

function normalizedInputUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function inputDomain(value: string): string {
  try {
    return new URL(normalizedInputUrl(value)).hostname;
  } catch {
    return "";
  }
}

function elapsedLabel(startedAt: string | null, endedAt: string | null, now: number) {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} мин ${seconds % 60} с` : `${seconds} с`;
}

function EvidenceLinks({ items }: { items?: Evidence[] }) {
  if (!items?.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Доказательства">
      {items.slice(0, 4).map((item, index) => (
        <li key={`${item.url}-${index}`}>
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-line px-2.5 py-1.5 text-[12px] font-semibold text-brand hover:border-brand/35 hover:bg-info-soft"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            {item.label || "Открыть страницу"}
          </a>
        </li>
      ))}
    </ul>
  );
}

function FindingList({ title, items, empty }: { title: string; items?: Finding[]; empty: string }) {
  return (
    <section>
      <h3 className="text-[16px] font-extrabold text-text">{title}</h3>
      {!items?.length ? (
        <p className="mt-3 rounded-sm bg-success-soft p-3 text-[13px] text-success-text">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {items.map((item, index) => (
            <li key={`${item.code || item.title}-${index}`} className="rounded-sm border border-line bg-surface-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-bold text-text">{item.title}</p>
                <Badge tone={item.severity === "high" ? "danger" : item.severity === "medium" ? "fire" : "neutral"}>
                  {item.severity === "high" ? "Высокий" : item.severity === "medium" ? "Средний" : "Низкий"}
                </Badge>
                {item.confidence && <span className="text-[11px] text-text-3">confidence: {item.confidence}</span>}
              </div>
              {item.description && <p className="mt-1.5 text-[13px] leading-relaxed text-text-2">{item.description}</p>}
              <EvidenceLinks items={item.evidence} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReportView({ report }: { report: SiteReport }) {
  const tasks = [
    ...(report.marketingPlan?.seoTasks || []),
    ...(report.marketingPlan?.geoTasks || []),
    ...(report.marketingPlan?.publicationBacklog || []),
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-sm bg-surface-inset p-4">
          <p className="text-[12px] text-text-3">Страниц в snapshot</p>
          <p className="nums mt-1 text-2xl font-black text-text">{report.inventory?.length || 0}</p>
        </div>
        <div className="rounded-sm bg-surface-inset p-4">
          <p className="text-[12px] text-text-3">Внутренних ссылок</p>
          <p className="nums mt-1 text-2xl font-black text-text">{report.internalLinking?.totalLinks || 0}</p>
        </div>
        <div className="rounded-sm bg-surface-inset p-4">
          <p className="text-[12px] text-text-3">Версия анализа</p>
          <p className="mt-1 truncate text-[13px] font-bold text-text">{report.policyVersion || "—"}</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <FindingList title="Технический SEO-аудит" items={report.seoAudit} empty="Критичных SEO-сигналов в проверенном snapshot не найдено." />
        <FindingList title="GEO-аудит для AI-поиска" items={report.geoAudit} empty="Критичных GEO-сигналов в проверенном snapshot не найдено." />
      </div>

      <section>
        <h3 className="text-[16px] font-extrabold text-text">Темы и интенты</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {(report.themes || []).map((theme) => (
            <span key={theme.theme} className="rounded-full border border-line bg-surface-2 px-3 py-1.5 text-[12px] font-semibold text-text-2">
              {theme.theme} · {theme.occurrences}
            </span>
          ))}
          {(report.intents || []).map((intent) => (
            <span key={intent.id} className="rounded-full bg-info-soft px-3 py-1.5 text-[12px] font-semibold text-info-text">
              {intent.label}: {intent.pages}
            </span>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-[16px] font-extrabold text-text">Основа маркетингового плана</h3>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {(report.marketingPlan?.goals || []).map((goal, index) => (
            <article key={`${goal.title}-${index}`} className="rounded-sm border border-line bg-surface-2 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wide text-brand">Цель</p>
              <p className="mt-1 font-bold text-text">{goal.title}</p>
              {goal.kpi && <p className="mt-1 text-[13px] text-text-2">KPI: {goal.kpi}</p>}
              {goal.target && <p className="mt-1 text-[13px] text-text-2">Ориентир: {goal.target}</p>}
              <p className="mt-2 text-[11px] text-text-3">confidence: {goal.confidence || "medium"}</p>
              <EvidenceLinks items={goal.sources} />
            </article>
          ))}
          {report.marketingPlan?.icp && (
            <article className="rounded-sm border border-line bg-surface-2 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wide text-brand">ICP-гипотеза</p>
              <p className="mt-1 text-[13px] leading-relaxed text-text-2">{report.marketingPlan.icp.description}</p>
              <p className="mt-2 text-[11px] text-text-3">confidence: {report.marketingPlan.icp.confidence || "low"}</p>
              <EvidenceLinks items={report.marketingPlan.icp.sources} />
            </article>
          )}
          {report.marketingPlan?.positioning && (
            <article className="rounded-sm border border-line bg-surface-2 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wide text-brand">Позиционирование</p>
              <p className="mt-1 text-[13px] leading-relaxed text-text-2">{report.marketingPlan.positioning.statement}</p>
              <p className="mt-2 text-[11px] text-text-3">confidence: {report.marketingPlan.positioning.confidence || "low"}</p>
              <EvidenceLinks items={report.marketingPlan.positioning.sources} />
            </article>
          )}
        </div>
      </section>

      <section>
        <h3 className="text-[16px] font-extrabold text-text">Воронка и каналы продвижения</h3>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {(report.marketingPlan?.funnel || []).map((step, index) => (
            <article key={`${step.stage}-${index}`} className="rounded-sm border border-line bg-surface-2 p-4">
              <p className="font-bold text-text">{step.stage}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-text-2">{step.action}</p>
              <p className="mt-2 text-[11px] text-text-3">confidence: {step.confidence || "medium"}</p>
              <EvidenceLinks items={step.sources} />
            </article>
          ))}
          {(report.marketingPlan?.promotionChannels || []).map((channel, index) => (
            <article key={`${channel.channel}-${index}`} className="rounded-sm border border-line bg-surface-2 p-4">
              <p className="font-bold text-text">{channel.channel}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-text-2">{channel.reason}</p>
              <p className="mt-2 text-[11px] text-text-3">confidence: {channel.confidence || "medium"}</p>
              <EvidenceLinks items={channel.sources} />
            </article>
          ))}
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-[16px] font-extrabold text-text">Приоритетный backlog</h3>
            <p className="mt-1 text-[13px] text-text-3">Каждый пункт содержит источник и уровень уверенности.</p>
          </div>
          <Badge tone="brand">{tasks.length} задач</Badge>
        </div>
        <ol className="mt-3 grid gap-3 lg:grid-cols-2">
          {tasks.slice(0, 16).map((task, index) => (
            <li key={`${task.title || task.action}-${index}`} className="rounded-sm border border-line bg-surface-2 p-4">
              <div className="flex gap-3">
                <span className="nums grid h-7 w-7 shrink-0 place-items-center rounded-full bg-info-soft text-[12px] font-black text-brand">{index + 1}</span>
                <div className="min-w-0">
                  <p className="font-bold text-text">{task.title || task.action}</p>
                  {task.rationale && <p className="mt-1 text-[13px] leading-relaxed text-text-2">{task.rationale}</p>}
                  <p className="mt-2 text-[11px] text-text-3">
                    {task.priority ? `${task.priority} · ` : ""}{task.dueDays ? `до ${task.dueDays} дней · ` : ""}confidence: {task.confidence || "medium"}
                  </p>
                  <EvidenceLinks items={task.sources} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-sm border border-line bg-surface-inset p-4">
        <h3 className="text-[14px] font-extrabold text-text">Какие данные нужны для реальных KPI</h3>
        <ul className="mt-2 space-y-2 text-[13px] text-text-2">
          {(report.marketingPlan?.measurement || []).map((row) => (
            <li key={row.kpi}><b className="text-text">{row.kpi}:</b> {row.sourceNeeded}</li>
          ))}
        </ul>
      </section>

      <section className="rounded-sm border border-fire/25 bg-fire-soft p-4">
        <h3 className="flex items-center gap-2 text-[14px] font-extrabold text-text">
          <AlertTriangle className="h-4 w-4" aria-hidden /> Ограничения публичного crawl
        </h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-text-2">
          {(report.limitations || []).map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>
    </div>
  );
}

export default function SiteAnalysisPage() {
  const [url, setUrl] = useState("");
  const [domain, setDomain] = useState("");
  const [domainEdited, setDomainEdited] = useState(false);
  const [consent, setConsent] = useState(false);
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [current, setCurrent] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [pageError, setPageError] = useState<{ message: string; requestId?: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requestSequence = useRef(0);
  const createKeyRef = useRef<StableSiteAnalysisKey | null>(null);
  const retryKeyRef = useRef<StableSiteAnalysisKey | null>(null);

  const loadList = useCallback(async () => {
    try {
      const response = await fetch("/api/site-analysis", { cache: "no-store" });
      const body = await response.json() as { analyses?: Analysis[]; requestId?: string; error?: string };
      if (!response.ok) throw Object.assign(new Error("list_failed"), { requestId: body.requestId });
      setAnalyses(body.analyses || []);
    } catch (error) {
      setPageError({ message: "Не удалось загрузить историю анализов.", requestId: (error as { requestId?: string }).requestId });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOne = useCallback(async (id: number) => {
    const sequence = ++requestSequence.current;
    try {
      const response = await fetch(`/api/site-analysis/${id}`, { cache: "no-store" });
      const body = await response.json() as { analysis?: Analysis; requestId?: string; error?: string };
      if (!response.ok || !body.analysis) throw Object.assign(new Error(body.error || "poll_failed"), { requestId: body.requestId });
      if (sequence !== requestSequence.current) return null;
      setCurrent(body.analysis);
      setAnalyses((items) => [body.analysis!, ...items.filter((item) => item.id !== body.analysis!.id)]);
      if (TERMINAL.has(body.analysis.status)) {
        const storage = availableSessionStorage();
        releaseStableSiteAnalysisKey(storage, CREATE_KEY_SLOT, body.analysis.id);
        releaseStableSiteAnalysisKey(storage, retryKeySlot(body.analysis.id), body.analysis.id);
        if (createKeyRef.current?.analysisId === body.analysis.id) createKeyRef.current = null;
        if (retryKeyRef.current?.analysisId === body.analysis.id) retryKeyRef.current = null;
      }
      setPageError(null);
      return body.analysis;
    } catch (error) {
      if (sequence === requestSequence.current) {
        setPageError({ message: "Не удалось обновить статус анализа.", requestId: (error as { requestId?: string }).requestId });
      }
      return null;
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- state changes only after the request settles
  useEffect(() => { void loadList(); }, [loadList]);

  useEffect(() => {
    if (!current || TERMINAL.has(current.status)) return;
    const timer = window.setInterval(() => void loadOne(current.id), 2_000);
    return () => window.clearInterval(timer);
  }, [current, loadOne]);

  useEffect(() => {
    if (!current || TERMINAL.has(current.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [current]);

  const canSubmit = Boolean(url.trim() && domain.trim() && consent && !submitting);
  const elapsed = useMemo(
    () => elapsedLabel(current?.createdAt || null, current?.completedAt || null, now),
    [current?.createdAt, current?.completedAt, now],
  );

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setPageError(null);
    try {
      const fingerprint = siteAnalysisIntentFingerprint(normalizedInputUrl(url), domain);
      const keyRecord = acquireStableSiteAnalysisKey(
        availableSessionStorage(),
        CREATE_KEY_SLOT,
        fingerprint,
        "site-analysis",
        () => crypto.randomUUID(),
        createKeyRef.current,
      );
      createKeyRef.current = keyRecord;
      const response = await fetch("/api/site-analysis", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": keyRecord.key },
        body: JSON.stringify({ url: normalizedInputUrl(url), confirmedDomain: domain.trim(), consent: true }),
      });
      const body = await response.json() as { analysis?: Analysis; requestId?: string; error?: string };
      if (body.analysis) {
        createKeyRef.current = bindStableSiteAnalysisKey(
          availableSessionStorage(),
          CREATE_KEY_SLOT,
          keyRecord,
          body.analysis.id,
        );
        setCurrent(body.analysis);
        setAnalyses((items) => [body.analysis!, ...items.filter((item) => item.id !== body.analysis!.id)]);
        if (TERMINAL.has(body.analysis.status)) {
          releaseStableSiteAnalysisKey(availableSessionStorage(), CREATE_KEY_SLOT, body.analysis.id);
          createKeyRef.current = null;
        }
      }
      if (!response.ok || !body.analysis) {
        const message = body.error === "worker_unavailable"
          ? "Полный фоновый worker сейчас недоступен. Запусти приложение через npm run dev."
          : siteAnalysisErrorMessage(body.error || "unavailable");
        throw Object.assign(new Error(message), { requestId: body.requestId });
      }
      setCurrent(body.analysis);
      setAnalyses((items) => [body.analysis!, ...items.filter((item) => item.id !== body.analysis!.id)]);
      // Первый poll выполняется сразу после подтверждённого создания, до интервального таймера.
      await loadOne(body.analysis.id);
    } catch (error) {
      setPageError({ message: error instanceof Error ? error.message : "Не удалось запустить анализ.", requestId: (error as { requestId?: string }).requestId });
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async () => {
    if (!current || submitting) return;
    setSubmitting(true);
    setPageError(null);
    try {
      const slot = retryKeySlot(current.id);
      const keyRecord = acquireStableSiteAnalysisKey(
        availableSessionStorage(),
        slot,
        `${current.id}:r${current.runRevision}`,
        "site-analysis-retry",
        () => crypto.randomUUID(),
        retryKeyRef.current,
      );
      retryKeyRef.current = keyRecord;
      const response = await fetch(`/api/site-analysis/${current.id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": keyRecord.key },
        body: JSON.stringify({ clientKey: keyRecord.key }),
      });
      const body = await response.json() as { analysis?: Analysis; requestId?: string; error?: string };
      if (body.analysis) {
        retryKeyRef.current = bindStableSiteAnalysisKey(
          availableSessionStorage(),
          slot,
          keyRecord,
          body.analysis.id,
        );
        setCurrent(body.analysis);
        if (TERMINAL.has(body.analysis.status)) {
          releaseStableSiteAnalysisKey(availableSessionStorage(), slot, body.analysis.id);
          retryKeyRef.current = null;
        }
      }
      if (!response.ok || !body.analysis) throw Object.assign(new Error(siteAnalysisErrorMessage(body.error || "unavailable")), { requestId: body.requestId });
      setCurrent(body.analysis);
      await loadOne(body.analysis.id);
    } catch (error) {
      setPageError({ message: error instanceof Error ? error.message : "Не удалось повторить анализ.", requestId: (error as { requestId?: string }).requestId });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell
      title="Анализ сайта"
      subtitle="Безопасный публичный crawl, технический SEO/GEO-аудит и доказательный маркетинговый план."
    >
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-5 sm:px-7">
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-sm bg-info-soft text-brand">
                  <SearchCode className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <h2 className="text-[18px] font-black text-text">Новый анализ</h2>
                  <p className="mt-1 text-[13px] leading-relaxed text-text-2">
                    Проверяем только публичные страницы подтверждённого домена, соблюдаем robots.txt и не входим в закрытые кабинеты.
                  </p>
                </div>
              </div>
            </div>
            <form onSubmit={submit} className="space-y-4 px-5 py-5 sm:px-7 sm:py-6">
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-bold text-text">URL сайта</span>
                <Input
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  value={url}
                  placeholder="https://example.com"
                  onChange={(event) => {
                    const next = event.target.value;
                    setUrl(next);
                    if (!domainEdited) setDomain(inputDomain(next));
                  }}
                  onBlur={() => { if (!domain) setDomain(inputDomain(url)); }}
                  required
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-bold text-text">Подтверждённый домен</span>
                <Input
                  value={domain}
                  placeholder="example.com"
                  autoComplete="off"
                  onChange={(event) => { setDomain(event.target.value); setDomainEdited(true); }}
                  required
                />
                <span className="mt-1.5 block text-[12px] text-text-3">Должен точно совпадать с доменом URL.</span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-sm border border-line bg-surface-2 p-4">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--brand)]"
                />
                <span className="text-[13px] leading-relaxed text-text-2">
                  Я подтверждаю право анализировать публичные страницы этого домена. Аврора не будет обходить авторизацию, подписку или ограничения сайта.
                </span>
              </label>
              <Button type="submit" loading={submitting} disabled={!canSubmit}>
                <FileSearch className="h-4 w-4" aria-hidden />
                Запустить фоновый анализ
              </Button>
            </form>
          </Card>

          {pageError && (
            <div role="alert" className="rounded-sm border border-danger/30 bg-danger-soft p-4 text-[13px] text-text">
              <p className="font-bold">{pageError.message}</p>
              {pageError.requestId && <p className="nums mt-1 text-[12px] text-text-3">Request ID: {pageError.requestId}</p>}
            </div>
          )}

          {current && (
            <Card className="overflow-hidden">
              <div className="border-b border-line px-5 py-5 sm:px-7">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-extrabold text-text">{current.targetUrl}</p>
                    <p className="nums mt-1 text-[11px] text-text-3">Request ID: {current.requestId}</p>
                  </div>
                  <Badge tone={current.status === "ready" ? "success" : current.status === "failed" ? "danger" : "brand"}>
                    {STAGE_LABELS[current.stage] || current.stage}
                  </Badge>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-text-3" aria-live="polite" aria-atomic="true">
                  <span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" aria-hidden /> {elapsed}</span>
                  <span>{current.progress}%</span>
                  <span>{current.detail || STAGE_LABELS[current.stage]}</span>
                </div>
                <div
                  className="mt-3 h-2 overflow-hidden rounded-full bg-surface-inset"
                  role="progressbar"
                  aria-label="Прогресс анализа сайта"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={current.progress}
                >
                  <div
                    className={cn("h-full origin-left bg-brand-gradient transition-transform duration-500 motion-reduce:transition-none", current.status === "failed" && "bg-danger")}
                    style={{ transform: `scaleX(${Math.max(0, Math.min(100, current.progress)) / 100})` }}
                  />
                </div>
                {current.status === "failed" && (
                  <div className="mt-4 flex flex-wrap items-center gap-3 rounded-sm bg-danger-soft p-4">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-danger-text" aria-hidden />
                    <p className="min-w-0 flex-1 text-[13px] text-text">{current.error?.message || "Анализ остановлен."}</p>
                    <Button type="button" variant="outline" size="sm" loading={submitting} onClick={() => void retry()}>
                      <RefreshCw className="h-4 w-4" aria-hidden /> Повторить
                    </Button>
                  </div>
                )}
              </div>
              <div className="px-5 py-6 sm:px-7">
                {current.status === "ready" && current.result ? (
                  <ReportView report={current.result} />
                ) : current.status !== "failed" ? (
                  <div className="grid gap-3 sm:grid-cols-2" aria-hidden>
                    {[0, 1, 2, 3].map((item) => <div key={item} className="skeleton h-28 rounded-sm motion-reduce:animate-none" />)}
                  </div>
                ) : null}
              </div>
            </Card>
          )}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-6">
          <Card className="p-5">
            <h2 className="flex items-center gap-2 text-[15px] font-extrabold text-text">
              <ShieldCheck className="h-5 w-5 text-success-text" aria-hidden /> Границы анализа
            </h2>
            <ul className="mt-3 space-y-2 text-[12px] leading-relaxed text-text-2">
              <li>До 20 HTML-страниц и 6 МБ на один запуск.</li>
              <li>Только стандартные HTTP/HTTPS-порты и публичные IP.</li>
              <li>DNS закрепляется на соединение; каждый redirect проверяется заново.</li>
              <li>Трафик и конверсии появятся только после отдельной интеграции аналитики.</li>
            </ul>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <h2 className="flex items-center gap-2 text-[15px] font-extrabold text-text">
                <Globe2 className="h-4 w-4 text-brand" aria-hidden /> История
              </h2>
            </div>
            {loading ? (
              <div className="space-y-2 p-4" role="status"><span className="sr-only">Загружаем историю</span>{[0, 1, 2].map((item) => <div key={item} className="skeleton h-16 rounded-sm" />)}</div>
            ) : analyses.length ? (
              <ul className="divide-y divide-line">
                {analyses.map((analysis) => (
                  <li key={analysis.id}>
                    <button
                      type="button"
                      onClick={() => void loadOne(analysis.id)}
                      className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
                    >
                      {analysis.status === "ready" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success-text" aria-hidden /> : analysis.status === "failed" ? <AlertTriangle className="h-4 w-4 shrink-0 text-danger-text" aria-hidden /> : <Sparkles className="h-4 w-4 shrink-0 text-brand" aria-hidden />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-bold text-text">{analysis.confirmedDomain}</span>
                        <span className="mt-0.5 block text-[11px] text-text-3">{STAGE_LABELS[analysis.stage] || analysis.stage} · {analysis.progress}%</span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-5 text-[13px] leading-relaxed text-text-3">Запуски появятся здесь и переживут перезагрузку страницы.</p>
            )}
          </Card>

          <div className="flex items-start gap-2 rounded-sm bg-info-soft p-4 text-[12px] leading-relaxed text-info-text">
            <Link2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Каждый вывод в готовом отчёте связан с публичной страницей-доказательством.
          </div>
        </aside>
      </div>
    </AppShell>
  );
}

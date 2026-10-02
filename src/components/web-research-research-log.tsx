"use client";

// Панель «Аврора в интернете»: единственное место, где пользователь видит, что
// именно Аврора искала в открытом интернете, какие страницы прочитала, какие факты
// прошли ворота достоверности и почему остальные были отклонены.
//
// Панель самодостаточна: сама загружает последний запуск, сама запускает новое
// исследование и сама снимает ненужные факты, поэтому страница «Сегодня» добавляет
// её одной строкой и не обрастает новым состоянием.

import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeCheck, ChevronDown, Globe, RefreshCw, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { useProjectFetch } from "@/lib/use-project-transport";
import {
  webResearchCitationRows,
  webResearchQueryRows,
  webResearchRejectionGroups,
  webResearchStepLabel,
  webResearchSummary,
  webResearchTimeLabel,
} from "@/lib/web-research-view";
import type { WebResearchRunRow, WebResearchStoredFinding } from "@/lib/web-research-store.mjs";

/** Форма факта, которую отдаёт GET /api/web-research. */
type FindingPayload = {
  fingerprint: string;
  kind: WebResearchStoredFinding["kind"];
  claim: string;
  quote: string;
  title?: string | null;
  legalStatus?: string | null;
  legalStatusLabel?: string | null;
  publishedAt: string;
  ageDays: number;
  corroborationCount?: number;
  trusted?: boolean;
  status: WebResearchStoredFinding["status"];
  source: {
    url: string;
    domain: string;
    label: string;
    tier: WebResearchStoredFinding["source"]["tier"];
    tierLabel: string;
    trust: number;
  };
};

const CATEGORY_OPTIONS = [
  { value: "law", label: "Право" },
  { value: "benchmark", label: "Бенчмарк" },
  { value: "market", label: "Рынок" },
  { value: "technology", label: "Технологии" },
  { value: "statistics", label: "Статистика" },
  { value: "society", label: "Общество" },
] as const;

const LANGUAGE_OPTIONS = [
  { value: "RU", label: "Русский" },
  { value: "EN", label: "Английский" },
  { value: "ANY", label: "Любой" },
] as const;

type LoadState = "loading" | "ready" | "error" | "no_channel";

function stageMessage(message: string | null | undefined): string {
  return String(message ?? "").replace(/\s+/gu, " ").trim().slice(0, 240);
}

function asFindingPayload(value: unknown): FindingPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source = record.source && typeof record.source === "object" && !Array.isArray(record.source)
    ? (record.source as Record<string, unknown>)
    : {};
  const fingerprint = typeof record.fingerprint === "string" ? record.fingerprint : "";
  const url = typeof source.url === "string" ? source.url : "";
  if (!fingerprint || !/^https?:\/\//iu.test(url)) return null;
  return {
    fingerprint,
    kind: record.kind as FindingPayload["kind"],
    claim: String(record.claim ?? ""),
    quote: String(record.quote ?? ""),
    title: typeof record.title === "string" ? record.title : null,
    legalStatus: typeof record.legalStatus === "string" ? record.legalStatus : null,
    legalStatusLabel: typeof record.legalStatusLabel === "string" ? record.legalStatusLabel : null,
    publishedAt: String(record.publishedAt ?? ""),
    ageDays: Number(record.ageDays) || 0,
    corroborationCount: Number(record.corroborationCount) || 0,
    trusted: record.trusted === true,
    status: record.status === "used" ? "used" : "new",
    source: {
      url,
      domain: typeof source.domain === "string" ? source.domain : "",
      label: typeof source.label === "string" ? source.label : "",
      tier: (source.tier as FindingPayload["source"]["tier"]) || "open",
      tierLabel: typeof source.tierLabel === "string" ? source.tierLabel : "",
      trust: Number(source.trust) || 0,
    },
  };
}

function asStoredFinding(finding: FindingPayload): WebResearchStoredFinding {
  return {
    id: 0,
    runId: null,
    fingerprint: finding.fingerprint,
    kind: finding.kind,
    claim: finding.claim,
    quote: finding.quote,
    title: finding.title ?? null,
    language: "RU",
    legalStatus: finding.legalStatus ?? null,
    legalStatusLabel: finding.legalStatusLabel ?? null,
    source: { ...finding.source, registered: finding.source.trust > 0 },
    publishedAt: finding.publishedAt,
    retrievedAt: finding.publishedAt,
    ageDays: Number(finding.ageDays) || 0,
    numbers: [],
    corroboratingDomains: [],
    corroborationCount: Number(finding.corroborationCount) || 0,
    trusted: finding.trusted === true,
    status: finding.status,
  };
}

function CitationCard({ row, busy, onDismiss, onMarkUsed }: {
  row: ReturnType<typeof webResearchCitationRows>[number];
  busy: boolean;
  onDismiss: () => void;
  onMarkUsed: () => void;
}) {
  return (
    <li className="rounded-sm border border-line bg-surface-inset p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">{row.kindLabel}</Badge>
        {row.legalStatusLabel ? <Badge tone="fire">{row.legalStatusLabel}</Badge> : null}
        {row.authoritative
          ? <Badge tone="success"><BadgeCheck className="h-3.5 w-3.5" aria-hidden />Проверенный источник</Badge>
          : <Badge tone="neutral">Нужно подтверждение</Badge>}
      </div>
      <p className="mt-3 text-pretty text-[15px] font-semibold leading-relaxed text-text">{row.claim}</p>
      <blockquote className="mt-3 border-l-2 border-brand/40 pl-3 text-[14px] leading-relaxed text-text-2">
        «{row.quote}»
      </blockquote>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-3">
        {row.sourceUrl ? (
          <a
            href={row.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="break-words font-semibold text-brand underline decoration-brand/35 underline-offset-4 hover:decoration-brand"
          >
            {row.sourceTitle}
          </a>
        ) : <span className="font-semibold text-text-2">{row.sourceTitle}</span>}
        <span>{row.tierLabel}</span>
        {row.publishedLabel ? <span>Опубликовано {row.publishedLabel}</span> : null}
        {row.ageLabel ? <span>{row.ageLabel}</span> : null}
        {row.sourceDomain ? <span className="break-all">{row.sourceDomain}</span> : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="min-h-11" disabled={busy} onClick={onMarkUsed}>
          Использовать
        </Button>
        <Button variant="ghost" size="sm" className="min-h-11" disabled={busy} onClick={onDismiss}>
          <X className="h-4 w-4" aria-hidden />Не использовать
        </Button>
      </div>
    </li>
  );
}

export function WebResearchResearchLog({ channelId, onFinished }: {
  channelId: number | null;
  onFinished?: (message: string) => void;
}) {
  const projectFetch = useProjectFetch();
  const [state, setState] = useState<LoadState>("loading");
  const [run, setRun] = useState<WebResearchRunRow | null>(null);
  const [findings, setFindings] = useState<FindingPayload[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [starting, setStarting] = useState(false);
  const [busyFingerprint, setBusyFingerprint] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [language, setLanguage] = useState<"RU" | "EN" | "ANY">("RU");
  const loadController = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const runStatusRef = useRef<WebResearchRunRow["status"] | null>(null);

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (!channelId) {
      runStatusRef.current = null;
      setRun(null);
      setFindings([]);
      setState("no_channel");
      return;
    }
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    if (!options.quiet) setState((current) => (current === "ready" ? current : "loading"));
    try {
      const response = await projectFetch(`/api/web-research?channel=${channelId}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json().catch(() => null) as { run?: unknown; findings?: unknown; error?: unknown } | null;
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setState("error");
        setError(response.status === 403
          ? "У вас нет доступа к исследованию интернета в этом проекте."
          : "Не удалось загрузить журнал исследования. Показаны последние доступные данные.");
        return;
      }
      const nextRun = body?.run && typeof body.run === "object" ? body.run as WebResearchRunRow : null;
      const nextFindings = (Array.isArray(body?.findings) ? body.findings : [])
        .map(asFindingPayload)
        .filter((item): item is FindingPayload => item !== null);
      runStatusRef.current = nextRun?.status ?? null;
      setRun(nextRun);
      setFindings(nextFindings);
      setError("");
      setState("ready");
    } catch {
      if (controller.signal.aborted) return;
      setState((current) => (current === "ready" ? current : "error"));
      setError("Не удалось загрузить журнал исследования. Проверьте соединение и повторите.");
    }
  }, [channelId, projectFetch]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      loadController.current?.abort();
      actionController.current?.abort();
    };
  }, [load]);

  // Пока воркер исследует интернет, панель сама подтягивает результат: пользователь
  // не должен угадывать, закончилось ли исследование, и жать «обновить».
  useEffect(() => {
    if (!channelId) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || runStatusRef.current !== "running") return;
      void load({ quiet: true });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [channelId, load]);

  const startResearch = useCallback(async () => {
    if (!channelId || starting) return;
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    setStarting(true);
    setError("");
    setNotice("");
    try {
      const response = await projectFetch(`/api/web-research?channel=${channelId}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "run",
          ...(categories.length ? { categories } : {}),
          language,
        }),
      });
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown; plan?: { queries?: unknown } } | null;
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setError(typeof body?.message === "string" && body.message
          ? body.message
          : response.status === 403
            ? "У вас нет права создавать материалы в этом проекте, поэтому исследование недоступно."
            : "Не удалось запустить исследование интернета. Повторите попытку позже.");
        return;
      }
      const queries = Array.isArray(body?.plan?.queries) ? body.plan.queries.length : 0;
      const message = `Аврора вышла в интернет: ${queries} ${queries === 1 ? "запрос" : queries >= 2 && queries <= 4 ? "запроса" : "запросов"}. Результат появится здесь через минуту.`;
      setNotice(message);
      runStatusRef.current = "running";
      setRun((current) => current ? { ...current, status: "running" } : current);
      onFinished?.(message);
      void load({ quiet: true });
    } catch {
      if (controller.signal.aborted) return;
      setError("Не удалось получить ответ от сервера. Исследование не запущено — повторите попытку.");
    } finally {
      if (!controller.signal.aborted) setStarting(false);
    }
  }, [categories, channelId, language, load, onFinished, projectFetch, starting]);

  const mark = useCallback(async (finding: FindingPayload, action: "dismiss" | "mark_used") => {
    if (!channelId || busyFingerprint) return;
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    setBusyFingerprint(finding.fingerprint);
    setError("");
    try {
      const response = await projectFetch(`/api/web-research?channel=${channelId}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, fingerprints: [finding.fingerprint] }),
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setError(action === "dismiss"
          ? "Не удалось убрать факт. Карточка возвращена — попробуйте ещё раз."
          : "Не удалось отметить факт использованным. Карточка возвращена — попробуйте ещё раз.");
        return;
      }
      setFindings((current) => current.filter((item) => item.fingerprint !== finding.fingerprint));
      setNotice(action === "dismiss" ? "Факт убран из подборки." : "Факт отмечен использованным.");
    } catch {
      if (controller.signal.aborted) return;
      setError("Не удалось получить ответ. Факт остался в списке — повторите действие.");
    } finally {
      if (!controller.signal.aborted) setBusyFingerprint(null);
    }
  }, [busyFingerprint, channelId, projectFetch]);

  if (state === "no_channel") {
    return (
      <section aria-labelledby="web-research-title">
        <Card as="section" className="p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <Globe className="h-5 w-5 shrink-0 text-brand" aria-hidden />
            <h2 id="web-research-title">Аврора в интернете</h2>
          </div>
          <p className="mt-2 max-w-[65ch] text-[14px] leading-relaxed text-text-2">
            Исследование интернета работает для выбранного канала. Подключите канал, чтобы Аврора искала нормы права, бенчмарки и статистику в первоисточниках.
          </p>
        </Card>
      </section>
    );
  }

  const summary = webResearchSummary(run, findings.map(asStoredFinding));
  const queryRows = webResearchQueryRows(run);
  const rejectionGroups = webResearchRejectionGroups(run);
  const citations = webResearchCitationRows(findings.map(asStoredFinding));
  const runStages = (run?.log ?? []).slice(-6).reverse();
  const running = run?.status === "running";
  const runFailed = run?.status === "failed";

  return (
    <section aria-labelledby="web-research-title">
      <Card as="section" className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Globe className="h-5 w-5 shrink-0 text-brand" aria-hidden />
              <h2 id="web-research-title">Аврора в интернете</h2>
              {running ? <Badge tone="brand">Исследование идёт</Badge> : null}
              {summary && summary.rejectionsCount > 0 ? <Badge tone="neutral">Отклонено: {summary.rejectionsCount}</Badge> : null}
            </div>
            <p className="mt-1 max-w-[70ch] text-[14px] leading-relaxed text-text-3">
              Аврора читает открытые страницы и берёт в работу только те факты, где есть ссылка, дословная цитата и дата публикации. Остальное остаётся в журнале с причиной отказа.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
            <Button
              variant="primary"
              className="min-h-11 whitespace-normal text-center"
              loading={starting}
              disabled={running}
              onClick={() => void startResearch()}
            >
              <Search className="h-4 w-4 shrink-0" aria-hidden />
              {running ? "Исследование идёт" : "Исследовать интернет"}
            </Button>
            <Button
              variant="secondary"
              size="icon"
              aria-label="Обновить журнал исследования"
              disabled={state === "loading" || starting}
              onClick={() => void load()}
            >
              <RefreshCw className="h-5 w-5" aria-hidden />
            </Button>
          </div>
        </div>

        <div className="px-5 py-4 sm:px-6">
          {state === "loading" ? (
            <div role="status" aria-busy="true" className="space-y-3">
              <div className="skeleton h-5 w-72 rounded-xs" />
              <div className="skeleton h-20 rounded-sm" />
              <span className="sr-only">Загружаем журнал исследования интернета</span>
            </div>
          ) : null}

          {error ? (
            <p className="mb-3 rounded-sm border border-danger/25 bg-danger-soft px-4 py-3 text-[14px] font-semibold text-danger-text" role="alert">{error}</p>
          ) : null}
          {notice ? (
            <p className="mb-3 rounded-sm border border-success/25 bg-success-soft px-4 py-3 text-[14px] text-success-text" role="status">{notice}</p>
          ) : null}

          {state !== "loading" && !run ? (
            <div className="rounded-sm bg-surface-inset px-4 py-5">
              <p className="text-[15px] font-semibold text-text">Аврора ещё не выходила в интернет по этому каналу</p>
              <p className="mt-2 max-w-[70ch] text-[14px] leading-relaxed text-text-2">
                Нажмите «Исследовать интернет» — Аврора соберёт запросы по теме канала, откроет первоисточники и покажет здесь каждый принятый факт и каждую причину отказа.
              </p>
            </div>
          ) : null}

          {run ? (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[14px] font-semibold text-text-2">{summary?.sentence}</p>
                <p className="type-caption text-text-3">
                  {summary ? `${summary.statusLabel} · ${webResearchTimeLabel(run.startedAt)}` : null}
                  {summary?.spentSeconds ? ` · ${summary.spentSeconds} с` : ""}
                </p>
              </div>
              {run.topic ? <p className="mt-1 text-[13px] text-text-3">Тема исследования: {run.topic}</p> : null}
              {runFailed && run.error ? (
                <p className="mt-3 rounded-sm border border-fire/25 bg-fire-soft px-4 py-3 text-[13px] text-fire-text" role="alert">
                  Исследование прервано: {stageMessage(run.error)}
                </p>
              ) : null}

              {runStages.length > 0 ? (
                <ul className="mt-3 space-y-1 text-[13px] leading-relaxed text-text-3">
                  {runStages.map((stage, index) => (
                    <li key={`${stage.at}:${index}`} className="flex flex-wrap gap-x-2">
                      <span className="font-semibold text-text-2">{webResearchStepLabel(stage.step)}</span>
                      <span className="break-words">{stageMessage(stage.message)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {queryRows.length > 0 ? (
                <details className="group mt-4 border-t border-line pt-3">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xs text-[14px] font-semibold text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
                    <span>Запросы исследования · {queryRows.length}</span>
                    <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
                  </summary>
                  <ol className="mt-2 space-y-1.5">
                    {queryRows.map((query) => (
                      <li key={query.id} className="flex flex-wrap items-center gap-2 text-[13px] leading-relaxed text-text-2">
                        <span className="break-words">{query.text}</span>
                        <Badge tone="neutral">{query.categoryLabel}</Badge>
                        {query.siteScoped ? <Badge tone="brand">Первоисточники</Badge> : null}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}

              {rejectionGroups.length > 0 ? (
                <details className="group mt-2 border-t border-line pt-3" open>
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xs text-[14px] font-semibold text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
                    <span>Полный лог исследования · отклонено {summary?.rejectionsCount ?? run.rejectionsCount}</span>
                    <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
                  </summary>
                  <ul className="mt-2 space-y-2">
                    {rejectionGroups.map((group) => (
                      <li key={group.code} className="rounded-sm border border-line bg-surface-inset px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-[14px] font-semibold text-text">{group.label}</p>
                          <Badge tone="neutral">{group.count}</Badge>
                        </div>
                        {group.details.length > 0 ? (
                          <ul className="mt-2 space-y-1 text-[13px] leading-relaxed text-text-2">
                            {group.details.map((detail, index) => <li key={index} className="break-words">«{detail}»</li>)}
                          </ul>
                        ) : null}
                        {group.domains.length > 0 ? (
                          <p className="mt-2 break-all text-[12px] text-text-3">Источники: {group.domains.join(", ")}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[12px] leading-relaxed text-text-3">
                    Отклонённый факт не попадает в материалы: без ссылки, дословной цитаты или даты публикации Аврора его не использует.
                  </p>
                </details>
              ) : null}

              <div className="mt-4 border-t border-line pt-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-[15px] font-semibold text-text">Факты, прошедшие проверку</h3>
                  <p className="type-caption text-text-3">
                    {citations.length > 0 ? `Показано: ${citations.length}` : "Пока пусто"}
                    {summary && summary.candidates > 0 ? ` · рассмотрено источников: ${summary.candidates}` : ""}
                  </p>
                </div>
                {citations.length === 0 ? (
                  <p className="mt-2 max-w-[70ch] text-[14px] leading-relaxed text-text-2">
                    {runFailed
                      ? "Запуск прервался до проверки фактов. Повторите исследование — журнал сохранится."
                      : running
                        ? "Аврора ещё читает страницы. Факты появятся здесь, как только пройдут проверку цитаты."
                        : "Ни один факт не прошёл ворота достоверности. Причины отказа перечислены в полном логе выше — это честный результат, а не пустой экран."}
                  </p>
                ) : (
                  <ul className="mt-3 space-y-3">
                    {citations.map((row) => (
                      <CitationCard
                        key={row.fingerprint}
                        row={row}
                        busy={busyFingerprint === row.fingerprint}
                        onDismiss={() => {
                          const finding = findings.find((item) => item.fingerprint === row.fingerprint);
                          if (finding) void mark(finding, "dismiss");
                        }}
                        onMarkUsed={() => {
                          const finding = findings.find((item) => item.fingerprint === row.fingerprint);
                          if (finding) void mark(finding, "mark_used");
                        }}
                      />
                    ))}
                  </ul>
                )}
                {run.findingsCount > citations.length ? (
                  <p className="mt-3 text-[13px] text-text-3">
                    Всего в базе канала: {run.findingsCount}. Часть фактов скрыта фильтром свежести.
                  </p>
                ) : null}
              </div>

              <details className="group mt-4 border-t border-line pt-3">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xs text-[14px] font-semibold text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
                  <span>Настройки следующего исследования</span>
                  <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <div className="mt-2 space-y-3">
                  <fieldset>
                    <legend className="type-caption font-semibold text-text-2">Какие факты искать</legend>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                      {CATEGORY_OPTIONS.map((option) => (
                        <label key={option.value} className="inline-flex min-h-11 items-center gap-2 text-[14px] text-text-2">
                          <input
                            type="checkbox"
                            className="h-5 w-5 rounded-xs border border-line-strong"
                            checked={categories.includes(option.value)}
                            onChange={(event) => setCategories((current) => event.target.checked
                              ? [...current, option.value]
                              : current.filter((value) => value !== option.value))}
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <label className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                    <span className="type-caption shrink-0 font-semibold text-text-2">Язык источников</span>
                    <select
                      value={language}
                      onChange={(event) => setLanguage(event.target.value as "RU" | "EN" | "ANY")}
                      className="h-12 w-full min-w-0 rounded-xs border border-line bg-surface px-4 text-base font-semibold text-text transition-colors hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:w-64 sm:text-sm"
                    >
                      {LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <p className="text-[12px] leading-relaxed text-text-3">
                    Если ничего не выбирать, Аврора возьмёт нормы права по теме канала. Тема берётся из профиля канала.
                  </p>
                </div>
              </details>
            </>
          ) : null}
        </div>
      </Card>
    </section>
  );
}

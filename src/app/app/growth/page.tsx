"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight, BarChart3, Check, ChevronDown, Circle, CircleAlert, CircleCheck,
  Clock3, Compass, Database, ExternalLink, FileText, Lightbulb, Radio,
  Sparkles, Target,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { EvidenceCard } from "@/components/app/evidence-card";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import type { GrowthBoard, GrowthConfidence, GrowthLifecycle, GrowthMoveRecord } from "@/lib/growth";
import { createWorkspaceRequestFence, isAbortError } from "@/lib/client-workspace-isolation";
import { growthRequestIdentity, isCurrentGrowthRequest } from "@/lib/growth-request-race";
import { useStore } from "@/lib/store";
import { cn, fmtNum } from "@/lib/utils";

const CONFIDENCE: Record<GrowthConfidence, { label: string; tone: "success" | "fire" | "neutral" }> = {
  answered: { label: "Подтверждено данными", tone: "success" },
  hypothesis: { label: "Нужно проверить", tone: "fire" },
  insufficient_data: { label: "Недостаточно данных", tone: "neutral" },
};

const LIFECYCLE: Record<GrowthLifecycle, { label: string; icon: typeof Circle; tone: "success" | "brand" | "neutral" }> = {
  open: { label: "Не начат", icon: Circle, tone: "neutral" },
  draft_created: { label: "Черновик создан", icon: FileText, tone: "brand" },
  plan_created: { label: "План создан", icon: FileText, tone: "brand" },
  scheduled: { label: "Запланирован", icon: Clock3, tone: "brand" },
  published: { label: "Опубликован", icon: Radio, tone: "brand" },
  collecting: { label: "Собираем данные", icon: Clock3, tone: "brand" },
  measured: { label: "Измерен", icon: CircleCheck, tone: "success" },
  done: { label: "Завершён", icon: Check, tone: "success" },
  skipped: { label: "Не актуально", icon: Circle, tone: "neutral" },
};

function ConfidenceBadge({ confidence }: { confidence: GrowthConfidence }) {
  const item = CONFIDENCE[confidence];
  const Icon = confidence === "answered" ? CircleCheck : confidence === "hypothesis" ? Lightbulb : CircleAlert;
  return <Badge tone={item.tone}><Icon className="h-3.5 w-3.5" aria-hidden />{item.label}</Badge>;
}

function LifecycleBadge({ lifecycle }: { lifecycle: GrowthLifecycle }) {
  const item = LIFECYCLE[lifecycle];
  const Icon = item.icon;
  return <Badge tone={item.tone}><Icon className="h-3.5 w-3.5" aria-hidden />{item.label}</Badge>;
}

function moveCta(move: GrowthMoveRecord): string {
  if (move.kind === "topic") return "Создать пост по сигналу";
  if (move.kind === "rhythm") return "Собрать план недели";
  if (move.kind === "offer") return "Создать пост об услуге";
  return "Ответить аудитории";
}

function evidenceSourceLabel(move: GrowthMoveRecord): string {
  const { sourceType, sourceLabel } = move.evidence;
  if (!sourceLabel || sourceLabel.toLocaleLowerCase("ru") === sourceType.toLocaleLowerCase("ru")) {
    return sourceType;
  }
  return `${sourceType} · ${sourceLabel}`;
}

function telemetry(event: "growth.board.viewed" | "growth.evidence.opened" | "growth.move.started", input: { moveId?: number; channelId?: number | null }) {
  void fetch("/api/growth/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, ...input }),
    keepalive: true,
  }).catch(() => undefined);
}

function Evidence({ move, compact = false }: { move: GrowthMoveRecord; compact?: boolean }) {
  const evidence = move.evidence;
  return (
    <div className={cn("grid min-w-0 gap-4", compact ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3")}>
      <div className="min-w-0">
        <p className="type-caption font-semibold text-text-3">Источник</p>
        <p className="mt-1 break-words text-[14px] leading-relaxed text-text">
          {evidenceSourceLabel(move)}
        </p>
        {evidence.href && (
          <Link className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-brand underline-offset-4 hover:underline focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15" href={evidence.href}>
            Открыть источник <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </div>
      <div className="min-w-0">
        <p className="type-caption font-semibold text-text-3">Наблюдение</p>
        <p className="mt-1 break-words text-[14px] leading-relaxed text-text">{evidence.metricLabel}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-text-3">
          {evidence.sampleSize == null ? "Размер выборки недоступен" : `Выборка: ${evidence.sampleSize}`}
          {evidence.periodLabel ? ` · ${evidence.periodLabel}` : ""}
        </p>
      </div>
      {!compact && (
        <div className="min-w-0 sm:col-span-2 lg:col-span-1">
          <p className="type-caption font-semibold text-text-3">Как считаем</p>
          <p className="mt-1 max-w-[68ch] text-[14px] leading-relaxed text-text-2">{evidence.methodology}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-text-3">{evidence.freshnessLabel}</p>
        </div>
      )}
    </div>
  );
}

function OutcomeCheck({ move }: { move: GrowthMoveRecord }) {
  const outcome = move.outcome;
  if (!outcome) {
    return (
      <li className="space-y-3 rounded-sm bg-surface-inset p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="min-w-0 text-[15px] font-semibold leading-snug text-text">{move.title}</h3>
          <LifecycleBadge lifecycle={move.lifecycle} />
        </div>
        <p className="text-[14px] leading-relaxed text-text-2">У старого хода нет связанного материала. Отсутствие связи не считаем нулевым результатом.</p>
      </li>
    );
  }
  return (
    <li className="space-y-4 rounded-sm bg-surface-inset p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold leading-snug text-text">{move.title}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-text-3">
            {outcome.artifactLabel}{outcome.publishedAt ? ` · опубликован ${new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(new Date(outcome.publishedAt))}` : " · ещё не опубликован"}
          </p>
        </div>
        <LifecycleBadge lifecycle={move.lifecycle} />
      </div>
      {outcome.maturity === "collecting" && (
        <div role="status" className="rounded-xs border border-line bg-surface p-3">
          <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-text">
            <Clock3 className="h-4 w-4 text-brand" aria-hidden />Собираем данные · прошло <span className="tabular-nums">{outcome.elapsedHours} из {outcome.checkpointHours} часов</span>
          </p>
        </div>
      )}
      <dl className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
        <div><dt className="type-caption text-text-3">Просмотры</dt><dd className="mt-1 break-words font-semibold tabular-nums text-text">{outcome.views == null ? "Недоступны" : fmtNum(outcome.views)}</dd></div>
        <div><dt className="type-caption text-text-3">Реакции</dt><dd className="mt-1 break-words font-semibold tabular-nums text-text">{outcome.reactions == null ? "Недоступны" : fmtNum(outcome.reactions)}</dd></div>
        <div><dt className="type-caption text-text-3">Медиана базы</dt><dd className="mt-1 break-words font-semibold tabular-nums text-text">{outcome.baselineViews == null ? "Мало данных" : fmtNum(Math.round(outcome.baselineViews))}</dd></div>
        <div><dt className="type-caption text-text-3">Конверсии</dt><dd className="mt-1 break-words font-semibold tabular-nums text-text">{outcome.trackingAvailable ? fmtNum(outcome.conversions ?? 0) : "Tracking не подключён"}</dd></div>
      </dl>
      <p className="max-w-[68ch] text-[14px] leading-relaxed text-text">{outcome.conclusion}</p>
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[13px] font-semibold text-text-2 focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15">
          Методика результата <ChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
        </summary>
        <p className="max-w-[68ch] pb-1 text-[13px] leading-relaxed text-text-3">{outcome.methodology} Выборка: <span className="tabular-nums">{outcome.sampleSize}</span> · качество {outcome.dataQuality === "high" ? "высокое" : outcome.dataQuality === "medium" ? "среднее" : "низкое"}.</p>
      </details>
    </li>
  );
}

function GrowthSkeleton() {
  return <div className="space-y-8" aria-hidden><div className="skeleton h-36 w-full rounded-md" /><div className="skeleton min-h-72 w-full rounded-md" /><div className="space-y-3"><div className="skeleton h-6 w-48 rounded-xs" /><div className="skeleton h-36 w-full rounded-md" /></div><div className="space-y-3"><div className="skeleton h-6 w-56 rounded-xs" /><div className="skeleton h-44 w-full rounded-md" /></div></div>;
}

export default function GrowthPage() {
  const store = useStore();
  const [picked, setPicked] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const value = Number(new URLSearchParams(window.location.search).get("channel"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, picked);
  const [board, setBoard] = useState<GrowthBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [liveMessage, setLiveMessage] = useState("");
  const [requestFence] = useState(createWorkspaceRequestFence);
  const channelRef = useRef(channelId);

  const load = useCallback(async () => {
    const requestedChannelId = channelRef.current;
    if (!requestedChannelId) {
      requestFence.invalidate(); setBoard(null); setLoadError(false); setLoading(false); setLiveMessage(""); return;
    }
    setBoard((current) => current?.channelId === requestedChannelId ? current : null);
    const ticket = requestFence.start(growthRequestIdentity(requestedChannelId));
    const isCurrent = () => isCurrentGrowthRequest(requestFence, ticket, channelRef.current);
    setLoading(true); setLoadError(false); setLiveMessage("Загружаем траекторию выбранного канала.");
    try {
      const response = await fetch(`/api/growth?channel=${requestedChannelId}`, { method: "POST", cache: "no-store", signal: ticket.signal });
      const next = (await response.json().catch(() => null)) as GrowthBoard | null;
      if (!response.ok || !next) throw new Error("growth_unavailable");
      if (!isCurrent()) return;
      setBoard(next); setLiveMessage(`Траектория загружена. Ходов: ${next.moves.length}.`);
      telemetry("growth.board.viewed", { channelId: requestedChannelId });
    } catch (error) {
      if (isAbortError(error) || !isCurrent()) return;
      setLoadError(true); setLiveMessage("Не удалось загрузить рекомендации. Можно попробовать снова.");
    } finally { if (isCurrent()) setLoading(false); }
  }, [requestFence]);

  useEffect(() => { channelRef.current = channelId; }, [channelId]);
  useEffect(() => { void load(); return () => requestFence.invalidate(); }, [channelId, load, requestFence]);

  async function skipMove(move: GrowthMoveRecord) {
    if (busyId) return;
    setBusyId(move.id);
    try {
      const response = await fetch(`/api/growth/moves/${move.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "skip" }) });
      if (!response.ok) throw new Error("update_failed");
      setLiveMessage(`Ход «${move.title}» отмечен как неактуальный.`); await load();
    } catch { store.toast({ kind: "danger", title: "Не удалось пропустить ход", body: "Рекомендация не изменилась. Попробуй снова." }); }
    finally { setBusyId(null); }
  }

  const visibleBoard = board?.channelId === channelId ? board : null;
  const primary = visibleBoard?.moves.find((move) => move.lifecycle === "open") ?? null;
  const secondary = visibleBoard?.moves.filter((move) => move.id !== primary?.id) ?? [];

  return (
    <AppShell title="Развитие" subtitle="Лучший ход недели, доказательства и реальный результат — без обещаний роста.">
      <ChannelPicker channels={tgChannels} value={channelId} onChange={setPicked} label="Канал" className="mb-6" />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveMessage}</div>
      <div role="region" aria-busy={loading} aria-label="Траектория развития" className="min-w-0">
        {loading && !visibleBoard && <GrowthSkeleton />}
        {loadError && <div role="alert" className="mb-6 flex flex-col gap-3 rounded-sm border border-danger/20 bg-danger-soft p-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-[14px] leading-relaxed text-danger-text">Не удалось загрузить рекомендации. Сохранённые данные остаются на экране.</p><Button variant="secondary" size="sm" onClick={() => void load()}>Попробовать снова</Button></div>}
        {!loading && !loadError && (!channelId || (visibleBoard && !visibleBoard.hasChannel)) && <Card><EmptyState icon={<Compass className="h-6 w-6" aria-hidden />} title="Подключи канал" body="Аврора соберёт сигналы, выберет первый ход и начнёт измерять результат." action={<Link href="/app/onboarding" className={buttonClassName({ variant: "primary", size: "sm" })}>Подключить канал</Link>} /></Card>}

        {visibleBoard?.hasChannel && <div className="space-y-10">
          <section aria-labelledby="growth-trajectory-heading"><Card className="overflow-hidden"><div className="grid min-w-0 gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(14rem,0.7fr)] lg:items-center">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge tone="brand"><Sparkles className="h-3.5 w-3.5" aria-hidden />Траектория недели</Badge><span className="type-caption text-text-3">{visibleBoard.periodLabel}</span></div><h2 id="growth-trajectory-heading" className="mt-4 text-balance text-[22px] font-bold leading-tight tracking-tight text-text sm:text-[26px]">{visibleBoard.goal ? `Цель: ${visibleBoard.goal}` : "Цель канала пока не заполнена"}</h2>{!visibleBoard.goal && <Link href={`/app/autopilot/brief?channel=${visibleBoard.channelId}`} className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-[14px] font-semibold text-brand underline-offset-4 hover:underline focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15">Добавить цель канала <ArrowRight className="h-4 w-4" aria-hidden /></Link>}<p className="mt-4 max-w-[68ch] text-pretty text-[15px] leading-relaxed text-text-2">{visibleBoard.weeklyInsight}</p></div>
            <div className="rounded-sm bg-surface-inset p-4"><div className="flex items-end justify-between gap-3"><div><p className="type-caption text-text-3">Выполнение ходов</p><p className="mt-1 text-[26px] font-bold leading-none tabular-nums text-text">{visibleBoard.completedMoves} из {visibleBoard.totalMoves}</p></div><Target className="h-7 w-7 text-brand" aria-hidden /></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-label="Выполнение ходов недели" aria-valuemin={0} aria-valuemax={Math.max(visibleBoard.totalMoves, 1)} aria-valuenow={visibleBoard.completedMoves}><div className="h-full rounded-full bg-brand" style={{ width: `${visibleBoard.totalMoves ? (visibleBoard.completedMoves / visibleBoard.totalMoves) * 100 : 0}%` }} /></div><p className="mt-3 flex items-center gap-2 text-[13px] leading-relaxed text-text-3"><Database className="h-4 w-4 shrink-0" aria-hidden />{visibleBoard.dataFreshness}</p></div>
          </div></Card></section>

          <section aria-labelledby="growth-primary-heading"><div className="mb-4"><p className="type-caption font-semibold text-brand">Лучший следующий шаг</p><h2 id="growth-primary-heading" className="mt-1 text-balance text-[22px] font-bold leading-tight tracking-tight text-text">Главный ход недели</h2></div>
            {primary ? <Card className="overflow-hidden ring-1 ring-brand/20"><div className="grid min-w-0 gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(15rem,0.7fr)]"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><ConfidenceBadge confidence={primary.confidence} /><LifecycleBadge lifecycle={primary.lifecycle} /></div><h3 className="mt-4 max-w-[24ch] text-balance text-[26px] font-bold leading-[1.12] tracking-tight text-text sm:text-[32px]">{primary.title}</h3><p className="mt-4 max-w-[68ch] text-pretty text-[15px] leading-relaxed text-text-2">{primary.reason}</p><p className="mt-3 max-w-[68ch] text-[14px] leading-relaxed text-text"><span className="font-semibold">Проверяем:</span> {primary.evidence.metricLabel}</p><div className="mt-6 flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center"><Link href={primary.actionHref} onClick={() => telemetry("growth.move.started", { moveId: primary.id, channelId: visibleBoard.channelId })} className={buttonClassName({ variant: "primary", size: "md", className: "w-full whitespace-normal text-center sm:w-auto" })}><Sparkles className="h-4 w-4 shrink-0" aria-hidden />{moveCta(primary)}</Link><Button variant="ghost" size="sm" disabled={busyId !== null} loading={busyId === primary.id} onClick={() => void skipMove(primary)}>Не актуально</Button>{primary.artifactDraftId && <EvidenceCard kind="draft" id={primary.artifactDraftId} compact />}</div></div><div className="min-w-0 rounded-sm bg-surface-inset p-4"><dl className="space-y-4"><div><dt className="type-caption text-text-3">Влияние</dt><dd className="mt-1 text-[14px] font-semibold text-text">{primary.evidence.opportunityStrength >= 4 ? "Высокое" : primary.evidence.opportunityStrength >= 2 ? "Среднее" : "Нужно проверить"}</dd></div><div><dt className="type-caption text-text-3">Усилие</dt><dd className="mt-1 text-[14px] font-semibold text-text">{primary.evidence.effort}</dd></div><div><dt className="type-caption text-text-3">Основание</dt><dd className="mt-1 break-words text-[14px] leading-relaxed text-text">{evidenceSourceLabel(primary)}</dd></div></dl></div></div><details className="group border-t border-line px-5 sm:px-6" onToggle={(event) => { if (event.currentTarget.open) telemetry("growth.evidence.opened", { moveId: primary.id, channelId: visibleBoard.channelId }); }}><summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 font-semibold text-text focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15"><span className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-brand" aria-hidden />Почему Аврора так решила</span><ChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" aria-hidden /></summary><div className="pb-6"><Evidence move={primary} /></div></details></Card>
            : <Card><EmptyState icon={<CircleCheck className="h-6 w-6" aria-hidden />} title={visibleBoard.moves.length ? "Все ходы недели закрыты" : "Пока нет подтверждённого хода"} body={visibleBoard.moves.length ? "Аврора следит за публикациями и результатом. Новый лучший ход появится с новым сигналом." : "Добавь данные ниже — Аврора соберёт устойчивую рекомендацию без догадок."} /></Card>}
          </section>

          {secondary.length > 0 && <section aria-labelledby="growth-more-heading"><h2 id="growth-more-heading" className="text-balance text-[20px] font-bold leading-tight text-text">Ещё ходы этой недели</h2><ul className="mt-5 space-y-7">{secondary.map((move) => <li key={move.id} className="min-w-0"><div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><LifecycleBadge lifecycle={move.lifecycle} /><ConfidenceBadge confidence={move.confidence} /></div><h3 className="mt-3 text-balance text-[17px] font-semibold leading-snug text-text">{move.title}</h3><p className="mt-2 max-w-[68ch] text-[14px] leading-relaxed text-text-2">{move.reason}</p><p className="mt-2 text-[13px] leading-relaxed text-text-3"><span className="font-semibold text-text-2">Критерий:</span> {move.evidence.metricLabel}</p></div><div className="flex shrink-0 flex-wrap items-center gap-2">{move.lifecycle === "open" && <Link href={move.actionHref} onClick={() => telemetry("growth.move.started", { moveId: move.id, channelId: visibleBoard.channelId })} className={buttonClassName({ variant: "secondary", size: "sm", className: "whitespace-normal" })}>{moveCta(move)}</Link>}{move.lifecycle === "open" && <Button variant="ghost" size="sm" disabled={busyId !== null} loading={busyId === move.id} onClick={() => void skipMove(move)}>Не актуально</Button>}</div></div><details className="group mt-3" onToggle={(event) => { if (event.currentTarget.open) telemetry("growth.evidence.opened", { moveId: move.id, channelId: visibleBoard.channelId }); }}><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[13px] font-semibold text-text-2 focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15">Источник и методика <ChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" aria-hidden /></summary><div className="rounded-sm bg-surface-inset p-4"><Evidence move={move} compact /><p className="mt-3 max-w-[68ch] text-[13px] leading-relaxed text-text-3">{move.evidence.methodology} · {move.evidence.freshnessLabel}</p></div></details></li>)}</ul></section>}

          {visibleBoard.readiness.length > 0 && <section aria-labelledby="growth-readiness-heading"><Card><div className="p-5 sm:p-6"><h2 id="growth-readiness-heading" className="text-balance text-[20px] font-bold leading-tight text-text">Сделать рекомендации точнее</h2><p className="mt-2 max-w-[68ch] text-[14px] leading-relaxed text-text-2">Только незавершённые шаги, которые откроют Авроре новые подтверждённые сигналы.</p><ul className="mt-5 grid min-w-0 gap-4 lg:grid-cols-2">{visibleBoard.readiness.map((item) => <li key={item.id} className="min-w-0 rounded-sm bg-surface-inset p-4"><h3 className="text-[15px] font-semibold text-text">{item.title}</h3><p className="mt-2 text-[14px] leading-relaxed text-text-2">{item.body}</p><Link href={item.href} className={buttonClassName({ variant: "secondary", size: "sm", className: "mt-4 whitespace-normal" })}>{item.cta}<ArrowRight className="h-4 w-4" aria-hidden /></Link></li>)}</ul></div></Card></section>}

          <section aria-labelledby="growth-results-heading"><h2 id="growth-results-heading" className="text-balance text-[20px] font-bold leading-tight text-text">Результаты прошлой недели</h2><p className="mt-2 max-w-[68ch] text-[14px] leading-relaxed text-text-2">Показываем реальную публикацию, зрелость данных и сравнение только с сопоставимой базой.</p>{visibleBoard.previousMoves.length ? <ul className="mt-5 space-y-4">{visibleBoard.previousMoves.map((move) => <OutcomeCheck key={move.id} move={move} />)}</ul> : <Card className="mt-5"><EmptyState icon={<BarChart3 className="h-6 w-6" aria-hidden />} title="Прошлой недели ещё нет" body="После первого недельного цикла здесь появятся созданный материал, публикация и честный чек результата." /></Card>}</section>

          <section aria-labelledby="growth-learning-heading"><Card><div className="flex min-w-0 gap-4 p-5 sm:p-6"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm bg-info-soft text-brand"><Lightbulb className="h-5 w-5" aria-hidden /></div><div className="min-w-0"><h2 id="growth-learning-heading" className="text-balance text-[20px] font-bold leading-tight text-text">Чему Аврора научилась</h2><p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-text">{visibleBoard.learning.text}</p><p className="mt-2 max-w-[68ch] text-[13px] leading-relaxed text-text-3">Основание: {visibleBoard.learning.basis}</p></div></div></Card></section>
        </div>}
      </div>
    </AppShell>
  );
}

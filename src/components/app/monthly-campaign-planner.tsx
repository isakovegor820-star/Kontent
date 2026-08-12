"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  FilePenLine,
  GripVertical,
  Loader2,
  RefreshCw,
  Send,
} from "lucide-react";

import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { Button } from "@/components/ui/button";
import { Badge, Checkbox, Field, Input, Textarea } from "@/components/ui/primitives";
import { RUBRICS, type Brief } from "@/lib/brief";
import {
  campaignMonthRange,
  equalPracticeMix,
  parseMonthlyCampaignDetail,
  parseMonthlyCampaignList,
  type MonthlyCampaignClientDetail,
  type MonthlyCampaignClientItem,
  type MonthlyCampaignClientPlan,
  type MonthlyCampaignClientSummary,
  type MonthlyCampaignRole,
} from "@/lib/monthly-campaign-client";
import { useStore } from "@/lib/store";
import { cn, plural } from "@/lib/utils";

type ProjectContext = {
  projectId: number;
  name: string;
  timezone: string;
  role: MonthlyCampaignRole;
};

type CampaignForm = {
  month: string;
  goal: string;
  audience: string;
  rubrics: string[];
  practices: string;
  funnelStages: ("awareness" | "consideration" | "consultation")[];
  postsPerWeek: number;
  cta: string;
  metrics: string[];
  importantDate: string;
  importantDateLabel: string;
};

const FUNNELS = [
  { value: "awareness" as const, label: "Узнаваемость" },
  { value: "consideration" as const, label: "Выбор решения" },
  { value: "consultation" as const, label: "Обращение" },
];

const METRICS = ["Просмотры", "Переходы", "Подтверждённые обращения"];

const STATUS_COPY = {
  draft: { label: "Черновик", tone: "neutral" as const },
  in_review: { label: "На согласовании", tone: "brand" as const },
  approved: { label: "Согласован", tone: "success" as const },
};

const REGENERATION_TERMINAL = new Set(["completed", "stale", "failed", "cancelled"]);

function nextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 7);
}

function blankForm(): CampaignForm {
  return {
    month: "",
    goal: "Системно раскрывать практику и приводить читателя к предметному обращению",
    audience: "",
    rubrics: RUBRICS.slice(0, 3).map((rubric) => rubric.label),
    practices: "",
    funnelStages: ["awareness", "consideration", "consultation"],
    postsPerWeek: 5,
    cta: "Обсудить задачу с командой",
    metrics: ["Переходы", "Подтверждённые обращения"],
    importantDate: "",
    importantDateLabel: "",
  };
}

function dateLabel(date: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    // A PostgreSQL DATE is a calendar value, not an instant. Formatting in UTC keeps
    // the same day even for project zones at UTC+12…+14.
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function periodLabel(campaign: MonthlyCampaignClientSummary): string {
  const format = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `${format.format(new Date(`${campaign.startsOn}T00:00:00.000Z`))} — ${format.format(new Date(`${campaign.endsOn}T00:00:00.000Z`))}`;
}

function apiError(code: string | undefined): string {
  const messages: Record<string, string> = {
    invalid_period: "Выбери полный календарный месяц.",
    invalid_rubrics: "Выбери от трёх до шести разных рубрик.",
    invalid_practice_mix: "Укажи хотя бы одно направление практики.",
    invalid_audience: "Укажи аудиторию кампании.",
    invalid_frequency: "Выбери частоту от одного до четырнадцати материалов в неделю.",
    duplicate_topics: "Несколько тем слишком похожи на прошлые материалы. Пересобери план.",
    version_conflict: "План изменился в другой вкладке. Данные обновлены — повтори действие.",
    regeneration_in_progress: "Дождись завершения пересборки. Аврора покажет новую версию плана автоматически.",
    stale_campaign: "Профиль проекта изменился. Обнови кампанию перед продолжением.",
    access_denied: "Для этого действия недостаточно прав в выбранном проекте.",
    worker_unavailable: "Фоновая подготовка сейчас недоступна. Запусти приложение вместе с обработчиком задач и повтори.",
    engine_unavailable: "Для выбранной модели не настроено подключение.",
    no_brief: "Сначала настрой Аврору для выбранного канала.",
  };
  return messages[code ?? ""] ?? "Действие не выполнено. Введённые данные сохранены — попробуй ещё раз.";
}

function chunkWeeks(items: MonthlyCampaignClientItem[]): MonthlyCampaignClientItem[][] {
  const weeks: MonthlyCampaignClientItem[][] = [];
  for (let index = 0; index < items.length; index += 7) weeks.push(items.slice(index, index + 7));
  return weeks;
}

function latestPlan(detail: MonthlyCampaignClientDetail | null): MonthlyCampaignClientPlan | null {
  return detail?.plans[0] ?? null;
}

export function MonthlyCampaignPlanner() {
  const store = useStore();
  const [pickedChannel, setPickedChannel] = useState<number | null>(null);
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, pickedChannel);
  const [project, setProject] = useState<ProjectContext | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [campaigns, setCampaigns] = useState<MonthlyCampaignClientSummary[]>([]);
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MonthlyCampaignClientDetail | null>(null);
  const [form, setForm] = useState<CampaignForm>(blankForm);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const creationAttempt = useRef<{ fingerprint: string; campaignKey: string; planKey: string } | null>(null);
  const appliedBriefChannel = useRef<number | null>(null);
  const monthRef = useRef<HTMLInputElement>(null);
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const audienceRef = useRef<HTMLInputElement>(null);
  const practicesRef = useRef<HTMLInputElement>(null);
  const importantDateLabelRef = useRef<HTMLInputElement>(null);
  const [creationAttempted, setCreationAttempted] = useState(false);

  const loadCampaigns = useCallback(async (preferredId?: number | null) => {
    const response = await fetch("/api/monthly-campaigns", { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    const parsed = parseMonthlyCampaignList(payload);
    if (!response.ok || !parsed) throw new Error("campaign_list_unavailable");
    setCampaigns(parsed);
    setCampaignId((current) => {
      const wanted = preferredId ?? current;
      return wanted && parsed.some((campaign) => campaign.id === wanted)
        ? wanted
        : parsed[0]?.id ?? null;
    });
  }, []);

  const loadDetail = useCallback(async (id: number, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/monthly-campaigns/${id}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      const parsed = parseMonthlyCampaignDetail(payload);
      if (!response.ok || !parsed) throw new Error("campaign_detail_unavailable");
      setDetail(parsed);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/projects/current", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/monthly-campaigns", { cache: "no-store" }).then((response) => response.json()),
    ]).then(([projectPayload, campaignPayload]) => {
      if (cancelled) return;
      const source = projectPayload?.project;
      const parsedCampaigns = parseMonthlyCampaignList(campaignPayload);
      if (!source || !Number.isSafeInteger(Number(source.projectId))
          || typeof source.timezone !== "string"
          || !["owner", "author", "approver", "publisher"].includes(source.role)
          || !parsedCampaigns) throw new Error("monthly_initial_state_invalid");
      setProject({
        projectId: Number(source.projectId),
        name: typeof source.name === "string" ? source.name : "Текущий проект",
        timezone: source.timezone,
        role: source.role,
      });
      setCampaigns(parsedCampaigns);
      const requestedCampaignId = Number(new URLSearchParams(window.location.search).get("campaign"));
      setCampaignId(
        Number.isSafeInteger(requestedCampaignId)
          && parsedCampaigns.some((campaign) => campaign.id === requestedCampaignId)
          ? requestedCampaignId
          : parsedCampaigns[0]?.id ?? null,
      );
      setForm((current) => ({ ...current, month: current.month || nextMonth() }));
    }).catch(() => {
      if (!cancelled) setMessage({ kind: "error", text: "Не удалось загрузить кампании. Обнови страницу." });
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    queueMicrotask(() => void loadDetail(campaignId).catch(() => {
      if (!cancelled) setMessage({ kind: "error", text: "Не удалось открыть кампанию. Выбери её ещё раз." });
    }));
    return () => {
      cancelled = true;
    };
  }, [campaignId, loadDetail]);

  useEffect(() => {
    if (!channelId) return;
    const controller = new AbortController();
    void fetch(`/api/autopilot/brief?channel=${channelId}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.json())
      .then((payload) => {
        if (controller.signal.aborted) return;
        const nextBrief = payload?.brief && typeof payload.brief === "object" ? payload.brief as Brief : null;
        setBrief(nextBrief);
        if (!nextBrief || appliedBriefChannel.current === channelId) return;
        appliedBriefChannel.current = channelId;
        setForm((current) => ({
          ...current,
          audience: nextBrief.audience || current.audience,
          goal: nextBrief.goal || current.goal,
          rubrics: nextBrief.rubrics.length >= 3
            ? nextBrief.rubrics.slice(0, 6)
            : current.rubrics,
          practices: nextBrief.niche || current.practices,
          cta: nextBrief.cta || current.cta,
        }));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [channelId]);

  const plan = latestPlan(detail);
  const hasActiveRegeneration = detail?.regenerations.some((operation) =>
    !REGENERATION_TERMINAL.has(operation.status),
  ) ?? false;

  useEffect(() => {
    if (!campaignId || !hasActiveRegeneration) return;
    const timer = window.setInterval(() => void loadDetail(campaignId, true), 2_500);
    return () => window.clearInterval(timer);
  }, [campaignId, hasActiveRegeneration, loadDetail]);

  const canCreate = project?.role === "owner" || project?.role === "author";
  const canEdit = project?.role === "owner" || project?.role === "author";
  const canApprove = project?.role === "owner" || project?.role === "approver";

  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!campaignMonthRange(form.month)) errors.push("Выбери месяц.");
    if (!form.goal.trim()) errors.push("Укажи цель кампании.");
    if (!form.audience.trim()) errors.push("Укажи аудиторию.");
    if (form.rubrics.length < 3 || form.rubrics.length > 6) errors.push("Выбери от трёх до шести рубрик.");
    if (!equalPracticeMix(form.practices.split(",")).length) errors.push("Укажи хотя бы одно направление практики.");
    if (!form.funnelStages.length) errors.push("Выбери хотя бы один этап воронки.");
    if (form.importantDate && !form.importantDateLabel.trim()) errors.push("Подпиши важную дату.");
    return errors;
  }, [form]);

  const createCampaign = async () => {
    setCreationAttempted(true);
    if (!project || !canCreate || validation.length) {
      setMessage({ kind: "error", text: validation[0] ?? "Для создания кампании нужна роль автора или владельца." });
      if (validation.length) {
        if (!campaignMonthRange(form.month)) monthRef.current?.focus();
        else if (!form.goal.trim()) goalRef.current?.focus();
        else if (!form.audience.trim()) audienceRef.current?.focus();
        else if (form.rubrics.length < 3 || form.rubrics.length > 6) {
          setAdvanced(true);
          requestAnimationFrame(() => document.querySelector<HTMLElement>("#campaign-rubrics")?.focus());
        } else if (!equalPracticeMix(form.practices.split(",")).length) {
          setAdvanced(true);
          requestAnimationFrame(() => practicesRef.current?.focus());
        } else if (!form.funnelStages.length) {
          setAdvanced(true);
          requestAnimationFrame(() => document.querySelector<HTMLElement>("#campaign-funnels")?.focus());
        } else if (form.importantDate && !form.importantDateLabel.trim()) {
          setAdvanced(true);
          requestAnimationFrame(() => importantDateLabelRef.current?.focus());
        }
      }
      return;
    }
    const range = campaignMonthRange(form.month)!;
    const briefPayload = {
      goal: form.goal,
      ...range,
      timezone: project.timezone,
      rubrics: form.rubrics,
      practiceMix: equalPracticeMix(form.practices.split(",")),
      audience: form.audience,
      funnelStages: form.funnelStages,
      postsPerWeek: form.postsPerWeek,
      importantDates: form.importantDate
        ? [{ date: form.importantDate, label: form.importantDateLabel }]
        : [],
      ctas: form.cta.trim() ? [form.cta.trim()] : [],
      metrics: form.metrics,
      profileVersion: 1,
      contentBriefVersion: 1,
    };
    const fingerprint = JSON.stringify(briefPayload);
    if (creationAttempt.current?.fingerprint !== fingerprint) {
      creationAttempt.current = {
        fingerprint,
        campaignKey: `monthly-campaign:${crypto.randomUUID()}`,
        planKey: `monthly-plan:${crypto.randomUUID()}`,
      };
    }
    setBusy("create");
    setMessage({ kind: "info", text: "Создаю кампанию и редакционную сетку…" });
    try {
      const campaignResponse = await fetch("/api/monthly-campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief: briefPayload, idempotencyKey: creationAttempt.current.campaignKey }),
      });
      const campaignPayload = await campaignResponse.json().catch(() => null);
      const created = parseMonthlyCampaignList({ ok: true, campaigns: [campaignPayload?.campaign] })?.[0];
      if (!campaignResponse.ok || !created) throw new Error(campaignPayload?.error || "server");
      const planResponse = await fetch(`/api/monthly-campaigns/${created.id}/plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generationMode: "editorial_seed",
          expectedCampaignVersion: created.version,
          idempotencyKey: creationAttempt.current.planKey,
        }),
      });
      const planPayload = await planResponse.json().catch(() => null);
      if (!planResponse.ok || planPayload?.ok !== true) throw new Error(planPayload?.error || "server");
      await loadCampaigns(created.id);
      await loadDetail(created.id);
      setMessage({ kind: "success", text: "Кампания создана. Проверь темы и отправь план на согласование." });
    } catch (error) {
      setMessage({ kind: "error", text: apiError(error instanceof Error ? error.message : undefined) });
      await loadCampaigns().catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  const createPlan = async () => {
    if (!detail || !canCreate) return;
    setBusy("plan");
    try {
      const response = await fetch(`/api/monthly-campaigns/${detail.campaign.id}/plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generationMode: "editorial_seed",
          expectedCampaignVersion: detail.campaign.version,
          idempotencyKey: `monthly-plan:${crypto.randomUUID()}`,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "server");
      await loadDetail(detail.campaign.id);
      setMessage({ kind: "success", text: "Темы месяца собраны без выдуманных фактов. Их можно пересобрать по одной или по неделе." });
    } catch (error) {
      setMessage({ kind: "error", text: apiError(error instanceof Error ? error.message : undefined) });
    } finally {
      setBusy(null);
    }
  };

  const transition = async (action: "submit" | "approve") => {
    if (!detail || !plan || hasActiveRegeneration) return;
    setBusy(action);
    try {
      const response = await fetch(`/api/monthly-campaigns/${detail.campaign.id}/plans/${plan.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, expectedPlanVersion: plan.version }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "server");
      await loadDetail(detail.campaign.id);
      setMessage({
        kind: "success",
        text: action === "submit" ? "План отправлен на согласование." : "План согласован. Теперь можно подготовить первую неделю.",
      });
    } catch (error) {
      setMessage({ kind: "error", text: apiError(error instanceof Error ? error.message : undefined) });
      await loadDetail(detail.campaign.id, true).catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  const moveItem = async (item: MonthlyCampaignClientItem, target: MonthlyCampaignClientItem) => {
    if (!detail || !plan || item.id === target.id || busy || hasActiveRegeneration) return;
    setBusy(`move:${item.id}`);
    try {
      const response = await fetch(`/api/monthly-campaigns/${detail.campaign.id}/plans/${plan.id}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          targetDate: target.scheduledFor,
          targetPosition: target.position,
          expectedPlanVersion: plan.version,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "server");
      setMessage({ kind: "success", text: `Материал перенесён на ${dateLabel(target.scheduledFor)}.` });
      await loadDetail(detail.campaign.id, true);
    } catch (error) {
      setMessage({ kind: "error", text: apiError(error instanceof Error ? error.message : undefined) });
      await loadDetail(detail.campaign.id, true).catch(() => {});
    } finally {
      setBusy(null);
      setDraggedId(null);
    }
  };

  const regenerate = async (scope: "item" | "week", item: MonthlyCampaignClientItem) => {
    if (!detail || !plan || busy) return;
    const key = scope === "item" ? `regen:item:${item.id}` : `regen:week:${item.scheduledFor}`;
    setBusy(key);
    try {
      const response = await fetch(`/api/monthly-campaigns/${detail.campaign.id}/plans/${plan.id}/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope,
          ...(scope === "item" ? { itemId: item.id } : { weekStartsOn: item.scheduledFor }),
          expectedPlanVersion: plan.version,
          idempotencyKey: `monthly-${key}:${crypto.randomUUID()}`,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "server");
      await loadDetail(detail.campaign.id, true);
      setMessage({ kind: "info", text: scope === "item" ? "Пересобираю только выбранную тему." : "Пересобираю только эту неделю." });
    } catch (error) {
      setMessage({ kind: "error", text: apiError(error instanceof Error ? error.message : undefined) });
      await loadDetail(detail.campaign.id, true).catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  const prepareFirstWeek = async () => {
    if (!detail || !plan || !channelId || hasActiveRegeneration) return;
    setBusy("prepare-week");
    try {
      const response = await fetch("/api/autopilot/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, planningWeeks: 1, monthlyCampaignPlanId: plan.id }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "server");
      setMessage({ kind: "info", text: "Готовлю тексты первой недели в фоне. Можно продолжать работу — связи с кампанией сохранятся автоматически." });
    } catch (error) {
      setMessage({ kind: "error", text: apiError(error instanceof Error ? error.message : undefined) });
    } finally {
      setBusy(null);
    }
  };

  const weeks = plan ? chunkWeeks(plan.items) : [];
  const selectedCampaign = detail?.campaign ?? campaigns.find((campaign) => campaign.id === campaignId) ?? null;

  return (
    <div className="space-y-5">
      <nav aria-label="Режим Автопилота" className="inline-flex min-h-11 rounded-md border border-line bg-surface p-1">
        <Link
          href="/app/autopilot"
          className="inline-flex min-h-11 items-center rounded-sm px-4 text-[14px] font-semibold text-text-2 hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
        >
          Недельный план
        </Link>
        <span className="inline-flex min-h-11 items-center rounded-sm bg-text px-4 text-[14px] font-semibold text-bg" aria-current="page">
          Кампания на месяц
        </span>
      </nav>

      <ChannelPicker
        channels={tgChannels}
        value={channelId}
        onChange={setPickedChannel}
        label="Канал для первой недели"
      />

      {message && (
        <div
          role={message.kind === "error" ? "alert" : "status"}
          aria-live="polite"
          className={cn(
            "flex items-start gap-2 rounded-sm px-4 py-3 text-[14px] leading-relaxed",
            message.kind === "error" ? "bg-danger-soft text-danger-text" :
              message.kind === "success" ? "bg-success-soft text-success-text" : "bg-info-soft text-info-text",
          )}
        >
          {message.kind === "error" ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <span>{message.text}</span>
        </div>
      )}

      {campaigns.length > 0 && (
        <div className="flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 max-w-full sm:w-80">
            <Field label="Кампания" htmlFor="monthly-campaign-select">
              <select
                id="monthly-campaign-select"
                value={campaignId ?? ""}
                onChange={(event) => setCampaignId(Number(event.target.value))}
                className="h-12 w-full min-w-0 max-w-full rounded-xs border border-line bg-surface px-4 text-base text-text outline-none focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[15px]"
              >
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>{campaign.goal} · {campaign.startsOn.slice(0, 7)}</option>
                ))}
              </select>
            </Field>
          </div>
          {canCreate && (
            <Button type="button" variant="outline" onClick={() => { setCampaignId(null); setDetail(null); setMessage(null); }}>
              Создать другую кампанию
            </Button>
          )}
        </div>
      )}

      {loading ? (
        <div role="status" className="flex min-h-56 items-center justify-center gap-2 text-[14px] text-text-2">
          <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden />
          Загружаю кампанию…
        </div>
      ) : !selectedCampaign ? (
        <section aria-labelledby="monthly-campaign-create-title" className="max-w-4xl">
          <div className="mb-6 max-w-2xl">
            <h2 id="monthly-campaign-create-title" className="text-xl font-bold tracking-[-0.02em] text-text sm:text-2xl">
              Собери редакционную сетку на месяц
            </h2>
            <p className="mt-2 text-[14px] leading-relaxed text-text-2 sm:text-[15px]">
              Аврора распределит 28–31 непохожую тему по рубрикам и практикам. Полные тексты ближайшей недели готовятся только после согласования плана.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Месяц" htmlFor="campaign-month" required messageId="campaign-month-error" error={creationAttempted && !campaignMonthRange(form.month) ? "Выбери месяц." : undefined}>
              <Input ref={monthRef} id="campaign-month" type="month" required value={form.month} aria-invalid={creationAttempted && !campaignMonthRange(form.month) || undefined} aria-describedby={creationAttempted && !campaignMonthRange(form.month) ? "campaign-month-error" : undefined} onChange={(event) => {
                const month = event.currentTarget.value;
                setForm((current) => ({ ...current, month }));
              }} />
            </Field>
            <Field label="Материалов в неделю" htmlFor="campaign-frequency">
              <select
                id="campaign-frequency"
                value={form.postsPerWeek}
                onChange={(event) => {
                  const postsPerWeek = Number(event.currentTarget.value);
                  setForm((current) => ({ ...current, postsPerWeek }));
                }}
                className="h-12 w-full rounded-xs border border-line bg-surface px-4 text-base text-text outline-none focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[15px]"
              >
                {[3, 4, 5, 6, 7].map((count) => <option key={count} value={count}>{count} {plural(count, "материал", "материала", "материалов")}</option>)}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Цель кампании" htmlFor="campaign-goal" required messageId="campaign-goal-error" error={creationAttempted && !form.goal.trim() ? "Укажи цель." : undefined}>
                <Textarea ref={goalRef} id="campaign-goal" rows={2} required value={form.goal} aria-invalid={creationAttempted && !form.goal.trim() || undefined} aria-describedby={creationAttempted && !form.goal.trim() ? "campaign-goal-error" : undefined} onChange={(event) => {
                  const goal = event.currentTarget.value;
                  setForm((current) => ({ ...current, goal }));
                }} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Для кого пишем" htmlFor="campaign-audience" required messageId="campaign-audience-message" error={creationAttempted && !form.audience.trim() ? "Укажи аудиторию." : undefined} hint={brief?.ready ? "Подставлено из настроек выбранного канала." : "Настрой канал, чтобы поле заполнялось автоматически."}>
                <Input ref={audienceRef} id="campaign-audience" required value={form.audience} aria-invalid={creationAttempted && !form.audience.trim() || undefined} aria-describedby="campaign-audience-message" onChange={(event) => {
                  const audience = event.currentTarget.value;
                  setForm((current) => ({ ...current, audience }));
                }} placeholder="Например: собственники малого бизнеса" />
              </Field>
            </div>
          </div>

          <button
            type="button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((current) => !current)}
            className="mt-6 flex min-h-11 w-full items-center justify-between border-y border-line py-3 text-left text-[14px] font-semibold text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
          >
            Рубрики, практики и метрики
            <ChevronDown className={cn("h-4 w-4 transition-transform", advanced && "rotate-180")} aria-hidden />
          </button>

          {advanced && (
            <div className="space-y-6 border-b border-line py-6">
              <fieldset id="campaign-rubrics" tabIndex={-1} aria-invalid={creationAttempted && (form.rubrics.length < 3 || form.rubrics.length > 6) || undefined}>
                <legend className="text-[13px] font-semibold text-text-2">Рубрики: выбери 3–6</legend>
                <div className="mt-2 grid gap-x-5 sm:grid-cols-2 lg:grid-cols-3">
                  {RUBRICS.slice(0, 9).map((rubric) => (
                    <Checkbox
                      key={rubric.key}
                      checked={form.rubrics.includes(rubric.label)}
                      onChange={(checked) => setForm((current) => ({
                        ...current,
                        rubrics: checked
                          ? [...new Set([...current.rubrics, rubric.label])].slice(0, 6)
                          : current.rubrics.filter((value) => value !== rubric.label),
                      }))}
                      label={`${rubric.emoji} ${rubric.label}`}
                    />
                  ))}
                </div>
                <p className="mt-1 text-[13px] text-text-3" aria-live="polite">Выбрано: {form.rubrics.length} из 6</p>
              </fieldset>
              <Field label="Практики или услуги" htmlFor="campaign-practices" messageId="campaign-practices-message" error={creationAttempted && !equalPracticeMix(form.practices.split(",")).length ? "Укажи хотя бы одно направление практики." : undefined} hint="Если направлений несколько, раздели их запятыми. Доли распределятся автоматически.">
                <Input ref={practicesRef} id="campaign-practices" value={form.practices} aria-invalid={creationAttempted && !equalPracticeMix(form.practices.split(",")).length || undefined} aria-describedby="campaign-practices-message" onChange={(event) => {
                  const practices = event.currentTarget.value;
                  setForm((current) => ({ ...current, practices }));
                }} placeholder="Например: договорная работа, судебные споры" />
              </Field>
              <fieldset id="campaign-funnels" tabIndex={-1} aria-invalid={creationAttempted && !form.funnelStages.length || undefined}>
                <legend className="text-[13px] font-semibold text-text-2">Этапы воронки</legend>
                <div className="mt-2 flex flex-wrap gap-x-6">
                  {FUNNELS.map((funnel) => (
                    <Checkbox
                      key={funnel.value}
                      checked={form.funnelStages.includes(funnel.value)}
                      onChange={(checked) => setForm((current) => ({
                        ...current,
                        funnelStages: checked
                          ? [...current.funnelStages, funnel.value]
                          : current.funnelStages.filter((value) => value !== funnel.value),
                      }))}
                      label={funnel.label}
                    />
                  ))}
                </div>
              </fieldset>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Важная дата" htmlFor="campaign-important-date" hint="Необязательно">
                  <Input id="campaign-important-date" type="date" value={form.importantDate} onChange={(event) => {
                    const importantDate = event.currentTarget.value;
                    setForm((current) => ({ ...current, importantDate }));
                  }} />
                </Field>
                <Field label="Что произойдёт" htmlFor="campaign-important-label" messageId="campaign-important-label-error" error={creationAttempted && form.importantDate && !form.importantDateLabel.trim() ? "Подпиши важную дату." : undefined}>
                  <Input ref={importantDateLabelRef} id="campaign-important-label" value={form.importantDateLabel} aria-invalid={creationAttempted && Boolean(form.importantDate) && !form.importantDateLabel.trim() || undefined} aria-describedby={creationAttempted && form.importantDate && !form.importantDateLabel.trim() ? "campaign-important-label-error" : undefined} onChange={(event) => {
                    const importantDateLabel = event.currentTarget.value;
                    setForm((current) => ({ ...current, importantDateLabel }));
                  }} disabled={!form.importantDate} placeholder="Например: вебинар для клиентов" />
                </Field>
              </div>
              <Field label="Призыв к действию" htmlFor="campaign-cta">
                <Input id="campaign-cta" value={form.cta} onChange={(event) => {
                  const cta = event.currentTarget.value;
                  setForm((current) => ({ ...current, cta }));
                }} />
              </Field>
              <fieldset>
                <legend className="text-[13px] font-semibold text-text-2">Что измеряем</legend>
                <div className="mt-2 flex flex-wrap gap-x-6">
                  {METRICS.map((metric) => (
                    <Checkbox
                      key={metric}
                      checked={form.metrics.includes(metric)}
                      onChange={(checked) => setForm((current) => ({
                        ...current,
                        metrics: checked ? [...current.metrics, metric] : current.metrics.filter((value) => value !== metric),
                      }))}
                      label={metric}
                    />
                  ))}
                </div>
              </fieldset>
            </div>
          )}

          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-xl text-[13px] leading-relaxed text-text-3">
              Темы не содержат выдуманных законов, дел или цифр. Предметные факты появятся только из базы знаний выбранного канала.
            </p>
            <Button variant="brand" onClick={createCampaign} loading={busy === "create"} disabled={!canCreate || Boolean(busy)}>
              <CalendarDays className="h-4 w-4" aria-hidden />
              Собрать месяц
            </Button>
          </div>
        </section>
      ) : (
        <section aria-labelledby="monthly-campaign-title" className="space-y-5">
          <div className="flex flex-col gap-4 border-b border-line pb-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 max-w-3xl">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={plan ? STATUS_COPY[plan.status].tone : "neutral"}>{plan ? STATUS_COPY[plan.status].label : "Без плана"}</Badge>
                {plan?.stale && <Badge tone="danger">Нужно обновить</Badge>}
                <span className="text-[13px] text-text-3">{periodLabel(selectedCampaign)}</span>
              </div>
              <h2 id="monthly-campaign-title" className="mt-3 text-xl font-bold tracking-[-0.02em] text-text sm:text-2xl">
                {selectedCampaign.goal}
              </h2>
              <p className="mt-2 text-[14px] leading-relaxed text-text-2">
                {selectedCampaign.audience} · {selectedCampaign.postsPerWeek} {plural(selectedCampaign.postsPerWeek, "материал", "материала", "материалов")} в неделю
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {!plan && canCreate && <Button variant="brand" onClick={createPlan} loading={busy === "plan"}>Собрать темы</Button>}
              {plan?.status === "draft" && canEdit && (
                <Button variant="brand" onClick={() => transition("submit")} loading={busy === "submit"} disabled={plan.stale || hasActiveRegeneration}>
                  <Send className="h-4 w-4" aria-hidden />Отправить на согласование
                </Button>
              )}
              {plan?.status === "in_review" && canApprove && (
                <Button variant="brand" onClick={() => transition("approve")} loading={busy === "approve"} disabled={plan.stale || hasActiveRegeneration}>
                  <Check className="h-4 w-4" aria-hidden />Согласовать план
                </Button>
              )}
              {plan?.status === "approved" && (
                <Button variant="brand" onClick={prepareFirstWeek} loading={busy === "prepare-week"} disabled={!channelId || !brief?.ready || plan.stale || hasActiveRegeneration}>
                  <FilePenLine className="h-4 w-4" aria-hidden />Подготовить первую неделю
                </Button>
              )}
            </div>
          </div>

          {plan?.stale && (
            <div role="alert" className="flex items-start gap-2 rounded-sm bg-danger-soft p-4 text-[14px] text-danger-text">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Настройки проекта изменились после создания этого плана. Согласование и подготовка текстов остановлены, чтобы не использовать устаревший бриф.
            </div>
          )}

          {hasActiveRegeneration && (
            <div role="status" aria-live="polite" className="flex items-start gap-2 rounded-sm bg-info-soft p-4 text-[14px] leading-relaxed text-info-text">
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
              <span>Аврора пересобирает темы. Перенос и согласование временно недоступны; новая версия плана появится здесь автоматически.</span>
            </div>
          )}

          {plan && (
            <>
              <p id="campaign-reorder-help" className="text-[13px] leading-relaxed text-text-3">
                Перетащи материал на другую дату или используй кнопки «Раньше» и «Позже». Перенос не меняет согласованный текст.
              </p>
              <div className="space-y-8">
                {weeks.map((week, weekIndex) => (
                  <section key={week[0].scheduledFor} aria-labelledby={`campaign-week-${weekIndex}`}>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <h3 id={`campaign-week-${weekIndex}`} className="text-[15px] font-bold text-text">
                        Неделя {weekIndex + 1} · {dateLabel(week[0].scheduledFor)} — {dateLabel(week[week.length - 1].scheduledFor)}
                      </h3>
                      {canEdit && (
                        <Button size="sm" variant="ghost" onClick={() => regenerate("week", week[0])} disabled={Boolean(busy) || hasActiveRegeneration}>
                          <RefreshCw className="h-4 w-4" aria-hidden />Пересобрать неделю
                        </Button>
                      )}
                    </div>
                    <ol className="divide-y divide-line border-y border-line">
                      {week.map((item) => {
                        const globalIndex = plan.items.findIndex((candidate) => candidate.id === item.id);
                        const previous = plan.items[globalIndex - 1];
                        const next = plan.items[globalIndex + 1];
                        const regenerating = item.regenerationStatus === "pending" || item.regenerationStatus === "processing";
                        return (
                          <li
                            id={`monthly-item-${item.id}`}
                            key={item.id}
                            draggable={canEdit && !busy && !hasActiveRegeneration}
                            onDragStart={() => setDraggedId(item.id)}
                            onDragEnd={() => setDraggedId(null)}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={() => {
                              const dragged = plan.items.find((candidate) => candidate.id === draggedId);
                              if (dragged) void moveItem(dragged, item);
                            }}
                            aria-describedby="campaign-reorder-help"
                            className={cn(
                              "grid gap-3 py-4 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto] sm:items-start",
                              draggedId === item.id && "opacity-50",
                            )}
                          >
                            <div className="flex items-center gap-2 text-[13px] font-semibold capitalize text-text-2">
                              {canEdit && <GripVertical className="h-4 w-4 text-text-3" aria-hidden />}
                              <time dateTime={item.scheduledFor}>{dateLabel(item.scheduledFor)}</time>
                            </div>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="break-words text-[15px] font-semibold leading-snug text-text">{item.title}</p>
                                {regenerating && <Badge tone="brand"><Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />Пересборка</Badge>}
                                {item.draftId && <Badge tone="success">Текст готов</Badge>}
                              </div>
                              <p className="mt-1 break-words text-[12px] leading-relaxed text-text-3">
                                {item.rubric} · {item.practice} · {FUNNELS.find((funnel) => funnel.value === item.funnelStage)?.label}
                              </p>
                              <div className="mt-2 flex flex-wrap gap-1">
                                {item.draftId && (
                                  <Link href={`/app/composer?draft=${item.draftId}&from=autopilot-month`} className="inline-flex min-h-11 items-center rounded-sm px-3 text-[13px] font-semibold text-brand hover:bg-info-soft focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15">
                                    Открыть текст
                                  </Link>
                                )}
                                {canEdit && (
                                  <>
                                    <Button size="sm" variant="ghost" onClick={() => previous && moveItem(item, previous)} disabled={!previous || Boolean(busy) || hasActiveRegeneration} aria-label={`Перенести тему «${item.title}» на день раньше`}>
                                      <ArrowUp className="h-4 w-4" aria-hidden />Раньше
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => next && moveItem(item, next)} disabled={!next || Boolean(busy) || hasActiveRegeneration} aria-label={`Перенести тему «${item.title}» на день позже`}>
                                      <ArrowDown className="h-4 w-4" aria-hidden />Позже
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => regenerate("item", item)} disabled={Boolean(busy) || regenerating || hasActiveRegeneration} aria-label={`Пересобрать только тему «${item.title}»`}>
                                      <RefreshCw className="h-4 w-4" aria-hidden />Только эту тему
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                            <Badge tone={STATUS_COPY[item.approvalStatus].tone}>{STATUS_COPY[item.approvalStatus].label}</Badge>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

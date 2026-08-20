"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronDown,
  CircleAlert,
  FilePenLine,
  GripVertical,
  List,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react";

import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { Button } from "@/components/ui/button";
import { Badge, Card, Checkbox, EmptyState, Field, Input, Tabs, Textarea } from "@/components/ui/primitives";
import { RUBRICS, type Brief } from "@/lib/brief";
import { createWorkspaceRequestFence, isAbortError } from "@/lib/client-workspace-isolation";
import {
  campaignEditorialWeeks,
  campaignMonthRange,
  campaignMonthTitle,
  equalPracticeMix,
  monthCalendarCells,
  monthlyCampaignWorkflowStep,
  parseMonthlyCampaignDetail,
  parseMonthlyCampaignList,
  type MonthlyCampaignClientDetail,
  type MonthlyCampaignClientItem,
  type MonthlyCampaignClientPlan,
  type MonthlyCampaignClientSummary,
  type MonthlyCampaignEditorialWeek,
  type MonthlyCampaignRole,
} from "@/lib/monthly-campaign-client";
import { isCurrentMonthlyDetailRequest, monthlyDetailRequestIdentity } from "@/lib/monthly-detail-request-race";
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

type ViewMode = "weeks" | "calendar";

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

const WORKFLOW = [
  { step: 1 as const, title: "Темы месяца", hint: "Сетка на каждый день" },
  { step: 2 as const, title: "Согласование", hint: "Порядок и формулировки" },
  { step: 3 as const, title: "Первая неделя", hint: "Полные тексты" },
];

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;

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
  });
  return `${format.format(new Date(`${campaign.startsOn}T00:00:00.000Z`))} — ${format.format(new Date(`${campaign.endsOn}T00:00:00.000Z`))}`;
}

function dayNumber(date: string): string {
  return String(Number(date.slice(8, 10)));
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
    invalid_channel: "Выбери активный канал проекта — в него уйдёт черновик.",
  };
  return messages[code ?? ""] ?? "Действие не выполнено. Введённые данные сохранены — попробуй ещё раз.";
}

function latestPlan(detail: MonthlyCampaignClientDetail | null): MonthlyCampaignClientPlan | null {
  return detail?.plans[0] ?? null;
}

function campaignChipLabel(
  campaign: MonthlyCampaignClientSummary,
  campaigns: readonly MonthlyCampaignClientSummary[],
): string {
  const title = campaignMonthTitle(campaign.startsOn);
  const sameMonth = campaigns.filter((entry) => entry.startsOn === campaign.startsOn).length > 1;
  return sameMonth ? `${title} · ${campaign.goal}` : title;
}

function syncCampaignQuery(campaignId: number | null) {
  const url = new URL(window.location.href);
  if (campaignId) url.searchParams.set("campaign", String(campaignId));
  else url.searchParams.delete("campaign");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function MonthlyCampaignPlanner() {
  const router = useRouter();
  const store = useStore();
  const [pickedChannel, setPickedChannel] = useState<number | null>(null);
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, pickedChannel);
  const [project, setProject] = useState<ProjectContext | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [campaigns, setCampaigns] = useState<MonthlyCampaignClientSummary[]>([]);
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const campaignIdRef = useRef<number | null>(null);
  const [detailRequestFence] = useState(createWorkspaceRequestFence);
  const [detail, setDetail] = useState<MonthlyCampaignClientDetail | null>(null);
  const [form, setForm] = useState<CampaignForm>(blankForm);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
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
    const wanted = preferredId ?? campaignIdRef.current;
    const nextId = wanted && parsed.some((campaign) => campaign.id === wanted)
      ? wanted
      : parsed[0]?.id ?? null;
    campaignIdRef.current = nextId;
    setCampaignId(nextId);
  }, []);

  const loadDetail = useCallback(async (id: number, quiet = false) => {
    const ticket = detailRequestFence.start(monthlyDetailRequestIdentity(id));
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/monthly-campaigns/${id}`, {
        cache: "no-store",
        signal: ticket.signal,
      });
      const payload = await response.json().catch(() => null);
      const parsed = parseMonthlyCampaignDetail(payload);
      if (!response.ok || !parsed) throw new Error("campaign_detail_unavailable");
      if (isCurrentMonthlyDetailRequest(detailRequestFence, ticket, campaignIdRef.current)) {
        setDetail(parsed);
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
    } finally {
      if (!quiet && isCurrentMonthlyDetailRequest(detailRequestFence, ticket, campaignIdRef.current)) {
        setLoading(false);
      }
    }
  }, [detailRequestFence]);

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
      const selectedId = Number.isSafeInteger(requestedCampaignId)
        && parsedCampaigns.some((campaign) => campaign.id === requestedCampaignId)
        ? requestedCampaignId
        : parsedCampaigns[0]?.id ?? null;
      campaignIdRef.current = selectedId;
      setCampaignId(selectedId);
      setCreating(parsedCampaigns.length === 0);
      setForm((current) => ({ ...current, month: current.month || nextMonth() }));
    }).catch(() => {
      if (!cancelled) setMessage({ kind: "error", text: "Не удалось загрузить кампании. Обнови страницу." });
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!campaignId || creating) return;
    let cancelled = false;
    queueMicrotask(() => void loadDetail(campaignId).catch(() => {
      if (!cancelled) setMessage({ kind: "error", text: "Не удалось открыть кампанию. Выбери её ещё раз." });
    }));
    return () => {
      cancelled = true;
    };
  }, [campaignId, creating, loadDetail]);

  useEffect(() => {
    if (!campaignId) return;
    syncCampaignQuery(campaignId);
  }, [campaignId]);

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

  const focusInvalidField = () => {
    if (!campaignMonthRange(form.month)) monthRef.current?.focus();
    else if (!form.goal.trim()) goalRef.current?.focus();
    else if (!form.audience.trim()) audienceRef.current?.focus();
    else if (!equalPracticeMix(form.practices.split(",")).length) practicesRef.current?.focus();
    else if (form.rubrics.length < 3 || form.rubrics.length > 6) {
      setAdvanced(true);
      requestAnimationFrame(() => document.querySelector<HTMLElement>("#campaign-rubrics")?.focus());
    } else if (!form.funnelStages.length) {
      setAdvanced(true);
      requestAnimationFrame(() => document.querySelector<HTMLElement>("#campaign-funnels")?.focus());
    } else if (form.importantDate && !form.importantDateLabel.trim()) {
      setAdvanced(true);
      requestAnimationFrame(() => importantDateLabelRef.current?.focus());
    }
  };

  const createCampaign = async () => {
    setCreationAttempted(true);
    if (!project || !canCreate || validation.length) {
      setMessage({ kind: "error", text: validation[0] ?? "Для создания кампании нужна роль автора или владельца." });
      if (validation.length) focusInvalidField();
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
      setCreating(false);
      await loadCampaigns(created.id);
      await loadDetail(created.id);
      setMessage({ kind: "success", text: "Сетка собрана. Проверь темы и отправь план на согласование." });
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

  const openTopic = async (item: MonthlyCampaignClientItem, destination: "composer" | "studio") => {
    if (!detail || !plan) return;
    if (!channelId) {
      setMessage({ kind: "error", text: "Сначала выбери канал — в него уйдёт черновик." });
      return;
    }
    if (destination === "studio") {
      const params = new URLSearchParams({
        monthlyCampaign: String(detail.campaign.id),
        monthlyPlan: String(plan.id),
        monthlyItem: String(item.id),
        intent: "create",
        channel: String(channelId),
      });
      router.push(`/app/studio?${params.toString()}`);
      return;
    }
    if (item.draftId) {
      router.push(`/app/composer?draft=${item.draftId}&from=autopilot-month`);
      return;
    }
    if (!canEdit) {
      setMessage({ kind: "error", text: "Создать черновик может автор или владелец проекта." });
      return;
    }
    setBusy(`draft:composer:${item.id}`);
    try {
      const response = await fetch(
        `/api/monthly-campaigns/${detail.campaign.id}/plans/${plan.id}/items/${item.id}/draft`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId }),
        },
      );
      const payload = await response.json().catch(() => null);
      const draftId = Number(payload?.draftId);
      if (!response.ok || !Number.isSafeInteger(draftId) || draftId <= 0) {
        throw new Error(payload?.error || "server");
      }
      setDetail((current) => {
        if (!current) return current;
        return {
          ...current,
          plans: current.plans.map((entry) => (
            entry.id !== plan.id
              ? entry
              : {
                ...entry,
                items: entry.items.map((candidate) => (
                  candidate.id === item.id ? { ...candidate, draftId } : candidate
                )),
              }
          )),
        };
      });
      router.push(`/app/composer?draft=${draftId}&from=autopilot-month`);
    } catch (error) {
      setMessage({ kind: "error", text: apiError(error instanceof Error ? error.message : undefined) });
    } finally {
      setBusy(null);
    }
  };

  const selectedCampaign = detail?.campaign ?? campaigns.find((campaign) => campaign.id === campaignId) ?? null;
  const workflowStep = monthlyCampaignWorkflowStep(plan);
  const textsReady = plan?.items.filter((item) => item.draftId).length ?? 0;

  const primaryAction = (() => {
    if (!selectedCampaign) return null;
    if (!plan && canCreate) {
      return (
        <Button variant="primary" onClick={createPlan} loading={busy === "plan"}>
          Собрать темы
        </Button>
      );
    }
    if (plan?.status === "draft" && canEdit) {
      return (
        <Button variant="primary" onClick={() => transition("submit")} loading={busy === "submit"} disabled={plan.stale || hasActiveRegeneration}>
          <Send className="h-4 w-4" aria-hidden />
          Отправить на согласование
        </Button>
      );
    }
    if (plan?.status === "in_review" && canApprove) {
      return (
        <Button variant="primary" onClick={() => transition("approve")} loading={busy === "approve"} disabled={plan.stale || hasActiveRegeneration}>
          <Check className="h-4 w-4" aria-hidden />
          Согласовать план
        </Button>
      );
    }
    return null;
  })();

  return (
    <div className="space-y-5">
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

      {!creating && campaigns.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p id="monthly-campaign-switcher-label" className="mb-2 text-[13px] font-semibold text-text-2">
              Месяц
            </p>
            <div
              role="group"
              aria-labelledby="monthly-campaign-switcher-label"
              className="flex flex-wrap gap-2"
            >
              {campaigns.map((campaign) => {
                const selected = campaign.id === campaignId;
                return (
                  <button
                    key={campaign.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      campaignIdRef.current = campaign.id;
                      setCampaignId(campaign.id);
                      setCreating(false);
                      setMessage(null);
                    }}
                    className={cn(
                      "min-h-11 cursor-pointer rounded-sm border px-3.5 text-left text-[14px] font-semibold transition-[background-color,border-color,color] duration-200 motion-reduce:transition-none",
                      "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
                      selected
                        ? "border-brand bg-info-soft text-text"
                        : "border-line bg-surface text-text-2 hover:border-line-strong hover:text-text",
                    )}
                  >
                    {campaignChipLabel(campaign, campaigns)}
                  </button>
                );
              })}
            </div>
          </div>
          {canCreate && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setCreating(true);
                setCreationAttempted(false);
                setMessage(null);
                setForm((current) => ({ ...blankForm(), month: current.month || nextMonth(), audience: brief?.audience || current.audience, practices: brief?.niche || current.practices, goal: brief?.goal || current.goal, cta: brief?.cta || current.cta }));
              }}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Новая кампания
            </Button>
          )}
        </div>
      )}

      {loading ? (
        <div role="status" className="flex min-h-56 items-center justify-center gap-2 text-[14px] text-text-2">
          <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden />
          Загружаю кампанию…
        </div>
      ) : creating || !selectedCampaign ? (
        !canCreate && campaigns.length === 0 ? (
          <Card>
            <EmptyState
              icon={<CalendarDays className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
              title="Кампаний пока нет"
              body="Сетку на месяц может собрать автор или владелец проекта. После этого её можно согласовать здесь."
            />
          </Card>
        ) : (
          <section aria-labelledby="monthly-campaign-create-title" className="space-y-5">
            {campaigns.length > 0 && (
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                К текущей кампании
              </Button>
            )}

            <Card className="p-5 sm:p-6">
              <div className="max-w-2xl">
                <h2 id="monthly-campaign-create-title" className="text-xl font-bold tracking-[-0.02em] text-text sm:text-2xl">
                  Сетка тем на месяц
                </h2>
                <p className="mt-2 text-[14px] leading-relaxed text-text-2 sm:text-[15px]">
                  Это не генерация постов. Аврора сначала раскладывает тему на каждый день, чтобы месяц не повторялся и не уходил в случайный поток.
                </p>
              </div>
              <ol className="mt-6 grid gap-3 sm:grid-cols-3">
                {WORKFLOW.map((item) => (
                  <li key={item.step} className="rounded-sm bg-surface-inset px-4 py-3">
                    <p className="text-[12px] font-semibold uppercase tracking-[0.04em] text-text-3">Шаг {item.step}</p>
                    <p className="mt-1 text-[14px] font-semibold text-text">{item.title}</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-text-2">{item.hint}</p>
                  </li>
                ))}
              </ol>
            </Card>

            <Card className="p-5 sm:p-6">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Месяц" htmlFor="campaign-month" required messageId="campaign-month-error" error={creationAttempted && !campaignMonthRange(form.month) ? "Выбери месяц." : undefined}>
                  <Input ref={monthRef} id="campaign-month" type="month" required value={form.month} aria-invalid={creationAttempted && !campaignMonthRange(form.month) || undefined} aria-describedby={creationAttempted && !campaignMonthRange(form.month) ? "campaign-month-error" : undefined} onChange={(event) => {
                    const month = event.currentTarget.value;
                    setForm((current) => ({ ...current, month }));
                  }} />
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
                  <Field label="Для кого пишем" htmlFor="campaign-audience" required messageId="campaign-audience-message" error={creationAttempted && !form.audience.trim() ? "Укажи аудиторию." : undefined} hint={brief?.ready ? "Подставлено из настроек канала." : "Настрой канал, чтобы поле заполнялось автоматически."}>
                    <Input ref={audienceRef} id="campaign-audience" required value={form.audience} aria-invalid={creationAttempted && !form.audience.trim() || undefined} aria-describedby="campaign-audience-message" onChange={(event) => {
                      const audience = event.currentTarget.value;
                      setForm((current) => ({ ...current, audience }));
                    }} placeholder="Например: собственники малого бизнеса" />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Field label="О чём пишем в этом месяце" htmlFor="campaign-practices" required messageId="campaign-practices-message" error={creationAttempted && !equalPracticeMix(form.practices.split(",")).length ? "Укажи хотя бы одно направление." : undefined} hint="Если направлений несколько, раздели их запятыми. Доли распределятся автоматически.">
                    <Input ref={practicesRef} id="campaign-practices" required value={form.practices} aria-invalid={creationAttempted && !equalPracticeMix(form.practices.split(",")).length || undefined} aria-describedby="campaign-practices-message" onChange={(event) => {
                      const practices = event.currentTarget.value;
                      setForm((current) => ({ ...current, practices }));
                    }} placeholder="Например: договорная работа, судебные споры" />
                  </Field>
                </div>
              </div>

              <button
                type="button"
                aria-expanded={advanced}
                onClick={() => setAdvanced((current) => !current)}
                className="mt-6 flex min-h-11 w-full cursor-pointer items-center justify-between border-y border-line py-3 text-left text-[14px] font-semibold text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
              >
                Рубрики, воронка и метрики
                <ChevronDown className={cn("h-4 w-4 transition-transform duration-200 motion-reduce:transition-none", advanced && "rotate-180")} aria-hidden />
              </button>

              {advanced && (
                <div className="space-y-6 py-6">
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
                  <Field label="Целевой темп публикаций" htmlFor="campaign-frequency" hint="Сетка всё равно строится на каждый день месяца. Темп сохранится в брифе кампании.">
                    <select
                      id="campaign-frequency"
                      value={form.postsPerWeek}
                      onChange={(event) => {
                        const postsPerWeek = Number(event.currentTarget.value);
                        setForm((current) => ({ ...current, postsPerWeek }));
                      }}
                      className="h-12 w-full cursor-pointer rounded-xs border border-line bg-surface px-4 text-base text-text outline-none focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[15px]"
                    >
                      {[3, 4, 5, 6, 7].map((count) => <option key={count} value={count}>{count} {plural(count, "материал", "материала", "материалов")} в неделю</option>)}
                    </select>
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
                  Темы не содержат выдуманных законов, дел или цифр. Предметные факты появятся только из базы знаний канала — и только в текстах первой недели.
                </p>
                <Button variant="primary" onClick={createCampaign} loading={busy === "create"} disabled={!canCreate || Boolean(busy)}>
                  <CalendarDays className="h-4 w-4" aria-hidden />
                  Собрать сетку месяца
                </Button>
              </div>
            </Card>
          </section>
        )
      ) : (
        <section aria-labelledby="monthly-campaign-title" className="space-y-5">
          <Card className="p-5 sm:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 max-w-3xl">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={plan ? STATUS_COPY[plan.status].tone : "neutral"}>{plan ? STATUS_COPY[plan.status].label : "Без плана"}</Badge>
                  {plan?.stale && <Badge tone="danger">Нужно обновить</Badge>}
                  <span className="text-[13px] text-text-3">{periodLabel(selectedCampaign)}</span>
                </div>
                <h2 id="monthly-campaign-title" className="mt-3 text-xl font-bold tracking-[-0.02em] text-text sm:text-2xl">
                  {campaignMonthTitle(selectedCampaign.startsOn)}
                </h2>
                <p className="mt-2 text-[14px] leading-relaxed text-text-2">
                  {selectedCampaign.goal}
                </p>
                <p className="mt-1 text-[13px] text-text-3">
                  {selectedCampaign.audience}
                  {plan ? ` · ${plan.items.length} ${plural(plan.items.length, "тема", "темы", "тем")}` : null}
                  {textsReady > 0 ? ` · ${textsReady} с текстом` : null}
                </p>
              </div>
              {primaryAction && <div className="flex flex-wrap gap-2">{primaryAction}</div>}
            </div>

            <div className="mt-4">
              <ChannelPicker
                channels={tgChannels}
                value={channelId}
                onChange={setPickedChannel}
                label="Канал для черновика"
              />
              {!channelId && (
                <p className="mt-2 text-[13px] leading-relaxed text-text-2">
                  Подключи канал, чтобы написать тему в редакторе или подготовить её в Студии.
                </p>
              )}
            </div>

            <WorkflowRail current={workflowStep} />
          </Card>

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

          {plan?.status === "approved" && (
            <Card className="p-5 sm:p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0 max-w-xl">
                  <h3 className="text-[15px] font-bold text-text">Тексты первой недели</h3>
                  <p className="mt-1 text-[14px] leading-relaxed text-text-2">
                    Сетка уже согласована. Аврора напишет полные материалы только на ближайшие семь дней — остальные даты останутся темами.
                  </p>
                </div>
                <Button
                  variant="primary"
                  onClick={prepareFirstWeek}
                  loading={busy === "prepare-week"}
                  disabled={!channelId || !brief?.ready || plan.stale || hasActiveRegeneration}
                >
                  <FilePenLine className="h-4 w-4" aria-hidden />
                  Подготовить первую неделю
                </Button>
              </div>
              <div className="mt-4">
                {!brief?.ready && (
                  <p className="mt-3 text-[13px] leading-relaxed text-text-2">
                    Сначала настрой Аврору для канала — без брифа тексты не собрать.{" "}
                    <Link
                      href={`/app/settings${channelId ? `?channel=${channelId}` : ""}`}
                      className="font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
                    >
                      Открыть настройки канала
                    </Link>
                  </p>
                )}
              </div>
            </Card>
          )}

          {plan && (
            <PlanBoard
              key={selectedCampaign.id}
              campaign={selectedCampaign}
              plan={plan}
              canEdit={canEdit}
              busy={busy}
              hasActiveRegeneration={hasActiveRegeneration}
              draggedId={draggedId}
              onDragStart={setDraggedId}
              onDragEnd={() => setDraggedId(null)}
              onMove={moveItem}
              onRegenerate={regenerate}
              onOpenTopic={openTopic}
            />
          )}
        </section>
      )}
    </div>
  );
}

function PlanBoard({
  campaign,
  plan,
  canEdit,
  busy,
  hasActiveRegeneration,
  draggedId,
  onDragStart,
  onDragEnd,
  onMove,
  onRegenerate,
  onOpenTopic,
}: {
  campaign: MonthlyCampaignClientSummary;
  plan: MonthlyCampaignClientPlan;
  canEdit: boolean;
  busy: string | null;
  hasActiveRegeneration: boolean;
  draggedId: number | null;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onMove: (item: MonthlyCampaignClientItem, target: MonthlyCampaignClientItem) => void;
  onRegenerate: (scope: "item" | "week", item: MonthlyCampaignClientItem) => void;
  onOpenTopic: (item: MonthlyCampaignClientItem, destination: "composer" | "studio") => void;
}) {
  const weeks = campaignEditorialWeeks(plan.items);
  const [viewMode, setViewMode] = useState<ViewMode>("weeks");
  const [weekOverride, setWeekOverride] = useState<string | null | undefined>(undefined);
  const [openItemId, setOpenItemId] = useState<number | null>(null);
  const openWeek = weekOverride === undefined ? weeks[0]?.startsOn ?? null : weekOverride;
  const importantDates = new Set(campaign.importantDates.map((item) => item.date));

  useEffect(() => {
    if (!openItemId || viewMode !== "weeks") return;
    const node = document.getElementById(`monthly-item-${openItemId}`);
    node?.scrollIntoView({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [openItemId, viewMode]);

  const revealItem = (item: MonthlyCampaignClientItem) => {
    const week = weeks.find((entry) => entry.items.some((candidate) => candidate.id === item.id));
    setWeekOverride(week?.startsOn ?? null);
    setOpenItemId(item.id);
    setViewMode("weeks");
  };

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p id="campaign-reorder-help" className="text-[13px] leading-relaxed text-text-3">
          Открой день, чтобы перенести тему или пересобрать её. Перенос не меняет уже согласованный текст.
        </p>
        <Tabs
          value={viewMode}
          onChange={setViewMode}
          ariaLabel="Как показать сетку месяца"
          items={[
            { value: "weeks", label: "По неделям", icon: <List className="h-4 w-4" aria-hidden /> },
            { value: "calendar", label: "Календарь", icon: <CalendarRange className="h-4 w-4" aria-hidden /> },
          ]}
        />
      </div>

      {viewMode === "calendar" ? (
        <MonthCalendar
          campaign={campaign}
          items={plan.items}
          importantDates={importantDates}
          onSelect={revealItem}
        />
      ) : (
        <div className="space-y-3">
          {weeks.map((week) => (
            <WeekSection
              key={week.startsOn}
              week={week}
              plan={plan}
              open={openWeek === week.startsOn}
              openItemId={openItemId}
              canEdit={canEdit}
              busy={busy}
              hasActiveRegeneration={hasActiveRegeneration}
              draggedId={draggedId}
              onToggle={() => setWeekOverride((current) => {
                const resolved = current === undefined ? weeks[0]?.startsOn ?? null : current;
                return resolved === week.startsOn ? null : week.startsOn;
              })}
              onOpenItem={(id) => setOpenItemId((current) => current === id ? null : id)}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onMove={onMove}
              onRegenerate={onRegenerate}
              onOpenTopic={onOpenTopic}
            />
          ))}
        </div>
      )}
    </>
  );
}

function WorkflowRail({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="mt-6 grid gap-2 sm:grid-cols-3" aria-label="Этапы кампании">
      {WORKFLOW.map((item) => {
        const done = item.step < current;
        const active = item.step === current;
        return (
          <li
            key={item.step}
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex items-start gap-3 rounded-sm px-3 py-3",
              active ? "bg-info-soft" : "bg-surface-inset",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold",
                done ? "bg-success-soft text-success-text" : active ? "bg-brand text-white" : "bg-surface text-text-3",
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden /> : item.step}
            </span>
            <span>
              <span className="block text-[14px] font-semibold text-text">{item.title}</span>
              <span className="mt-0.5 block text-[12px] text-text-3">{item.hint}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function MonthCalendar({
  campaign,
  items,
  importantDates,
  onSelect,
}: {
  campaign: MonthlyCampaignClientSummary;
  items: readonly MonthlyCampaignClientItem[];
  importantDates: ReadonlySet<string>;
  onSelect: (item: MonthlyCampaignClientItem) => void;
}) {
  const byDate = new Map(items.map((item) => [item.scheduledFor, item]));
  const cells = monthCalendarCells(campaign.startsOn, campaign.endsOn);
  return (
    <Card className="overflow-hidden p-3 sm:p-4">
      <div className="grid grid-cols-7 gap-1" aria-label={`Календарь: ${campaignMonthTitle(campaign.startsOn)}`}>
        {WEEKDAYS.map((day) => (
          <div key={day} className="px-1 py-2 text-center text-[12px] font-semibold text-text-3">
            {day}
          </div>
        ))}
        {cells.map((date, index) => {
          if (!date) {
            return <div key={`empty-${index}`} aria-hidden className="min-h-16 rounded-sm sm:min-h-24" />;
          }
          const item = byDate.get(date);
          const ready = Boolean(item?.draftId);
          const regenerating = item?.regenerationStatus === "pending" || item?.regenerationStatus === "processing";
          return (
            <button
              key={date}
              type="button"
              disabled={!item}
              aria-label={item ? `${dateLabel(date)}: ${item.title}` : undefined}
              onClick={() => item && onSelect(item)}
              className={cn(
                "flex min-h-16 cursor-pointer flex-col items-start rounded-sm border px-1.5 py-1.5 text-left transition-[border-color,background-color] duration-150 motion-reduce:transition-none sm:min-h-24 sm:px-2 sm:py-2",
                "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
                item ? "border-line bg-surface hover:border-line-strong" : "cursor-default border-transparent",
                importantDates.has(date) && "border-brand/40 bg-info-soft",
              )}
            >
              <span className="flex w-full items-center justify-between gap-1">
                <time dateTime={date} className="text-[12px] font-semibold text-text-2">{dayNumber(date)}</time>
                {ready && <span className="h-1.5 w-1.5 rounded-full bg-success-text" aria-label="Текст готов" />}
                {regenerating && <Loader2 className="h-3 w-3 animate-spin text-brand motion-reduce:animate-none" aria-label="Пересборка" />}
              </span>
              {item && (
                <span className="mt-1 line-clamp-3 text-[11px] leading-snug text-text sm:text-[12px]">
                  {item.title}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function WeekSection({
  week,
  plan,
  open,
  openItemId,
  canEdit,
  busy,
  hasActiveRegeneration,
  draggedId,
  onToggle,
  onOpenItem,
  onDragStart,
  onDragEnd,
  onMove,
  onRegenerate,
  onOpenTopic,
}: {
  week: MonthlyCampaignEditorialWeek;
  plan: MonthlyCampaignClientPlan;
  open: boolean;
  openItemId: number | null;
  canEdit: boolean;
  busy: string | null;
  hasActiveRegeneration: boolean;
  draggedId: number | null;
  onToggle: () => void;
  onOpenItem: (id: number) => void;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onMove: (item: MonthlyCampaignClientItem, target: MonthlyCampaignClientItem) => void;
  onRegenerate: (scope: "item" | "week", item: MonthlyCampaignClientItem) => void;
  onOpenTopic: (item: MonthlyCampaignClientItem, destination: "composer" | "studio") => void;
}) {
  const ready = week.items.filter((item) => item.draftId).length;
  const panelId = `campaign-week-panel-${week.startsOn}`;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 sm:px-5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 py-1 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
        >
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-text-3 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
          <span className="min-w-0">
            <span className="block text-[15px] font-bold text-text">
              Неделя {week.index}
            </span>
            <span className="block text-[13px] text-text-3">
              {dateLabel(week.startsOn)} — {dateLabel(week.endsOn)}
              {" · "}
              {week.items.length} {plural(week.items.length, "тема", "темы", "тем")}
              {ready > 0 ? ` · ${ready} с текстом` : ""}
            </span>
          </span>
        </button>
        {canEdit && (
          <Button size="sm" variant="ghost" onClick={() => week.items[0] && onRegenerate("week", week.items[0])} disabled={Boolean(busy) || hasActiveRegeneration}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Пересобрать неделю
          </Button>
        )}
      </div>
      {open && (
        <ol id={panelId} className="divide-y divide-line border-t border-line">
          {week.items.map((item) => {
            const globalIndex = plan.items.findIndex((candidate) => candidate.id === item.id);
            const previous = plan.items[globalIndex - 1];
            const next = plan.items[globalIndex + 1];
            return (
              <TopicRow
                key={item.id}
                item={item}
                previous={previous}
                next={next}
                open={openItemId === item.id}
                canEdit={canEdit}
                busy={busy}
                hasActiveRegeneration={hasActiveRegeneration}
                dragged={draggedId === item.id}
                onToggle={() => onOpenItem(item.id)}
                onDragStart={() => onDragStart(item.id)}
                onDragEnd={onDragEnd}
                onDrop={() => {
                  const dragged = plan.items.find((candidate) => candidate.id === draggedId);
                  if (dragged) void onMove(dragged, item);
                }}
                onMove={onMove}
                onRegenerate={onRegenerate}
                onOpenTopic={onOpenTopic}
              />
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function TopicRow({
  item,
  previous,
  next,
  open,
  canEdit,
  busy,
  hasActiveRegeneration,
  dragged,
  onToggle,
  onDragStart,
  onDragEnd,
  onDrop,
  onMove,
  onRegenerate,
  onOpenTopic,
}: {
  item: MonthlyCampaignClientItem;
  previous?: MonthlyCampaignClientItem;
  next?: MonthlyCampaignClientItem;
  open: boolean;
  canEdit: boolean;
  busy: string | null;
  hasActiveRegeneration: boolean;
  dragged: boolean;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onMove: (item: MonthlyCampaignClientItem, target: MonthlyCampaignClientItem) => void;
  onRegenerate: (scope: "item" | "week", item: MonthlyCampaignClientItem) => void;
  onOpenTopic: (item: MonthlyCampaignClientItem, destination: "composer" | "studio") => void;
}) {
  const regenerating = item.regenerationStatus === "pending" || item.regenerationStatus === "processing";
  return (
    <li
      id={`monthly-item-${item.id}`}
      draggable={canEdit && !busy && !hasActiveRegeneration}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      aria-describedby="campaign-reorder-help"
      className={cn("px-4 py-3 sm:px-5", dragged && "opacity-50")}
    >
      <div className="flex items-start gap-3">
        {canEdit && <GripVertical className="mt-2.5 h-4 w-4 shrink-0 text-text-3" aria-hidden />}
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="grid min-h-11 min-w-0 flex-1 cursor-pointer grid-cols-1 gap-2 py-1 text-left sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-start focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
        >
          <time dateTime={item.scheduledFor} className="text-[13px] font-semibold capitalize text-text-2">
            {dateLabel(item.scheduledFor)}
          </time>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="break-words text-[15px] font-semibold leading-snug text-text">{item.title}</span>
              {regenerating && <Badge tone="brand"><Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />Пересборка</Badge>}
              {item.draftId && <Badge tone="success">Текст готов</Badge>}
              {item.approvalStatus !== "draft" && (
                <Badge tone={STATUS_COPY[item.approvalStatus].tone}>{STATUS_COPY[item.approvalStatus].label}</Badge>
              )}
            </span>
            <span className="mt-1 block break-words text-[12px] leading-relaxed text-text-3">
              {item.rubric} · {item.practice} · {FUNNELS.find((funnel) => funnel.value === item.funnelStage)?.label}
            </span>
          </span>
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1 sm:pl-[2.25rem]">
        {(canEdit || item.draftId) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenTopic(item, "composer")}
            loading={busy === `draft:composer:${item.id}`}
            disabled={Boolean(busy) && busy !== `draft:composer:${item.id}`}
          >
            <Pencil className="h-4 w-4" aria-hidden />
            {item.draftId ? "Открыть в редакторе" : "Написать в редакторе"}
          </Button>
        )}
        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenTopic(item, "studio")}
            disabled={Boolean(busy)}
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            Подготовить в Студии
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-1 flex flex-wrap gap-1 sm:pl-[2.25rem]">
          {canEdit && (
            <>
              <Button size="sm" variant="ghost" onClick={() => previous && onMove(item, previous)} disabled={!previous || Boolean(busy) || hasActiveRegeneration} aria-label={`Перенести тему «${item.title}» на день раньше`}>
                <ArrowUp className="h-4 w-4" aria-hidden />Раньше
              </Button>
              <Button size="sm" variant="ghost" onClick={() => next && onMove(item, next)} disabled={!next || Boolean(busy) || hasActiveRegeneration} aria-label={`Перенести тему «${item.title}» на день позже`}>
                <ArrowDown className="h-4 w-4" aria-hidden />Позже
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onRegenerate("item", item)} disabled={Boolean(busy) || regenerating || hasActiveRegeneration} aria-label={`Пересобрать только тему «${item.title}»`}>
                <RefreshCw className="h-4 w-4" aria-hidden />Только эту тему
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

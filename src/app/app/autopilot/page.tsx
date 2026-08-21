"use client";

// А10. Автопилот (ТЗ 5.6, Д.9). ИИ собирает план недели по аналитике (Д.5) и залётам (Д.7),
// в стиле пользователя. Одобрил — посты уходят в ту же очередь публикации (Д.3). Настоящие
// данные, никаких фейков: нет движка/аналитики — честно помечаем.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  BookText,
  CalendarCheck,
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  Loader2,
  Newspaper,
  Pencil,
  Rocket,
  Settings2,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card, EmptyState, Textarea } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { RUBRICS, type Brief } from "@/lib/brief";
import {
  hasHumanQualityAttestation,
  hasVerifiedQualityMetadata,
  type QualityResult,
} from "@/lib/post-quality.mjs";
import {
  isAutopilotHumanReviewItem,
  isAutopilotReaderReadyItem,
} from "@/lib/autopilot-review.mjs";
import type { ApprovalBlocker, AutopilotApprovalPreview } from "@/lib/autopilot-approval.mjs";
import {
  estimateAutopilotBuildMinutes,
  type AutopilotBuildMinuteEstimate,
} from "@/lib/autopilot-build-progress.mjs";
import { cn, plural } from "@/lib/utils";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import {
  AUTOPILOT_ENGINE_OPTIONS,
  DEFAULT_AUTOPILOT_PLANNING_WEEKS,
  DEFAULT_AUTOPILOT_ENGINE,
  MAX_AUTOPILOT_PLANNING_WEEKS,
  MIN_AUTOPILOT_PLANNING_WEEKS,
  planCountWasCappedForWeeks,
  plannedPostCountForWeeks,
} from "@/lib/autopilot-config.mjs";

interface PlanItem {
  i: number;
  scheduledAt: string;
  topic: string;
  rubric?: string | null; // рубрика из брифа — по ней берём иконку
  draft: string;
  status: "pending" | "approved" | "rejected" | "published" | "expired";
  aiReady?: boolean;
  // На чём основан пост: куски базы знаний. Это доказательство, что цифры не выдуманы,
  // а взяты из материалов автора. Пусто — пост написан без конкретики (её нечем подпереть).
  sources?: {
    id: number | string;
    text: string;
    kind?: string;
    title?: string;
    url?: string;
    publishedAt?: string;
  }[];
  // Конкретика, которой нет в базе: она может остаться в старом плане или после ручной
  // правки. Новая автоматическая сборка такой пост готовым уже не считает.
  invented?: string[];
  qualityBlocked?: boolean;
  quality?: QualityResult;
  qualityOrigin?: string;
  approvalBlockers?: ApprovalBlocker[];
  reviewRequired?: boolean;
  reviewReason?: string;
}
interface Settings {
  enabled: boolean;
  mode: "confirm" | "full";
  post_frequency: number;
  approvals_streak: number;
  generation_engine: string;
  planning_months: number;
  planning_weeks: number;
}
interface State {
  settings: Settings | null;
  plan: {
    id: number;
    revision: number;
    items: PlanItem[];
    rules: string | null;
    status: string;
    generation_engine: string;
    planning_months: number;
    planning_weeks: number;
    buildProgress?: {
      completed: number;
      total: number;
      reviewRequired: number;
      percent: number;
      stage: "preparing" | "generating" | "finalizing";
    };
    expected_post_count?: number | null;
    errorReason?:
      | "timeout"
      | "quota"
      | "variety"
      | "quality"
      | "knowledge"
      | "sources"
      | "provider"
      | "cancelled";
  } | null;
  hasChannel: boolean;
  brief: Brief | null;
  briefReady: boolean;
  channelId: number | null;
}

const MSK = "Europe/Moscow";
const fmtDayMsk = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { timeZone: MSK, weekday: "short", day: "numeric" });
const fmtTimeMsk = (iso: string) =>
  new Date(iso).toLocaleTimeString("ru-RU", { timeZone: MSK, hour: "2-digit", minute: "2-digit" });
const fmtRangeMsk = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { timeZone: MSK, day: "numeric", month: "short" });

const fmtBuildEstimate = ({ min, max }: AutopilotBuildMinuteEstimate) => {
  if (max <= 0) return "меньше минуты";
  if (min === max) {
    return max === 1 ? "около минуты" : `около ${max} минут`;
  }
  return `примерно ${min}–${max} ${plural(max, "минута", "минуты", "минут")}`;
};

const hasPassedVerifiedQuality = (item: PlanItem) =>
  item.aiReady !== false &&
  hasVerifiedQualityMetadata(item.quality) &&
  item.quality?.passed === true &&
  item.qualityBlocked !== true;

const canApproveItem = (item: PlanItem) =>
  hasPassedVerifiedQuality(item) || isAutopilotHumanReviewItem(item);

// Иконка поста. Сначала — точная, по рубрике из брифа; если рубрики нет
// (например, тема пришла из залётов конкурентов) — угадываем по словам темы.
const RUBRIC_ICONS = new Map(RUBRICS.map((r) => [r.label, r.emoji]));
const TOPIC_ICONS: [RegExp, string][] = [
  [/новост|событ|анонс|изменен|исследован/i, "🗞️"],
  [/совет|полезн/i, "💡"],
  [/истори|личн/i, "📖"],
  [/ошибк|разбор/i, "⚠️"],
  [/вопрос/i, "❓"],
  [/итог|недел|подборк/i, "📊"],
  [/инструкц|шаг/i, "📋"],
  [/кейс/i, "🔍"],
  [/миф|правд/i, "🎭"],
  [/видео|сценар|кулис/i, "🎬"],
];
function topicIcon(topic: string, rubric?: string | null): string {
  if (rubric && RUBRIC_ICONS.has(rubric)) return RUBRIC_ICONS.get(rubric)!;
  for (const [re, icon] of TOPIC_ICONS) if (re.test(topic)) return icon;
  return "✨";
}

export default function AutopilotPage() {
  const s = useStore();
  const reduce = useReducedMotion();
  const [data, setData] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{
    channelId: number;
    planId: number;
    revision: number;
    itemIndex: number;
  } | null>(null);
  const [editText, setEditText] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null); // какая карточка раскрыта целиком
  const [generationEngine, setGenerationEngine] = useState(DEFAULT_AUTOPILOT_ENGINE);
  const [planningWeeks, setPlanningWeeks] = useState(DEFAULT_AUTOPILOT_PLANNING_WEEKS);
  const [planningAnchorMs] = useState(Date.now);
  const [visibleLimit, setVisibleLimit] = useState(14);
  const approvalBusy = useRef(false);
  const loadSequence = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const activePlanIdentity = useRef<string | null>(null);
  const approvalAttempt = useRef<{
    planId: number;
    revision: number;
    hash: string;
    key: string;
  } | null>(null);
  // Выбранный канал. Список и выбор — как на «Конкурентах» и «Трендах»: общий компонент,
  // общий источник (стор), чтобы человек узнавал один и тот же элемент на всех экранах.
  const [picked, setPicked] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const value = Number(new URLSearchParams(window.location.search).get("channel"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const { tgChannels, channelId: chId } = useChannelChoice(s.realChannels, picked);
  const [growthNotice, setGrowthNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const requestedChannelId = chId;
    const sequence = ++loadSequence.current;
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    try {
      const r = await fetch(`/api/autopilot${requestedChannelId ? `?channel=${requestedChannelId}` : ""}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const d = (await r.json().catch(() => null)) as (State & { error?: string }) | null;
      if (!r.ok || !d) throw new Error(d?.error || `http_${r.status}`);
      if (sequence !== loadSequence.current || controller.signal.aborted) return;
      if (requestedChannelId != null && d.channelId !== requestedChannelId) return;
      setLoadError(null);
      setData(d);
      if (d.settings) {
        setGenerationEngine(
          AUTOPILOT_ENGINE_OPTIONS.some((option) => option.id === d.settings?.generation_engine)
            ? d.settings.generation_engine as typeof DEFAULT_AUTOPILOT_ENGINE
            : DEFAULT_AUTOPILOT_ENGINE,
        );
        const savedWeeks = Number(d.settings.planning_weeks || d.settings.planning_months * 4);
        setPlanningWeeks(
          savedWeeks >= MIN_AUTOPILOT_PLANNING_WEEKS && savedWeeks <= MAX_AUTOPILOT_PLANNING_WEEKS
            ? savedWeeks
            : DEFAULT_AUTOPILOT_PLANNING_WEEKS,
        );
      }
      const nextPlanIdentity = d.plan
        ? `${d.channelId}:${d.plan.id}:${d.plan.revision}`
        : null;
      if (activePlanIdentity.current !== nextPlanIdentity) setVisibleLimit(14);
      activePlanIdentity.current = nextPlanIdentity;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (sequence === loadSequence.current) {
        setLoadError("Не удалось загрузить Автопилот. Проверь подключение и повтори.");
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [chId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setData(null);
      setLoadError(null);
      setEditing(null);
      setEditText("");
      setExpanded(null);
      activePlanIdentity.current = null;
      void load();
    });
    return () => {
      cancelled = true;
      loadSequence.current += 1;
      loadAbort.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const moveId = Number(new URLSearchParams(window.location.search).get("growthMove"));
    if (!Number.isSafeInteger(moveId) || moveId <= 0) return;
    const controller = new AbortController();
    void fetch(`/api/growth/moves/${moveId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as {
          move?: { reason?: string; missingSlots?: number | null };
        } | null;
        if (!response.ok || !body?.move) return;
        const missing = body.move.missingSlots;
        setGrowthNotice(
          missing
            ? `Развитие: не хватает ${missing} постов. Собери план и одобри слоты.`
            : (body.move.reason ?? "Развитие: закрой дыру в ритме через план на неделю."),
        );
      })
      .catch((error) => {
        if ((error as Error)?.name === "AbortError") return;
      });
    return () => controller.abort();
  }, []);

  const building = data?.plan?.status === "building";
  useEffect(() => {
    if (!building) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      await load();
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [building, load]);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/autopilot/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: chId,
          generationEngine,
          planningWeeks,
        }),
      });
      const d = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (d?.ok) {
        const count = plannedPostCountForWeeks(data?.settings?.post_frequency ?? 5, planningWeeks);
        const duration = fmtBuildEstimate(estimateAutopilotBuildMinutes(count));
        s.toast({
          kind: "info",
          title: "Собираю контент-план",
          body: `${count} ${plural(count, "пост", "поста", "постов")} на ${planningWeeks} ${plural(planningWeeks, "неделю", "недели", "недель")}. Сборка займёт ${duration}; можно продолжать работу в других разделах.`,
        });
        await load();
      } else {
        const why: Record<string, string> = {
          no_channel: "Сначала подключи Telegram-канал.",
          no_brief: "Сначала настрой автопилот — без этого он не знает, о чём твой канал.",
          worker_unavailable: "Фоновый обработчик не запущен. Перезапусти приложение и повтори.",
          queue_unavailable: "Очередь генерации сейчас недоступна. Попробуй ещё раз через минуту.",
          bad_engine: "Выбери доступную модель и повтори.",
          bad_horizon: "Выбери период от 1 до 12 недель.",
          engine_unavailable: "Для выбранной модели не настроен API-ключ Navy.",
        };
        s.toast({
          kind: "danger",
          title: "Не вышло",
          body: why[d?.error ?? ""] ?? "Что-то пошло не так, попробуй ещё раз.",
        });
        await load();
      }
    } catch {
      s.toast({
        kind: "danger",
        title: "Не удалось запустить сборку",
        body: "Проверь подключение и попробуй ещё раз. Текущий план не изменён.",
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const cancelBuild = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/autopilot/generate", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: chId }),
      });
      const result = (await response.json().catch(() => null)) as
        | { ok?: boolean; cancelled?: boolean }
        | null;
      if (response.ok && result?.ok) {
        s.toast({
          kind: "info",
          title: result.cancelled ? "Сборка остановлена" : "Сборка уже завершилась",
          body: result.cancelled
            ? "Готовые публикации не затронуты. Можно выбрать другой период и запустить снова."
            : "Обновляю актуальное состояние плана.",
        });
      } else {
        s.toast({
          kind: "danger",
          title: "Не удалось остановить сборку",
          body: "Обнови страницу и повтори. Готовые публикации не затронуты.",
        });
      }
      await load();
    } catch {
      s.toast({
        kind: "danger",
        title: "Не удалось остановить сборку",
        body: "Проверь подключение и повтори. Готовые публикации не затронуты.",
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const approveAll = async () => {
    if (approvalBusy.current) return;
    approvalBusy.current = true;
    setBusy(true);
    try {
      const previewResponse = await fetch("/api/autopilot/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: chId, action: "preview" }),
      });
      const previewBody = (await previewResponse.json().catch(() => null)) as
        | { ok?: boolean; preview?: AutopilotApprovalPreview | null; error?: string }
        | null;
      if (!previewBody?.ok || !previewBody.preview) {
        s.toast({
          kind: previewBody?.ok ? "info" : "danger",
          title: previewBody?.ok ? "План уже обработан" : "Не удалось проверить план",
          body: previewBody?.ok
            ? "Обновил состояние — повторная постановка не нужна."
            : "Ничего не поставлено в очередь. Попробуй ещё раз.",
        });
        await load();
        return;
      }

      const preview = previewBody.preview;
      if (!preview.token) {
        throw new Error("Не получено подтверждение предварительного просмотра");
      }
      const channelName = preview.channel.title ||
        (preview.channel.handle ? `@${preview.channel.handle}` : `канал #${preview.channel.id}`);
      const dateLines = preview.dates.map(
        ({ scheduledAt }) =>
          `• ${new Date(String(scheduledAt)).toLocaleString("ru-RU", {
            timeZone: MSK,
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}`,
      );
      const confirmation = [
        `Канал: ${channelName}`,
        `Будет поставлено в очередь: ${preview.counts.eligible}`,
        ...(dateLines.length ? ["Даты:", ...dateLines] : []),
        ...(preview.counts.expired || preview.counts.blocked
          ? [
              `Не попадут в очередь: ${preview.counts.expired} неактуальных, ${preview.counts.blocked} ещё не готово`,
              "Аврора оставит их вне очереди и заменит при следующем обновлении плана.",
            ]
          : []),
        "",
        "Подтвердить постановку?",
      ].join("\n");
      if (preview.counts.eligible > 0 && !window.confirm(confirmation)) return;

      const previous = approvalAttempt.current;
      const idempotencyKey =
        previous?.planId === preview.planId &&
        previous.revision === preview.revision &&
        previous.hash === preview.hash
          ? previous.key
          : `web-${preview.revision}-${crypto.randomUUID()}`;
      approvalAttempt.current = {
        planId: preview.planId,
        revision: preview.revision,
        hash: preview.hash,
        key: idempotencyKey,
      };
      const confirmationResponse = await fetch("/api/autopilot/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: chId,
          action: "confirm",
          planId: preview.planId,
          idempotencyKey,
          previewToken: preview.token,
          planRevision: preview.revision,
          previewHash: preview.hash,
        }),
      });
      const result = (await confirmationResponse.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            scheduled?: number;
            blocked?: number;
            expired?: number;
            partial?: boolean;
            retryable?: boolean;
            remaining?: { eligible?: number };
            preview?: AutopilotApprovalPreview | null;
          }
        | null;
      // A structured response means the server stored the result for this key. A later
      // retry should use a fresh key and operate only on the remaining plan items.
      approvalAttempt.current = null;
      if (result?.error === "stale_preview") {
        const fresh = result.preview;
        if (fresh) {
          const freshChannel = fresh.channel.title ||
            (fresh.channel.handle ? `@${fresh.channel.handle}` : `канал #${fresh.channel.id}`);
          const freshDates = fresh.dates.map(
            ({ scheduledAt }) => `• ${new Date(String(scheduledAt)).toLocaleString("ru-RU", {
              timeZone: MSK,
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}`,
          );
          window.alert([
            "План изменился после preview. Ничего не поставлено в очередь.",
            "",
            `Канал: ${freshChannel}`,
            `Теперь можно поставить: ${fresh.counts.eligible}`,
            `Неактуально: ${fresh.counts.expired}; ещё не готово: ${fresh.counts.blocked}`,
            ...(freshDates.length ? ["Новые даты:", ...freshDates] : []),
            "",
            "Проверь изменения и нажми «Одобрить всё» ещё раз.",
          ].join("\n"));
        } else {
          s.toast({
            kind: "info",
            title: "План изменился",
            body: "Ничего не поставлено в очередь. План уже обрабатывается или больше не доступен.",
          });
        }
      } else if (result?.ok) {
        const skipped = Number(result.blocked || 0) + Number(result.expired || 0);
        s.toast({
          kind: result.scheduled ? (skipped ? "info" : "success") : "info",
          title: result.scheduled
            ? `Одобрено — ${result.scheduled} в очереди 🚀`
            : "Ничего не поставлено в очередь",
          body: skipped
            ? `${result.expired || 0} неактуальных и ${result.blocked || 0} неготовых материалов не попали в очередь.`
            : "Посты выйдут по показанному расписанию. Компьютер держать включённым не нужно.",
        });
      } else if (result?.error === "queue_unavailable") {
        s.toast({
          kind: "danger",
          title: result.partial
            ? `${result.scheduled || 0} уже в очереди, продолжение остановлено`
            : "Очередь публикации недоступна",
          body: result.partial
            ? `Состояние сохранено. Осталось безопасно повторить: ${result.remaining?.eligible || 0}.`
            : "Ни одного нового поста не создано. Можно безопасно повторить.",
        });
      } else {
        s.toast({
          kind: "danger",
          title: "План не одобрен",
          body: "Ничего дополнительно не поставлено в очередь. Обнови план и попробуй ещё раз.",
        });
      }
      await load();
    } catch {
      // Keep the key after an ambiguous network failure: the next click replays the same
      // server-side result instead of risking a duplicate operation.
      s.toast({
        kind: "danger",
        title: "Не удалось получить ответ",
        body: "Не повторяй даты вручную: нажми ещё раз, и я безопасно проверю ту же операцию.",
      });
    } finally {
      approvalBusy.current = false;
      setBusy(false);
    }
  };

  const itemAction = async (index: number, action: string, draft?: string) => {
    const plan = data?.plan;
    const channelId = data?.channelId;
    if (!plan || !channelId || channelId !== chId) return;
    const identity = `${channelId}:${plan.id}:${plan.revision}`;
    const r = await fetch("/api/autopilot/item", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        index,
        action,
        draft,
        channelId,
        planId: plan.id,
        planRevision: plan.revision,
        itemId: index,
        idempotencyKey: action === "approve" ? `item-${crypto.randomUUID()}` : undefined,
      }),
    }).catch(() => null);
    const result = (await r?.json().catch(() => null)) as
      | { ok?: boolean; error?: string; blockers?: string[] }
      | null;
    if (activePlanIdentity.current !== identity) return;
    if (result?.error === "approval_blocked") {
      s.toast({
        kind: "danger",
        title: "Пост нельзя поставить в очередь",
        body: result.blockers?.[0] ?? "Выбери новую дату, исправь замечания или пересобери план.",
      });
    } else if (result?.error === "queue_unavailable") {
      s.toast({
        kind: "danger",
        title: "Очередь публикации недоступна",
        body: "Пост не создан. Можно безопасно повторить.",
      });
    } else if (result?.error === "stale_plan") {
      s.toast({
        kind: "info",
        title: "План уже изменился",
        body: "Обновил карточки. Повтори действие для актуальной версии плана.",
      });
    }
    setEditing(null);
    await load();
  };

  if (loading) {
    return (
      <AppShell title="Автопилот">
        <div className="space-y-4">
          <div className="skeleton h-24 rounded-lg" />
          <div className="skeleton h-64 rounded-lg" />
        </div>
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell title="Автопилот">
        <Card className="p-8 text-center" role="alert">
          <AlertTriangle className="mx-auto h-7 w-7 text-brand" aria-hidden />
          <p className="mt-3 text-[15px] font-semibold text-text">Не удалось загрузить Автопилот</p>
          <p className="mx-auto mt-1 max-w-md text-[14px] leading-relaxed text-text-3">
            {loadError ?? "Проверь подключение и повтори."}
          </p>
          <div className="mt-4">
            <Button variant="brand" onClick={() => void load()}>
              Повторить загрузку
            </Button>
          </div>
        </Card>
      </AppShell>
    );
  }

  // Спрашиваем СЕРВЕР, а не стор: каналы в сторе приезжают отдельным запросом, и на его
  // фоне «Сначала подключи канал» мигало бы человеку, у которого канал давно подключён.
  if (!data.hasChannel) {
    return (
      <AppShell title="Автопилот" subtitle="Выбери любой период от 1 до 12 недель.">
        <Card className="py-4">
          <EmptyState
            icon={<Rocket className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title="Сначала подключи канал"
            body="Автопилот публикует в твой Telegram-канал. Подключи его — и я соберу контент-план."
            action={
              <Link href="/app/onboarding" className={buttonClassName({ variant: "solid" })}>
                Подключить канал
              </Link>
            }
          />
        </Card>
      </AppShell>
    );
  }

  const picker = (
    <ChannelPicker
      channels={tgChannels}
      value={chId}
      onChange={setPicked}
      label="Какой канал ведём"
      className="mb-5"
    />
  );

  // Пока автопилот не знает, о чём канал, он писал наугад. Не пускаем дальше настройки.
  // Бриф свой у каждого канала: подключил второй — здесь же его и настроишь.
  if (!data.briefReady) {
    return (
      <AppShell
        title="Автопилот"
        subtitle="Выбери любой период от 1 до 12 недель."
      >
        {picker}
        <Card className="py-4">
          <EmptyState
            icon={<Settings2 className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title="Сначала настрой автопилот"
            body="Чтобы посты были про твоё дело, а не ни о чём, мне нужно знать: о чём канал, для кого и о чём писать нельзя. Займёт минуту — или дай прочитать твой канал, и я предложу всё сам."
            action={
              <Link
                href={`/app/settings${chId ? `?channel=${chId}` : ""}`}
                className={buttonClassName({ variant: "brand" })}
              >
                <Wand2 className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
                Настроить автопилот
              </Link>
            }
          />
        </Card>
      </AppShell>
    );
  }

  const st = data.settings!;
  const plan = data.plan;
  const planItems = plan?.items ?? [];
  // Legacy plans may contain internal quality-review drafts. The reader-facing product
  // boundary is stricter: show only verified material (plus already published history).
  const items = planItems.filter((item) =>
    item.status !== "expired" && item.status !== "rejected" &&
      (
        item.status === "approved" || item.status === "published" ||
        isAutopilotReaderReadyItem(item)
      ),
  );
  const pending = items.filter((it) => it.status === "pending");
  const reviewPending = pending.filter(isAutopilotHumanReviewItem);
  const readyPending = pending.filter(
    (item) => canApproveItem(item) && !isAutopilotHumanReviewItem(item),
  );
  const approved = items.filter((it) => it.status === "approved" || it.status === "published");
  const canOfferFull = st.approvals_streak >= 2 && st.mode !== "full";

  // Отсортированный по времени список для ленты недели и карточек.
  const visible = [...items]
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  const rangeLabel =
    visible.length > 0
      ? `${fmtRangeMsk(visible[0].scheduledAt)} — ${fmtRangeMsk(visible[visible.length - 1].scheduledAt)}`
      : "";
  const allApproved = pending.length === 0 && approved.length > 0;
  const sourceCount = new Set(
    items.flatMap((item) => item.sources?.map((source) => String(source.id)) ?? []),
  ).size;
  const newsCount = items.filter((item) => item.sources?.some((source) => source.kind === "news")).length;
  const plannedCount = plannedPostCountForWeeks(st.post_frequency, planningWeeks);
  const plannedDuration = fmtBuildEstimate(estimateAutopilotBuildMinutes(plannedCount));
  const buildCompleted = plan?.buildProgress?.completed ?? 0;
  const buildTotal = plan?.buildProgress?.total ?? plannedCount;
  const remainingBuildDuration = fmtBuildEstimate(
    estimateAutopilotBuildMinutes(buildTotal, buildCompleted),
  );
  const countCapped = planCountWasCappedForWeeks(st.post_frequency, planningWeeks);
  const selectedEngine = AUTOPILOT_ENGINE_OPTIONS.find((option) => option.id === generationEngine)
    ?? AUTOPILOT_ENGINE_OPTIONS[0];
  const renderedVisible = visible.slice(0, visibleLimit);
  const planEndLabel = new Date(planningAnchorMs + planningWeeks * 7 * 86_400_000).toLocaleDateString(
    "ru-RU",
    { day: "numeric", month: "long", year: "numeric" },
  );

  return (
    <AppShell
      title="Автопилот"
      subtitle="Аврора сама найдёт свежие источники, выберет интересные темы и подготовит готовые посты."
    >
      {picker}
      {growthNotice && (
        <Card className="mb-5 p-4">
          <p className="text-[14px] leading-relaxed text-text">{growthNotice}</p>
        </Card>
      )}
      {/* Резюме настроек. Редактирование живёт в одном месте — «Настройке Авроры». */}
      <Card className="mb-5 p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={st.enabled ? "success" : "neutral"}>
                {st.enabled ? "Автопилот включён" : "Автопилот выключен"}
              </Badge>
              <Badge tone="neutral">
                {st.post_frequency} {plural(st.post_frequency, "пост", "поста", "постов")} в неделю
              </Badge>
              <Badge tone="neutral">
                {st.mode === "full" ? "без подтверждения" : "с подтверждением"}
              </Badge>
            </div>
            <p className="mt-3 min-w-0 text-[13px] leading-relaxed text-text-3">
              <span className="font-semibold text-text-2">Пишу про: </span>
              {data.brief?.niche}
              {data.brief?.audience && (
                <>
                  <span className="font-semibold text-text-2"> · для кого: </span>
                  {data.brief.audience}
                </>
              )}
            </p>
          </div>
          <Link
            href={`/app/settings${chId ? `?channel=${chId}` : ""}`}
            className={buttonClassName({ variant: "outline", size: "sm", className: "shrink-0" })}
          >
            <Settings2 className="h-4 w-4" aria-hidden />
            Настроить Аврору
          </Link>
        </div>
      </Card>

      <Card className="mb-5 p-4 sm:p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1">
            <label htmlFor="autopilot-engine" className="text-[13px] font-semibold text-text">
              Редактор
            </label>
            <select
              id="autopilot-engine"
              value={generationEngine}
              onChange={(event) => setGenerationEngine(event.target.value as typeof generationEngine)}
              disabled={busy || building}
              className="mt-2 h-11 w-full rounded-md border border-line bg-surface px-3 text-[14px] font-semibold text-text outline-none transition-colors focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {AUTOPILOT_ENGINE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <p className="mt-1.5 text-[12px] leading-relaxed text-text-3">
              {selectedEngine.note}
            </p>
          </div>

          <div className="min-w-0 flex-1">
            <label htmlFor="autopilot-horizon" className="text-[13px] font-semibold text-text">
              На сколько недель
            </label>
            <select
              id="autopilot-horizon"
              value={planningWeeks}
              onChange={(event) => setPlanningWeeks(Number(event.target.value))}
              disabled={busy || building}
              className="mt-2 h-11 w-full rounded-md border border-line bg-surface px-3 text-[14px] font-semibold text-text outline-none transition-colors focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {Array.from(
                { length: MAX_AUTOPILOT_PLANNING_WEEKS - MIN_AUTOPILOT_PLANNING_WEEKS + 1 },
                (_, index) => index + MIN_AUTOPILOT_PLANNING_WEEKS,
              ).map((weeks) => (
                <option key={weeks} value={weeks}>
                  {weeks} {plural(weeks, "неделя", "недели", "недель")}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[12px] text-text-3" aria-live="polite">
              До {planEndLabel} · {plannedCount} {plural(plannedCount, "пост", "поста", "постов")}
              {countCapped && " · максимум 90 за один запуск"}
              {` · сборка — ${plannedDuration}`}
            </p>
          </div>

          <Button
            variant="brand"
            onClick={generate}
            loading={busy}
            disabled={busy || building}
            className="min-h-11 shrink-0 lg:min-w-[230px]"
          >
            <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
            {building ? "План собирается" : `${plan ? "Обновить" : "Собрать"} ${plannedCount} ${plural(plannedCount, "пост", "поста", "постов")}`}
          </Button>
        </div>
        <p className="mt-4 flex items-start gap-2 rounded-md bg-surface-inset p-3 text-[12px] leading-relaxed text-text-3">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
          Аврора сама подбирает источники по теме канала, проверяет факты и убирает слабые варианты до того, как ты увидишь план.
        </p>
      </Card>

      {/* Предложение полного режима после 2 недель без правок */}
      {canOfferFull && (
        <div className="mb-5 flex items-start gap-3 rounded-lg bg-info-soft p-4">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
          <div className="flex-1">
            <p className="text-[14px] font-semibold text-text">
              Ты 2 недели одобрял планы без правок — можно доверить полностью
            </p>
            <p className="mt-1 text-[13px] text-text-2">
              В полном режиме посты будут выходить без твоего подтверждения. В любой момент вернёшь.
            </p>
            <div className="mt-3">
              <Link
                href={`/app/settings${chId ? `?channel=${chId}` : ""}`}
                className={buttonClassName({ size: "sm", variant: "brand" })}
              >
                Проверить и включить в настройках
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Состояние плана */}
      {building ? (
        <Card className="p-8 text-center" aria-busy="true">
          <Loader2 className={cn("mx-auto h-7 w-7 text-brand", !reduce && "animate-spin")} aria-hidden />
          <p className="mt-3 text-[15px] font-semibold text-text">Собираю контент-план…</p>
          <p
            className="mt-1 text-[14px] tabular-nums text-text-3"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {buildCompleted} из {buildTotal} {plural(buildTotal, "пост", "поста", "постов")} готовы. Осталось {remainingBuildDuration}. Можно уйти со страницы — прогресс сохранится.
          </p>
          <div
            className="mx-auto mt-4 h-2 max-w-md overflow-hidden rounded-full bg-surface-inset"
            role="progressbar"
            aria-label="Прогресс сборки контент-плана"
            aria-valuemin={0}
            aria-valuemax={buildTotal}
            aria-valuenow={buildCompleted}
          >
            <div
              className="h-full rounded-full bg-brand"
              style={{ width: `${plan?.buildProgress?.percent ?? 0}%` }}
            />
          </div>
          {loadError && (
            <p className="mx-auto mt-4 max-w-md text-[13px] text-danger" role="status">
              Прогресс временно не обновляется. Повторю автоматически.
            </p>
          )}
          <div className="mt-5">
            <Button variant="outline" onClick={cancelBuild} loading={busy} disabled={busy}>
              <X className="h-4 w-4" aria-hidden />
              Остановить сборку
            </Button>
          </div>
        </Card>
      ) : plan?.status === "error" ? (
        <Card className="p-6 sm:p-8" role="alert">
          <Newspaper className="mx-auto h-7 w-7 text-brand" aria-hidden />
          <p className="mt-3 text-center text-[15px] font-semibold text-text">
            Пока не получилось собрать сильный план
          </p>
          <p className="mx-auto mt-1 max-w-xl text-center text-[14px] text-text-3">
            {plan.errorReason === "timeout"
              ? "Поиск занял больше времени, чем ожидалось. Текущий план не изменился — попробуй обновить ещё раз."
              : plan.errorReason === "cancelled"
                ? "Сборка остановлена. Готовые публикации и календарь не изменились."
              : plan.errorReason === "quota"
                ? "Дневной лимит редактора исчерпан. Он обновится завтра; готовые публикации сохранены."
                : plan.errorReason === "variety"
                  ? "Свежие материалы оказались слишком похожи на недавние посты. Аврора не стала заполнять план повторами."
                  : plan.errorReason === "sources" || plan.errorReason === "knowledge"
                    ? "Аврора не нашла достаточно свежих и подтверждённых материалов по теме канала. Слабые источники в план не попали."
                    : plan.errorReason === "quality"
                      ? "Найденные темы не удалось довести до готовых публикаций. Аврора убрала слабые варианты вместо того, чтобы отдавать их на исправление."
                      : plan.errorReason === "provider"
                        ? "Редактор временно недоступен. Источники и настройки сохранены — повтори сборку немного позже."
                        : "Готовые публикации сохранены. Попробуй обновить план ещё раз."}
          </p>
          <div className="mt-5 flex justify-center">
            <Button
              variant="brand"
              onClick={generate}
              loading={busy}
              disabled={busy}
            >
              Найти новые материалы
            </Button>
          </div>
        </Card>
      ) : !plan || visible.length === 0 ? (
        <Card className="py-4">
          <EmptyState
            icon={<Newspaper className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title="Готовых материалов пока нет"
            body="Аврора сама найдёт свежие источники по теме канала, выберет интересные события и соберёт из них понятные посты."
          />
        </Card>
      ) : (
        <div className="space-y-5">
          {/* Обзор плана — с одного взгляда: что, когда и что от тебя нужно */}
          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[15px] font-bold text-text">
                  {allApproved ? "Контент-план в очереди 🚀" : "Контент-план готов"}
                </p>
                <p className="mt-0.5 text-[13px] text-text-3">
                  {visible.length} {plural(visible.length, "пост", "поста", "постов")}
                  {rangeLabel && <> · {rangeLabel}</>}
                  {readyPending.length > 0 && (
                    <>
                      {" "}
                      · {readyPending.length} {plural(readyPending.length, "готов", "готовы", "готовы")} к одобрению
                    </>
                  )}
                  {reviewPending.length > 0 && (
                    <>
                      {" "}
                      · {reviewPending.length} на согласовании
                    </>
                  )}
                  {sourceCount > 0 && <> · {sourceCount} {plural(sourceCount, "источник", "источника", "источников")}</>}
                  {newsCount > 0 && <> · {newsCount} по свежим событиям</>}
                </p>
              </div>
              {readyPending.length > 0 ? (
                <Button variant="brand" onClick={approveAll} loading={busy} disabled={busy}>
                  <Check className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
                  Одобрить всё
                </Button>
              ) : allApproved ? (
                <Link
                  href="/app/calendar"
                  className={buttonClassName({ variant: "soft", size: "sm" })}
                >
                  <CalendarCheck className="h-4 w-4" aria-hidden />
                  Открыть календарь
                </Link>
              ) : null}
            </div>

            {/* Полоса дней. Кликни день — раскроется текст этого поста ниже. */}
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
              {renderedVisible.map((it) => {
                const done = it.status === "approved" || it.status === "published";
                const active = expanded === it.i;
                return (
                  <button
                    key={it.i}
                    type="button"
                    onClick={() => setExpanded(active ? null : it.i)}
                    aria-pressed={active}
                    aria-label={`${active ? "Свернуть" : "Открыть"} пост «${it.topic}»`}
                    className={cn(
                      "flex min-w-[84px] flex-1 flex-col items-center gap-1 rounded-lg border px-2 py-3 text-center transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
                      active
                        ? "border-brand bg-info-soft"
                        : "border-line bg-surface-inset hover:border-brand/40",
                    )}
                  >
                    <span className="text-[12px] font-semibold capitalize text-text-3">
                      {fmtDayMsk(it.scheduledAt)}
                    </span>
                    <span className="text-[22px] leading-none" aria-hidden>
                      {topicIcon(it.topic, it.rubric)}
                    </span>
                    <span className="nums text-[12px] font-semibold text-text">
                      {fmtTimeMsk(it.scheduledAt)}
                    </span>
                    <span
                      className={cn(
                        "mt-0.5 h-1.5 w-1.5 rounded-full",
                        done
                          ? "bg-success"
                          : "bg-brand",
                      )}
                      aria-hidden
                    />
                  </button>
                );
              })}
            </div>

            {/* Легенда — чтобы точки на полосе читались */}
            <div className="mt-2 flex items-center gap-4 text-[12px] text-text-3">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
                ждёт тебя
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />в очереди
              </span>
            </div>
          </Card>

          {/* Правило: почему такой план (из аналитики) */}
          {plan.rules && (
            <div className="flex items-start gap-3 rounded-lg bg-surface-inset p-4">
              <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
              <p className="text-[14px] leading-relaxed text-text-2">
                <span className="font-semibold text-text">Почему такой план: </span>
                {plan.rules}
              </p>
            </div>
          )}

          {/* Посты плана — компактные карточки, раскрываются по клику */}
          <ul className="space-y-3">
            {renderedVisible.map((it) => {
              const done = it.status === "approved" || it.status === "published";
              const isEditing = editing?.channelId === data.channelId &&
                editing.planId === plan.id &&
                editing.revision === plan.revision &&
                editing.itemIndex === it.i;
              const isOpen = expanded === it.i || isEditing;
              const externalSources = (it.sources ?? []).filter((source) => source.url);
              const knowledgeSources = (it.sources ?? []).filter((source) => !source.url);
              return (
                <motion.li
                  key={it.i}
                  initial={reduce ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <Card className="overflow-hidden p-0">
                    {/* Шапка: иконка темы + тема + когда + статус. Клик — раскрыть/свернуть. */}
                    <button
                      type="button"
                      onClick={() => !isEditing && setExpanded(isOpen ? null : it.i)}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? "Свернуть" : "Открыть"} пост «${it.topic}»`}
                      className="flex w-full items-center gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-brand/15"
                    >
                      <span
                        className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-inset text-[20px]"
                        aria-hidden
                      >
                        {topicIcon(it.topic, it.rubric)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold text-text">
                          {it.topic}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-text-3">
                          <Clock className="h-3.5 w-3.5" aria-hidden />
                          <span className="nums capitalize">
                            {fmtDayMsk(it.scheduledAt)}, {fmtTimeMsk(it.scheduledAt)}
                          </span>
                        </span>
                      </span>
                      {done ? (
                        <Badge tone="success">
                          <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden />в очереди
                        </Badge>
                      ) : isAutopilotHumanReviewItem(it) ? (
                        <Badge tone="brand">на согласовании</Badge>
                      ) : (
                        <Badge tone="success">
                          {hasHumanQualityAttestation(it.quality)
                            ? "подтверждено вручную"
                            : "готов к просмотру"}
                        </Badge>
                      )}
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 shrink-0 text-text-3 transition-transform",
                          isOpen && "rotate-180",
                        )}
                        aria-hidden
                      />
                    </button>

                    {/* Тело: редактор / полный текст / короткое превью */}
                    <div className="px-4 pb-4">
                      {isEditing ? (
                        <div>
                          <Textarea
                            rows={5}
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                          />
                          <div className="mt-2 flex gap-2">
                            <Button
                              size="sm"
                              variant="solid"
                              onClick={() => itemAction(it.i, "edit", editText)}
                            >
                              Сохранить
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                              Отмена
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <p
                          className={cn(
                            "max-w-[72ch] whitespace-pre-line text-[14px] leading-relaxed text-text-2",
                            !isOpen && "line-clamp-2",
                          )}
                        >
                          {it.draft}
                        </p>
                      )}

                      {!isEditing && isAutopilotHumanReviewItem(it) && (
                        <div className="mt-3 flex items-start gap-2 rounded-sm bg-info-soft p-3">
                          <Sparkles
                            className="mt-0.5 h-4 w-4 shrink-0 text-info-text"
                            aria-hidden
                          />
                          <p className="text-[13px] leading-snug text-info-text">
                            <span className="font-semibold">Пост готов к согласованию.</span>{" "}
                            Прочитай его перед первой публикацией — Аврора запомнит твои правки и подачу.
                          </p>
                        </div>
                      )}

                      {isOpen && !isEditing && it.sources && it.sources.length > 0 && (
                        <div className="mt-3 max-w-[72ch] rounded-sm bg-surface-inset p-3">
                          <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-text-3">
                            <BookText className="h-3.5 w-3.5" aria-hidden />
                            Источники и контекст
                          </p>
                          <ul className="space-y-2">
                            {externalSources.map((src) => (
                              <li key={String(src.id)} className="text-[13px] leading-snug text-text-3">
                                <a
                                  href={src.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex min-h-6 items-center gap-1 font-semibold text-text-2 underline-offset-4 hover:text-brand hover:underline focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15"
                                >
                                  {src.title || "Открыть первоисточник"}
                                  <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                </a>
                                {src.publishedAt && (
                                  <span className="ml-2 tabular-nums text-text-3">
                                    {new Date(src.publishedAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}
                                  </span>
                                )}
                              </li>
                            ))}
                            {knowledgeSources.slice(0, 3).map((src) => (
                              <li key={String(src.id)} className="text-[13px] leading-snug text-text-3">
                                {src.text}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {it.status === "pending" && !isEditing && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="soft"
                            disabled={!canApproveItem(it)}
                            onClick={() => itemAction(it.i, "approve")}
                          >
                            <Check className="h-4 w-4" aria-hidden />
                            Одобрить
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (!data.channelId) return;
                              setEditing({
                                channelId: data.channelId,
                                planId: plan.id,
                                revision: plan.revision,
                                itemIndex: it.i,
                              });
                              setEditText(it.draft);
                            }}
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                            Редактировать
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => itemAction(it.i, "reject")}>
                            <X className="h-4 w-4" aria-hidden />
                            Убрать
                          </Button>
                        </div>
                      )}
                    </div>
                  </Card>
                </motion.li>
              );
            })}
          </ul>
          {visible.length > renderedVisible.length && (
            <div className="flex justify-center pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => setVisibleLimit((current) => Math.min(visible.length, current + 14))}
              >
                Показать ещё {Math.min(14, visible.length - renderedVisible.length)}
              </Button>
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}

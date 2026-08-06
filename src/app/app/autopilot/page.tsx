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
  Loader2,
  Pencil,
  Rocket,
  Settings2,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Textarea } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { RUBRICS, type Brief } from "@/lib/brief";
import {
  hasHumanQualityAttestation,
  hasVerifiedQualityMetadata,
  type QualityResult,
} from "@/lib/post-quality.mjs";
import type { ApprovalBlocker, AutopilotApprovalPreview } from "@/lib/autopilot-approval.mjs";
import { cn, plural } from "@/lib/utils";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";

interface PlanItem {
  i: number;
  scheduledAt: string;
  topic: string;
  rubric?: string | null; // рубрика из брифа — по ней берём иконку
  draft: string;
  status: "pending" | "approved" | "rejected" | "published" | "expired";
  // На чём основан пост: куски базы знаний. Это доказательство, что цифры не выдуманы,
  // а взяты из материалов автора. Пусто — пост написан без конкретики (её нечем подпереть).
  sources?: { id: number; text: string }[];
  // Конкретика, которой нет в базе: ИИ её выдумал, и вторая попытка не помогла. Такой пост
  // автопилот НИКОГДА не публикует сам — решает человек.
  invented?: string[];
  qualityBlocked?: boolean;
  quality?: QualityResult;
  approvalBlockers?: ApprovalBlocker[];
}
interface Settings {
  enabled: boolean;
  mode: "confirm" | "full";
  post_frequency: number;
  approvals_streak: number;
}
interface State {
  settings: Settings | null;
  plan: {
    id: number;
    revision: number;
    items: PlanItem[];
    rules: string | null;
    status: string;
    errorReason?: "timeout" | "quota";
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

const hasPassedVerifiedQuality = (item: PlanItem) =>
  hasVerifiedQualityMetadata(item.quality) &&
  item.quality?.passed === true &&
  item.qualityBlocked !== true;

// Иконка поста. Сначала — точная, по рубрике из брифа; если рубрики нет
// (например, тема пришла из залётов конкурентов) — угадываем по словам темы.
const RUBRIC_ICONS = new Map(RUBRICS.map((r) => [r.label, r.emoji]));
const TOPIC_ICONS: [RegExp, string][] = [
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
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{
    channelId: number;
    planId: number;
    revision: number;
    itemIndex: number;
  } | null>(null);
  const [editText, setEditText] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null); // какая карточка раскрыта целиком
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
  const [picked, setPicked] = useState<number | null>(null);
  const { tgChannels, channelId: chId } = useChannelChoice(s.realChannels, picked);

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
      const d = (await r.json()) as State;
      if (sequence !== loadSequence.current || controller.signal.aborted) return;
      if (requestedChannelId != null && d.channelId !== requestedChannelId) return;
      setData(d);
      activePlanIdentity.current = d.plan
        ? `${d.channelId}:${d.plan.id}:${d.plan.revision}`
        : null;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      /* сеть */
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

  const building = data?.plan?.status === "building";
  useEffect(() => {
    if (!building) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [building, load]);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/autopilot/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: chId }),
      });
      const d = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (d?.ok) {
        s.toast({ kind: "info", title: "Собираю план", body: "ИИ пишет посты на неделю — минутку." });
        await load();
      } else {
        const why: Record<string, string> = {
          no_channel: "Сначала подключи Telegram-канал.",
          no_brief: "Сначала настрой автопилот — без этого он не знает, о чём твой канал.",
          worker_unavailable: "Фоновый обработчик не запущен. Перезапусти приложение и повтори.",
          queue_unavailable: "Очередь генерации сейчас недоступна. Попробуй ещё раз через минуту.",
        };
        s.toast({
          kind: "danger",
          title: "Не вышло",
          body: why[d?.error ?? ""] ?? "Что-то пошло не так, попробуй ещё раз.",
        });
        await load();
      }
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
      const blockerLines = preview.blockers.slice(0, 5).map((entry) => {
        const label = entry.topic ? `«${entry.topic}»` : `Пост ${entry.index + 1}`;
        return `• ${label}: ${entry.reasons.map((reason) => reason.message).join("; ")}`;
      });
      const confirmation = [
        `Канал: ${channelName}`,
        `Будет поставлено в очередь: ${preview.counts.eligible}`,
        ...(dateLines.length ? ["Даты:", ...dateLines] : []),
        ...(preview.counts.expired || preview.counts.blocked
          ? [
              `Не будут опубликованы: ${preview.counts.expired} с истёкшей датой, ${preview.counts.blocked} заблокировано`,
              ...blockerLines,
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
            `Истекло: ${fresh.counts.expired}; заблокировано: ${fresh.counts.blocked}`,
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
            ? `${result.expired || 0} с истёкшей датой и ${result.blocked || 0} без пройденного контроля оставлены в плане.`
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

  if (loading || !data) {
    return (
      <AppShell title="Автопилот">
        <div className="space-y-4">
          <div className="skeleton h-24 rounded-lg" />
          <div className="skeleton h-64 rounded-lg" />
        </div>
      </AppShell>
    );
  }

  // Спрашиваем СЕРВЕР, а не стор: каналы в сторе приезжают отдельным запросом, и на его
  // фоне «Сначала подключи канал» мигало бы человеку, у которого канал давно подключён.
  if (!data.hasChannel) {
    return (
      <AppShell title="Автопилот" subtitle="Веди канал на автопилоте — план недели за одну кнопку.">
        <Card className="py-4">
          <EmptyState
            icon={<Rocket className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title="Сначала подключи канал"
            body="Автопилот публикует в твой Telegram-канал. Подключи его — и я соберу план на неделю."
            action={
              <Link href="/app/onboarding">
                <Button variant="solid">Подключить канал</Button>
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
        subtitle="Веди канал на автопилоте — план недели за одну кнопку."
      >
        {picker}
        <Card className="py-4">
          <EmptyState
            icon={<Settings2 className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title="Сначала настрой автопилот"
            body="Чтобы посты были про твоё дело, а не ни о чём, мне нужно знать: о чём канал, для кого и о чём писать нельзя. Займёт минуту — или дай прочитать твой канал, и я предложу всё сам."
            action={
              <Link href={`/app/settings${chId ? `?channel=${chId}` : ""}`}>
                <Button variant="brand">
                  <Wand2 className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
                  Настроить автопилот
                </Button>
              </Link>
            }
          />
        </Card>
      </AppShell>
    );
  }

  const st = data.settings!;
  const plan = data.plan;
  const items = plan?.items ?? [];
  const pending = items.filter((it) => it.status === "pending");
  const blocked = pending.filter((it) => !hasPassedVerifiedQuality(it));
  const readyPending = pending.filter(hasPassedVerifiedQuality);
  const expired = items.filter((it) => it.status === "expired");
  const approved = items.filter((it) => it.status === "approved" || it.status === "published");
  const canOfferFull = st.approvals_streak >= 2 && st.mode !== "full";

  // Отсортированный по времени список для ленты недели и карточек.
  const visible = [...items]
    .filter((it) => it.status !== "rejected")
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  const rangeLabel =
    visible.length > 0
      ? `${fmtRangeMsk(visible[0].scheduledAt)} — ${fmtRangeMsk(visible[visible.length - 1].scheduledAt)}`
      : "";
  const allApproved = pending.length === 0 && expired.length === 0 && approved.length > 0;

  return (
    <AppShell
      title="Автопилот"
      subtitle="ИИ собирает план недели по твоей аналитике и залётам конкурентов. Ты одобряешь — посты выходят сами."
      action={
        <Button variant="brand" onClick={generate} loading={busy} disabled={busy || building}>
          <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
          {building ? "План собирается" : plan ? "Пересобрать план" : "Собрать план недели"}
        </Button>
      }
    >
      {picker}
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
          <Link href={`/app/settings${chId ? `?channel=${chId}` : ""}`} className="shrink-0">
            <Button variant="outline" size="sm">
              <Settings2 className="h-4 w-4" aria-hidden />
              Настроить Аврору
            </Button>
          </Link>
        </div>
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
              <Link href={`/app/settings${chId ? `?channel=${chId}` : ""}`}>
                <Button size="sm" variant="brand">
                  Проверить и включить в настройках
                </Button>
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Состояние плана */}
      {building ? (
        <Card className="p-8 text-center">
          <Loader2 className="mx-auto h-7 w-7 animate-spin text-brand" aria-hidden />
          <p className="mt-3 text-[15px] font-semibold text-text">Собираю план недели…</p>
          <p className="mt-1 text-[14px] text-text-3">ИИ пишет посты в твоём стиле. Обычно минута.</p>
        </Card>
      ) : plan?.status === "error" ? (
        <Card className="p-8 text-center">
          <p className="text-[15px] font-semibold text-text">Не получилось собрать план</p>
          <p className="mx-auto mt-1 max-w-md text-[14px] text-text-3">
            {plan.errorReason === "timeout"
              ? "Сборка не была обработана вовремя. Перезапусти приложение и попробуй ещё раз."
              : plan.errorReason === "quota"
                ? "Дневной лимит ИИ исчерпан. Он обновится завтра; текущий план и настройки сохранены."
              : "Проверь, что канал подключён и ИИ-движок доступен, и попробуй ещё раз."}
          </p>
          <div className="mt-4">
            <Button variant="solid" onClick={generate} loading={busy} disabled={busy}>
              Попробовать снова
            </Button>
          </div>
        </Card>
      ) : !plan ? (
        <Card className="py-4">
          <EmptyState
            icon={<CalendarCheck className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title="Плана пока нет"
            body="Жми «Собрать план недели» — ИИ подготовит посты по твоей аналитике и залётам конкурентов, а ты одобришь одной кнопкой."
          />
        </Card>
      ) : (
        <div className="space-y-5">
          {/* Обзор недели — с одного взгляда: что, когда и что от тебя нужно */}
          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[15px] font-bold text-text">
                  {allApproved ? "Неделя в очереди 🚀" : "Твоя неделя готова"}
                </p>
                <p className="mt-0.5 text-[13px] text-text-3">
                  {visible.length} {plural(visible.length, "пост", "поста", "постов")}
                  {rangeLabel && <> · {rangeLabel}</>}
                  {pending.length > 0 && (
                    <>
                      {" "}
                      · {pending.length} {plural(pending.length, "ждёт", "ждут", "ждут")} тебя
                    </>
                  )}
                  {expired.length > 0 && <> · {expired.length} с истёкшей датой</>}
                </p>
              </div>
              {readyPending.length > 0 ? (
                <Button variant="brand" onClick={approveAll} loading={busy} disabled={busy}>
                  <Check className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
                  {blocked.length ? `Одобрить готовые (${readyPending.length})` : "Одобрить всё"}
                </Button>
              ) : blocked.length > 0 ? (
                <Link href={`/app/settings${chId ? `?channel=${chId}` : ""}`}>
                  <Button variant="outline" size="sm">
                    <Settings2 className="h-4 w-4" aria-hidden />
                    Исправить настройки
                  </Button>
                </Link>
              ) : allApproved ? (
                <Link href="/app/calendar">
                  <Button variant="soft" size="sm">
                    <CalendarCheck className="h-4 w-4" aria-hidden />
                    Открыть календарь
                  </Button>
                </Link>
              ) : null}
            </div>

            {/* Полоса дней. Кликни день — раскроется текст этого поста ниже. */}
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
              {visible.map((it) => {
                const done = it.status === "approved" || it.status === "published";
                const active = expanded === it.i;
                return (
                  <button
                    key={it.i}
                    type="button"
                    onClick={() => setExpanded(active ? null : it.i)}
                    aria-pressed={active}
                    className={cn(
                      "flex min-w-[84px] flex-1 flex-col items-center gap-1 rounded-lg border px-2 py-3 text-center transition-colors",
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
                          : it.status === "expired" || !hasPassedVerifiedQuality(it)
                            ? "bg-danger"
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
              {blocked.length > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden />не прошёл контроль
                </span>
              )}
              {expired.length > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden />дата истекла
                </span>
              )}
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
            {visible.map((it) => {
              const done = it.status === "approved" || it.status === "published";
              const isEditing = editing?.channelId === data.channelId &&
                editing.planId === plan.id &&
                editing.revision === plan.revision &&
                editing.itemIndex === it.i;
              const isOpen = expanded === it.i || isEditing;
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
                      className="flex w-full items-center gap-3 p-4 text-left"
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
                      ) : it.status === "expired" ? (
                        <Badge tone="danger">
                          <Clock className="h-3 w-3" aria-hidden />дата истекла
                        </Badge>
                      ) : !it.quality || !hasVerifiedQualityMetadata(it.quality) ? (
                        <Badge tone="neutral">
                          <AlertTriangle className="h-3 w-3" aria-hidden />не проверено
                        </Badge>
                      ) : it.qualityBlocked || it.quality.passed !== true ? (
                        <Badge tone="danger">
                          <AlertTriangle className="h-3 w-3" aria-hidden />
                          {it.quality.score}/{it.quality.threshold}
                        </Badge>
                      ) : (
                        <Badge tone="success">
                          {hasHumanQualityAttestation(it.quality)
                            ? "подтверждено вручную"
                            : "автопроверка"}{" "}
                          {it.quality.score}/{it.quality.threshold}
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
                            "whitespace-pre-line text-[14px] leading-relaxed text-text-2",
                            !isOpen && "line-clamp-2",
                          )}
                        >
                          {it.draft}
                        </p>
                      )}

                      {/* Невыверенная конкретика — ВСЕГДА на виду, без раскрытия карточки.
                          Человек не должен раскапывать риск: выдуманный номер статьи в канале
                          юриста — это его репутация. Автопилот такой пост сам не публикует. */}
                      {!isEditing && it.invented && it.invented.length > 0 && (
                        <div className="mt-3 flex items-start gap-2 rounded-sm bg-danger-soft p-3">
                          <AlertTriangle
                            className="mt-0.5 h-4 w-4 shrink-0 text-danger-text"
                            strokeWidth={2}
                            aria-hidden
                          />
                          <p className="text-[13px] leading-snug text-danger-text">
                            <span className="font-semibold">Проверь перед публикацией:</span> в тексте есть{" "}
                            {it.invented.join(", ")} — этого нет в твоей базе знаний. Возможно, ИИ
                            выдумал. Сам такой пост я не опубликую.
                          </p>
                        </div>
                      )}

                      {!isEditing && it.status === "expired" && (
                        <div className="mt-3 flex items-start gap-2 rounded-sm bg-danger-soft p-3">
                          <Clock
                            className="mt-0.5 h-4 w-4 shrink-0 text-danger-text"
                            aria-hidden
                          />
                          <p className="text-[13px] leading-snug text-danger-text">
                            <span className="font-semibold">Дата публикации истекла.</span> Этот
                            черновик не поставлен в очередь. Пересобери план, чтобы выбрать новую
                            дату перед следующим одобрением.
                          </p>
                        </div>
                      )}

                      {!isEditing &&
                        it.status === "pending" &&
                        !hasVerifiedQualityMetadata(it.quality) && (
                        <div className="mt-3 flex items-start gap-2 rounded-sm bg-danger-soft p-3">
                          <AlertTriangle
                            className="mt-0.5 h-4 w-4 shrink-0 text-danger-text"
                            aria-hidden
                          />
                          <p className="text-[13px] leading-snug text-danger-text">
                            <span className="font-semibold">Пост не проверен.</span> Без фактического
                            результата контроля качества его нельзя одобрить.
                          </p>
                        </div>
                      )}

                      {!isEditing &&
                        it.qualityBlocked &&
                        it.quality &&
                        hasVerifiedQualityMetadata(it.quality) && (
                        <div className="mt-3 rounded-sm bg-danger-soft p-3">
                          <p className="flex items-center gap-2 text-[13px] font-semibold text-danger-text">
                            <AlertTriangle className="h-4 w-4" aria-hidden />
                            Пост заблокирован · {it.quality.score}/{it.quality.threshold}
                          </p>
                          <ul className="mt-1.5 space-y-1 text-[13px] leading-snug text-danger-text">
                            {it.quality.violations.slice(0, 4).map((v) => (
                              <li key={`${v.code}-${v.message}`}>— {v.message}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* На чём основан пост — только в раскрытой карточке. Это доказательство,
                          что конкретика взята из базы знаний, а не выдумана. */}
                      {isOpen && !isEditing && it.sources && it.sources.length > 0 && (
                        <div className="mt-3 rounded-sm bg-surface-inset p-3">
                          <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-text-3">
                            <BookText className="h-3.5 w-3.5" aria-hidden />
                            На основе твоей базы знаний
                          </p>
                          <ul className="space-y-1">
                            {it.sources.map((src) => (
                              <li key={src.id} className="text-[13px] leading-snug text-text-3">
                                — {src.text}
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
                            disabled={!hasPassedVerifiedQuality(it)}
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
                            Поправить
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
        </div>
      )}
    </AppShell>
  );
}

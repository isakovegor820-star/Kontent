"use client";

// А10. Автопилот (ТЗ 5.6, Д.9). ИИ собирает план недели по аналитике (Д.5) и залётам (Д.7),
// в стиле пользователя. Одобрил — посты уходят в ту же очередь публикации (Д.3). Настоящие
// данные, никаких фейков: нет движка/аналитики — честно помечаем.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import {
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
import { Badge, Card, EmptyState, Switch, Textarea } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { MAX_WEEKLY_POSTS, RUBRICS, type Brief } from "@/lib/brief";
import { cn, plural } from "@/lib/utils";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";

interface PlanItem {
  i: number;
  scheduledAt: string;
  topic: string;
  rubric?: string | null; // рубрика из брифа — по ней берём иконку
  draft: string;
  status: "pending" | "approved" | "rejected" | "published";
}
interface Settings {
  enabled: boolean;
  mode: "confirm" | "full";
  post_frequency: number;
  approvals_streak: number;
}
interface State {
  settings: Settings | null;
  plan: { id: number; items: PlanItem[]; rules: string | null; status: string } | null;
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
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null); // какая карточка раскрыта целиком
  // Выбранный канал. Список и выбор — как на «Конкурентах» и «Трендах»: общий компонент,
  // общий источник (стор), чтобы человек узнавал один и тот же элемент на всех экранах.
  const [picked, setPicked] = useState<number | null>(null);
  const { tgChannels, channelId: chId } = useChannelChoice(s.realChannels, picked);

  // Частота — свободный ввод, поэтому держим её строкой: иначе поле нельзя очистить, чтобы
  // напечатать новое число (Number("") === 0 и ввод залипает на нуле).
  const [freq, setFreq] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/autopilot${chId ? `?channel=${chId}` : ""}`, { cache: "no-store" });
      const d = (await r.json()) as State;
      setData(d);
      // Синхронизируем поле здесь, а не эффектом на data: эффект переписывал бы ввод
      // прямо под пальцами, пока человек печатает.
      if (d.settings) setFreq(String(d.settings.post_frequency));
    } catch {
      /* сеть */
    } finally {
      setLoading(false);
    }
  }, [chId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка при монтировании
    load();
  }, [load]);

  const building = data?.plan?.status === "building";
  useEffect(() => {
    if (!building) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [building, load]);

  const patchSettings = async (patch: Partial<Settings>) => {
    setData((d) => (d && d.settings ? { ...d, settings: { ...d.settings, ...patch } } : d));
    await fetch("/api/autopilot/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...patch, channelId: chId }),
    }).catch(() => {});
    load();
  };

  const commitFreq = () => {
    const n = Math.round(Number(freq));
    if (!Number.isFinite(n) || n < 1) {
      setFreq(String(data?.settings?.post_frequency ?? 5)); // мусор — молча возвращаем прежнее
      return;
    }
    const capped = Math.min(MAX_WEEKLY_POSTS, n);
    if (capped !== n) {
      // Не режем молча: человек должен знать, что его число не приняли, и почему.
      s.toast({
        kind: "info",
        title: `Больше ${MAX_WEEKLY_POSTS} в неделю пока не могу`,
        body: "ИИ пишет посты по одному, и план собирался бы часами. Поставил максимум.",
      });
    }
    setFreq(String(capped));
    if (capped !== data?.settings?.post_frequency) patchSettings({ post_frequency: capped });
  };

  const perDay = Math.ceil((Number(freq) || 1) / 7);

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
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/autopilot/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: chId }),
      });
      const d = (await r.json().catch(() => null)) as { ok?: boolean; scheduled?: number } | null;
      if (d?.ok) {
        s.toast({
          kind: "success",
          title: `Одобрено — ${d.scheduled} в очереди 🚀`,
          body: "Посты выйдут по расписанию сами. Компьютер держать включённым не нужно.",
        });
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const itemAction = async (index: number, action: string, draft?: string) => {
    await fetch("/api/autopilot/item", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index, action, draft, channelId: chId }),
    }).catch(() => {});
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
              <Link href={`/app/autopilot/brief${chId ? `?channel=${chId}` : ""}`}>
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
  const allApproved = pending.length === 0 && approved.length > 0;

  return (
    <AppShell
      title="Автопилот"
      subtitle="ИИ собирает план недели по твоей аналитике и залётам конкурентов. Ты одобряешь — посты выходят сами."
      action={
        <Button variant="brand" onClick={generate} loading={busy && !plan} disabled={busy}>
          <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
          {plan ? "Пересобрать план" : "Собрать план недели"}
        </Button>
      }
    >
      {picker}
      {/* Настройки */}
      <Card className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-4 p-4">
        <div className="flex items-center gap-3">
          <span className="text-[14px] font-semibold text-text">Автопилот</span>
          <Switch
            checked={st.enabled}
            onChange={(v) => patchSettings({ enabled: v })}
            label="Автопилот"
          />
          {/* Состояние словами — по одному цвету не угадаешь */}
          <span
            className={cn(
              "text-[13px] font-semibold",
              st.enabled ? "text-success-text" : "text-text-3",
            )}
          >
            {st.enabled ? "включён" : "выключен"}
          </span>
        </div>

        {/* Свободный ввод вместо выпадашки из 3–7: частоту выбирает автор, а не мы.
            Больше семи — план сам разложит по несколько в день (см. weekSlots в воркере). */}
        <label className="flex items-center gap-2 text-[14px] text-text-2">
          Постов в неделю
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_WEEKLY_POSTS}
            value={freq}
            onChange={(e) => setFreq(e.target.value)}
            onBlur={commitFreq}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="Постов в неделю"
            className="h-9 w-16 rounded-sm border border-line bg-surface px-2 text-[14px] text-text tabular-nums"
          />
          {perDay > 1 && (
            <span className="text-[13px] text-text-3">≈ {perDay} в день</span>
          )}
        </label>

        <span className="ml-auto text-[13px] text-text-3">
          Режим: {st.mode === "full" ? "полный (без подтверждения)" : "с подтверждением"}
        </span>

        {/* Бриф на виду: всегда понятно, о чём автопилот считает нужным писать */}
        <div className="flex w-full flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <p className="min-w-0 text-[13px] leading-relaxed text-text-3">
            <span className="font-semibold text-text-2">Пишу про: </span>
            {data.brief?.niche}
            {data.brief?.audience && (
              <>
                <span className="font-semibold text-text-2"> · для кого: </span>
                {data.brief.audience}
              </>
            )}
          </p>
          <Link href={`/app/autopilot/brief${chId ? `?channel=${chId}` : ""}`}>
            <Button variant="ghost" size="sm">
              <Pencil className="h-4 w-4" aria-hidden />
              Изменить настройку
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
              <Button size="sm" variant="brand" onClick={() => patchSettings({ mode: "full" })}>
                Включить полный автопилот
              </Button>
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
            Проверь, что канал подключён и ИИ-движок доступен, и попробуй ещё раз.
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
                </p>
              </div>
              {pending.length > 0 ? (
                <Button variant="brand" onClick={approveAll} loading={busy} disabled={busy}>
                  <Check className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
                  Одобрить всё
                </Button>
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
                        done ? "bg-success" : "bg-brand",
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
            {visible.map((it) => {
              const done = it.status === "approved" || it.status === "published";
              const isOpen = expanded === it.i || editing === it.i;
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
                      onClick={() => editing !== it.i && setExpanded(isOpen ? null : it.i)}
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
                      ) : (
                        <Badge tone="neutral">ждёт тебя</Badge>
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
                      {editing === it.i ? (
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

                      {it.status === "pending" && editing !== it.i && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button size="sm" variant="soft" onClick={() => itemAction(it.i, "approve")}>
                            <Check className="h-4 w-4" aria-hidden />
                            Одобрить
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditing(it.i);
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

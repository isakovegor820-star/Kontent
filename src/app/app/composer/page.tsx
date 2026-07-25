"use client";

// А5. Редактор поста (Приложение А). Главное действие — «Запланировать».
// ТЗ 5.3: один пост адаптируется под обе сети с предпросмотром — предпросмотры
// TG и VK живут справа и обновляются на каждый символ.
// ТЗ 5.6: ИИ пишет/переписывает/сокращает с опорой на разведку (sourceRef → тренд/конкурент).
//
// Next 16: страница читает ?id=, ?date=, ?time= через useSearchParams(), а он требует
// обёртки в <Suspense> — иначе билд падает на CSR bailout. Поэтому всё состояние формы
// живёт в ComposerPage (над Suspense), чтобы кнопка «Запланировать» в шапке AppShell
// видела то же состояние, что и редактор. ComposerInner только читает параметры и рисует.

import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Bookmark,
  CalendarClock,
  CircleStop,
  Clapperboard,
  Clock,
  Eye,
  Flame,
  Heart,
  ImageIcon,
  MessageCircle,
  RefreshCw,
  Scissors,
  Share2,
  Sparkles,
  Trash2,
  TrendingUp,
  Video,
  X,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import {
  Badge,
  Card,
  Checkbox,
  Divider,
  Field,
  Input,
  TelegramIcon,
  Textarea,
  VkIcon,
} from "@/components/ui/primitives";
import { run, stream, type AiCommand } from "@/lib/ai";
import { useStore } from "@/lib/store";
import type { Network, Post, PostStatus, RealChannel } from "@/lib/types";
import {
  addDays,
  atTime,
  cn,
  fmtCompact,
  fmtDate,
  fmtDateTime,
  fmtNum,
  isoDay,
  plural,
} from "@/lib/utils";

/* ------------------------------------------------------------------ ХЕЛПЕРЫ */

/** Лимиты сетей на текст сообщения. Предпросмотр TG честно режет до своего. */
const TG_LIMIT = 4096;
const VK_LIMIT = 16384;
const NETWORK_LIMIT: Record<Network, number> = { tg: TG_LIMIT, vk: VK_LIMIT };

const NETWORK_ORDER: Network[] = ["tg", "vk"];

const toDateValue = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const toTimeValue = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** «2026-07-15» + «10:00» → Date в местном времени. null — если пусто или мусор. */
function parseWhen(date: string, time: string): Date | null {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Заглушка медиа: цветной градиент по hue — файлы в демо не грузим. */
const mediaStyle = (hue: number) => ({
  backgroundImage: `linear-gradient(135deg, hsl(${hue} 88% 64%), hsl(${(hue + 46) % 360} 82% 48%))`,
});

const chars = (n: number) => `${fmtNum(n)} ${plural(n, "символ", "символа", "символов")}`;

/* ------------------------------------------------------------- ОБЩЕЕ СОСТОЯНИЕ */

type Errors = { text?: string; networks?: string; when?: string };

interface HydrateInput {
  post: Post | null;
  date: string | null;
  time: string | null;
}

interface ComposerValue {
  hydrated: boolean;
  editingId: string | null;
  text: string;
  setText: (v: string) => void;
  networks: Network[];
  toggleNetwork: (n: Network, on: boolean) => void;
  /** Активные Telegram-каналы аккаунта. Пусто — канал ещё не подключён. */
  tgChannels: RealChannel[];
  /** Активные VK-сообщества аккаунта. Пусто — сообщество ещё не подключено. */
  vkChannels: RealChannel[];
  /** В какой TG-канал уходит пост. null — каналов нет или ещё грузятся. */
  channelId: number | null;
  setChannelId: (id: number) => void;
  /** В какое VK-сообщество уходит пост. null — сообществ нет или ещё грузятся. */
  vkChannelId: number | null;
  setVkChannelId: (id: number) => void;
  media: Post["media"];
  setMedia: (m: Post["media"]) => void;
  sourceRef: Post["sourceRef"];
  date: string;
  setDate: (v: string) => void;
  time: string;
  setTime: (v: string) => void;
  noDate: boolean;
  setNoDate: (v: boolean) => void;
  aiBusy: AiCommand | null;
  typing: boolean;
  topicOpen: boolean;
  setTopicOpen: (v: boolean) => void;
  topic: string;
  setTopic: (v: string) => void;
  errors: Errors;
  confirmDelete: boolean;
  setConfirmDelete: (v: boolean) => void;
  saving: boolean;
  runAi: (cmd: AiCommand) => void;
  stopAi: () => void;
  quick: (kind: "hour" | "tomorrow" | "best") => void;
  schedule: () => void;
  saveDraft: () => void;
  removeCurrent: () => void;
  hydrate: (input: HydrateInput) => void;
}

const ComposerCtx = createContext<ComposerValue | null>(null);

function useComposer() {
  const v = useContext(ComposerCtx);
  if (!v) throw new Error("useComposer должен вызываться внутри редактора поста");
  return v;
}

/* ---------------------------------------------------------------- СТРАНИЦА */

export default function ComposerPage() {
  const s = useStore();
  const router = useRouter();

  const [hydrated, setHydrated] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [networks, setNetworks] = useState<Network[]>(["tg", "vk"]);
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [pickedVkId, setPickedVkId] = useState<number | null>(null);
  const [media, setMedia] = useState<Post["media"]>(null);
  const [sourceRef, setSourceRef] = useState<Post["sourceRef"]>(undefined);
  const [origin, setOrigin] = useState<Post["origin"]>("manual");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [noDate, setNoDate] = useState(false);
  const [aiBusy, setAiBusy] = useState<AiCommand | null>(null);
  const [typing, setTyping] = useState(false);
  const [topicOpen, setTopicOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  const cancelRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Уходим со страницы — гасим печать ИИ, чтобы не сыпать setState в пустоту
  useEffect(
    () => () => {
      cancelRef.current?.();
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  /** Первичное заполнение формы: пост из ?id= либо чистый лист на ?date=/?time= */
  const hydrate = useCallback(({ post, date: d, time: t }: HydrateInput) => {
    const fallback = new Date(Date.now() + 3600_000);
    fallback.setMinutes(0, 0, 0); // ровный час — по нему легче попадать глазом
    const when = post?.scheduledAt ? new Date(post.scheduledAt) : fallback;

    setEditingId(post?.id ?? null);
    setText(post?.text ?? "");
    setNetworks(post?.networks?.length ? post.networks : ["tg", "vk"]);
    setMedia(post?.media ?? null);
    setSourceRef(post?.sourceRef);
    setOrigin(post?.origin ?? "manual");
    setDate(d ?? toDateValue(when));
    setTime(t ?? toTimeValue(when));
    // Клик по дню в календаре — это явное намерение поставить дату
    setNoDate(d ? false : post ? post.scheduledAt === null : false);
    setHydrated(true);
  }, []);

  /* -------------------------------------------------------------- КАНАЛЫ */
  // Каналов может быть несколько (мультиканальность).
  const tgChannels = useMemo(
    () => s.realChannels.filter((c) => c.network === "tg" && c.is_active),
    [s.realChannels],
  );
  const vkChannels = useMemo(
    () => s.realChannels.filter((c) => c.network === "vk" && c.is_active),
    [s.realChannels],
  );

  // Выбранный канал ВЫЧИСЛЯЕМ, а не синхронизируем эффектом. Каналы приезжают асинхронно,
  // и выбранный мог быть отключён в другой вкладке — при вычислении оба случая
  // разруливаются сами: нет живого выбора → первый активный. Плюс никакого setState
  // в эффекте, за который справедливо ругается линтер.
  const channelId = useMemo(() => {
    if (pickedId && tgChannels.some((c) => c.id === pickedId)) return pickedId;
    return tgChannels[0]?.id ?? null;
  }, [pickedId, tgChannels]);
  const vkChannelId = useMemo(() => {
    if (pickedVkId && vkChannels.some((c) => c.id === pickedVkId)) return pickedVkId;
    return vkChannels[0]?.id ?? null;
  }, [pickedVkId, vkChannels]);

  const toggleNetwork = useCallback(
    (n: Network, on: boolean) => {
      const next = NETWORK_ORDER.filter((x) => (x === n ? on : networks.includes(x)));
      setNetworks(next);
      setErrors((e) => ({
        ...e,
        networks: next.length ? undefined : "Выбери хотя бы одну сеть — иначе посту некуда идти.",
      }));
    },
    [networks],
  );

  /* --------------------------------------------------------------------- ИИ */

  // Связка «разведка → контент» (ТЗ 5.6): если пост родился из залёта — ИИ опирается на него
  const aiCtx = useMemo(() => {
    if (!sourceRef) return undefined;
    if (sourceRef.kind === "trend") {
      const trend = s.trends.find((t) => t.id === sourceRef.id);
      return trend ? { trend } : undefined;
    }
    const competitor = s.competitors.find((c) => c.id === sourceRef.id);
    return competitor ? { competitor } : undefined;
  }, [s.competitors, s.trends, sourceRef]);

  const stopAi = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setTyping(false);
    setAiBusy(null);
  }, []);

  const runAi = useCallback(
    (cmd: AiCommand) => {
      if (typing) return;

      const hasText = text.trim().length > 0;
      const hasTopic = topic.trim().length > 0;

      // «Напиши»/«Сценарий» на пустом листе — сначала спросим тему
      if ((cmd === "write" || cmd === "script") && !hasText && !hasTopic) {
        setTopicOpen(true);
        return;
      }
      if ((cmd === "rewrite" || cmd === "shorten") && !hasText) {
        s.toast({
          kind: "info",
          title: "Сначала нужен текст",
          body: "Перепишу и сокращу то, что уже написано. Пустой лист — жми «Напиши».",
        });
        return;
      }

      // Честный дневной лимит (ТЗ 12): говорим прямо, а не прячем в справке
      if (!s.spendAi(1)) {
        s.toast({
          kind: "danger",
          title: "Лимит ИИ на сегодня исчерпан",
          body: `Он честный: ${s.settings.aiDailyLimit} генераций в сутки. Обновится завтра — ИИ стоит денег, и мы не прячем это в справке.`,
        });
        return;
      }

      setErrors((e) => ({ ...e, text: undefined }));
      setAiBusy(cmd);

      const subject = topic.trim() || text.trim();
      const source = cmd === "rewrite" || cmd === "shorten" ? text : subject;
      const result = run(cmd, source, aiCtx);

      // Небольшая пауза «думает», потом текст печатается посимвольно прямо в поле
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setTyping(true);
        setText("");
        cancelRef.current = stream(
          result,
          (partial) => setText(partial),
          () => {
            cancelRef.current = null;
            setTyping(false);
            setAiBusy(null);
            setTopicOpen(false);
            setTopic("");
            setOrigin((o) => (o === "manual" ? "ai" : o));
          },
          14,
        );
      }, 420);
    },
    [aiCtx, s, text, topic, typing],
  );

  /* ------------------------------------------------------------------ ВРЕМЯ */

  const quick = useCallback((kind: "hour" | "tomorrow" | "best") => {
    const now = new Date();
    let target: Date;

    if (kind === "hour") {
      target = new Date(now.getTime() + 3600_000);
      target.setSeconds(0, 0);
    } else if (kind === "tomorrow") {
      target = atTime(addDays(now, 1), "10:00");
    } else {
      // «Лучшее время» — вторник 19:00 по аналитике канала
      const shift = (1 - isoDay(now) + 7) % 7;
      target = atTime(addDays(now, shift), "19:00");
      if (target.getTime() <= now.getTime()) target = atTime(addDays(target, 7), "19:00");
    }

    setNoDate(false);
    setDate(toDateValue(target));
    setTime(toTimeValue(target));
    setErrors((e) => ({ ...e, when: undefined }));
  }, []);

  /* ------------------------------------------------------------- СОХРАНЕНИЕ */

  const validate = useCallback(
    (needWhen: boolean) => {
      const next: Errors = {};

      if (!text.trim()) next.text = "Пост пустой. Напиши что-нибудь или попроси ИИ.";
      if (!networks.length) next.networks = "Выбери хотя бы одну сеть — иначе посту некуда идти.";

      if (needWhen && !noDate) {
        const when = parseWhen(date, time);
        if (!when) next.when = "Поставь дату и время — или отметь «Без даты — в очередь».";
        else if (when.getTime() <= Date.now())
          next.when = "Это время уже прошло. Выбери будущее — или отправим в очередь без даты.";
      }

      setErrors(next);
      return next;
    },
    [date, networks.length, noDate, text, time],
  );

  const schedule = useCallback(async () => {
    const bad = validate(true);
    const first = bad.text ?? bad.networks ?? bad.when;
    if (first) {
      s.toast({ kind: "danger", title: "Пост пока не готов", body: first });
      return;
    }

    const when = noDate ? null : parseWhen(date, time);
    const scheduledAt = when ? when.toISOString() : null;

    // Настоящий постинг (Д.3): пост уходит в реальную очередь по одной записи на каждую
    // выбранную сеть (у поста в базе один канал, воркер ветвится по network). Канал берём
    // ВЫБРАННЫЙ, а не первый попавшийся: при нескольких подключённых каналах .find() всегда
    // слал бы всё в один и тот же — мультиканальность существовала бы только в базе.
    if (scheduledAt) {
      const targets: { network: Network; channelId: number }[] = [];
      if (networks.includes("tg")) {
        const tg = channelId ? tgChannels.find((c) => c.id === channelId) : tgChannels[0];
        if (tg) targets.push({ network: "tg", channelId: tg.id });
      }
      if (networks.includes("vk")) {
        const vk = vkChannelId ? vkChannels.find((c) => c.id === vkChannelId) : vkChannels[0];
        if (vk) targets.push({ network: "vk", channelId: vk.id });
      }

      if (!targets.length) {
        s.toast({
          kind: "info",
          title: "Сначала подключи канал",
          body: "В мастере первого запуска добавь Telegram-канал или VK-сообщество — тогда пост уйдёт по-настоящему.",
        });
        return;
      }

      setSaving(true);
      const results = await Promise.all(
        targets.map((t) => s.createRealPost({ channelId: t.channelId, text, scheduledAt })),
      );
      setSaving(false);

      if (results.every((r) => r.ok)) {
        s.toast({
          kind: "success",
          title: "Пост запланирован",
          body: `${fmtDateTime(scheduledAt)}. Публикует сервер — можешь закрыть ноутбук.`,
        });
        router.push("/app/calendar");
      } else {
        s.toast({
          kind: "danger",
          title: "Не получилось запланировать",
          body: "Сервер не принял пост. Попробуй ещё раз.",
        });
      }
      return;
    }

    // Без даты — очередь в демо-хранилище (реальная очередь требует времени публикации).
    const status: PostStatus = scheduledAt ? "scheduled" : "queued";
    if (editingId) s.updatePost(editingId, { text, networks, media, scheduledAt, status });
    else s.addPost({ text, networks, media, scheduledAt, status, origin, sourceRef });
    s.toast({
      kind: "success",
      title: scheduledAt ? "Пост запланирован" : "Пост в очереди",
      body: scheduledAt
        ? `${fmtDateTime(scheduledAt)}. Публикует сервер — можешь закрыть ноутбук.`
        : "Даты нет — пост ждёт своей очереди. Поставишь время, когда решишь.",
    });
    router.push("/app/calendar");
  }, [
    channelId,
    date,
    editingId,
    media,
    networks,
    noDate,
    origin,
    router,
    s,
    sourceRef,
    text,
    tgChannels,
    time,
    validate,
    vkChannelId,
    vkChannels,
  ]);

  const saveDraft = useCallback(() => {
    const bad = validate(false);
    const first = bad.text ?? bad.networks;
    if (first) {
      s.toast({ kind: "danger", title: "Черновик не сохранён", body: first });
      return;
    }

    const when = noDate ? null : parseWhen(date, time);
    const scheduledAt = when ? when.toISOString() : null;

    if (editingId) {
      s.updatePost(editingId, { text, networks, media, scheduledAt, status: "draft" });
    } else {
      const created = s.addPost({
        text,
        networks,
        media,
        scheduledAt,
        status: "draft",
        origin,
        sourceRef,
      });
      setEditingId(created.id); // второй клик не создаст двойника
    }

    s.toast({
      kind: "success",
      title: "Черновик сохранён",
      body: "Никуда не денется — вернёшься, когда будет время.",
    });
  }, [date, editingId, media, networks, noDate, origin, s, sourceRef, text, time, validate]);

  const removeCurrent = useCallback(() => {
    if (!editingId) return;
    s.removePost(editingId);
    s.toast({
      kind: "info",
      title: "Пост удалён",
      body: "Если это вышло случайно — напиши заново, ИИ поможет за минуту.",
    });
    router.push("/app/calendar");
  }, [editingId, router, s]);

  const value = useMemo<ComposerValue>(
    () => ({
      hydrated,
      editingId,
      text,
      setText,
      networks,
      toggleNetwork,
      tgChannels,
      vkChannels,
      channelId,
      setChannelId: setPickedId,
      vkChannelId,
      setVkChannelId: setPickedVkId,
      media,
      setMedia,
      sourceRef,
      date,
      setDate,
      time,
      setTime,
      noDate,
      setNoDate,
      aiBusy,
      typing,
      topicOpen,
      setTopicOpen,
      topic,
      setTopic,
      errors,
      confirmDelete,
      setConfirmDelete,
      saving,
      runAi,
      stopAi,
      quick,
      schedule,
      saveDraft,
      removeCurrent,
      hydrate,
    }),
    [
      aiBusy,
      channelId,
      confirmDelete,
      date,
      editingId,
      errors,
      hydrate,
      hydrated,
      media,
      networks,
      noDate,
      tgChannels,
      vkChannels,
      vkChannelId,
      quick,
      removeCurrent,
      runAi,
      saveDraft,
      saving,
      schedule,
      sourceRef,
      stopAi,
      text,
      time,
      topic,
      topicOpen,
      toggleNetwork,
      typing,
    ],
  );

  return (
    <ComposerCtx.Provider value={value}>
      <AppShell
        title="Редактор поста"
        subtitle="Один пост — обе сети. Предпросмотр покажет, как он будет выглядеть."
        action={<ScheduleButton />}
      >
        <Suspense fallback={<ComposerSkeleton />}>
          <ComposerInner />
        </Suspense>
      </AppShell>
    </ComposerCtx.Provider>
  );
}

/* ------------------------------------------------- ГЛАВНОЕ ДЕЙСТВИЕ (шапка) */
// Единственный градиент на экране — правило ТЗ 7.2 («магнит»).

function ScheduleButton() {
  const c = useComposer();
  return (
    <Button
      variant="brand"
      size="lg"
      onClick={c.schedule}
      disabled={!c.hydrated}
      loading={c.saving}
      className="glow-pulse"
    >
      {!c.saving && <CalendarClock className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />}
      {c.noDate ? "Отправить в очередь" : "Запланировать"}
    </Button>
  );
}

/* ---------------------------------------------------------------- РЕДАКТОР */

function ComposerInner() {
  const s = useStore();
  const params = useSearchParams();
  const reduce = useReducedMotion();
  const c = useComposer();

  const idParam = params.get("id");
  const dateParam = params.get("date");
  const timeParam = params.get("time");
  const textParam = params.get("text"); // готовый черновик из «Сними это» (Д.7)

  const { hydrate, hydrated, text, typing } = c;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const topicRef = useRef<HTMLInputElement>(null);
  const once = useRef(false);

  // Ждём гидрацию стора (s.ready) — иначе прочитаем seed вместо сохранённого поста
  useEffect(() => {
    if (!s.ready || once.current) return;
    once.current = true;

    const post = idParam ? (s.posts.find((p) => p.id === idParam) ?? null) : null;
    if (idParam && !post) {
      s.toast({
        kind: "info",
        title: "Пост не нашёлся",
        body: "Похоже, его уже удалили. Открыл чистый лист — можно писать заново.",
      });
    }
    hydrate({ post, date: dateParam, time: timeParam });
    // Пришли из идеи «Сними это» с готовым текстом — подставляем в редактор.
    if (!idParam && textParam) c.setText(textParam);
  }, [dateParam, hydrate, idParam, s, timeParam, textParam, c]);

  // ИИ печатает — держим видимым хвост текста
  useEffect(() => {
    if (typing && taRef.current) taRef.current.scrollTop = taRef.current.scrollHeight;
  }, [text, typing]);

  useEffect(() => {
    if (c.topicOpen) topicRef.current?.focus();
  }, [c.topicOpen]);

  if (!s.ready || !hydrated) return <ComposerSkeleton />;

  const len = text.length;
  // Лимит считаем по выбранной сети: TG режет на 4096, VK терпит до 16384.
  // Если включены обе — ориентиром служит более строгий telegram-лимит.
  const effLimit = c.networks.includes("tg") ? NETWORK_LIMIT.tg : NETWORK_LIMIT.vk;
  const over = len > effLimit;
  const tgOn = c.networks.includes("tg");
  const vkOn = c.networks.includes("vk");
  const aiLeft = Math.max(0, s.settings.aiDailyLimit - s.settings.aiUsedToday);
  const when = parseWhen(c.date, c.time);

  // Предпросмотр обязан показывать ТОТ канал, в который уйдёт пост. Раньше он всегда брал
  // демо-канал из моков — при одном канале это была незаметная условность, но теперь человек
  // выбирает канал сам, и чужое имя в превью прямо противоречило бы его выбору.
  const pickedCh = c.tgChannels.find((ch) => ch.id === c.channelId);
  const demoTg = s.channels.find((ch) => ch.network === "tg");
  const tgCh = pickedCh
    ? {
        name: pickedCh.title ?? "Твой канал",
        handle: pickedCh.handle ? `@${pickedCh.handle.replace(/^@/, "")}` : "",
        // Подписчиков реального канала здесь нет — показываем демо-число только когда
        // канал демонстрационный, иначе честнее не показывать ничего.
        subscribers: 0,
      }
    : demoTg;
  const vkCh = s.channels.find((ch) => ch.network === "vk");

  const aiActions: { cmd: AiCommand; label: string; icon: React.ReactNode }[] = [
    { cmd: "write", label: "Напиши", icon: <Sparkles className="h-4 w-4" aria-hidden /> },
    { cmd: "rewrite", label: "Перепиши", icon: <RefreshCw className="h-4 w-4" aria-hidden /> },
    { cmd: "shorten", label: "Сократи", icon: <Scissors className="h-4 w-4" aria-hidden /> },
    {
      cmd: "script",
      label: "Сценарий видео",
      icon: <Clapperboard className="h-4 w-4" aria-hidden />,
    },
  ];

  const addMedia = (kind: "image" | "video") =>
    c.setMedia({
      kind,
      label: kind === "video" ? "Вертикалка 9:16" : "Фото к посту",
      hue: Math.floor(Math.random() * 360),
    });

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      c.schedule();
    }
  };

  const fade = {
    initial: { opacity: 0, y: reduce ? 0 : -6 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: reduce ? 0 : -6 },
    transition: { duration: reduce ? 0 : 0.2, ease: "easeOut" as const },
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* ------------------------------------------------------ ЛЕВО: РЕДАКТОР */}
      <Card className="min-w-0 flex-1 space-y-6 p-5 sm:p-6">
        {c.sourceRef && <SourcePlate source={c.sourceRef} />}

        <Field label="Текст поста" htmlFor="composer-text" error={c.errors.text}>
          <div>
            <Textarea
              id="composer-text"
              ref={taRef}
              rows={12}
              value={text}
              readOnly={typing}
              aria-busy={typing || undefined}
              onChange={(e) => c.setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Пиши как обычно — или нажми «Напиши», и ИИ начнёт за тебя."
              className={cn(typing && "cursor-progress")}
            />

            <div className="mt-2 flex items-start justify-between gap-4">
              {over ? (
                <p className="text-[13px] font-medium text-danger">
                  {c.networks.includes("tg")
                    ? `Для Telegram лимит ${fmtNum(TG_LIMIT)} символов — VK стерпит, Telegram обрежет.`
                    : `Для VK лимит ${fmtNum(VK_LIMIT)} символов — сократи текст.`}
                </p>
              ) : (
                <p className="text-[13px] text-text-3">Ctrl + Enter — запланировать</p>
              )}
              <span className="nums shrink-0 text-[13px] text-text-3">{chars(len)}</span>
            </div>
          </div>
        </Field>

        {/* --------------------------------------------------------------- ИИ */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-semibold text-text-2">ИИ-помощник</p>
            <p className="nums text-[13px] text-text-3">
              осталось {fmtNum(aiLeft)} из {fmtNum(s.settings.aiDailyLimit)} генераций на сегодня
            </p>
          </div>

          <AnimatePresence initial={false}>
            {c.topicOpen && (
              <motion.div key="topic" {...fade} className="flex flex-wrap gap-2">
                <Input
                  ref={topicRef}
                  value={c.topic}
                  onChange={(e) => c.setTopic(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      c.runAi("write");
                    }
                    if (e.key === "Escape") c.setTopicOpen(false);
                  }}
                  placeholder="О чём пост?"
                  className="min-w-0 flex-1"
                  aria-label="Тема поста"
                />
                <Button variant="soft" onClick={() => c.runAi("write")} className="shrink-0">
                  <Sparkles className="h-[18px] w-[18px]" aria-hidden />
                  Написать
                </Button>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex flex-wrap gap-2">
            {aiActions.map((a) => (
              <Button
                key={a.cmd}
                variant="soft"
                size="sm"
                loading={c.aiBusy === a.cmd}
                disabled={typing && c.aiBusy !== a.cmd}
                onClick={() => c.runAi(a.cmd)}
              >
                {c.aiBusy === a.cmd ? null : a.icon}
                {a.label}
              </Button>
            ))}
          </div>

          <AnimatePresence initial={false}>
            {typing && (
              <motion.div
                key="typing"
                {...fade}
                className="flex items-center gap-2 rounded-sm bg-info-soft px-3 py-2"
              >
                <Sparkles className="h-4 w-4 animate-pulse text-brand" aria-hidden />
                <span className="text-[13px] font-semibold text-info-text">ИИ печатает…</span>
                <Button variant="ghost" size="sm" onClick={c.stopAi} className="ml-auto">
                  <CircleStop className="h-4 w-4" aria-hidden />
                  Стоп
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <Divider />

        {/* ------------------------------------------------------------ МЕДИА */}
        <div className="space-y-3">
          <p className="text-[13px] font-semibold text-text-2">Медиа</p>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => addMedia("image")}>
              <ImageIcon className="h-4 w-4" aria-hidden />
              {c.media?.kind === "image" ? "Заменить фото" : "Добавить фото"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => addMedia("video")}>
              <Video className="h-4 w-4" aria-hidden />
              {c.media?.kind === "video" ? "Заменить видео" : "Добавить видео"}
            </Button>
          </div>

          <AnimatePresence initial={false}>
            {c.media && (
              <motion.div
                key="media"
                {...fade}
                className="flex items-center gap-3 rounded-sm border border-line bg-surface-2 p-3"
              >
                <div
                  className="relative h-14 w-20 shrink-0 overflow-hidden rounded-xs"
                  style={mediaStyle(c.media.hue)}
                  aria-hidden
                >
                  <span className="absolute inset-0 flex items-center justify-center text-white">
                    {c.media.kind === "video" ? (
                      <Video className="h-5 w-5" strokeWidth={2} />
                    ) : (
                      <ImageIcon className="h-5 w-5" strokeWidth={2} />
                    )}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-text">{c.media.label}</p>
                  <p className="truncate text-[13px] text-text-3">
                    {c.media.kind === "video" ? "Видео" : "Изображение"} · размер подгоним под каждую
                    сеть
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Убрать медиа"
                  onClick={() => c.setMedia(null)}
                >
                  <X className="h-[18px] w-[18px]" aria-hidden />
                </Button>
              </motion.div>
            )}
          </AnimatePresence>

          <p className="text-[13px] text-text-3">
            В демо медиа — заглушка. В платформе картинка сама подгонится под размеры каждой сети.
          </p>
        </div>

        <Divider />

        {/* ------------------------------------------------------------- СЕТИ */}
        <div className="space-y-3">
          <p className="text-[13px] font-semibold text-text-2">Куда публикуем</p>

          <div className="flex flex-wrap items-center gap-6">
            <Checkbox
              id="net-tg"
              checked={tgOn}
              onChange={(v) => c.toggleNetwork("tg", v)}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <TelegramIcon className="h-4 w-4 text-text-2" />
                  Telegram
                </span>
              }
            />
            <Checkbox
              id="net-vk"
              checked={vkOn}
              onChange={(v) => c.toggleNetwork("vk", v)}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <VkIcon className="h-4 w-4 text-text-2" />
                  VK
                </span>
              }
            />
          </div>

          {c.errors.networks && (
            <p role="alert" className="text-[13px] font-medium text-danger-text">
              {c.errors.networks}
            </p>
          )}

          {/* Выбор канала — только при нескольких. У кого канал один, тому нечего решать,
              и лишний селектор был бы шумом. */}
          {tgOn && c.tgChannels.length > 1 && (
            <div className="space-y-2 pt-1">
              <p className="text-[13px] font-semibold text-text-2">В какой канал</p>
              <div className="flex flex-wrap gap-2">
                {c.tgChannels.map((ch) => {
                  const on = c.channelId === ch.id;
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => c.setChannelId(ch.id)}
                      aria-pressed={on}
                      className={cn(
                        "inline-flex h-11 max-w-full cursor-pointer items-center gap-2 rounded-xs px-3.5",
                        "text-[14px] font-semibold transition-colors duration-200",
                        on
                          ? "bg-info-soft text-info-text ring-1 ring-brand/30 ring-inset"
                          : "bg-surface-inset text-text-2 hover:text-text",
                      )}
                    >
                      <TelegramIcon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{ch.title ?? ch.handle ?? `Канал ${ch.id}`}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {vkOn && c.vkChannels.length > 1 && (
            <div className="space-y-2 pt-1">
              <p className="text-[13px] font-semibold text-text-2">В какое сообщество</p>
              <div className="flex flex-wrap gap-2">
                {c.vkChannels.map((ch) => {
                  const on = c.vkChannelId === ch.id;
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => c.setVkChannelId(ch.id)}
                      aria-pressed={on}
                      className={cn(
                        "inline-flex h-11 max-w-full cursor-pointer items-center gap-2 rounded-xs px-3.5",
                        "text-[14px] font-semibold transition-colors duration-200",
                        on
                          ? "bg-info-soft text-info-text ring-1 ring-brand/30 ring-inset"
                          : "bg-surface-inset text-text-2 hover:text-text",
                      )}
                    >
                      <VkIcon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{ch.title ?? ch.handle ?? `Сообщество ${ch.id}`}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ------------------------------------------------------------ ВРЕМЯ */}
        <Field
          label="Когда публикуем"
          error={c.errors.when}
          hint="Публикует сервер — компьютер можно выключить."
        >
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                type="date"
                value={c.date}
                disabled={c.noDate}
                aria-label="Дата публикации"
                onChange={(e) => c.setDate(e.target.value)}
                className="w-[176px] nums"
              />
              <Input
                type="time"
                value={c.time}
                disabled={c.noDate}
                aria-label="Время публикации"
                onChange={(e) => c.setTime(e.target.value)}
                className="w-[136px] nums"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="soft"
                size="sm"
                disabled={c.noDate}
                onClick={() => c.quick("hour")}
              >
                <Clock className="h-4 w-4" aria-hidden />
                Через час
              </Button>
              <Button
                variant="soft"
                size="sm"
                disabled={c.noDate}
                onClick={() => c.quick("tomorrow")}
              >
                <CalendarClock className="h-4 w-4" aria-hidden />
                Завтра 10:00
              </Button>
              <Button
                variant="soft"
                size="sm"
                disabled={c.noDate}
                onClick={() => c.quick("best")}
                className="gap-2"
              >
                <TrendingUp className="h-4 w-4" aria-hidden />
                Лучшее время (вт 19:00)
                <Badge tone="brand">по твоей аналитике</Badge>
              </Button>
            </div>

            <Checkbox
              id="no-date"
              checked={c.noDate}
              onChange={c.setNoDate}
              label="Без даты — в очередь"
            />
          </div>
        </Field>

        <Divider />

        {/* --------------------------------------------------------- ДЕЙСТВИЯ */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={c.saveDraft}>
              Сохранить как черновик
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                const text = c.text.trim();
                if (!text) return;
                try {
                  const r = await fetch("/api/library/posts", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text }),
                  });
                  if (r.ok) {
                    s.toast({ kind: "success", title: "Сохранено в библиотеку" });
                  } else {
                    s.toast({ kind: "danger", title: "Не удалось сохранить" });
                  }
                } catch {
                  s.toast({ kind: "danger", title: "Сетевая ошибка" });
                }
              }}
              disabled={!c.text.trim()}
            >
              <Bookmark className="h-[18px] w-[18px]" aria-hidden />
              В библиотеку
            </Button>
            {c.editingId && (
              <Button variant="danger" onClick={() => c.setConfirmDelete(true)}>
                <Trash2 className="h-[18px] w-[18px]" aria-hidden />
                Удалить
              </Button>
            )}
          </div>
          <p className="text-[13px] text-text-3">
            Главная кнопка — «{c.noDate ? "Отправить в очередь" : "Запланировать"}» — вверху.
          </p>
        </div>

        <AnimatePresence initial={false}>
          {c.confirmDelete && (
            <motion.div key="confirm" {...fade}>
              <div className="rounded-sm border border-danger/30 bg-danger-soft p-4">
                <p className="text-[15px] font-bold text-danger-text">
                  Удалить пост? Это нельзя отменить.
                </p>
                <p className="mt-1 text-[14px] leading-relaxed text-danger-text/80">
                  Он исчезнет и из календаря, и из очереди. Восстановить не получится.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="danger" onClick={c.removeCurrent}>
                    <Trash2 className="h-[18px] w-[18px]" aria-hidden />
                    Да, удалить
                  </Button>
                  <Button variant="ghost" onClick={() => c.setConfirmDelete(false)}>
                    Оставить
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {/* -------------------------------------------------- ПРАВО: ПРЕДПРОСМОТР */}
      <aside className="w-full shrink-0 space-y-4 lg:sticky lg:top-6 lg:w-[380px]">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[17px] font-extrabold tracking-tight text-text">Как это увидят</h2>
          <span className="text-[13px] text-text-3">обновляется на лету</span>
        </div>

        <TelegramPreview
          on={tgOn}
          text={text}
          media={c.media}
          typing={typing}
          name={tgCh?.name ?? "Твой канал"}
          handle={tgCh?.handle ?? "@your_channel"}
          subscribers={tgCh?.subscribers ?? 0}
          when={c.noDate ? "в очереди" : c.time || "—"}
        />

        <VkPreview
          on={vkOn}
          text={text}
          media={c.media}
          typing={typing}
          name={vkCh?.name ?? "Твоё сообщество"}
          subscribers={vkCh?.subscribers ?? 0}
          when={
            c.noDate
              ? "в очереди · без даты"
              : when
                ? `${fmtDate(when.toISOString())} в ${c.time}`
                : "дата не выбрана"
          }
        />

        <p className="text-[13px] leading-relaxed text-text-3">
          Различия сетей платформа учтёт сама: длину, разметку и размер картинки. Цифры под постом —
          пример оформления, а не прогноз.
        </p>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------- ПЛАШКА «ИЗ РАЗВЕДКИ» */

function SourcePlate({ source }: { source: NonNullable<Post["sourceRef"]> }) {
  const href = source.kind === "competitor" ? `/app/competitors/${source.id}` : "/app/trends";

  return (
    <div className="flex items-center gap-3 rounded-sm bg-fire-soft px-4 py-2.5">
      <Flame className="h-[18px] w-[18px] shrink-0 text-fire" strokeWidth={2} aria-hidden />
      <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fire-text">
        Из разведки: {source.label}
      </p>
      <Link
        href={href}
        className="-mx-2 inline-flex min-h-11 shrink-0 items-center gap-1 px-2 text-[13px] font-semibold text-fire-text transition-opacity duration-200 hover:opacity-70"
      >
        Открыть
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------- ПРЕДПРОСМОТРЫ */

interface PreviewProps {
  on: boolean;
  text: string;
  media: Post["media"];
  typing: boolean;
  name: string;
  subscribers: number;
  when: string;
}

function PreviewHead({ network, on }: { network: Network; on: boolean }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-text-2">
        {network === "tg" ? (
          <TelegramIcon className="h-4 w-4" />
        ) : (
          <VkIcon className="h-4 w-4" />
        )}
        {network === "tg" ? "Telegram" : "VK"}
      </span>
      {!on && <span className="text-[13px] font-medium text-text-3">Сеть отключена</span>}
    </div>
  );
}

function PreviewText({ value, typing }: { value: string; typing: boolean }) {
  return (
    <p className="max-h-[280px] overflow-y-auto text-[15px] leading-relaxed whitespace-pre-wrap break-words text-text">
      {value ? (
        value
      ) : (
        <span className="text-text-3">
          Здесь появится твой пост. Начни печатать — или попроси ИИ.
        </span>
      )}
      {typing && <span className="caret" aria-hidden />}
    </p>
  );
}

function MediaBlock({ media, className }: { media: NonNullable<Post["media"]>; className?: string }) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-sm", className)}
      style={mediaStyle(media.hue)}
      aria-hidden
    >
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-black/25 px-3 py-1.5 text-[13px] font-semibold text-white backdrop-blur-[2px]">
        {media.kind === "video" ? (
          <Video className="h-4 w-4" strokeWidth={2} />
        ) : (
          <ImageIcon className="h-4 w-4" strokeWidth={2} />
        )}
        {media.label}
      </div>
    </div>
  );
}

// Telegram: медиа сверху, текст под ним, снизу — просмотры и время.
function TelegramPreview({
  on,
  text,
  media,
  typing,
  name,
  handle,
  subscribers,
  when,
}: PreviewProps & { handle: string }) {
  const shown = text.slice(0, TG_LIMIT);
  const cut = Math.max(0, text.length - TG_LIMIT);
  const views = Math.max(140, Math.round(subscribers * 0.26));

  return (
    <div>
      <PreviewHead network="tg" on={on} />
      <Card
        className={cn(
          "overflow-hidden rounded-lg p-0 transition-opacity duration-200",
          !on && "opacity-40",
        )}
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="h-9 w-9 shrink-0 rounded-full bg-brand-gradient" aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-bold text-text">{name}</p>
            <p className="truncate text-[13px] text-text-3">{handle}</p>
          </div>
        </div>

        {media && (
          <div className="px-3 pt-3">
            <MediaBlock media={media} className="h-32" />
          </div>
        )}

        <div className="px-4 py-3">
          <PreviewText value={shown} typing={typing} />
          {cut > 0 && (
            <p className="mt-2 text-[13px] font-medium text-danger">
              Telegram обрежет здесь — {chars(cut)} не поместились.
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5 border-t border-line px-4 py-2.5 text-[13px] text-text-3">
          <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          <span className="nums">{fmtCompact(views)}</span>
          <span aria-hidden>·</span>
          <span className="nums">{when}</span>
        </div>
      </Card>
    </div>
  );
}

// VK: текст сверху, вложение под ним, снизу — реакции.
function VkPreview({ on, text, media, typing, name, subscribers, when }: PreviewProps) {
  const likes = Math.max(12, Math.round(subscribers * 0.021));
  const comments = Math.max(2, Math.round(subscribers * 0.004));
  const shares = Math.max(1, Math.round(subscribers * 0.0022));
  const views = Math.max(120, Math.round(subscribers * 0.42));

  return (
    <div>
      <PreviewHead network="vk" on={on} />
      <Card className={cn("overflow-hidden p-0 transition-opacity duration-200", !on && "opacity-40")}>
        <div className="flex items-center gap-3 px-4 pt-4">
          <div className="h-10 w-10 shrink-0 rounded-xs bg-brand-gradient" aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-bold text-text">{name}</p>
            <p className="truncate text-[13px] text-text-3">{when}</p>
          </div>
        </div>

        <div className="px-4 py-3">
          <PreviewText value={text} typing={typing} />
        </div>

        {media && (
          <div className="px-4 pb-3">
            <MediaBlock media={media} className="h-36" />
          </div>
        )}

        <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 text-[13px] text-text-3">
          <span className="inline-flex items-center gap-1.5">
            <Heart className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            <span className="nums">{fmtNum(likes)}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <MessageCircle className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            <span className="nums">{fmtNum(comments)}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Share2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            <span className="nums">{fmtNum(shares)}</span>
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            <span className="nums">{fmtCompact(views)}</span>
          </span>
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- СКЕЛЕТОН */

function ComposerSkeleton() {
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <Card className="min-w-0 flex-1 space-y-5 p-5 sm:p-6">
        <div className="skeleton h-4 w-28" />
        <div className="skeleton h-64 w-full rounded-sm" />
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-9 w-32 rounded-[10px]" />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="skeleton h-12 w-[176px] rounded-xs" />
          <div className="skeleton h-12 w-[136px] rounded-xs" />
        </div>
        <div className="skeleton h-11 w-56 rounded-xs" />
      </Card>

      <aside className="w-full shrink-0 space-y-4 lg:w-[380px]">
        <div className="skeleton h-5 w-40" />
        <div className="skeleton h-60 w-full rounded-lg" />
        <div className="skeleton h-60 w-full rounded-md" />
      </aside>
    </div>
  );
}

"use client";

// А8 — «Сними это» (ТЗ 5.5, Д.7). Панель разведки контента: что у конкурентов зашло
// сильнее их собственной нормы — и как снять это себе.
//
// Почему это лента-рейтинг, а не «детектор залётов»: в Telegram нет алгоритмической ленты,
// подписчик видит каждый пост канала, поэтому просмотры почти не гуляют. На живых каналах
// потолок — ×2–4 к медиане (даже у @durov ×3.85), а порог ×5 не берётся никогда. Страница,
// которая ждёт ×5, стоит пустой при полной базе постов. Поэтому показываем рейтинг всегда,
// а огонёк ставим на настоящие выбросы. Порог — в руках пользователя, а не в env.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  ExternalLink,
  Eye,
  FileText,
  Flame,
  Loader2,
  Radar,
  RefreshCw,
  Sparkles,
  Users,
} from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { ReconTabs } from "@/components/app/recon-tabs";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Tabs } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { cn, fmtAgo, fmtCompact, plural } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

interface Idea {
  id: number;
  topic: string | null;
  hook: string | null;
  structure: string | null;
  why: string | null;
}

interface Item {
  id: number;
  competitorId: number;
  handle: string;
  competitorTitle: string | null;
  category: string | null;
  msgId: number;
  text: string | null;
  views: number;
  reactions: number | null;
  photoUrl: string | null;
  media: string | null;
  postedAt: string;
  median: number;
  ratio: number;
  link: string;
  idea: Idea | null;
}

interface Competitor {
  id: number;
  handle: string;
  title: string | null;
  subscribers: number | null;
  status: string;
  lastError: string | null;
  category: string | null;
  posts: number;
  median: number | null;
  matured: number;
  link: string;
}

interface Data {
  status: {
    competitors: number;
    ready: number;
    pending: number;
    error: number;
    posts: number;
    lastCollectedAt: string | null;
    matureHours: number;
    minMature: number;
    /** Находок по теме канала, ждущих подтверждения */
    waiting: number;
    /** Тема канала из брифа — по ней и искали */
    niche: string | null;
  };
  competitors: Competitor[];
  items: Item[];
}

// Пороги — то, что раньше было env-переменной HIT_RATIO=5 и молча решало за пользователя.
const THRESHOLDS = [
  { value: "all", label: "Всё", min: 0 },
  { value: "1.5", label: "×1,5+", min: 1.5 },
  { value: "2", label: "×2+", min: 2 },
  { value: "3", label: "×3+", min: 3 },
] as const;
type ThresholdValue = (typeof THRESHOLDS)[number]["value"];

const fmtRatio = (r: number) => `×${r.toFixed(1).replace(".", ",")}`;

/* ------------------------------------------------------------ СТРОКА СОСТОЯНИЯ */
// Отвечает на «что вообще происходит»: за кем слежу, сколько собрано, когда проверяли.

function StatusStrip({ status, onCheck, checking }: { status: Data["status"]; onCheck: () => void; checking: boolean }) {
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
      <span className="inline-flex items-center gap-2 text-[14px] font-semibold text-text">
        <Radar className="h-4 w-4 text-brand" aria-hidden />
        Слежу за {status.competitors} {plural(status.competitors, "каналом", "каналами", "каналами")}
      </span>
      <span className="text-[13px] text-text-2">
        {fmtCompact(status.posts)} {plural(status.posts, "пост", "поста", "постов")} собрано
      </span>
      {status.lastCollectedAt && (
        <span className="text-[13px] text-text-3">проверено {fmtAgo(status.lastCollectedAt)}</span>
      )}
      {status.pending > 0 && (
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          собираю {status.pending}
        </span>
      )}
      {status.error > 0 && (
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-danger-text">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          {status.error} не собрался
        </span>
      )}
      <Button size="sm" variant="soft" onClick={onCheck} loading={checking} className="ml-auto">
        <RefreshCw className="h-4 w-4" aria-hidden />
        Проверить сейчас
      </Button>
    </Card>
  );
}

/* ------------------------------------------------------------- ЗА КЕМ СЛЕЖУ */
// Норма канала показана явно — иначе «×2,2 к норме» это число из воздуха.

function WatchList({ competitors }: { competitors: Competitor[] }) {
  // 12 источников — это три ряда чипов, которые съедали весь первый экран до самой ленты.
  // Показываем шесть, остальные по клику: список важен для доверия, но не важнее контента.
  const [all, setAll] = useState(false);
  const shown = all ? competitors : competitors.slice(0, 6);
  const rest = competitors.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {shown.map((c) => (
        <a
          key={c.id}
          href={c.link}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] transition-colors hover:border-line-strong"
        >
          <span className="font-semibold text-text">{c.title || `@${c.handle}`}</span>
          {c.subscribers != null && (
            <span className="inline-flex items-center gap-1 text-text-3">
              <Users className="h-3 w-3" aria-hidden />
              {fmtCompact(c.subscribers)}
            </span>
          )}
          {c.status === "error" ? (
            <span className="text-danger-text">не собрался</span>
          ) : c.median != null ? (
            <span className="text-text-3">норма {fmtCompact(c.median)}</span>
          ) : (
            // Нормы ещё нет: либо канал новый, либо все его посты моложе 48ч.
            <span className="text-text-3">
              норма считается ({c.matured}/5)
            </span>
          )}
        </a>
      ))}
      {rest > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="cursor-pointer rounded-full border border-dashed border-line-strong px-3 py-1.5 text-[12px] font-semibold text-text-3 transition-colors hover:text-text"
        >
          ещё {rest}
        </button>
      )}
      {all && competitors.length > 6 && (
        <button
          type="button"
          onClick={() => setAll(false)}
          className="cursor-pointer px-2 py-1.5 text-[12px] font-semibold text-text-3 transition-colors hover:text-text"
        >
          свернуть
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- ФОТО ПОСТА */
// Кадр показываем ЦЕЛИКОМ (object-contain), а не куском: у Telegram половина картинок
// вертикальные (600×800), и обрезка по широкой карточке съедала 84% кадра и растягивала
// остаток в 1.36 раза — отсюда и мыло. Поля вокруг закрываем размытой копией того же кадра,
// поэтому пустых поле́й тоже нет. Пока грузится — скелет, а не серая дыра.
// Ссылка CDN может протухнуть: тогда блок исчезает целиком, без битого значка.

function PostPhoto({ src, link }: { src: string; link: string }) {
  const [state, setState] = useState<"loading" | "ok" | "fail">("loading");
  const imgRef = useRef<HTMLImageElement>(null);

  // Картинка из кеша успевает загрузиться ДО того, как React навесит onLoad — тогда событие
  // не придёт никогда и кадр навсегда останется прозрачным (виден один размытый фон).
  // Поэтому при монтировании спрашиваем сам элемент, а не ждём события.
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete) setState(img.naturalWidth ? "ok" : "fail");
  }, []);

  if (state === "fail") return null;

  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group relative block aspect-[4/3] overflow-hidden bg-surface-inset",
        state === "loading" && "skeleton",
      )}
    >
      <div
        className="absolute inset-0 scale-125 bg-cover bg-center opacity-35 blur-2xl"
        style={{ backgroundImage: `url("${src}")` }}
        aria-hidden
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- внешний CDN Telegram, next/image здесь только мешает */}
      <img
        ref={imgRef}
        src={src}
        alt=""
        loading="lazy"
        onLoad={() => setState("ok")}
        onError={() => setState("fail")}
        className={cn(
          "relative h-full w-full object-contain transition-all duration-300 group-hover:scale-[1.03]",
          state === "ok" ? "opacity-100" : "opacity-0",
        )}
      />
    </a>
  );
}

/* ------------------------------------------------------------------ КАРТОЧКА */

function ItemCard({
  item,
  draft,
  generating,
  onSnap,
  onToComposer,
}: {
  item: Item;
  draft: string | undefined;
  generating: boolean;
  onSnap: () => void;
  onToComposer: () => void;
}) {
  const hot = item.ratio >= 2;
  const snippet = (item.text || "").replace(/\s+/g, " ").trim();

  return (
    <Card className="flex flex-col overflow-hidden">
      {item.photoUrl && <PostPhoto src={item.photoUrl} link={item.link} />}

      <div className="flex flex-1 flex-col p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={hot ? "fire" : "neutral"}>
          {hot && <Flame className="h-3 w-3" strokeWidth={2.5} aria-hidden />}
          {fmtRatio(item.ratio)} к норме
        </Badge>
        {item.media && item.media !== "text" && (
          <Badge tone="neutral">{item.media === "video" ? "Видео" : "Фото"}</Badge>
        )}
        <span className="truncate text-[13px] text-text-3">
          у «{item.competitorTitle || item.handle}»
        </span>
        <span className="ml-auto text-[12px] text-text-3">{fmtAgo(item.postedAt)}</span>
      </div>

      {/* Почему карточка здесь — числа, которые можно проверить руками */}
      <p className="mt-2.5 text-[12px] text-text-3">
        норма канала {fmtCompact(item.median)} · этот пост {fmtCompact(item.views)}
        {item.reactions != null && ` · ${fmtCompact(item.reactions)} реакций`}
      </p>

      {snippet ? (
        <p className="mt-3 line-clamp-4 text-[14px] leading-relaxed text-text-2">{snippet}</p>
      ) : (
        <p className="mt-3 text-[14px] text-text-3 italic">Пост без текста — только медиа.</p>
      )}

      {item.idea && (
        <div className="mt-3 rounded-md bg-surface-inset p-3.5">
          <p className="flex items-center gap-1.5 text-[12px] font-bold text-text-3 uppercase">
            <Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden />
            {item.idea.topic || "Идея"}
          </p>
          {item.idea.hook && <p className="mt-1.5 text-[14px] leading-relaxed text-text-2">{item.idea.hook}</p>}
          {item.idea.structure && (
            <p className="mt-1.5 whitespace-pre-line text-[14px] leading-relaxed text-text-2">
              {item.idea.structure}
            </p>
          )}
        </div>
      )}

      {(draft || generating) && (
        <div className="mt-3 rounded-md border border-brand/20 bg-surface-inset p-3.5">
          <p className="flex items-center gap-1.5 text-[12px] font-bold text-text-3 uppercase">
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" aria-hidden />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden />
            )}
            Твой пост на эту тему
          </p>
          <p className="mt-1.5 whitespace-pre-line text-[14px] leading-relaxed text-text-2">
            {draft || "…"}
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 pt-1">
        {draft && !generating ? (
          <Button size="sm" variant="brand" onClick={onToComposer}>
            <FileText className="h-4 w-4" aria-hidden />В черновик
          </Button>
        ) : (
          <Button size="sm" variant={hot ? "brand" : "soft"} onClick={onSnap} loading={generating}>
            <Sparkles className="h-4 w-4" aria-hidden />
            Сними это
          </Button>
        )}
        <a
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-text-3 transition-colors hover:text-brand"
        >
          <Eye className="h-4 w-4" aria-hidden />
          {fmtCompact(item.views)}
          <span className="inline-flex items-center gap-1">
            оригинал
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </span>
        </a>
      </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------- СТРАНИЦА */

export default function TrendsPage() {
  const router = useRouter();
  const store = useStore();
  const reduce = useReducedMotion();

  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<"niche" | "global">("niche");
  const [threshold, setThreshold] = useState<ThresholdValue>("all");
  const [checking, setChecking] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [generating, setGenerating] = useState<number | null>(null);

  const [picked, setPicked] = useState<number | null>(null);

  // «Твоя ниша» — это ниша КАНАЛА: у кофейного и юридического каналов разные соседи и
  // разные нормы. Сервер это уже умеет, страница просто не спрашивала.
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, picked);

  const load = useCallback(async () => {
    try {
      const ch = channelRef.current;
      const r = await fetch(
        `/api/trends?scope=${scopeRef.current}${ch ? `&channel=${ch}` : ""}`,
        { cache: "no-store" },
      );
      if (r.ok) setData((await r.json()) as Data);
    } catch {
      /* сеть — оставляем прошлые данные */
    } finally {
      setLoading(false);
    }
  }, []);

  // Вкладка живёт в ref: load() не должен пересоздаваться при переключении, иначе
  // интервалы опроса перезапускались бы на каждый клик. Канал — по той же причине.
  const scopeRef = useRef(scope);
  const channelRef = useRef(channelId);
  channelRef.current = channelId;

  useEffect(() => {
    load();
  }, [load]);

  // Каналы приезжают асинхронно, и первый load уходит раньше них — без ?channel=.
  // Сервер в этом случае молча подставляет первый канал: сейчас это совпадает с тем, что
  // покажет селектор, но держаться на совпадении нельзя. Как только каналы приехали —
  // перезапрашиваем уже с явным каналом. Ровно один раз: дальше канал меняет switchChannel.
  const bootRef = useRef(false);
  useEffect(() => {
    if (!channelId || bootRef.current) return;
    bootRef.current = true;
    load();
  }, [channelId, load]);

  // Переключение вкладки — это действие пользователя, а не эффект: меняем scope и грузим сразу.
  const switchScope = (v: "niche" | "global") => {
    if (v === scopeRef.current) return;
    scopeRef.current = v;
    setScope(v);
    setLoading(true);
    setData(null);
    setDrafts({});
    load();
  };

  // Смена канала — тоже действие пользователя, и ведёт себя так же: сбрасываем показанное
  // и грузим заново. Оставить старые идеи на экране нельзя — они от соседей другого канала.
  const switchChannel = (id: number) => {
    if (id === channelRef.current) return;
    channelRef.current = id;
    setPicked(id);
    setLoading(true);
    setData(null);
    setDrafts({});
    load();
  };

  // Пока воркер собирает досье — подтягиваем.
  const pending = data?.status.pending ?? 0;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [pending, load]);

  const check = async () => {
    setChecking(true);
    try {
      // Канал обязателен и здесь: «Проверить сейчас» на канале Б иначе обновило бы
      // соседей канала А (сервер молча взял бы самый ранний).
      const r = await fetch(
        `/api/trends?scope=${scopeRef.current}${channelId ? `&channel=${channelId}` : ""}`,
        { method: "POST" },
      );
      const d = (await r.json()) as { ok?: boolean; error?: string; queued?: number };
      if (d.error === "no_competitors") {
        store.toast({
          kind: "info",
          title: "Пока не за кем следить",
          body: "Добавь хотя бы один канал конкурента в «Разведке» — дальше я сам.",
        });
      } else if (d.ok) {
        store.toast({
          kind: "success",
          title: "Проверяю каналы",
          body: `Обновляю ${d.queued} ${plural(d.queued ?? 0, "канал", "канала", "каналов")}. Свежие цифры появятся здесь через минуту.`,
        });
        setTimeout(load, 3000);
      }
    } catch {
      store.toast({ kind: "danger", title: "Не получилось", body: "Проверь соединение и попробуй ещё раз." });
    } finally {
      setChecking(false);
    }
  };

  // «Сними это»: если воркер уже написал идею — сразу в композер. Если нет — пишем сейчас,
  // тем же движком (Д.8), потоком прямо в карточку. Движка нет — честно скажем.
  const snap = async (item: Item) => {
    if (item.idea) {
      const text = [item.idea.hook, item.idea.structure].filter(Boolean).join("\n\n");
      router.push(`/app/composer?text=${encodeURIComponent(text)}`);
      return;
    }

    setGenerating(item.id);
    setDrafts((d) => ({ ...d, [item.id]: "" }));
    try {
      const r = await fetch("/api/ai/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "write",
          input: (item.text || "").replace(/\s+/g, " ").slice(0, 140) || "тема залетевшего поста конкурента",
          context:
            `у конкурента «${item.competitorTitle || item.handle}» пост на эту тему собрал ` +
            `${fmtRatio(item.ratio)} к его норме. Напиши МОЙ пост на эту тему — не копию, свой угол.`,
        }),
      });

      if (r.status === 429) {
        store.toast({
          kind: "info",
          title: "Лимит на сегодня исчерпан",
          body: "Генерации обновятся завтра. Пост можно написать руками — открой «Студию».",
        });
        setDrafts((d) => ({ ...d, [item.id]: "" }));
        return;
      }
      if (!r.ok || !r.body) {
        store.toast({
          kind: "info",
          title: "ИИ пока не подключён",
          body: "Движок недоступен, поэтому сценарий не написать. Открой оригинал — идею можно снять с него самому.",
        });
        setDrafts((d) => ({ ...d, [item.id]: "" }));
        return;
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setDrafts((d) => ({ ...d, [item.id]: acc }));
      }
    } catch {
      store.toast({ kind: "danger", title: "Не получилось", body: "Проверь соединение и попробуй ещё раз." });
      setDrafts((d) => ({ ...d, [item.id]: "" }));
    } finally {
      setGenerating(null);
    }
  };

  const items = useMemo(() => data?.items ?? [], [data]);
  const counts = useMemo(
    () => THRESHOLDS.map((t) => items.filter((i) => i.ratio >= t.min).length),
    [items],
  );
  const minRatio = THRESHOLDS.find((t) => t.value === threshold)?.min ?? 0;
  const shown = items.filter((i) => i.ratio >= minRatio);
  const best = items[0]?.ratio;

  const st = data?.status;
  const global = scope === "global";
  const noCompetitors = !!st && st.competitors === 0;
  // Находки ждут подтверждения — только у «своей ниши»: у глобальных источников
  // канала нет, и находок для них не бывает.
  const waiting = global ? 0 : (st?.waiting ?? 0);
  const niche = st?.niche ?? null;
  const noMatureData = !!st && st.competitors > 0 && items.length === 0;

  return (
    <AppShell
      title="Сними это"
      subtitle={
        global
          ? "Что зашло в каналах твоей ниши сильнее их нормы — и как снять это себе."
          : "Что зашло у конкурентов сильнее их нормы — и как снять это себе."
      }
    >
      {/* Единый таб-бар «Разведки»: Сигналы / Конкуренты / Тренды */}
      <div className="mb-5">
        <ReconTabs />
      </div>

      <Tabs
        items={[
          { value: "niche", label: "Моя ниша" },
          { value: "global", label: "Насмотренность" },
        ]}
        value={scope}
        onChange={switchScope}
      />

      {/* Только на «Моей нише»: «Насмотренность» — это глобальные источники, у них
          канала нет по определению, и селектор там был бы бессмыслицей. */}
      {!global && (
        <ChannelPicker
          channels={tgChannels}
          value={channelId}
          onChange={switchChannel}
          label="Ниша какого канала"
          className="mt-5"
        />
      )}

      {loading ? (
        <div className="mt-5 grid gap-5">
          <div className="skeleton h-14 rounded-md" />
          <div className="grid gap-5 lg:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="skeleton h-56 rounded-lg" />
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-5 grid gap-5">
          {st && <StatusStrip status={st} onCheck={check} checking={checking} />}

          {data && data.competitors.length > 0 && <WatchList competitors={data.competitors} />}

          {items.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[13px] font-semibold text-text-2">Что считать залётом:</span>
              <Tabs
                items={THRESHOLDS.map((t, i) => ({
                  value: t.value,
                  label: `${t.label} · ${counts[i]}`,
                }))}
                value={threshold}
                onChange={setThreshold}
              />
            </div>
          )}

          {noCompetitors ? (
            <Card className="py-4">
              {/* Пустое состояние обязано говорить правду. Раньше оно всегда звало добавлять
                  руками — даже когда разведка уже прошла и находки по теме лежали в одном
                  клике. Человек видел «не за кем следить» и решал, что платформа не работает. */}
              <EmptyState
                icon={<Radar className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
                title={
                  global
                    ? "Источники ещё не собраны"
                    : waiting > 0
                      ? `Нашёл ${waiting} ${plural(waiting, "канал", "канала", "каналов")} по теме — подтверди`
                      : "Пока не за кем следить"
                }
                body={
                  global
                    ? "Список каналов ниши уже заведён — воркер соберёт их в ближайшем цикле. Если он не запущен, запусти: npm run worker."
                    : waiting > 0
                      ? `Разведка уже прошла по теме${niche ? ` «${niche}»` : ""} и отобрала кандидатов. Оставь тех, кто правда твой сосед, — дальше я сам посчитаю их норму и поймаю посты, которые её обошли.`
                      : "Добавь каналы конкурентов — и я начну считать их норму и ловить посты, которые её обошли. Данные беру только открытые: посты, просмотры, реакции."
                }
                action={
                  global ? undefined : (
                    <Button variant="brand" onClick={() => router.push("/app/competitors")}>
                      <Radar className="h-4 w-4" aria-hidden />
                      {waiting > 0 ? "Посмотреть находки" : "Добавить конкурента"}
                    </Button>
                  )
                }
              />
            </Card>
          ) : noMatureData ? (
            <Card className="py-4">
              <EmptyState
                icon={<Loader2 className="h-6 w-6 animate-spin" strokeWidth={1.75} aria-hidden />}
                title="Считаю норму каналов"
                body={`Собрано ${st?.posts ?? 0} ${plural(st?.posts ?? 0, "пост", "поста", "постов")}. Чтобы честно сказать «этот пост выше нормы», нужно минимум ${st?.minMature ?? 5} постов старше ${st?.matureHours ?? 48} часов на канал — свежий пост ещё набирает просмотры, сравнивать его не с чем. Как наберётся — здесь появится рейтинг.`}
              />
            </Card>
          ) : shown.length === 0 ? (
            <Card className="py-4">
              <EmptyState
                icon={<Flame className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
                title={`Постов ${THRESHOLDS.find((t) => t.value === threshold)?.label} сейчас нет`}
                body={
                  best != null
                    ? `Лучшее у твоих конкурентов сейчас — ${fmtRatio(best)} к норме. В Telegram посты редко обгоняют норму канала в разы: подписчики видят их все, алгоритм ничего не разгоняет. Понизь порог — и увидишь, что заходит лучше остального.`
                    : "Понизь порог, чтобы увидеть ленту."
                }
                action={
                  <Button variant="soft" onClick={() => setThreshold("all")}>
                    Показать всё
                  </Button>
                }
              />
            </Card>
          ) : (
            // Кладка, а не грид: у грида строка тянется по самой высокой карточке, и под
            // короткими остаются дыры. Колонки укладывают карточки вплотную. Три колонки на
            // широком экране — ещё и польза для чёткости: карточка уже картинки, значит кадр
            // уменьшается, а не растягивается.
            <ul className="columns-1 gap-5 md:columns-2 xl:columns-3">
              {shown.map((item, i) => (
                <motion.li
                  key={item.id}
                  className="mb-5 break-inside-avoid"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.24, ease: EASE, delay: Math.min(i * 0.03, 0.2) }}
                >
                  <ItemCard
                    item={item}
                    draft={drafts[item.id]}
                    generating={generating === item.id}
                    onSnap={() => snap(item)}
                    onToComposer={() =>
                      router.push(`/app/composer?text=${encodeURIComponent(drafts[item.id] ?? "")}`)
                    }
                  />
                </motion.li>
              ))}
            </ul>
          )}
        </div>
      )}
    </AppShell>
  );
}

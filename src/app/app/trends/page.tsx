"use client";

// Свежая лента выбранных Telegram-источников + отдельный рейтинг проверенных постов.
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
  BarChart3,
  Clock,
  ExternalLink,
  Eye,
  FileText,
  Flame,
  Loader2,
  Radar,
  RefreshCw,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { TrendStatistics } from "@/app/app/trends/trend-statistics";
import { Button } from "@/components/ui/button";
import { Badge, Card, Checkbox, EmptyState, Input, Tabs } from "@/components/ui/primitives";
import { appDraftActionHref } from "@/lib/app-routes";
import { finalizeAiClientStream, parseAiStreamBuffer, type AiStreamEvent } from "@/lib/ai-stream";
import {
  acknowledgeAiTerminal,
  stableAiClientRequest,
  type AiClientRequestIdentity,
} from "@/lib/ai-client-idempotency";
import { createDraftClientKey, createServerDraft, DraftRequestError } from "@/lib/draft-client";
import { isAbortError } from "@/lib/client-workspace-isolation";
import { useStore } from "@/lib/store";
import {
  createReviewedTrendDraft,
  TrendDraftReviewError,
} from "@/lib/trend-draft-review";
import { buildTrendReferenceDraft } from "@/lib/trend-reference";
import { TREND_PERIODS, type TrendPeriod } from "@/lib/trend-period";
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
  median: number | null;
  ratio: number | null;
  isMature: boolean;
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
    periodPosts: number;
    lastCollectedAt: string | null;
    latestPostAt: string | null;
    refreshEveryHours: number;
    matureHours: number;
    minMature: number;
    /** Находок по теме канала, ждущих подтверждения */
    waiting: number;
    /** Тема канала из брифа — по ней и искали */
    niche: string | null;
  };
  competitors: Competitor[];
  items: Item[];
  period: TrendPeriod;
  meta: (typeof TREND_PERIODS)[TrendPeriod];
}

type TrendView = "feed" | "statistics";
type TrendFeedScope = "niche" | "internet" | "global";
type InternetSearchState = "idle" | "invalid" | "searching" | "ready" | "error";

interface RadarSearchRun {
  id: number;
  status: "queued" | "running" | "ready" | "partial" | "failed";
  stage: "queued" | "discovering" | "verifying" | "ranking" | "ready" | "failed";
  progress: number;
  errorMessage?: string | null;
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

const postDateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

const fmtPostDate = (iso: string) => postDateFormatter.format(new Date(iso));

/* ------------------------------------------------------------ СТРОКА СОСТОЯНИЯ */
// Отвечает на «что вообще происходит»: за кем слежу, сколько собрано, когда проверяли.

function StatusStrip({
  status,
  period,
  scope,
  onCheck,
  checking,
  actionLabel = "Проверить сейчас",
}: {
  status: Data["status"];
  period: TrendPeriod;
  scope: TrendFeedScope;
  onCheck: () => void;
  checking: boolean;
  actionLabel?: string;
}) {
  const periodLabel =
    period === "today" ? "сегодня" : period === "week" ? "за 7 дней" : "проверенных за 30 дней";
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
      <span className="inline-flex items-center gap-2 text-[14px] font-semibold text-text">
        <Radar className="h-4 w-4 text-brand" aria-hidden />
        {scope === "internet"
          ? `${status.competitors} ${plural(status.competitors, "проверенный источник", "проверенных источника", "проверенных источников")} из интернета`
          : `Слежу за ${status.competitors} ${plural(status.competitors, "каналом", "каналами", "каналами")}`}
      </span>
      <span className="text-[13px] font-semibold text-text-2">
        {status.periodPosts} {plural(status.periodPosts, "пост", "поста", "постов")} {periodLabel}
      </span>
      {status.latestPostAt && (
        <span className="text-[13px] text-text-3">последняя публикация {fmtAgo(status.latestPostAt)}</span>
      )}
      {status.lastCollectedAt && (
        <span className="text-[13px] text-text-3">все источники проверены {fmtAgo(status.lastCollectedAt)}</span>
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
        {scope === "internet" ? (
          <Radar className="h-4 w-4" aria-hidden />
        ) : (
          <RefreshCw className="h-4 w-4" aria-hidden />
        )}
        {actionLabel}
      </Button>
    </Card>
  );
}

/* ------------------------------------------------------------- ЗА КЕМ СЛЕЖУ */
// Норма канала показана явно — иначе «×2,2 к норме» это число из воздуха.

function WatchList({ competitors, internet = false }: { competitors: Competitor[]; internet?: boolean }) {
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
          {internet ? (
            <span className="text-success-text">проверен</span>
          ) : c.status === "error" ? (
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
  period,
  internet = false,
  draft,
  generating,
  generationError,
  generationLocked,
  requiresReview,
  reviewAcknowledged,
  transferring,
  onSnap,
  onReviewAcknowledged,
  onToComposer,
}: {
  item: Item;
  period: TrendPeriod;
  internet?: boolean;
  draft: string | undefined;
  generating: boolean;
  generationError: string | undefined;
  generationLocked: boolean;
  requiresReview: boolean;
  reviewAcknowledged: boolean;
  transferring: boolean;
  onSnap: () => void;
  onReviewAcknowledged: (checked: boolean) => void;
  onToComposer: () => void;
}) {
  const ratio = item.ratio;
  const median = item.median;
  const evaluated = item.isMature && ratio != null && median != null;
  const hot = ratio != null && evaluated && ratio >= 2;
  const snippet = (item.text || "").replace(/\s+/g, " ").trim();
  const hasGenerationTopic = Boolean(item.idea || snippet);

  return (
    <Card className="flex flex-col overflow-hidden">
      {item.photoUrl && <PostPhoto src={item.photoUrl} link={item.link} />}

      <div className="flex flex-1 flex-col p-5">
      <div className="flex flex-wrap items-center gap-2">
        {evaluated ? (
          <Badge tone={hot ? "fire" : "neutral"}>
            {hot && <Flame className="h-3 w-3" strokeWidth={2.5} aria-hidden />}
            {fmtRatio(ratio!)} к норме
          </Badge>
        ) : item.isMature ? (
          <Badge tone="neutral">Проверенный пост</Badge>
        ) : (
          <Badge tone="brand">
            <Clock className="h-3 w-3" aria-hidden />
            Набирает просмотры
          </Badge>
        )}
        {item.media && item.media !== "text" && (
          <Badge tone="neutral">{item.media === "video" ? "Видео" : "Фото"}</Badge>
        )}
        <span className="truncate text-[13px] text-text-3">
          у «{item.competitorTitle || item.handle}»
        </span>
        <time dateTime={item.postedAt} className="ml-auto text-[12px] text-text-3">
          {fmtPostDate(item.postedAt)}
        </time>
      </div>

      <p className="mt-2.5 text-[12px] text-text-3">
        {evaluated
          ? `норма канала ${fmtCompact(median!)} · этот пост ${fmtCompact(item.views)}`
          : internet
            ? `${fmtCompact(item.views)} ${plural(item.views, "просмотр", "просмотра", "просмотров")} · источник проверен Авророй`
          : item.isMature
            ? `${fmtCompact(item.views)} ${plural(item.views, "просмотр", "просмотра", "просмотров")} · пока мало сопоставимой истории для нормы`
            : `${fmtCompact(item.views)} ${plural(item.views, "просмотр", "просмотра", "просмотров")} сейчас · результат оценим через 48 часов`}
        {item.reactions != null && ` · ${fmtCompact(item.reactions)} ${plural(item.reactions, "реакция", "реакции", "реакций")}`}
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

      {generationError && !draft && !generating && (
        <div role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger-soft p-3.5">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-danger-text">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            Публикация не была завершена
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-text-2">{generationError}</p>
        </div>
      )}

      {draft && !generating && requiresReview && (
        <div className="mt-3 rounded-md border border-info-text/20 bg-info-soft p-3.5">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-info-text">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            Автоматическая смысловая проверка не выполнена
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-text-2">
            Сверь факты, цифры и формулировки с источником. Отметка будет сохранена на сервере
            для этой версии текста; после редактирования редактор запросит проверку снова.
          </p>
          <div className="mt-3">
            <Checkbox
              id={`trend-review-${item.id}`}
              checked={reviewAcknowledged}
              onChange={onReviewAcknowledged}
              label="Я сверил факты и смысл этого текста"
            />
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 pt-1">
        {draft && !generating ? (
          <Button
            size="sm"
            variant="brand"
            onClick={onToComposer}
            disabled={requiresReview && !reviewAcknowledged}
            loading={transferring}
          >
            {!transferring && <FileText className="h-4 w-4" aria-hidden />}
            {requiresReview ? "Подтвердить и открыть черновик" : "В черновик"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant={hot || period !== "hits" ? "brand" : "soft"}
            onClick={onSnap}
            loading={generating}
            disabled={generationLocked || !hasGenerationTopic}
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            {!hasGenerationTopic
              ? "Нет текста для темы"
              : generationError
                ? "Повторить создание"
                : "Создать публикацию"}
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
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<TrendView>(() => {
    if (typeof window === "undefined") return "feed";
    return new URLSearchParams(window.location.search).get("view") === "statistics"
      ? "statistics"
      : "feed";
  });
  const [scope, setScope] = useState<TrendFeedScope>("niche");
  const [period, setPeriod] = useState<TrendPeriod>("today");
  const [internetQuery, setInternetQuery] = useState("");
  const [internetAppliedQuery, setInternetAppliedQuery] = useState("");
  const [internetSearchState, setInternetSearchState] = useState<InternetSearchState>("idle");
  const [internetSearchMessage, setInternetSearchMessage] = useState(
    "Нажми «Найти публикации»: пустое поле возьмёт тему из брифа, затем пойду в интернет и проверю каналы на t.me.",
  );
  const [threshold, setThreshold] = useState<ThresholdValue>("all");
  const [checking, setChecking] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [draftFailures, setDraftFailures] = useState<Record<number, string>>({});
  const [draftReviews, setDraftReviews] = useState<Record<number, boolean>>({});
  const [draftAcknowledgements, setDraftAcknowledgements] = useState<Record<number, boolean>>({});
  const [generating, setGenerating] = useState<number | null>(null);
  const [transferring, setTransferring] = useState<number | null>(null);
  const draftClientKeysRef = useRef<Record<string, string>>({});
  const generationInFlightRef = useRef<number | null>(null);
  const generationRequestRef = useRef<Record<number, AiClientRequestIdentity>>({});
  const transferInFlightRef = useRef<Set<number>>(new Set());
  const refreshRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const internetQueryRef = useRef("");
  const internetSearchInputRef = useRef<HTMLInputElement>(null);
  const internetSearchTokenRef = useRef(0);
  const internetSearchRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const [picked, setPicked] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const value = Number(new URLSearchParams(window.location.search).get("channel"));
    return Number.isInteger(value) && value > 0 ? value : null;
  });

  // «Твоя ниша» — это ниша КАНАЛА: у кофейного и юридического каналов разные соседи и
  // разные нормы. Сервер это уже умеет, страница просто не спрашивала.
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, picked);

  const scopeRef = useRef(scope);
  const periodRef = useRef(period);
  const channelRef = useRef(channelId);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const pageLeavingRef = useRef(false);
  channelRef.current = channelId;

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const ch = channelRef.current;
      const query = scopeRef.current === "internet" ? internetQueryRef.current : "";
      const r = await fetch(
        `/api/trends?scope=${scopeRef.current}&period=${periodRef.current}${ch ? `&channel=${ch}` : ""}${query ? `&q=${encodeURIComponent(query)}` : ""}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!r.ok) throw new Error(`trends: ${r.status}`);
      const next = (await r.json()) as Data;
      if (!controller.signal.aborted) {
        setData(next);
        setLoadError(false);
      }
    } catch (error) {
      // Навигация и размонтирование могут прийти в тот же цикл событий, что и сетевой
      // TypeError. Даём cleanup выполнить abort, прежде чем показывать реальную ошибку.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const requestIsCurrent = requestRef.current === controller;
      const expectedCancellation = controller.signal.aborted
        || isAbortError(error)
        || !mountedRef.current
        || pageLeavingRef.current
        || !requestIsCurrent;
      if (!expectedCancellation) {
        console.error("[trends] load", error);
        setLoadError(true);
      }
    } finally {
      if (mountedRef.current && requestRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    pageLeavingRef.current = false;
    const cancelPendingLoad = () => {
      pageLeavingRef.current = true;
      requestRef.current?.abort();
      internetSearchTokenRef.current += 1;
    };
    const resumePage = (event: PageTransitionEvent) => {
      pageLeavingRef.current = false;
      if (event.persisted) {
        setLoading(true);
        void load();
      }
    };
    window.addEventListener("pagehide", cancelPendingLoad);
    window.addEventListener("pageshow", resumePage);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", cancelPendingLoad);
      window.removeEventListener("pageshow", resumePage);
      cancelPendingLoad();
    };
  }, [load]);

  // Каналы приезжают асинхронно, и первый load уходит раньше них — без ?channel=.
  // Сервер в этом случае молча подставляет первый канал: сейчас это совпадает с тем, что
  // покажет селектор, но держаться на совпадении нельзя. Как только каналы приехали —
  // перезапрашиваем уже с явным каналом. Ровно один раз: дальше канал меняет switchChannel.
  const bootRef = useRef(false);
  useEffect(() => {
    if (!channelId || bootRef.current) return;
    bootRef.current = true;
    channelRef.current = channelId;
    load();
  }, [channelId, load]);

  // Переключение вкладки — это действие пользователя, а не эффект: меняем scope и грузим сразу.
  const switchScope = (v: TrendFeedScope) => {
    if (v === scopeRef.current) return;
    internetSearchTokenRef.current += 1;
    if (v !== "internet") setInternetSearchState("idle");
    scopeRef.current = v;
    setScope(v);
    setLoading(true);
    setLoadError(false);
    setData(null);
    setDrafts({});
    setDraftFailures({});
    setDraftReviews({});
    setDraftAcknowledgements({});
    load();
  };

  const switchView = (next: TrendView) => {
    if (next === view) return;
    setView(next);
    const url = new URL(window.location.href);
    if (next === "statistics") url.searchParams.set("view", "statistics");
    else url.searchParams.delete("view");
    window.history.replaceState(window.history.state, "", url);
  };

  const loadInternetQuery = (query: string) => {
    internetQueryRef.current = query;
    setInternetAppliedQuery(query);
    setLoading(true);
    setLoadError(false);
    setData(null);
    load();
  };

  const clearInternetQuery = () => {
    internetSearchTokenRef.current += 1;
    internetQueryRef.current = "";
    internetSearchRequestRef.current = null;
    setInternetQuery("");
    setInternetAppliedQuery("");
    setInternetSearchState("idle");
    setInternetSearchMessage("Нажми «Найти публикации»: пустое поле возьмёт тему из брифа, затем пойду в интернет и проверю каналы на t.me.");
    setLoading(true);
    setLoadError(false);
    setData(null);
    load();
  };

  const searchInternet = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = (internetQuery.replace(/\s+/gu, " ").trim() || String(data?.status.niche || "").trim())
      .slice(0, 200);
    if (query.length < 2) {
      setInternetSearchState("invalid");
      setInternetSearchMessage("Введи минимум два символа.");
      return;
    }
    const destinationChannelId = Number(channelId);
    if (!Number.isSafeInteger(destinationChannelId) || destinationChannelId <= 0) {
      setInternetSearchState("error");
      setInternetSearchMessage("Сначала выбери активный канал.");
      return;
    }

    if (!internetQuery.trim()) setInternetQuery(query);
    const token = ++internetSearchTokenRef.current;
    loadInternetQuery(query);
    setInternetSearchState("searching");
    setInternetSearchMessage("Показываю совпадения из базы и проверяю новые источники…");

    const fingerprint = `${destinationChannelId}:${query.toLocaleLowerCase("ru-RU")}`;
    if (
      !internetSearchRequestRef.current
      || internetSearchRequestRef.current.fingerprint !== fingerprint
    ) {
      internetSearchRequestRef.current = { fingerprint, key: crypto.randomUUID() };
    }

    const finish = async (state: "ready" | "error", message: string) => {
      if (internetSearchTokenRef.current !== token) return;
      await load();
      if (internetSearchTokenRef.current !== token) return;
      setInternetSearchState(state);
      setInternetSearchMessage(message);
    };

    try {
      const response = await fetch("/api/radar/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": internetSearchRequestRef.current.key,
        },
        body: JSON.stringify({ q: query, channelId: destinationChannelId }),
      });
      const payload = (await response.json().catch(() => null)) as {
        cached?: boolean;
        run?: RadarSearchRun | null;
      } | null;
      if (internetSearchTokenRef.current !== token) return;

      if (!response.ok || !payload) {
        await finish(
          "error",
          "Совпадения из базы показаны, но новые источники сейчас недоступны. Повтори поиск позже.",
        );
        return;
      }

      if (payload.cached || payload.run?.status === "ready" || payload.run?.status === "partial") {
        await finish("ready", "Поиск завершён. Проверенные публикации добавлены в ленту.");
        return;
      }

      const runId = Number(payload.run?.id);
      if (!Number.isSafeInteger(runId) || runId <= 0) {
        await finish("ready", "Совпадения из проверенной базы показаны в ленте.");
        return;
      }

      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        if (internetSearchTokenRef.current !== token) return;
        const statusResponse = await fetch(`/api/radar/search?run=${runId}`, { cache: "no-store" });
        const statusPayload = (await statusResponse.json().catch(() => null)) as {
          run?: RadarSearchRun | null;
        } | null;
        if (!statusResponse.ok || !statusPayload?.run) continue;
        if (statusPayload.run.status === "ready" || statusPayload.run.status === "partial") {
          await finish("ready", "Поиск завершён. Проверенные публикации добавлены в ленту.");
          return;
        }
        if (statusPayload.run.status === "failed") {
          await finish(
            "error",
            "Совпадения из базы показаны, но новые источники сейчас недоступны. Повтори поиск позже.",
          );
          return;
        }
        setInternetSearchMessage(
          statusPayload.run.stage === "verifying"
            ? `Проверяю найденные ссылки — ${statusPayload.run.progress}%`
            : statusPayload.run.stage === "ranking"
              ? `Ранжирую проверенные публикации — ${statusPayload.run.progress}%`
              : `Ищу публичные источники — ${statusPayload.run.progress}%`,
        );
      }

      await finish(
        "error",
        "Поиск продолжается в фоне. Уже проверенные совпадения остаются в ленте.",
      );
    } catch {
      await finish(
        "error",
        "Совпадения из базы показаны, но новые источники сейчас недоступны. Проверь соединение и повтори поиск.",
      );
    }
  };

  const switchPeriod = (value: TrendPeriod) => {
    if (value === periodRef.current) return;
    periodRef.current = value;
    setPeriod(value);
    setThreshold("all");
    setLoading(true);
    setLoadError(false);
    setData(null);
    setDrafts({});
    setDraftFailures({});
    setDraftReviews({});
    setDraftAcknowledgements({});
    load();
  };

  // Смена канала — тоже действие пользователя, и ведёт себя так же: сбрасываем показанное
  // и грузим заново. Оставить старые идеи на экране нельзя — они от соседей другого канала.
  const switchChannel = (id: number) => {
    if (id === channelRef.current) return;
    internetSearchTokenRef.current += 1;
    channelRef.current = id;
    setPicked(id);
    if (scopeRef.current === "internet") {
      internetQueryRef.current = "";
      internetSearchRequestRef.current = null;
      setInternetQuery("");
      setInternetAppliedQuery("");
      setInternetSearchState("idle");
      setInternetSearchMessage("Нажми «Найти публикации»: пустое поле возьмёт тему из брифа, затем пойду в интернет и проверю каналы на t.me.");
    }
    const url = new URL(window.location.href);
    url.searchParams.set("channel", String(id));
    window.history.replaceState(window.history.state, "", url);
    setLoading(true);
    setLoadError(false);
    setData(null);
    setDrafts({});
    setDraftFailures({});
    setDraftReviews({});
    setDraftAcknowledgements({});
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
    if (checking) return;
    setChecking(true);
    try {
      // Канал обязателен и здесь: «Проверить сейчас» на канале Б иначе обновило бы
      // соседей канала А (сервер молча взял бы самый ранний).
      const fingerprint = `${scopeRef.current}:${channelId ?? "global"}`;
      if (!refreshRequestRef.current || refreshRequestRef.current.fingerprint !== fingerprint) {
        refreshRequestRef.current = { fingerprint, key: crypto.randomUUID() };
      }
      const r = await fetch(
        `/api/trends?scope=${scopeRef.current}${channelId ? `&channel=${channelId}` : ""}`,
        {
          method: "POST",
          headers: { "idempotency-key": refreshRequestRef.current.key },
        },
      );
      const d = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; queued?: number } | null;
      if (r.status === 202 && d?.error === "request_in_progress") {
        store.toast({ kind: "info", title: "Проверка уже запускается", body: "Второй сбор не создан." });
        return;
      }
      if (!r.ok || !d) {
        if (d?.error !== "request_in_progress") refreshRequestRef.current = null;
        throw new Error(d?.error || `trends_refresh_${r.status}`);
      }
      if (d.error === "no_competitors") {
        refreshRequestRef.current = null;
        store.toast({
          kind: "info",
          title: "Пока не за кем следить",
          body: "Добавь хотя бы один канал конкурента в «Разведке» — дальше я сам.",
        });
      } else if (d.ok) {
        refreshRequestRef.current = null;
        store.toast({
          kind: "success",
          title: "Проверяю каналы",
          body: `Поставил в сбор ${d.queued} ${plural(d.queued ?? 0, "канал", "канала", "каналов")}. Экран обновится сам, когда проверка закончится.`,
        });
        await load();
      }
    } catch {
      store.toast({ kind: "danger", title: "Не получилось", body: "Проверь соединение и попробуй ещё раз." });
    } finally {
      setChecking(false);
    }
  };

  // Создание публикации: готовую идею воркера сначала показываем в карточке для ручной
  // проверки. Если идеи нет — пишем тем же движком (Д.8), потоком прямо в карточку.
  const snap = async (item: Item) => {
    if (process.env.NEXT_PUBLIC_TREND_REFERENCE_STUDIO === "disabled") {
      store.toast({
        kind: "danger",
        title: "Безопасный create-flow обязателен",
        body: "Операторский rollback отключён: исходный текст нельзя превращать в публикуемый черновик напрямую.",
      });
      return;
    }
    // Новый основной путь: сначала сохраняем принадлежавший пользователю reference-draft,
    // затем передаём в URL только его ID. Студия запускает адаптацию по механике источника.
    // Старый inline-flow оставлен только как мёртвый migration fallback: feature flag
    // теперь fail-closed выше и не может вернуть прямую публикацию исходного текста.
    if (process.env.NEXT_PUBLIC_TREND_REFERENCE_STUDIO !== "disabled") {
      if (generationInFlightRef.current !== null) return;
      const destinationChannelId = Number(channelId);
      if (!Number.isSafeInteger(destinationChannelId) || destinationChannelId <= 0) {
        store.toast({
          kind: "danger",
          title: "Некуда сохранить публикацию",
          body: "Сначала подключи или выбери канал — исходный тренд останется на месте.",
        });
        return;
      }

      generationInFlightRef.current = item.id;
      setGenerating(item.id);
      const key = `${destinationChannelId}:${item.id}:studio-reference`;
      const clientKey = (draftClientKeysRef.current[key] ??= createDraftClientKey());
      try {
        const result = await createServerDraft(buildTrendReferenceDraft({
          trendId: item.id,
          channelId: destinationChannelId,
          clientKey,
          sourceLabel: item.competitorTitle || `@${item.handle}`,
          scope,
          text: item.text,
          idea: item.idea ? {
            topic: item.idea.topic,
            hook: item.idea.hook,
            structure: item.idea.structure,
          } : null,
        }));
        router.push(appDraftActionHref("create", result.draft.id));
      } catch (error) {
        const emptyReference = error instanceof RangeError
          && error.message === "trend reference text is required";
        store.toast({
          kind: emptyReference ? "info" : "danger",
          title: emptyReference ? "Не вижу тему публикации" : "Контекст не сохранён",
          body: emptyReference
            ? "В карточке нет текста или идеи для адаптации. Открой оригинал либо выбери другой тренд."
            : error instanceof DraftRequestError && error.kind === "offline"
              ? "Нет связи с сервером. Карточка осталась на месте — повтори после восстановления сети."
              : "Карточка осталась на месте. Повтор использует тот же ключ и не создаст второй черновик.",
        });
      } finally {
        if (generationInFlightRef.current === item.id) generationInFlightRef.current = null;
        setGenerating(null);
      }
      return;
    }

    if (item.idea) {
      const text = [item.idea.hook, item.idea.structure].filter(Boolean).join("\n\n");
      setDrafts((drafts) => ({ ...drafts, [item.id]: text }));
      setDraftFailures((failures) => ({ ...failures, [item.id]: "" }));
      // Worker ideas are AI-authored too. They do not carry semantic provenance, so the
      // same human-review boundary applies instead of silently importing them as manual.
      setDraftReviews((reviews) => ({ ...reviews, [item.id]: true }));
      setDraftAcknowledgements((reviews) => ({ ...reviews, [item.id]: false }));
      return;
    }

    if (!item.text?.trim()) {
      const message = "В исходной публикации есть только медиа и нет текста, по которому можно определить тему. Открой оригинал или выбери текстовую карточку — лимит не списан.";
      setDraftFailures((failures) => ({ ...failures, [item.id]: message }));
      store.toast({ kind: "info", title: "Не вижу тему публикации", body: message });
      return;
    }
    const sourceText = item.text.replace(/\s+/g, " ").trim();

    // Only one paid generation may be started from this page at a time. The ref closes the
    // tiny gap before React renders the disabled state after a rapid second click.
    if (generationInFlightRef.current !== null) return;
    generationInFlightRef.current = item.id;
    setGenerating(item.id);
    setDrafts((d) => ({ ...d, [item.id]: "" }));
    setDraftFailures((failures) => ({ ...failures, [item.id]: "" }));
    setDraftReviews((reviews) => ({ ...reviews, [item.id]: true }));
    setDraftAcknowledgements((reviews) => ({ ...reviews, [item.id]: false }));
    try {
      const generationBody = {
        command: "write",
        input: sourceText.slice(0, 1800),
        surface: "trends",
        channelId,
        context:
          `У конкурента «${item.competitorTitle || item.handle}» вышел пост на эту тему` +
          (item.ratio != null ? ` и собрал ${fmtRatio(item.ratio)} к его норме.` : ".") +
          " Используй его только как сигнал темы. Напиши МОЙ самостоятельный пост: не копируй формулировки, выбери свой угол и не добавляй факты, которых нет в исходном материале или подтверждённых данных моего канала.",
      };
      const requestFingerprint = JSON.stringify(generationBody);
      const generationRequest = stableAiClientRequest(
        generationRequestRef.current[item.id],
        requestFingerprint,
      );
      generationRequestRef.current[item.id] = generationRequest;
      const r = await fetch("/api/ai/generate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": generationRequest.key,
        },
        body: requestFingerprint,
      });
      const responseRequestId = r.headers.get("x-ai-request-id") ?? undefined;
      const correlated = (message: string, requestId = responseRequestId) =>
        `${message}${requestId ? ` Номер запроса: ${requestId}` : ""}`;

      if (r.status === 429) {
        const message = "Генерации обновятся завтра. Пост можно написать руками — открой «Студию».";
        const recovery = correlated(message);
        store.toast({
          kind: "info",
          title: "Лимит на сегодня исчерпан",
          body: recovery,
        });
        setDraftFailures((failures) => ({ ...failures, [item.id]: recovery }));
        setDrafts((d) => ({ ...d, [item.id]: "" }));
        return;
      }
      if (!r.ok || !r.body) {
        const info = (await r.json().catch(() => null)) as
          { error?: string; retryable?: boolean; requestId?: string } | null;
        const message = info?.error === "brief_insufficient_facts"
          ? "Для заданных настроек не хватает подтверждённых фактов. Уточни тему или добавь факты в настройках Авроры."
          : info?.error === "post_settings_conflict"
            ? "Некоторые настройки поста противоречат друг другу. Исправь их в настройках Авроры и повтори."
            : info?.error === "request_result_unavailable"
              ? "Запрос был завершён раньше, но сохранённый результат недоступен. Не создавай новый ключ; передай номер запроса в поддержку."
              : "Генерация сейчас недоступна. Проверь подключение модели и повтори тот же запрос.";
        const recovery = correlated(message, info?.requestId);
        store.toast({
          kind: "info",
          title: "ИИ пока не подключён",
          body: recovery,
        });
        setDraftFailures((failures) => ({ ...failures, [item.id]: recovery }));
        setDrafts((d) => ({ ...d, [item.id]: "" }));
        return;
      }
      if (!r.headers.get("content-type")?.includes("application/x-ndjson")) {
        throw new Error("unconfirmed_ai_stream");
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalText = "";
      let failed = false;
      let failureCode = "";
      let failureRetryable = false;
      let validationReceived = false;
      let validationBlocked = false;
      let validationRequiresReview = true;
      let doneReceived = false;
      let terminalRequestId = responseRequestId;
      const applyEvent = (event: AiStreamEvent) => {
        terminalRequestId = event.requestId;
        if (event.type === "delta") {
          finalText += event.text;
          setDrafts((drafts) => ({ ...drafts, [item.id]: finalText }));
        } else if (event.type === "replace") {
          finalText = event.text;
          setDrafts((drafts) => ({ ...drafts, [item.id]: finalText }));
        } else if (event.type === "validation") {
          validationReceived = true;
          validationBlocked = event.status !== "passed";
          validationRequiresReview = event.requiresReview;
        } else if (event.type === "error") {
          failed = true;
          failureCode = event.code || event.error;
          failureRetryable = event.retryable === true;
        } else if (event.type === "done") {
          doneReceived = true;
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseAiStreamBuffer(buffer);
        buffer = parsed.rest;
        parsed.events.forEach(applyEvent);
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        parseAiStreamBuffer(`${buffer}\n`).events.forEach(applyEvent);
      }

      const completion = finalizeAiClientStream({
        text: finalText,
        failed,
        validationReceived,
        doneReceived,
        validationBlocked,
        validationRequiresReview,
      });
      if (completion.status !== "complete") {
        const rejected = failureCode === "factual_validation_failed" || failureCode === "post_validation_failed";
        const message = rejected
          ? "Черновик остановлен на проверке качества. Уточни тему или настройки и повтори тот же запрос: ключ сохранён."
          : failureRetryable
            ? "Связь прервалась до подтверждения результата. Состояние списания не угадываем: повтор с сохранённым ключом вернёт готовый результат или безопасно продолжит запрос."
            : "Сервер не подтвердил готовую публикацию. Повтори с сохранённым ключом, чтобы не запускать отдельное списание.";
        const recovery = correlated(message, terminalRequestId);
        setDrafts((drafts) => ({ ...drafts, [item.id]: "" }));
        setDraftFailures((failures) => ({ ...failures, [item.id]: recovery }));
        store.toast({ kind: "danger", title: "Публикация не создана", body: recovery });
        return;
      }

      try {
        await acknowledgeAiTerminal(generationRequest.key);
      } catch {
        const recovery = correlated(
          "Результат сохранён, но подтверждение списания не завершилось. Повтори тот же запрос — модель не будет вызвана заново.",
          terminalRequestId,
        );
        setDrafts((drafts) => ({ ...drafts, [item.id]: "" }));
        setDraftFailures((failures) => ({ ...failures, [item.id]: recovery }));
        store.toast({ kind: "danger", title: "Результат ещё не подтверждён", body: recovery });
        return;
      }

      setDrafts((drafts) => ({ ...drafts, [item.id]: completion.text }));
      setDraftFailures((failures) => ({ ...failures, [item.id]: "" }));
      delete generationRequestRef.current[item.id];
      // A competitor trend is never treated as an authoritative fact source. Even a
      // technically passed result stays behind the explicit human-review checkpoint.
      setDraftReviews((reviews) => ({ ...reviews, [item.id]: true }));
    } catch {
      const message = "Связь оборвалась до подтверждения результата. Состояние списания не угадываем; повтор использует сохранённый ключ и не создаёт отдельную генерацию.";
      store.toast({ kind: "danger", title: "Не получилось", body: message });
      setDrafts((d) => ({ ...d, [item.id]: "" }));
      setDraftFailures((failures) => ({ ...failures, [item.id]: message }));
    } finally {
      if (generationInFlightRef.current === item.id) generationInFlightRef.current = null;
      setGenerating(null);
      void store.refreshAiUsage();
    }
  };

  const toComposer = async (item: Item) => {
    if (transferInFlightRef.current.has(item.id)) return;
    const text = drafts[item.id]?.trim() ?? "";
    const acknowledged = draftAcknowledgements[item.id] === true;
    if (!text || !acknowledged) return;

    transferInFlightRef.current.add(item.id);
    setTransferring(item.id);
    try {
      const transferKey = `${channelId ?? "none"}:${item.id}`;
      const clientKey = (draftClientKeysRef.current[transferKey] ??= createDraftClientKey());
      const draft = await createReviewedTrendDraft({
        text,
        trendId: item.id,
        sourceLabel: item.competitorTitle || `@${item.handle}`,
        channelId,
        clientKey,
        humanAcknowledged: acknowledged,
      });
      router.push(`/app/composer?draft=${draft.id}`);
    } catch (error) {
      const noDestination = error instanceof TrendDraftReviewError
        && error.code === "destination_required";
      const conflict = error instanceof TrendDraftReviewError
        && error.code === "draft_conflict";
      const offline = error instanceof DraftRequestError && error.kind === "offline";
      store.toast({
        kind: "danger",
        title: noDestination
          ? "Некуда сохранить черновик"
          : conflict
            ? "Черновик уже изменён"
            : "Проверка не сохранилась",
        body: noDestination
          ? "Подключи активный Telegram-канал и повтори. Текст остаётся на этой странице."
          : conflict
            ? "Серверная версия отличается. Текст не перезаписан и публикация не разрешена."
            : offline
              ? "Нет связи с сервером. Текст и отметка остались здесь — повтори после восстановления сети."
              : "Сервер не подтвердил отметку для этой версии. Публикация остаётся заблокированной.",
      });
    } finally {
      transferInFlightRef.current.delete(item.id);
      setTransferring((current) => (current === item.id ? null : current));
    }
  };

  const items = useMemo(() => data?.items ?? [], [data]);
  const counts = useMemo(
    () => THRESHOLDS.map((t) => items.filter((i) => (i.ratio ?? 0) >= t.min).length),
    [items],
  );
  const minRatio = THRESHOLDS.find((t) => t.value === threshold)?.min ?? 0;
  const shown = period === "hits" ? items.filter((i) => (i.ratio ?? 0) >= minRatio) : items;
  const best = items.find((item) => item.ratio != null)?.ratio ?? null;

  const st = data?.status;
  const global = scope === "global";
  const internet = scope === "internet";
  const noCompetitors = !!st && st.competitors === 0;
  // Находки ждут подтверждения — только у «своей ниши»: у глобальных источников
  // канала нет, и находок для них не бывает.
  const waiting = global ? 0 : (st?.waiting ?? 0);
  const niche = st?.niche ?? null;
  const noPeriodData = !!st && st.competitors > 0 && items.length === 0;

  return (
    <AppShell
      title="Тренды"
      subtitle="Сравнивай динамику тем и находи публикации, которые набирают интерес."
    >
      <Tabs
        items={[
          {
            value: "feed",
            label: "Лента",
            icon: <FileText className="h-4 w-4" aria-hidden />,
          },
          {
            value: "statistics",
            label: "Статистика",
            icon: <BarChart3 className="h-4 w-4" aria-hidden />,
          },
        ]}
        value={view}
        onChange={switchView}
      />

      {view === "statistics" ? (
        <div className="mt-5">
          <TrendStatistics channelId={channelId} channelTopic={niche} />
        </div>
      ) : (
        <>
          <div className="mt-7 max-w-3xl">
            <h2 className="text-[19px] font-bold text-text">Лента публикаций</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-text-3">
              Просматривай посты конкурентов, проверенные находки из интернета или редакционную подборку и создавай собственные публикации по найденным темам.
            </p>
          </div>

          <Tabs
            className="mt-5"
            items={[
              { value: "niche", label: "Моя ниша" },
              { value: "internet", label: "Интернет" },
              { value: "global", label: "Подборка платформы" },
            ]}
            value={scope}
            onChange={switchScope}
          />

          {global && (
        <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-text-3">
          Сейчас это общая редакционная подборка про право и ИИ. Она одинакова для всех каналов и не зависит от выбора ниши.
        </p>
      )}

          {internet && (
            <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-text-3">
              По запросу Аврора ищет в открытом интернете публичные Telegram-каналы, проверяет их на t.me и кладёт сюда. Повторные ссылки скрыты. Без нажатия «Найти» новых источников не будет.
            </p>
          )}

      {/* У общей подборки канала нет по определению. Своя и интернет-базы всегда
          изолированы выбранным каналом, поэтому для них селектор обязателен. */}
          {!global && (
        <ChannelPicker
          channels={tgChannels}
          value={channelId}
          onChange={switchChannel}
          label="Ниша какого канала"
          className="mt-5"
        />
      )}

          {internet && (
            <form
              className="mt-5 max-w-4xl rounded-md bg-surface p-4 shadow-soft"
              onSubmit={searchInternet}
              noValidate
            >
              <label
                htmlFor="internet-feed-search"
                className="block text-[13px] font-semibold text-text-2"
              >
                Поиск публикаций в интернете
              </label>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Input
                  ref={internetSearchInputRef}
                  id="internet-feed-search"
                  name="internetFeedSearch"
                  type="search"
                  autoComplete="off"
                  value={internetQuery}
                  onChange={(event) => {
                    setInternetQuery(event.target.value);
                    if (internetSearchState === "invalid") {
                      setInternetSearchState("idle");
                      setInternetSearchMessage(
                        "Нажми «Найти публикации»: пустое поле возьмёт тему из брифа, затем пойду в интернет и проверю каналы на t.me.",
                      );
                    }
                  }}
                  aria-describedby="internet-feed-search-status"
                  aria-invalid={internetSearchState === "invalid" || undefined}
                  placeholder={niche || "Например: рыбалка, садоводство или банкротство"}
                  className="min-w-0 flex-1"
                />
                <Button type="submit" variant="brand" className="shrink-0">
                  {internetSearchState === "searching" ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Search className="h-4 w-4" aria-hidden />
                  )}
                  Найти публикации
                </Button>
                {internetAppliedQuery && (
                  <Button
                    type="button"
                    variant="soft"
                    className="shrink-0"
                    onClick={clearInternetQuery}
                  >
                    Показать всю базу
                  </Button>
                )}
              </div>
              <p
                id="internet-feed-search-status"
                role="status"
                aria-live="polite"
                className={cn(
                  "mt-2 text-[12px] leading-relaxed",
                  internetSearchState === "invalid" || internetSearchState === "error"
                    ? "text-danger-text"
                    : "text-text-3",
                )}
              >
                {internetSearchMessage}
              </p>
            </form>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Tabs
          items={(Object.keys(TREND_PERIODS) as TrendPeriod[]).map((value) => ({
            value,
            label: TREND_PERIODS[value].label,
          }))}
          value={period}
          onChange={switchPeriod}
        />
        <p className="max-w-2xl text-[13px] leading-relaxed text-text-3">
          {TREND_PERIODS[period].description}{" "}
          {internet
            ? "Интернет-база обновляется после каждого проверенного поиска."
            : "Источники обновляются каждые 2 часа."}
        </p>
      </div>

          {loading ? (
        <div className="mt-5 grid gap-5">
          <div className="skeleton h-14 rounded-md" />
          <div className="grid gap-5 lg:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="skeleton h-56 rounded-lg" />
            ))}
          </div>
        </div>
      ) : loadError && !data ? (
        <Card className="mt-5 py-4">
          <EmptyState
            icon={<AlertTriangle className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title="Не получилось загрузить публикации"
            body="Данные не пропали. Проверь соединение и попробуй загрузить экран ещё раз."
            action={
              <Button
                variant="soft"
                onClick={() => {
                  setLoading(true);
                  setLoadError(false);
                  load();
                }}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Повторить
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="mt-5 grid gap-5">
          {st && (
            <StatusStrip
              status={st}
              period={period}
              scope={scope}
              onCheck={internet ? () => internetSearchInputRef.current?.focus() : check}
              checking={internet ? false : checking}
              actionLabel={internet
                ? internetAppliedQuery
                  ? "Изменить поиск"
                  : "Найти тему"
                : "Проверить сейчас"}
            />
          )}

          {data && data.competitors.length > 0 && (
            <WatchList competitors={data.competitors} internet={internet} />
          )}

          {period === "hits" && items.length > 0 && !internet && (
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
                    ? "Редакционная подборка ещё не собрана"
                    : internet
                      ? internetAppliedQuery
                        ? `По запросу «${internetAppliedQuery}» публикаций пока нет`
                        : "В интернет-базе пока нет публикаций"
                    : waiting > 0
                      ? `Нашёл ${waiting} ${plural(waiting, "канал", "канала", "каналов")} по теме — подтверди`
                      : "Пока не за кем следить"
                }
                body={
                  global
                    ? "Мы уже подготовили список открытых каналов про право и ИИ. Нажми «Проверить сейчас» — публикации появятся после сбора."
                    : internet
                      ? internetSearchState === "searching"
                        ? "Аврора проверяет публичные Telegram-источники. Новые публикации появятся здесь автоматически."
                        : internetAppliedQuery
                          ? "Попробуй другую формулировку или покажи всю уже собранную интернет-базу."
                          : "Нажми «Найти публикации»: пустое поле возьмёт тему из брифа, затем Аврора пойдёт в интернет и проверит каналы на t.me."
                    : waiting > 0
                      ? `Разведка уже прошла по теме${niche ? ` «${niche}»` : ""} и отобрала кандидатов. Оставь тех, кто правда твой сосед, — дальше я сам посчитаю их норму и поймаю посты, которые её обошли.`
                      : "Добавь каналы конкурентов — и я начну считать их норму и ловить посты, которые её обошли. Данные беру только открытые: посты, просмотры, реакции."
                }
                action={
                  global ? undefined : (
                    <Button
                      variant="brand"
                      onClick={() => {
                        if (!internet) router.push("/app/competitors");
                        else if (internetAppliedQuery) clearInternetQuery();
                        else internetSearchInputRef.current?.focus();
                      }}
                    >
                      <Radar className="h-4 w-4" aria-hidden />
                      {internet
                        ? internetAppliedQuery
                          ? "Показать всю базу"
                          : "Найти публикации"
                        : waiting > 0
                          ? "Посмотреть находки"
                          : "Добавить конкурента"}
                    </Button>
                  )
                }
              />
            </Card>
          ) : noPeriodData ? (
            <Card className="py-4">
              <EmptyState
                icon={period === "hits" ? <Flame className="h-6 w-6" strokeWidth={1.75} aria-hidden /> : <Clock className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
                title={
                  internet
                    ? period === "today"
                      ? "Сегодня новых интернет-публикаций пока нет"
                      : period === "week"
                        ? "За 7 дней интернет-публикаций нет"
                        : "За 30 дней интернет-находок нет"
                  : period === "today"
                    ? "Сегодня новых публикаций пока нет"
                    : period === "week"
                      ? "За последние 7 дней публикаций нет"
                      : "За 30 дней подтверждённых залётов нет"
                }
                body={
                  internet
                    ? "Измени период или найди новые публичные Telegram-публикации по нужной теме."
                  : period === "hits"
                    ? `Залётом считаем только пост, который обновлялся спустя ${st?.matureHours ?? 48} часов и сравним минимум с ${st?.minMature ?? 5} постами своего канала. Посмотри свежую ленту или добавь больше источников.`
                    : st?.latestPostAt
                      ? `Последняя публикация у отслеживаемых каналов вышла ${fmtPostDate(st.latestPostAt)}. Проверим их снова автоматически или по кнопке выше.`
                      : "У этих источников ещё нет собранных публикаций. Запусти проверку или добавь больше каналов-конкурентов."
                }
                action={
                  internet ? (
                    <Button
                      variant="soft"
                      onClick={() => internetSearchInputRef.current?.focus()}
                    >
                      Изменить поиск
                    </Button>
                  ) : period === "hits" ? (
                    <Button variant="soft" onClick={() => switchPeriod("today")}>Показать свежие</Button>
                  ) : global ? undefined : (
                    <Button variant="primary" onClick={() => router.push("/app/competitors")}>Добавить источники</Button>
                  )
                }
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
                    period={period}
                    internet={internet}
                    draft={drafts[item.id]}
                    generating={generating === item.id}
                    generationError={draftFailures[item.id]}
                    generationLocked={generating !== null}
                    requiresReview={draftReviews[item.id] === true}
                    reviewAcknowledged={draftAcknowledgements[item.id] === true}
                    transferring={transferring === item.id}
                    onSnap={() => snap(item)}
                    onReviewAcknowledged={(checked) =>
                      setDraftAcknowledgements((reviews) => ({
                        ...reviews,
                        [item.id]: checked,
                      }))
                    }
                    onToComposer={() => void toComposer(item)}
                  />
                </motion.li>
              ))}
            </ul>
          )}
        </div>
          )}
        </>
      )}
    </AppShell>
  );
}

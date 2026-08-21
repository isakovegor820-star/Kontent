"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  ImageIcon,
  RotateCcw,
  Settings2,
  Sparkles,
  Video,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import {
  shouldRetainMediaRequestKey,
  startImmediateMediaPolling,
} from "@/lib/media-generation-client";
import type { MediaGenerationStatus } from "@/lib/media-generation.mjs";
import { cn } from "@/lib/utils";

export type MediaKind = "image" | "video";

export type MediaGeneration = {
  id: string;
  requestId: string;
  kind: MediaKind;
  status: MediaGenerationStatus;
  prompt: string;
  negativePrompt?: string;
  sourceText?: string;
  exactText?: string;
  model: string;
  aspectRatio: string;
  quality: string | null;
  seconds: number | null;
  style: string;
  assetId: string | null;
  assetUrl: string | null;
  downloadUrl: string | null;
  mimeType: string | null;
  bytes: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type MediaCapability = {
  kind: MediaKind;
  id: string;
  label: string;
  available: boolean;
  reason: string | null;
  requiredPlan: string | null;
};

type MediaCapabilities = {
  configured: boolean;
  enabled: boolean;
  checked: boolean;
  plan: string | null;
  models: MediaCapability[];
};

const ACTIVE = new Set<MediaGenerationStatus>(["queued", "submitting", "generating", "saving"]);
const DEFAULT_IMAGE_MODEL = "nano-banana-2";

const DESIGN_STARTERS = [
  {
    label: "Обложка к посту",
    kind: "image",
    prompt: "Сделай выразительную обложку для публикации без надписей.",
  },
  {
    label: "Минималистичный визуал",
    kind: "image",
    prompt: "Создай минималистичный визуал: один главный объект, чистый фон и много воздуха.",
  },
  {
    label: "Вертикальный рилс",
    kind: "video",
    prompt: "Создай короткий вертикальный ролик с одним понятным действием и спокойным движением камеры.",
  },
] as const satisfies readonly { label: string; kind: MediaKind; prompt: string }[];

export type ActiveMediaPollTarget = Pick<MediaGeneration, "id" | "kind">;

/**
 * Polls a stable snapshot of active generations serially. A slow request cannot
 * overlap the next cycle, and a failed/terminal response for one id cannot keep
 * the remaining ids from being checked.
 */
export function startActiveMediaPolling(
  targets: readonly ActiveMediaPollTarget[],
  poll: (target: ActiveMediaPollTarget) => Promise<unknown>,
  scheduler: {
    setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>;
    clearInterval(handle: ReturnType<typeof setInterval>): void;
  },
): () => void {
  if (targets.length === 0) return () => {};

  const snapshot = [...targets];
  const intervalMs = snapshot.some((target) => target.kind === "image") ? 3_000 : 5_000;
  let stopped = false;
  const stopInterval = startImmediateMediaPolling(async () => {
    for (const target of snapshot) {
      if (stopped) return;
      try {
        await poll(target);
      } catch {
        // Один сетевой сбой не должен блокировать polling остальных задач.
      }
    }
  }, intervalMs, scheduler);

  return () => {
    stopped = true;
    stopInterval();
  };
}

const STYLES = [
  ["natural", "Естественный"],
  ["editorial", "Редакционный"],
  ["minimal", "Минимализм"],
  ["cinematic", "Кино"],
  ["product", "Предметный"],
  ["illustration", "Иллюстрация"],
] as const;

const SELECT_CLASS = cn(
  "h-11 w-full rounded-xs border border-line bg-surface px-3 text-[14px] font-semibold text-text",
  "transition-colors hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
);

export function buildAutomaticVisualBrief(sourceText: string | undefined, kind: MediaKind) {
  const source = sourceText?.trim().slice(0, 1200) ?? "";
  if (!source) return "";
  return kind === "video"
    ? `Короткая визуальная история без надписей к публикации. Передай её главный смысл через одно ясное действие: ${source}`
    : `Визуал без надписей к публикации. Передай её главный смысл через одну ясную сцену: ${source}`;
}

export function mediaGenerationErrorText(value: string | null | undefined) {
  const raw = value?.trim();
  if (!raw) return "Измени описание и попробуй ещё раз.";
  const code = raw.toLowerCase();
  const known: Record<string, string> = {
    unsafe_media_url: "Не удалось безопасно сохранить созданный файл. Попробуй ещё раз.",
    provider_unavailable: "Сервис создания файлов временно недоступен. Попробуй чуть позже.",
    worker_unavailable: "Создание временно недоступно. Попробуй чуть позже.",
    queue_unavailable: "Не удалось запустить создание. Попробуй ещё раз.",
    model_unavailable: "Выбранная модель сейчас недоступна. Выбери другую.",
    generation_failed: "Не удалось создать файл. Измени описание и попробуй ещё раз.",
  };
  if (known[code]) return known[code];
  if (/[а-яё]/iu.test(raw)) return raw;
  return "Не удалось создать файл. Измени описание и попробуй ещё раз.";
}

function statusCopy(generation: MediaGeneration) {
  switch (generation.status) {
    case "queued":
      return { title: "Задача принята", body: "Ждём свободный слот генератора.", icon: Clock3 };
    case "submitting":
      return { title: "Передаём модели", body: "Проверяем задачу и начинаем генерацию.", icon: Sparkles };
    case "generating":
      return {
        title: generation.kind === "video" ? "Видео создаётся" : "Изображение создаётся",
        body: "",
        icon: RotateCcw,
      };
    case "saving":
      return { title: "Сохраняем файл", body: "Копируем результат в медиатеку Авроры.", icon: Download };
    case "ready":
      return { title: "Готово", body: "Файл сохранён и не исчезнет после обновления страницы.", icon: CheckCircle2 };
    default:
      return { title: "Не получилось", body: mediaGenerationErrorText(generation.errorMessage || generation.errorCode), icon: AlertTriangle };
  }
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(bytes / 1024)} КБ`;
}

export function MediaGenerator({
  initialKind,
  channelId,
  sourceText,
  onUse,
}: {
  initialKind: MediaKind;
  channelId: number | null;
  sourceText?: string;
  onUse: (generation: MediaGeneration) => void;
}) {
  const [kind, setKind] = useState<MediaKind>(initialKind);
  const [promptOverride, setPromptOverride] = useState<string | null>(null);
  const [exactText, setExactText] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("водяные знаки, логотипы, нечитаемый текст, искажённые руки");
  const [style, setStyle] = useState("natural");
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [imageRatio, setImageRatio] = useState("1:1");
  const [quality, setQuality] = useState("medium");
  const [videoRatio, setVideoRatio] = useState("9:16");
  const [seconds, setSeconds] = useState(6);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generations, setGenerations] = useState<MediaGeneration[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [capabilities, setCapabilities] = useState<MediaCapabilities | null>(null);
  const submitRef = useRef(false);
  const requestRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const feedEndRef = useRef<HTMLDivElement | null>(null);
  const prompt = promptOverride ?? "";

  const hasActiveGenerations = generations.some((item) => ACTIVE.has(item.status));
  const activePollPlan = useMemo(() => JSON.stringify(
    generations
      .filter((item) => ACTIVE.has(item.status))
      .map(({ id, kind: generationKind }) => ({ id, kind: generationKind }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  ), [generations]);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      fetch("/api/media/generations", { cache: "no-store" })
        .then(async (res) => ({ res, data: (await res.json().catch(() => null)) as { generations?: MediaGeneration[] } | null }))
        .then(({ res, data }) => {
          if (!cancelled && res.ok) {
            const history = data?.generations ?? [];
            setGenerations(history);
            setCurrentId(history[0]?.id ?? null);
          }
        }),
      fetch("/api/media/capabilities", { cache: "no-store" })
        .then(async (res) => ({ res, data: (await res.json().catch(() => null)) as MediaCapabilities | null }))
        .then(({ res, data }) => {
          if (!cancelled && res.ok && data) setCapabilities(data);
        }),
    ]);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const targets = JSON.parse(activePollPlan) as ActiveMediaPollTarget[];
    if (targets.length === 0) return;

    let cancelled = false;
    const controller = new AbortController();
    const poll = async (target: ActiveMediaPollTarget) => {
      if (controller.signal.aborted) return;
      try {
        const res = await fetch(`/api/media/generations/${target.id}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = (await res.json().catch(() => null)) as
          | { generation?: MediaGeneration; requestId?: string; error?: string }
          | null;
        if (!cancelled && res.ok && data?.generation) {
          setGenerations((items) => [data.generation!, ...items.filter((item) => item.id !== data.generation!.id)]);
          if (!ACTIVE.has(data.generation.status)) {
            window.dispatchEvent(new Event("aurora:ai-usage-changed"));
          }
        }
      } catch {
        // Сетевой обрыв не меняет серверную задачу: следующий poll продолжит с того же id.
      }
    };
    const stop = startActiveMediaPolling(
      targets,
      poll,
      { setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window) },
    );
    return () => {
      cancelled = true;
      stop();
      controller.abort();
    };
  }, [activePollPlan]);

  useEffect(() => {
    if (!currentId) return;
    feedEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [currentId]);

  const generate = async (retry?: MediaGeneration) => {
    const requestedKind = retry?.kind ?? kind;
    const requestedPrompt = retry?.prompt ?? prompt;
    const retryModel = retry?.model === "flux" ? DEFAULT_IMAGE_MODEL : retry?.model;
    const requestedModel = retryModel ?? (requestedKind === "image" ? imageModel : "veo-3.1");
    const requestedRatio = retry?.aspectRatio ?? (requestedKind === "image" ? imageRatio : videoRatio);
    const requestedQuality = retry?.quality ?? quality;
    const requestedSeconds = retry?.seconds ?? seconds;
    const requestedStyle = retry?.style ?? style;
    const requestedNegativePrompt = retry?.negativePrompt ?? negativePrompt;
    const requestedSourceText = retry?.sourceText ?? sourceText?.trim() ?? "";
    const requestedExactText = retry?.exactText ?? exactText;
    if (requestedPrompt.trim().length < 5) {
      setError({
        message: "Опиши, что нужно создать — хотя бы одним предложением.",
        requestId: null,
      });
      requestAnimationFrame(() => promptRef.current?.focus());
      return;
    }
    if (submitRef.current || submitting) return;
    const access = capabilities?.models.find((model) => model.kind === requestedKind && model.id === requestedModel);
    if (capabilities?.enabled === false || access?.available === false) {
      setError({
        message: requestedKind === "video"
          ? "Видео пока недоступно на сервере. Картинки уже можно создавать."
          : "Эта модель сейчас недоступна. Выбери другую модель.",
        requestId: null,
      });
      return;
    }
    const payload = {
      kind: requestedKind,
      prompt: requestedPrompt,
      sourceText: requestedSourceText,
      exactText: requestedExactText,
      negativePrompt: requestedNegativePrompt,
      style: requestedStyle,
      channelId,
      model: requestedModel,
      aspectRatio: requestedRatio,
      quality: requestedKind === "image" ? requestedQuality : undefined,
      seconds: requestedKind === "video" ? requestedSeconds : undefined,
    };
    const fingerprint = JSON.stringify(payload);
    if (!requestRef.current || requestRef.current.fingerprint !== fingerprint) {
      requestRef.current = {
        fingerprint,
        key: globalThis.crypto.randomUUID(),
      };
    }
    const requestKey = requestRef.current.key;
    setError(null);
    submitRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch("/api/media/generations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": requestKey,
        },
        body: fingerprint,
      });
      const data = (await res.json().catch(() => null)) as
        | {
            generation?: MediaGeneration;
            error?: string;
            limit?: number;
            requiredPlan?: string;
            requestId?: string;
            retryable?: boolean;
          }
        | null;
      if (!res.ok || !data?.generation) {
        if (!shouldRetainMediaRequestKey(res.status, data?.error)) requestRef.current = null;
        const creationFailed = requestedKind === "video"
          ? "Не удалось создать видео. Попробуй ещё раз."
          : "Не удалось создать изображение. Попробуй ещё раз.";
        const message =
          data?.error === "limit"
            ? `Лимит на сегодня исчерпан (${data.limit ?? 0}).`
            : data?.error === "already_generating"
              ? "Дождись текущей генерации — одновременно можно запускать только одну такую задачу."
              : data?.error === "not_configured"
                ? creationFailed
                : data?.error === "model_unavailable"
                  ? requestedKind === "video"
                    ? "Видео пока недоступно на сервере. Картинки уже можно создавать."
                    : "Эта модель сейчас недоступна. Выбери другую модель."
                : data?.error === "queue_unavailable"
                  ? creationFailed
                  : data?.error === "worker_unavailable"
                    ? creationFailed
                    : data?.error === "provider_unavailable" || data?.error === "usage_unavailable"
                      ? creationFailed
                  : data?.error === "request_in_progress"
                    ? "Запрос уже принят. Повтори через несколько секунд — второе обращение к ИИ не запустится."
                  : "Не удалось поставить задачу в очередь. Попробуй ещё раз.";
        setError({
          message,
          requestId: data?.requestId || res.headers.get("x-request-id"),
        });
        return;
      }
      requestRef.current = null;
      setCurrentId(data.generation.id);
      setGenerations((items) => [data.generation!, ...items.filter((item) => item.id !== data.generation!.id)]);
      window.dispatchEvent(new Event("aurora:ai-usage-changed"));
    } catch {
      // Ambiguous network outcome keeps the same key. A retry asks the server for the
      // existing generation instead of starting another provider request.
      setError({
        message: "Не удалось связаться с Авророй. Проверь соединение и попробуй ещё раз.",
        requestId: null,
      });
    } finally {
      submitRef.current = false;
      setSubmitting(false);
    }
  };

  const applyStarter = (starter: (typeof DESIGN_STARTERS)[number]) => {
    setKind(starter.kind);
    setPromptOverride(starter.prompt);
    setError(null);
    requestAnimationFrame(() => {
      const input = promptRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };

  const editGeneration = (generation: MediaGeneration) => {
    setKind(generation.kind);
    setPromptOverride(generation.prompt);
    setStyle(generation.style);
    setNegativePrompt(generation.negativePrompt ?? negativePrompt);
    setExactText(generation.exactText ?? "");
    if (generation.kind === "image") {
      setImageModel(generation.model === "flux" ? DEFAULT_IMAGE_MODEL : generation.model);
      setImageRatio(generation.aspectRatio);
      if (generation.quality) setQuality(generation.quality);
    } else {
      setVideoRatio(generation.aspectRatio);
      if (generation.seconds) setSeconds(generation.seconds);
    }
    requestAnimationFrame(() => {
      const input = promptRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };

  const handlePromptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void generate();
  };

  const imageRatios = imageModel === "gpt-image-2"
    ? ["1:1", "2:3", "3:2"]
    : imageModel === "nano-banana-2"
      ? ["1:1", "3:4", "4:3", "9:16", "16:9"]
      : ["1:1", "3:4", "9:16", "16:9"];
  const videoAvailable = capabilities?.models.some((model) => model.kind === "video" && model.available) ?? true;
  const visibleGenerations = useMemo(
    () => generations.slice(0, 20).reverse(),
    [generations],
  );
  const latest = generations[0] ?? null;
  const latestStatus = latest ? statusCopy(latest) : null;
  const announcement = error
    ? error.message
    : latest && latestStatus
      ? `${latestStatus.title}${latestStatus.body ? `. ${latestStatus.body}` : ""}`
      : "";

  return (
    <section
      className="flex h-[var(--studio-h)] min-h-[520px] min-w-0 flex-col overflow-hidden"
      aria-label="Чат с дизайнером"
      aria-busy={hasActiveGenerations}
    >
      <p role="status" className="sr-only">{announcement}</p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex min-h-full w-full max-w-[820px] flex-col px-4 py-6 md:px-6 md:py-8",
            visibleGenerations.length > 0 ? "gap-8" : "justify-center",
          )}
        >
          {visibleGenerations.length === 0 ? (
            <div className="flex flex-col items-center pb-16 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-[16px] bg-brand/15 text-brand">
                <Sparkles className="h-5 w-5" strokeWidth={2} aria-hidden />
              </div>
              <h2 className="mt-5 text-[24px] font-semibold tracking-tight text-text">Что создаём?</h2>
              <p className="mt-2 max-w-[42ch] text-[14px] leading-relaxed text-text-3">
                Опиши идею обычными словами. Формат и детали можно уточнить после первого результата.
              </p>
              <div className="mt-6 flex max-w-[680px] flex-wrap justify-center gap-2" aria-label="Примеры запросов">
                {DESIGN_STARTERS.map((starter) => (
                  <button
                    key={starter.label}
                    type="button"
                    disabled={starter.kind === "video" && capabilities?.checked && !videoAvailable}
                    onClick={() => applyStarter(starter)}
                    className={cn(
                      "min-h-11 rounded-full border border-line bg-surface px-4 text-[13px] font-semibold text-text-2 shadow-sm",
                      "transition-[transform,background-color,border-color,color] duration-150 hover:border-line-strong hover:bg-surface-2 hover:text-text active:scale-[0.96]",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-45",
                    )}
                  >
                    {starter.label}
                    {starter.kind === "video" && capabilities?.checked && !videoAvailable ? " · скоро" : ""}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            visibleGenerations.map((generation) => {
              const status = statusCopy(generation);
              const StatusIcon = status.icon;
              const active = ACTIVE.has(generation.status);
              const vertical = ["9:16", "2:3", "3:4"].includes(generation.aspectRatio);
              const aspectRatio = generation.aspectRatio.replace(":", " / ");

              return (
                <article key={generation.id} className="space-y-5" aria-label={`Запрос: ${generation.prompt}`}>
                  <div className="ms-auto w-fit max-w-[min(88%,42rem)] text-end">
                    <p className="mb-1 text-[11px] font-bold tracking-wide text-text-3 uppercase">Ты</p>
                    <p className="text-[15px] leading-[1.65] whitespace-pre-wrap text-text">{generation.prompt}</p>
                  </div>

                  <div className="min-w-0">
                    <p className="mb-3 flex items-center gap-2 text-[11px] font-bold tracking-wide text-text-3 uppercase">
                      <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
                      Аврора
                    </p>

                    {!active && (
                      <div className="flex items-start gap-3">
                        <span
                          className={cn(
                            "grid h-10 w-10 shrink-0 place-items-center rounded-[12px]",
                            generation.status === "ready"
                              ? "bg-success-soft text-success-text"
                              : "bg-danger-soft text-danger-text",
                          )}
                        >
                          <StatusIcon className="h-5 w-5" aria-hidden />
                        </span>
                        <div className="min-w-0 pt-0.5">
                          <h3 className="text-[15px] font-semibold text-text">{status.title}</h3>
                          {status.body && <p className="mt-0.5 text-[13px] leading-relaxed text-text-3">{status.body}</p>}
                        </div>
                      </div>
                    )}

                    {active && (
                      <div
                        className={cn(
                          "relative w-full overflow-hidden rounded-[18px] bg-surface-inset outline -outline-offset-1 outline-[var(--image-outline)]",
                          vertical ? "max-w-[360px]" : "max-w-[640px]",
                        )}
                        style={{ aspectRatio }}
                        aria-label={status.title}
                      >
                        <div className="skeleton absolute inset-0 rounded-none" aria-hidden />
                      </div>
                    )}

                    {generation.status === "ready" && generation.assetUrl && (
                      <div
                        className={cn(
                          "mt-4 overflow-hidden rounded-[18px] outline -outline-offset-1 outline-[var(--image-outline)]",
                          generation.kind === "video" ? "bg-black" : "bg-surface",
                          vertical ? "max-w-[420px]" : "max-w-[680px]",
                        )}
                      >
                        {generation.kind === "video" ? (
                          <video
                            src={generation.assetUrl}
                            controls
                            preload="metadata"
                            className="max-h-[640px] w-full object-contain"
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={generation.assetUrl}
                            alt={`Результат по запросу: ${generation.prompt}`}
                            className="block h-auto w-full"
                          />
                        )}
                      </div>
                    )}

                    {!active && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {generation.status === "ready" && generation.downloadUrl && (
                          <a
                            href={generation.downloadUrl}
                            download
                            className={cn(
                              "inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-line-strong bg-surface px-4 text-[13px] font-semibold text-text",
                              "transition-[transform,background-color] duration-150 hover:bg-surface-inset active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                            )}
                          >
                            <Download className="h-4 w-4" aria-hidden />
                            Скачать {formatBytes(generation.bytes)}
                          </a>
                        )}
                        {generation.status === "ready" && (
                          <Button variant="solid" size="sm" onClick={() => onUse(generation)} disabled={submitting}>
                            Добавить к посту
                          </Button>
                        )}
                        {generation.status === "ready" && (
                          <Button variant="soft" size="sm" onClick={() => void generate(generation)} disabled={submitting}>
                            Создать ещё вариант
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => editGeneration(generation)} disabled={submitting}>
                          Изменить запрос
                        </Button>
                        {generation.status === "failed" && (
                          <Button variant="outline" size="sm" onClick={() => void generate(generation)} disabled={submitting}>
                            Повторить генерацию
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })
          )}
          <div ref={feedEndRef} className="h-px shrink-0" aria-hidden />
        </div>
      </div>

      <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-5 md:pb-4">
        <div className="mx-auto w-full max-w-[820px] overflow-hidden rounded-[24px] border border-line/70 bg-surface shadow-[0_12px_40px_rgb(17_17_17/0.10)] focus-within:ring-2 focus-within:ring-brand/15">
          {error && (
            <div id="design-prompt-error" role="alert" className="border-b border-danger-text/20 bg-danger-soft px-4 py-3 text-[12px] leading-relaxed text-danger-text">
              <p className="font-semibold">{error.message}</p>
            </div>
          )}

          {settingsOpen && (
            <div
              id="design-settings"
              className="max-h-[min(58svh,560px)] overflow-y-auto overscroll-contain border-b border-line bg-surface-2/70 p-4 md:p-5"
            >
              <div>
                <p className="text-[12px] font-semibold text-text-2">Визуальный стиль</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {STYLES.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={style === value}
                      onClick={() => setStyle(value)}
                      className={cn(
                        "min-h-11 rounded-full border px-3.5 text-[12px] font-semibold",
                        "transition-[transform,background-color,border-color,color] duration-150 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                        style === value
                          ? "border-text bg-text text-bg"
                          : "border-line-strong bg-surface text-text-2 hover:bg-surface-inset hover:text-text",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {kind === "image" ? (
                  <>
                    <label className="space-y-2 text-[12px] font-semibold text-text-2">
                      Модель
                      <select
                        className={SELECT_CLASS}
                        value={imageModel}
                        onChange={(event) => {
                          setImageModel(event.target.value);
                          setImageRatio("1:1");
                        }}
                      >
                        <option value="nano-banana-2">Nano Banana 2 · текст и детали</option>
                        <option value="gpt-image-2">GPT Image 2 · качество</option>
                      </select>
                    </label>
                    <label className="space-y-2 text-[12px] font-semibold text-text-2">
                      Формат
                      <select className={SELECT_CLASS} value={imageRatio} onChange={(event) => setImageRatio(event.target.value)}>
                        {imageRatios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                      </select>
                    </label>
                    <label className="space-y-2 text-[12px] font-semibold text-text-2 sm:col-span-2">
                      Качество
                      <select className={SELECT_CLASS} value={quality} onChange={(event) => setQuality(event.target.value)}>
                        <option value="low">Черновик · быстрее</option>
                        <option value="medium">Финал · среднее качество</option>
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    <label className="space-y-2 text-[12px] font-semibold text-text-2">
                      Формат видео
                      <select className={SELECT_CLASS} value={videoRatio} onChange={(event) => setVideoRatio(event.target.value)}>
                        <option value="9:16">9:16 · вертикальный</option>
                        <option value="16:9">16:9 · горизонтальный</option>
                      </select>
                    </label>
                    <label className="space-y-2 text-[12px] font-semibold text-text-2">
                      Длительность
                      <select className={SELECT_CLASS} value={seconds} onChange={(event) => setSeconds(Number(event.target.value))}>
                        <option value={4}>4 секунды</option>
                        <option value={6}>6 секунд</option>
                        <option value={8}>8 секунд</option>
                      </select>
                    </label>
                  </>
                )}

                <label className="space-y-2 text-[12px] font-semibold text-text-2 sm:col-span-2">
                  Точный текст в кадре
                  <input
                    id="media-exact-text"
                    type="text"
                    value={exactText}
                    maxLength={240}
                    onChange={(event) => setExactText(event.target.value)}
                    className={cn(SELECT_CLASS, "text-[16px] sm:text-[14px]")}
                    placeholder="Например: Контент без авралов"
                  />
                </label>

                <label className="space-y-2 text-[12px] font-semibold text-text-2 sm:col-span-2">
                  Что исключить
                  <Textarea
                    rows={2}
                    value={negativePrompt}
                    onChange={(event) => setNegativePrompt(event.target.value)}
                    className="bg-surface text-[16px] sm:text-[14px]"
                    placeholder="Например: логотипы, водяные знаки, нечитаемый текст"
                  />
                </label>
              </div>
            </div>
          )}

          <label htmlFor="media-prompt" className="sr-only">Опиши, что нужно создать</label>
          <Textarea
            ref={promptRef}
            id="media-prompt"
            rows={2}
            value={prompt}
            onChange={(event) => {
              setPromptOverride(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handlePromptKeyDown}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "design-prompt-error" : undefined}
            placeholder={kind === "video" ? "Например: создай короткий ролик о запуске нового продукта…" : "Напиши, что нужно создать…"}
            className="min-h-[76px] max-h-[180px] overflow-y-auto rounded-none border-0 bg-transparent px-5 pt-4 pb-2 text-[16px] hover:border-0 focus:border-0 focus-visible:ring-0"
          />

          <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 pb-3">
            <div className="inline-flex rounded-full bg-surface-inset p-1" role="group" aria-label="Тип результата">
              {(["image", "video"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={kind === value}
                  disabled={value === "video" && capabilities?.checked && !videoAvailable}
                  onClick={() => setKind(value)}
                  className={cn(
                    "inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold",
                    "transition-[transform,background-color,color] duration-150 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-45",
                    kind === value ? "bg-surface text-text shadow-sm" : "text-text-3 hover:text-text",
                  )}
                >
                  {value === "image" ? <ImageIcon className="h-4 w-4" aria-hidden /> : <Video className="h-4 w-4" aria-hidden />}
                  {value === "image" ? "Изображение" : capabilities?.checked && !videoAvailable ? "Видео · скоро" : "Видео"}
                </button>
              ))}
            </div>

            <Button
              variant="ghost"
              size="sm"
              aria-expanded={settingsOpen}
              aria-controls="design-settings"
              onClick={() => setSettingsOpen((open) => !open)}
              className="rounded-full px-3 active:scale-[0.96]"
            >
              <Settings2 className="h-4 w-4" aria-hidden />
              Настройки
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-150", settingsOpen && "rotate-180")} aria-hidden />
            </Button>

            {sourceText?.trim() && (
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full px-3 active:scale-[0.96]"
                onClick={() => {
                  setPromptOverride(buildAutomaticVisualBrief(sourceText, kind));
                  requestAnimationFrame(() => promptRef.current?.focus());
                }}
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                Взять последний пост
              </Button>
            )}

            <Button
              variant="brand"
              size="icon"
              className="ms-auto h-11 w-11 shrink-0 rounded-full active:scale-[0.96]"
              aria-label={kind === "image" ? "Создать изображение" : "Создать видео"}
              onClick={() => void generate()}
              loading={submitting}
            >
              {!submitting && <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />}
            </Button>
          </div>

          {kind === "video" && capabilities?.checked && !videoAvailable && (
            <p className="border-t border-line px-4 py-2.5 text-[11px] leading-relaxed text-text-3">
              Видео пока недоступно. Можно создать изображение.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

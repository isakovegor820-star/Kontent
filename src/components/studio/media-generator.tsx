"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  ImageIcon,
  RotateCcw,
  Sparkles,
  Video,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export type MediaKind = "image" | "video";

export type MediaGeneration = {
  id: string;
  kind: MediaKind;
  status: "queued" | "submitting" | "generating" | "saving" | "ready" | "failed";
  prompt: string;
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

const ACTIVE = new Set(["queued", "submitting", "generating", "saving"]);

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

function statusCopy(generation: MediaGeneration) {
  switch (generation.status) {
    case "queued":
      return { title: "В очереди", body: "Worker заберёт задачу автоматически.", icon: Clock3 };
    case "submitting":
      return { title: "Передаём модели", body: "Не закрывай вкладку только первые несколько секунд.", icon: Sparkles };
    case "generating":
      return {
        title: generation.kind === "video" ? "Создаём видео" : "Рисуем изображение",
        body: generation.kind === "video" ? "Обычно 1–10 минут. Страницу можно закрыть." : "Обычно 10–60 секунд. Страницу можно закрыть.",
        icon: RotateCcw,
      };
    case "saving":
      return { title: "Сохраняем файл", body: "Копируем результат в медиатеку Авроры.", icon: Download };
    case "ready":
      return { title: "Готово", body: "Файл сохранён и не исчезнет после обновления страницы.", icon: CheckCircle2 };
    default:
      return { title: "Не получилось", body: generation.errorMessage || "Измени описание и попробуй ещё раз.", icon: AlertTriangle };
  }
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(bytes / 1024)} КБ`;
}

export function MediaGenerator({
  initialKind,
  niche,
  tone,
  onClose,
  onUse,
}: {
  initialKind: MediaKind;
  niche?: string;
  tone?: string;
  onClose: () => void;
  onUse: (generation: MediaGeneration) => void;
}) {
  const [kind, setKind] = useState<MediaKind>(initialKind);
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("водяные знаки, логотипы, нечитаемый текст, искажённые руки");
  const [style, setStyle] = useState("natural");
  const [imageModel, setImageModel] = useState("flux");
  const [imageRatio, setImageRatio] = useState("1:1");
  const [quality, setQuality] = useState("medium");
  const [videoRatio, setVideoRatio] = useState("9:16");
  const [seconds, setSeconds] = useState(6);
  const [generations, setGenerations] = useState<MediaGeneration[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = useMemo(
    () => generations.find((item) => item.id === currentId) ?? generations[0] ?? null,
    [currentId, generations],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/media/generations", { cache: "no-store" })
      .then(async (res) => ({ res, data: (await res.json().catch(() => null)) as { generations?: MediaGeneration[] } | null }))
      .then(({ res, data }) => {
        if (!cancelled && res.ok) setGenerations(data?.generations ?? []);
      })
      .catch(() => {
        // Пустое состояние уже доступно; история появится при следующем открытии панели.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!current || !ACTIVE.has(current.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/media/generations/${current.id}`, { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as { generation?: MediaGeneration } | null;
        if (!cancelled && res.ok && data?.generation) {
          setGenerations((items) => [data.generation!, ...items.filter((item) => item.id !== data.generation!.id)]);
        }
      } catch {
        // Сетевой обрыв не меняет серверную задачу: следующий poll продолжит с того же id.
      }
    };
    const timer = window.setInterval(() => void poll(), current.kind === "video" ? 5000 : 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [current]);

  const generate = async () => {
    if (prompt.trim().length < 5 || submitting) {
      setError("Опиши, что должно быть в кадре — хотя бы одним предложением.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/media/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          prompt,
          negativePrompt,
          style,
          niche,
          tone,
          model: kind === "image" ? imageModel : "veo-3.1",
          aspectRatio: kind === "image" ? imageRatio : videoRatio,
          quality: kind === "image" ? quality : undefined,
          seconds: kind === "video" ? seconds : undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { generation?: MediaGeneration; error?: string; limit?: number }
        | null;
      if (!res.ok || !data?.generation) {
        const message =
          data?.error === "limit"
            ? `Лимит на сегодня исчерпан (${data.limit ?? 0}).`
            : data?.error === "already_generating"
              ? "Дождись текущей генерации — одновременно можно запускать только одну такую задачу."
              : data?.error === "not_configured"
                ? "NavyAI не подключён на сервере."
                : data?.error === "queue_unavailable"
                  ? "Worker или Redis сейчас недоступен. Запусти npm run dev и попробуй снова."
                  : "Не удалось поставить задачу в очередь. Попробуй ещё раз.";
        setError(message);
        return;
      }
      setCurrentId(data.generation.id);
      setGenerations((items) => [data.generation!, ...items.filter((item) => item.id !== data.generation!.id)]);
    } catch {
      setError("Не удалось связаться с Авророй. Проверь соединение и попробуй ещё раз.");
    } finally {
      setSubmitting(false);
    }
  };

  const imageRatios = imageModel === "gpt-image-2" ? ["1:1", "2:3", "3:2"] : ["1:1", "3:4", "9:16", "16:9"];

  const status = current ? statusCopy(current) : null;
  const StatusIcon = status?.icon;

  return (
    <section className="rounded-md border-2 border-text bg-surface" aria-label="Генератор медиа">
      <header className="flex items-start justify-between gap-4 border-b-2 border-text p-4 md:p-5">
        <div>
          <h2 className="text-[18px] font-extrabold tracking-tight text-text">Создать медиа</h2>
          <p className="mt-1 max-w-[65ch] text-[13px] leading-relaxed text-text-2">
            NavyAI получает только твоё описание и настройки Авроры. Результат сохранится в медиатеке.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть генератор">
          <X className="h-5 w-5" aria-hidden />
        </Button>
      </header>

      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.08fr)_minmax(280px,.92fr)]">
        <div className="min-w-0 space-y-5 p-4 md:p-5 lg:border-r-2 lg:border-text">
          <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Тип медиа">
            {(["image", "video"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={kind === value}
                onClick={() => setKind(value)}
                className={cn(
                  "flex min-h-11 items-center justify-center gap-2 rounded-xs border-2 border-text px-4 text-[14px] font-extrabold",
                  "transition-colors duration-200",
                  kind === value ? "bg-brand text-text" : "bg-surface hover:bg-surface-2",
                )}
              >
                {value === "image" ? <ImageIcon className="h-4 w-4" aria-hidden /> : <Video className="h-4 w-4" aria-hidden />}
                {value === "image" ? "Картинка" : "Рилс / видео"}
              </button>
            ))}
          </div>

          <div>
            <label htmlFor="media-prompt" className="mb-2 block text-[13px] font-bold text-text-2">
              Что должно быть в кадре
            </label>
            <Textarea
              id="media-prompt"
              rows={4}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={kind === "video" ? "Например: автор открывает ноутбук, видит готовый контент-план и улыбается…" : "Например: минималистичная обложка поста о регулярном контенте…"}
            />
            <p className="mt-1.5 text-[12px] text-text-3">Не проси модель придумывать факты: опиши только видимую сцену.</p>
          </div>

          <div>
            <p className="mb-2 text-[13px] font-bold text-text-2">Визуальный стиль</p>
            <div className="flex flex-wrap gap-2">
              {STYLES.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={style === value}
                  onClick={() => setStyle(value)}
                  className={cn(
                    "min-h-9 rounded-full border px-3 text-[12px] font-semibold transition-colors",
                    style === value ? "border-text bg-text text-bg" : "border-line-strong bg-surface text-text-2 hover:text-text",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {kind === "image" ? (
              <>
                <label className="space-y-2 text-[13px] font-bold text-text-2">
                  Модель
                  <select
                    className={SELECT_CLASS}
                    value={imageModel}
                    onChange={(event) => {
                      setImageModel(event.target.value);
                      setImageRatio("1:1");
                    }}
                  >
                    <option value="flux">Flux · быстро</option>
                    <option value="gpt-image-2">GPT Image 2 · качество</option>
                  </select>
                </label>
                <label className="space-y-2 text-[13px] font-bold text-text-2">
                  Формат
                  <select className={SELECT_CLASS} value={imageRatio} onChange={(event) => setImageRatio(event.target.value)}>
                    {imageRatios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                  </select>
                </label>
                <label className="space-y-2 text-[13px] font-bold text-text-2 sm:col-span-2">
                  Качество
                  <select className={SELECT_CLASS} value={quality} onChange={(event) => setQuality(event.target.value)}>
                    <option value="low">Черновик · быстрее</option>
                    <option value="medium">Финал · среднее качество</option>
                  </select>
                </label>
              </>
            ) : (
              <>
                <label className="space-y-2 text-[13px] font-bold text-text-2">
                  Формат видео
                  <select className={SELECT_CLASS} value={videoRatio} onChange={(event) => setVideoRatio(event.target.value)}>
                    <option value="9:16">9:16 · рилс</option>
                    <option value="16:9">16:9 · горизонтальное</option>
                  </select>
                </label>
                <label className="space-y-2 text-[13px] font-bold text-text-2">
                  Длительность
                  <select className={SELECT_CLASS} value={seconds} onChange={(event) => setSeconds(Number(event.target.value))}>
                    <option value={4}>4 секунды</option>
                    <option value={6}>6 секунд</option>
                    <option value={8}>8 секунд</option>
                  </select>
                </label>
              </>
            )}
          </div>

          <details className="rounded-xs border border-line bg-surface-2 p-3">
            <summary className="cursor-pointer text-[13px] font-bold text-text">Что исключить из результата</summary>
            <Textarea
              rows={2}
              value={negativePrompt}
              onChange={(event) => setNegativePrompt(event.target.value)}
              className="mt-3 bg-surface"
              aria-label="Что исключить из результата"
            />
          </details>

          {error && <p role="alert" className="rounded-xs bg-danger-soft p-3 text-[13px] font-semibold text-danger-text">{error}</p>}

          <Button variant="brand" size="lg" onClick={() => void generate()} loading={submitting} disabled={prompt.trim().length < 5}>
            {!submitting && (kind === "image" ? <ImageIcon className="h-[18px] w-[18px]" aria-hidden /> : <Video className="h-[18px] w-[18px]" aria-hidden />)}
            {kind === "image" ? "Создать картинку" : "Создать видео"}
          </Button>
        </div>

        <div className="min-w-0 bg-bg-section p-4 md:p-5" aria-live="polite">
          {!current ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center text-center">
              <div className="grid h-14 w-14 place-items-center rounded-sm border-2 border-text bg-brand">
                <ImageIcon className="h-6 w-6" aria-hidden />
              </div>
              <h3 className="mt-4 text-[17px] font-extrabold text-text">Здесь появится результат</h3>
              <p className="mt-1 max-w-[30ch] text-[13px] leading-relaxed text-text-2">Опиши сцену, выбери формат и запусти первую генерацию.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                {StatusIcon && (
                  <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xs border-2 border-text", current.status === "ready" ? "bg-success-soft text-success-text" : current.status === "failed" ? "bg-danger-soft text-danger-text" : "bg-brand text-text")}>
                    <StatusIcon className={cn("h-5 w-5", ACTIVE.has(current.status) && current.status !== "queued" && "animate-spin motion-reduce:animate-none")} aria-hidden />
                  </span>
                )}
                <div className="min-w-0">
                  <h3 className="text-[16px] font-extrabold text-text">{status?.title}</h3>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-text-2">{status?.body}</p>
                </div>
              </div>

              {current.status === "ready" && current.assetUrl && (
                <div className="overflow-hidden rounded-sm border-2 border-text bg-black">
                  {current.kind === "video" ? (
                    <video src={current.assetUrl} controls preload="metadata" className="aspect-[9/16] max-h-[520px] w-full object-contain" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={current.assetUrl} alt={current.prompt} className="max-h-[520px] w-full object-contain" />
                  )}
                </div>
              )}

              {ACTIVE.has(current.status) && (
                <div className="h-2 overflow-hidden rounded-full bg-surface-inset" aria-label="Генерация выполняется">
                  <div className="h-full w-1/3 animate-[media-progress_1.6s_ease-in-out_infinite] rounded-full bg-brand motion-reduce:animate-none" />
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {current.status === "ready" && current.downloadUrl && (
                  <a href={current.downloadUrl} download className="inline-flex h-11 items-center justify-center gap-2 rounded-xs border border-line-strong bg-surface px-4 text-[14px] font-semibold text-text transition-colors hover:bg-surface-inset">
                    <Download className="h-4 w-4" aria-hidden />
                    Скачать {formatBytes(current.bytes)}
                  </a>
                )}
                {current.status === "ready" && (
                  <Button variant="solid" onClick={() => onUse(current)}>Добавить к посту</Button>
                )}
                {current.status === "failed" && (
                  <Button variant="outline" onClick={() => { setPrompt(current.prompt); setKind(current.kind); }}>Повторить с настройками</Button>
                )}
              </div>

              {generations.length > 1 && (
                <div className="border-t border-line pt-3">
                  <p className="mb-2 text-[12px] font-bold text-text-3">Последние генерации</p>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {generations.slice(0, 8).map((item) => (
                      <button key={item.id} type="button" onClick={() => setCurrentId(item.id)} className={cn("min-w-[112px] rounded-xs border px-3 py-2 text-left text-[12px]", current.id === item.id ? "border-text bg-surface" : "border-line bg-surface-2")}>
                        <strong className="block truncate text-text">{item.kind === "video" ? "Видео" : "Картинка"}</strong>
                        <span className="mt-0.5 block text-text-3">{item.status === "ready" ? "Готово" : item.status === "failed" ? "Ошибка" : "В работе"}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Bookmark, Check, ChevronDown, ExternalLink, Eye, EyeOff, MessageSquareText, Sparkles, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { libraryCardContentId } from "@/components/app/library-card-text";
import type { DraftBackedAppAction } from "@/lib/app-routes";
import type { LibraryRegistryItem } from "@/lib/library-filters";
import { cn, fmtAgo, fmtNum } from "@/lib/utils";

const FORMATS = { text: "Текст", photo: "Фото", video: "Видео" };
const KINDS = { reference: "Референс", idea: "Идея", saved: "Коллекция" };
const QUALITY = { high: "Высокое", medium: "Среднее", low: "Низкое" };

function metric(value: number | null, digits = 1) {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function coverCopy(item: LibraryRegistryItem) {
  const text = item.text.trim();
  const firstLine = text.split(/\r?\n/u)[0];
  const title = item.idea?.topic?.trim() || firstLine || "Материал без текста";
  return {
    title: title.length > 160 ? `${title.slice(0, 157)}…` : title,
    preview: title === firstLine && firstLine.length <= 160 ? text.slice(firstLine.length).trim() : text,
  };
}

export type LibraryFocusViewProps = {
  items: LibraryRegistryItem[];
  channelId: number;
  expanded: ReadonlySet<string>;
  formulaVersion: string | null;
  stateBusy: string | null;
  draftBusy: string | null;
  onToggleText: (item: LibraryRegistryItem) => void;
  onSave: (item: LibraryRegistryItem) => void;
  onStateChange: (item: LibraryRegistryItem, state: { rating?: number | null; viewed?: boolean }) => void;
  onDraft: (action: DraftBackedAppAction, item: LibraryRegistryItem) => void;
};

/** Presentation only: mutations and draft routing stay in LibraryRegistryView. */
export function LibraryFocusView({ items, channelId, expanded, formulaVersion, stateBusy, draftBusy, onToggleText, onSave, onStateChange, onDraft }: LibraryFocusViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const index = Math.max(0, items.findIndex((item) => item.id === selectedId));
  const item = items[index];
  const isExpanded = item ? expanded.has(item.id) : false;
  const root = useRef<HTMLElement>(null);
  const readButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const restoreTextFocus = useRef(false);

  useEffect(() => {
    if (!restoreTextFocus.current) return;
    restoreTextFocus.current = false;
    (isExpanded ? backButton : readButton).current?.focus({ preventScroll: true });
    root.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [isExpanded]);

  if (!item) return null;

  const { title, preview } = coverCopy(item);
  const contentId = libraryCardContentId("registry", item.id);
  const titleId = `${contentId}-title`;
  const primaryAction: DraftBackedAppAction = item.kind === "saved" ? "editor" : "create";
  const primaryKey = `${primaryAction}:${item.id}:channel:${channelId}`;
  const discussKey = `discuss:${item.id}:channel:${channelId}`;
  const stateDisabled = Boolean(stateBusy);

  function toggleText() {
    restoreTextFocus.current = true;
    onToggleText(item);
  }

  function moveTo(nextIndex: number) {
    const next = items[nextIndex];
    if (!next) return;
    setSelectedId(next.id);
    root.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  const metadata = (
    <div className="min-w-0 space-y-1 text-sm leading-relaxed [overflow-wrap:anywhere]">
      <p className="font-semibold">{KINDS[item.kind]} · {item.sourceTitle}</p>
      <p>{fmtAgo(item.postedAt)} · {FORMATS[item.format]} · {item.viewedAt ? "Просмотрено" : "Новое"}</p>
    </div>
  );

  return (
    <section ref={root} aria-label="Просмотр материалов" className="mx-auto w-full min-w-0 max-w-4xl scroll-mt-24 rounded-[28px] border border-line bg-surface-inset p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-4 pt-1">
        <p className="flex items-center gap-2 text-sm font-semibold text-text-2"><Sparkles className="h-4 w-4 text-info-text" aria-hidden /> В фокусе</p>
        <p className="text-sm text-text-3">{items.length === 1 ? "Один материал" : `Материал ${index + 1} из ${items.length}`}</p>
      </div>

      <article key={item.id} aria-labelledby={titleId} className="min-w-0">
        {isExpanded ? (
          <div className="rounded-[20px] bg-surface px-4 py-5 sm:px-8 sm:py-7">
            <Button ref={backButton} variant="ghost" size="sm" onClick={toggleText} aria-expanded="true" aria-controls={contentId} className="mb-6 rounded-full!">
              <ArrowLeft className="h-4 w-4" aria-hidden /> К обложке
            </Button>
            <div className="text-text-3">{metadata}</div>
            <h3 id={titleId} className="sr-only">{title}</h3>
            <div id={contentId} className="mx-auto mt-7 max-w-[66ch] whitespace-pre-wrap text-base leading-[1.75] text-text [overflow-wrap:anywhere]">
              {item.text}
            </div>
            <Button variant="ghost" size="sm" onClick={toggleText} aria-expanded="true" aria-controls={contentId} className="mt-5 rounded-full!">
              <ArrowUp className="h-4 w-4" aria-hidden /> Свернуть пост
            </Button>
          </div>
        ) : (
          <div className="rounded-[20px] px-5 py-6 text-white [background:var(--gradient-brand)] [--type-h3-size:clamp(1.75rem,4vw,2.75rem)] [--type-h3-weight:600] [--type-h3-color:white] [--type-h3-line:1.18] sm:px-8 sm:py-8">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div className="min-w-0 flex-1 basis-52">{metadata}</div>
              <div className="shrink-0 text-right">
                <p className="text-xs font-medium">Аналитическая оценка</p>
                <p className="mt-1 font-normal tabular-nums"><span className="text-4xl tracking-tight sm:text-5xl">{metric(item.analyticsScore, 1)}</span><span className="ml-1.5 text-sm">/ 100</span></p>
              </div>
            </div>
            <h3 id={titleId} className="mb-5 mt-9 max-w-[28ch] text-white [overflow-wrap:anywhere]">{title}</h3>
            {preview && <p className="mb-7 line-clamp-3 max-w-[65ch] whitespace-pre-wrap text-base leading-relaxed [overflow-wrap:anywhere]">{preview}</p>}
            <div className="mt-7 flex flex-wrap items-center justify-between gap-5">
              <button ref={readButton} type="button" onClick={toggleText} aria-expanded="false" aria-controls={contentId} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-white px-5 py-3 font-semibold text-brand-2 transition-colors hover:bg-white/90 focus-visible:outline-white! motion-reduce:transition-none">
                Читать полностью <ArrowUpRight className="h-4 w-4" aria-hidden />
              </button>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm tabular-nums">
                <span>Прирост {item.lift == null ? "—" : `×${metric(item.lift, 2)}`}</span>
                {item.views != null && <span className="inline-flex items-center gap-1.5"><Eye className="h-4 w-4" aria-hidden /> {fmtNum(item.views)} просмотров</span>}
              </div>
            </div>
            {item.isHit && <p className="mt-5 text-xs leading-relaxed">Лучшие 10% автора · прирост ≥ 5</p>}
            <div id={contentId} hidden>{item.text}</div>
          </div>
        )}

        <details className="group mt-4 rounded-[20px] bg-surface px-4 sm:px-6">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3 font-semibold text-text-2 [&::-webkit-details-marker]:hidden">
            Аналитика и ваша оценка
            <ChevronDown className="h-4 w-4 shrink-0 group-open:rotate-180" aria-hidden />
          </summary>
          <div className="pb-5">
            <dl className="grid grid-cols-2 gap-x-5 gap-y-6 py-5 sm:grid-cols-3">
              {[
                ["Оценка 0–100", metric(item.analyticsScore, 1)],
                ["Прирост", item.lift == null ? "—" : `×${metric(item.lift, 2)}`],
                ["Просмотры", item.views == null ? "—" : fmtNum(item.views)],
                ["Скорость", metric(item.velocity, 1)],
                ["Вовлечённость", item.erBayes == null ? "—" : `${(item.erBayes * 100).toFixed(2)}%`],
                ["Реакции", item.reactions == null ? "—" : fmtNum(item.reactions)],
                ["Отклонение", metric(item.velocityZ, 2)],
                ["Качество данных", item.dataQuality ? QUALITY[item.dataQuality] : "Не определено"],
                ["Зрелость данных", item.dataMaturity === "mature" ? "Данных достаточно" : item.dataMaturity === "collecting" ? "Данные накапливаются" : "Не определена"],
                ["Формат", FORMATS[item.format]],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0"><dt className="text-sm leading-relaxed text-text-3">{label}</dt><dd className="mt-1 text-base font-semibold tabular-nums text-text [overflow-wrap:anywhere]">{value}</dd></div>
              ))}
            </dl>
            {item.isHit && <p className="text-sm text-info-text">Лучшие 10% автора · прирост ≥ 5</p>}
            <details className="mt-4 border-y border-line py-1">
              <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-text-2">Как рассчитана оценка</summary>
              <p className="pb-2 text-sm leading-relaxed text-text-2">{item.explanation || "Недостаточно сопоставимых данных."}</p>
              <p className="pb-3 text-sm text-text-3">Версия формулы: {(item.formulaVersion || formulaVersion)?.match(/\d+(?:\.\d+)*/u)?.[0] || "текущая"}</p>
            </details>
            <fieldset className="mt-5">
              <legend className="text-text-2">Ваша оценка · отдельно от аналитической</legend>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[1, 2, 3, 4, 5].map((rating) => (
                  <button key={rating} type="button" aria-label={`Поставить оценку ${rating} из 5`} aria-pressed={item.userRating === rating} disabled={stateDisabled} onClick={() => onStateChange(item, { rating: item.userRating === rating ? null : rating })} className="grid h-11 w-11 place-items-center rounded-full text-text-3 hover:bg-info-soft hover:text-info-text disabled:opacity-45">
                    <Star className={cn("h-5 w-5", item.userRating != null && rating <= item.userRating && "fill-current text-info-text")} aria-hidden />
                  </button>
                ))}
              </div>
            </fieldset>
            <Button variant="ghost" size="sm" disabled={stateDisabled} onClick={() => onStateChange(item, { viewed: !item.viewedAt })} className="mt-3 rounded-full! whitespace-normal! text-left">
              {item.viewedAt ? <EyeOff className="h-4 w-4 shrink-0" aria-hidden /> : <Check className="h-4 w-4 shrink-0" aria-hidden />}
              {item.viewedAt ? "Сделать новым" : "Отметить просмотренным"}
            </Button>
          </div>
        </details>
      </article>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-4">
        <nav aria-label="Переход между материалами" className="flex items-center gap-3">
          <Button variant="secondary" size="icon" aria-label="Предыдущий материал" disabled={index === 0} onClick={() => moveTo(index - 1)} className="rounded-full!"><ArrowLeft className="h-4 w-4" aria-hidden /></Button>
          <span className="min-w-[5ch] text-center text-sm tabular-nums text-text-2" aria-live="polite" aria-atomic="true">{index + 1} / {items.length}</span>
          <Button variant="secondary" size="icon" aria-label="Следующий материал" disabled={index === items.length - 1} onClick={() => moveTo(index + 1)} className="rounded-full!"><ArrowRight className="h-4 w-4" aria-hidden /></Button>
        </nav>
        {item.kind === "reference" && (
          <Button variant="secondary" size="sm" disabled={item.saved || stateDisabled} loading={stateBusy === `save:${item.id}`} onClick={() => onSave(item)} className="rounded-full!">
            {stateBusy !== `save:${item.id}` && <Bookmark className={cn("h-4 w-4", item.saved && "fill-current")} aria-hidden />}
            {item.saved ? "Сохранено" : "Сохранить"}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-1 pt-4 pb-1">
        <Button variant="primary" size="sm" loading={draftBusy === primaryKey} disabled={Boolean(draftBusy) && draftBusy !== primaryKey} onClick={() => onDraft(primaryAction, item)} className="rounded-full! whitespace-normal! text-left">
          {draftBusy !== primaryKey && <Sparkles className="h-4 w-4 shrink-0" aria-hidden />}
          {item.kind === "saved" ? "Открыть в редакторе" : "Создать публикацию"}
        </Button>
        <Button variant="ghost" size="sm" loading={draftBusy === discussKey} disabled={Boolean(draftBusy) && draftBusy !== discussKey} onClick={() => onDraft("discuss", item)} className="rounded-full! whitespace-normal! text-left">
          {draftBusy !== discussKey && <MessageSquareText className="h-4 w-4 shrink-0" aria-hidden />} Обсудить с Авророй
        </Button>
        {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm font-semibold text-text-2 hover:bg-surface"><ExternalLink className="h-4 w-4 shrink-0" aria-hidden />Открыть оригинал</a>}
      </div>
    </section>
  );
}

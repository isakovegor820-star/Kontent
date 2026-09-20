"use client";

import { useId, useRef, useState } from "react";
import { ArrowUpRight, Bookmark, Check, ExternalLink, Eye, Heart, MessageSquareText, Sparkles, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import { libraryCardContentId } from "./library-card-text";
import type { DraftBackedAppAction } from "@/lib/app-routes";
import type { LibraryRegistryItem } from "@/lib/library-filters";
import { cn, fmtAgo, fmtNum } from "@/lib/utils";
import styles from "./library-reading-feed.module.css";

type Props = {
  items: LibraryRegistryItem[];
  channelId: number;
  stateBusy: string | null;
  draftBusy: string | null;
  onSave: (item: LibraryRegistryItem) => void;
  onStateChange: (item: LibraryRegistryItem, state: { rating?: number | null; viewed?: boolean }) => void;
  onDraft: (action: DraftBackedAppAction, item: LibraryRegistryItem) => void;
};

export function libraryReadingCopy(item: LibraryRegistryItem) {
  const text = item.text.trim();
  const firstLine = text.split(/\r?\n/u)[0] || "Материал без текста";
  const heading = item.idea?.topic?.trim() || firstLine;
  const title = heading.length > 150 ? `${heading.slice(0, 147).trimEnd()}…` : heading;
  // A long opening paragraph stays complete in the reader, without repeating it in the preview.
  const rest = text.startsWith(heading) ? text.slice(heading.length).trim() : text;
  return { title, preview: rest || (heading.length > 150 ? heading.slice(147).trimStart() : "") };
}

const decimal = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
function number(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : decimal.format(value);
}

function Metrics({ item }: { item: LibraryRegistryItem }) {
  return (
    <dl className={styles.metrics} aria-label={item.kind === "idea" ? "Статистика исходной публикации" : "Статистика публикации"}>
      <div><dt><Eye aria-hidden /> Просмотры</dt><dd>{item.views == null ? "—" : fmtNum(item.views)}</dd></div>
      <div><dt><Heart aria-hidden /> Реакции</dt><dd>{item.reactions == null ? "—" : fmtNum(item.reactions)}</dd></div>
      <div title="Отношение просмотров к медиане сопоставимых публикаций этого источника. Это сравнение, а не рост за период."><dt>К обычному уровню</dt><dd>{item.lift == null ? "—" : `×${number(item.lift)}`}</dd></div>
    </dl>
  );
}

function Metadata({ item }: { item: LibraryRegistryItem }) {
  return (
    <div className={styles.metadata}>
      <span className={styles.source} title={item.sourceTitle}>{item.sourceTitle}</span>
      <time dateTime={item.postedAt} title={new Date(item.postedAt).toLocaleString("ru-RU")}>{fmtAgo(item.postedAt)}</time>
      {!item.viewedAt && <span className={styles.unread}>Новое</span>}
    </div>
  );
}

function SaveButton({ item, stateBusy, onSave }: Pick<Props, "stateBusy" | "onSave"> & { item: LibraryRegistryItem }) {
  if (item.kind !== "reference") return null;
  return (
    <Button variant="ghost" size="icon" className={styles.save} disabled={item.saved || Boolean(stateBusy)} loading={stateBusy === `save:${item.id}`} onClick={() => onSave(item)} aria-label={item.saved ? "Материал сохранён" : "Сохранить материал"} title={item.saved ? "Сохранено в коллекцию" : "Сохранить в коллекцию"}>
      <Bookmark className={cn("h-4 w-4", item.saved && "fill-current")} aria-hidden />
    </Button>
  );
}

function ReadingDialog({ item, onClose, ...props }: Omit<Props, "items"> & { item: LibraryRegistryItem; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const { overlayRef, dialogRef, onKeyDown } = useModalFocus({ open: true, initialFocusRef: closeRef, onEscape: onClose });
  const { title } = libraryReadingCopy(item);
  const action = item.kind === "saved" ? "editor" : "create";
  const primaryKey = `${action}:${item.id}:channel:${props.channelId}`;
  const discussKey = `discuss:${item.id}:channel:${props.channelId}`;
  return (
    <div ref={overlayRef} className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown} className={styles.dialog}>
        <header className={styles.readerHeader}>
          <span>{item.kind === "idea" ? "Идея Авроры" : item.kind === "saved" ? "Из коллекции" : "Публикация источника"}</span>
          <Button ref={closeRef} variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть материал"><X className="h-5 w-5" aria-hidden /></Button>
        </header>
        <div className={styles.readerBody}>
          <Metadata item={item} />
          <h2 id={titleId} className="sr-only">{title}</h2>
          <div id={`${libraryCardContentId("registry", item.id)}-full`} className={styles.fullText}>{item.text}</div>
          {item.kind === "idea" && <p className={styles.caption}>Показатели относятся к исходной публикации, на основе которой подготовлена идея.</p>}
          <Metrics item={item} />
          <p className={styles.caption}>×1 — обычный уровень просмотров источника, ×2 — примерно вдвое выше. Сравниваются публикации одного формата и периода. «—» означает, что данных пока нет.</p>
          <details className={styles.details}>
            <summary>Подробная аналитика и моя оценка</summary>
            <dl className={styles.analytics}>
              <div><dt>Аналитическая оценка</dt><dd>{number(item.analyticsScore)} / 100</dd></div>
              <div><dt>Вовлечённость</dt><dd>{item.erBayes == null ? "—" : `${number(item.erBayes * 100)}%`}</dd></div>
              <div><dt>Скорость просмотров</dt><dd>{number(item.velocity)}</dd></div>
            </dl>
            <p className={styles.caption}>{item.explanation || "Недостаточно сопоставимых данных для оценки."}</p>
            <fieldset className={styles.rating}>
              <legend>Моя оценка</legend>
              <p className={styles.caption}>Личная отметка от 1 до 5. Не влияет на аналитическую оценку.</p>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {[1, 2, 3, 4, 5].map((rating) => <Button key={rating} variant="ghost" size="icon" disabled={Boolean(props.stateBusy)} aria-label={`Поставить оценку ${rating} из 5`} aria-pressed={item.userRating === rating} onClick={() => props.onStateChange(item, { rating: item.userRating === rating ? null : rating })}><Star className={cn("h-4 w-4", item.userRating != null && rating <= item.userRating && "fill-current text-fire-text")} aria-hidden /></Button>)}
              </div>
            </fieldset>
          </details>
          <div className={styles.readerLinks}>
            <Button variant="ghost" size="sm" disabled={Boolean(props.draftBusy)} loading={props.draftBusy === discussKey} onClick={() => props.onDraft("discuss", item)}><MessageSquareText className="h-4 w-4" aria-hidden /> Обсудить с Авророй</Button>
            {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden /> Открыть оригинал</a>}
            <Button variant="ghost" size="sm" disabled={Boolean(props.stateBusy)} onClick={() => props.onStateChange(item, { viewed: !item.viewedAt })}><Check className="h-4 w-4" aria-hidden />{item.viewedAt ? "Отметить непрочитанным" : "Отметить прочитанным"}</Button>
          </div>
        </div>
        <footer className={styles.readerFooter}>
          <Button variant="primary" size="sm" loading={props.draftBusy === primaryKey} disabled={Boolean(props.draftBusy)} onClick={() => props.onDraft(action, item)}><Sparkles className="h-4 w-4" aria-hidden />{item.kind === "saved" ? "Открыть в редакторе" : "Создать пост"}</Button>
          <SaveButton item={item} {...props} />
        </footer>
      </section>
    </div>
  );
}

export function LibraryReadingFeed({ items, ...props }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(20);
  const selected = items.find((item) => item.id === selectedId);
  function read(item: LibraryRegistryItem) {
    setSelectedId(item.id);
    if (!item.viewedAt) props.onStateChange(item, { viewed: true });
  }
  return (
    <>
      <div className={styles.grid} aria-label="Материалы для публикаций">
        {items.slice(0, visibleCount).map((item) => {
          const copy = libraryReadingCopy(item);
          const action = item.kind === "saved" ? "editor" : "create";
          const primaryKey = `${action}:${item.id}:channel:${props.channelId}`;
          return (
            <article key={item.id} className={styles.card} aria-labelledby={`heading-${item.id}`}>
              <Metadata item={item} />
              <span className={styles.kind}>{item.kind === "idea" ? "Идея Авроры" : item.kind === "saved" ? "Из коллекции" : "Публикация источника"}</span>
              <h3 id={`heading-${item.id}`} className={styles.title}><button type="button" onClick={() => read(item)}>{copy.title}</button></h3>
              <p id={libraryCardContentId("registry", item.id)} className={styles.preview}>{copy.preview}</p>
              <button type="button" className={styles.read} aria-haspopup="dialog" onClick={() => read(item)}>Читать полностью <ArrowUpRight aria-hidden /></button>
              {item.kind === "idea" && <p className={styles.caption}>Статистика исходной публикации</p>}
              <Metrics item={item} />
              <div className={styles.actions}>
                <Button variant="secondary" size="sm" className={styles.create} loading={props.draftBusy === primaryKey} disabled={Boolean(props.draftBusy)} onClick={() => props.onDraft(action, item)}><Sparkles className="h-4 w-4" aria-hidden />{item.kind === "saved" ? "Открыть в редакторе" : "Создать пост"}</Button>
                <SaveButton item={item} {...props} />
              </div>
            </article>
          );
        })}
      </div>
      {items.length > visibleCount && <div className={styles.more}><Button variant="secondary" onClick={() => setVisibleCount((current) => current + 20)}>Показать ещё</Button><span>Показано {Math.min(visibleCount, items.length)} из {items.length}</span></div>}
      {selected && <ReadingDialog item={selected} onClose={() => setSelectedId(null)} {...props} />}
    </>
  );
}

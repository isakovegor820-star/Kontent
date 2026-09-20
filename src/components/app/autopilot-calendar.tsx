"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Pencil, X } from "lucide-react";
import { Button, buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import { toTelegramHtml } from "@/lib/telegram-format.mjs";
import type { RichTextEntity } from "@/lib/rich-text.mjs";
import { cn } from "@/lib/utils";
import { localScheduleFieldsForInstant } from "@/lib/timezone-schedule";

export type AutopilotCalendarItem = {
  id: string;
  scheduledAt: string;
  title: string;
  text: string;
  media?: unknown;
  formatting?: RichTextEntity[];
  state: "review" | "scheduled" | "published" | "attention";
  statusLabel: string;
  planIndex?: number;
  postId?: number;
  scheduleRevision?: number;
  selectable: boolean;
  editable: boolean;
  issues: string[];
  publishedUrl?: string | null;
  returnView?: "week" | "month";
  returnAnchor?: string;
};
const TZ = "Europe/Moscow";
const dayKey = (date: Date | string) => localScheduleFieldsForInstant(date instanceof Date ? date.toISOString() : date, TZ).localDate;
const dateForKey = (key: string) => new Date(`${key}T12:00:00Z`);
const shiftDay = (key: string, days: number) => { const d = dateForKey(key); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const monday = (key: string) => shiftDay(key, -((dateForKey(key).getUTCDay() + 6) % 7));
const fmt = (key: string, options: Intl.DateTimeFormatOptions) => dateForKey(key).toLocaleDateString("ru-RU", { ...options, timeZone: TZ });
const time = (value: string) => new Date(value).toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

function MediaPreview({ media }: { media: unknown }) {
  if (!media || typeof media !== "object") return null;
  const record = media as Record<string, unknown>;
  const entries = Array.isArray(record.items) ? record.items : [record];
  return <div className="grid gap-3">{entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") return null;
    const asset = entry as Record<string, unknown>;
    const url = typeof asset.url === "string" ? asset.url : null;
    if (!url || !/^(https?:\/\/|\/)/u.test(url)) return null;
    return asset.kind === "video" || record.kind === "video"
      ? <video key={index} src={url} controls preload="metadata" className="max-h-80 w-full rounded-md" />
      : <Image key={index} src={url} alt={`Изображение поста ${index + 1}`} width={640} height={480} unoptimized className="max-h-80 w-full rounded-md object-contain" />;
  })}</div>;
}

function PostPanel({ item, busy, channelName, onClose, onEdit, onAdd, onReschedule }: {
  item: AutopilotCalendarItem; busy: boolean; channelName: string;
  onClose: () => void; onEdit: () => void; onAdd: () => void;
  onReschedule: (date: string, time: string) => Promise<boolean>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const { overlayRef, dialogRef, onKeyDown } = useModalFocus({ open: true, initialFocusRef: closeRef, onEscape: onClose, busy });
  const schedule = localScheduleFieldsForInstant(item.scheduledAt, TZ);
  const [editingDate, setEditingDate] = useState(false);
  const [date, setDate] = useState(schedule.localDate);
  const [localTime, setLocalTime] = useState(schedule.localTime.slice(0, 5));
  return createPortal(
    <div ref={overlayRef} className="fixed inset-0 z-[80] flex justify-end bg-black/40" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="autopilot-post-title" tabIndex={-1} onKeyDown={onKeyDown}
        className="flex h-dvh w-full max-w-xl flex-col bg-surface shadow-lift">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <p className="text-[13px] font-semibold text-text-2">{channelName} · {item.statusLabel}</p>
          <Button ref={closeRef} variant="ghost" size="icon" disabled={busy} onClick={onClose} aria-label="Закрыть просмотр поста"><X className="h-5 w-5" /></Button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto overscroll-contain p-5 sm:p-6">
          <h3 id="autopilot-post-title" className="text-xl font-bold text-text">{item.title}</h3>
          <p className="text-sm text-text-2">{fmt(schedule.localDate, { day: "numeric", month: "long", year: "numeric" })}, {time(item.scheduledAt)} · МСК</p>
          <MediaPreview media={item.media} />
          <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-text [&_a]:text-brand [&_a]:underline" dangerouslySetInnerHTML={{ __html: toTelegramHtml(item.text, item.formatting) }} />
          {item.issues.length > 0 && <div role="status" className="rounded-md bg-info-soft p-4 text-sm text-info-text">{item.issues.map((issue) => <p key={issue} className="mt-1 first:mt-0">{issue}</p>)}</div>}
          {item.editable && (
            <div className="rounded-md border border-line p-4">
              <Button variant="ghost" size="sm" onClick={() => setEditingDate(!editingDate)} disabled={busy} aria-expanded={editingDate}><CalendarDays className="h-4 w-4" />Изменить дату и время</Button>
              {editingDate && <form className="mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); void onReschedule(date, localTime).then((ok) => { if (ok) setEditingDate(false); }); }}>
                <div className="flex flex-wrap gap-3">
                  <label className="min-w-0 flex-1 text-sm">Дата<input type="date" required value={date} disabled={busy} onChange={(event) => setDate(event.target.value)} className="mt-1 block min-h-11 w-full rounded-sm border border-line bg-surface p-2" /></label>
                  <label className="text-sm">Время, МСК<input type="time" required value={localTime} disabled={busy} onChange={(event) => setLocalTime(event.target.value)} className="mt-1 block min-h-11 w-full rounded-sm border border-line bg-surface p-2" /></label>
                </div>
                <Button type="submit" variant="primary" size="sm" loading={busy}>Сохранить время</Button>
              </form>}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {item.editable && <Button variant="outline" disabled={busy} onClick={onEdit}><Pencil className="h-4 w-4" />Редактировать</Button>}
          {item.selectable && <Button variant="primary" disabled={busy} onClick={onAdd}>Добавить в основной календарь</Button>}
          {item.publishedUrl && <a href={item.publishedUrl} target="_blank" rel="noopener noreferrer" className={buttonClassName({ variant: "outline" })}>Открыть публикацию</a>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

type SavedView = { expanded: boolean; view: "week" | "month"; anchor: string; openId: string | null };
function initialView(storageKey: string, items: AutopilotCalendarItem[], returnItemId?: string | null): SavedView {
  const today = dayKey(new Date());
  let state: SavedView = { expanded: false, view: "week", anchor: dayKey(items.find((item) => dayKey(item.scheduledAt) >= today)?.scheduledAt ?? new Date()), openId: null };
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (saved && /^\d{4}-\d{2}-\d{2}$/u.test(saved.anchor) && Number.isFinite(Date.parse(saved.anchor))) state = { expanded: Boolean(saved.expanded), view: saved.view === "month" ? "month" : "week", anchor: saved.anchor, openId: typeof saved.openId === "string" ? saved.openId : null };
  } catch { /* Session state is optional. */ }
  if (returnItemId && typeof window !== "undefined") {
    const query = new URLSearchParams(window.location.search);
    const view = query.get("autopilotView"); const anchor = query.get("autopilotAnchor");
    if ((view === "month" || view === "week") && anchor && /^\d{4}-\d{2}-\d{2}$/u.test(anchor) && Number.isFinite(Date.parse(anchor))) state = { ...state, view, anchor };
  }
  const returned = returnItemId ? items.find((item) => item.id === returnItemId) : null;
  return returnItemId ? { ...state, expanded: true, openId: returned?.id ?? returnItemId } : state;
}

export function AutopilotCalendar({ items, selected, busy, storageKey, channelName, returnItemId, onSelect, onSelectAll, onAdd, onEdit, onReschedule }: {
  items: AutopilotCalendarItem[]; selected: Set<number>; busy: boolean; storageKey: string; channelName: string; returnItemId?: string | null;
  onSelect: (index: number) => void; onSelectAll: (indexes: number[]) => void; onAdd: (indexes?: number[]) => void;
  onEdit: (item: AutopilotCalendarItem) => void;
  onReschedule: (item: AutopilotCalendarItem, date: string, time: string) => Promise<boolean>;
}) {
  const [state, setState] = useState(() => initialView(storageKey, items, returnItemId));
  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* View state is optional. */ } }, [storageKey, state]);
  const setOpenId = (openId: string | null) => setState((current) => ({ ...current, openId }));
  const selectedItem = items.find((item) => item.id === state.openId);
  const selectable = items.filter((item) => item.selectable && item.planIndex != null);
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.planIndex!));
  const selectedCount = selectable.filter((item) => selected.has(item.planIndex!)).length;
  const month = state.expanded && state.view === "month";
  const first = month ? monday(state.anchor.slice(0, 8) + "01") : monday(state.anchor);
  const days = Array.from({ length: month ? 42 : 7 }, (_, i) => shiftDay(first, i));
  const shift = (direction: number) => setState((current) => {
    const d = dateForKey(current.anchor);
    if (month) { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + direction); }
    else d.setUTCDate(d.getUTCDate() + direction * 7);
    return { ...current, anchor: d.toISOString().slice(0, 10) };
  });
  return (
    <Card as="section" className="overflow-hidden p-0" aria-labelledby="autopilot-schedule-title">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <button type="button" id="autopilot-schedule-title" aria-expanded={state.expanded} aria-controls="autopilot-calendar-content" onClick={() => setState({ ...state, expanded: !state.expanded })} className="flex min-h-11 items-center gap-2 rounded-sm text-left text-[17px] font-bold focus-visible:outline-2 focus-visible:outline-brand">
          <CalendarDays className="h-5 w-5 text-brand" />Расписание публикаций<ChevronDown className={cn("h-4 w-4 transition-transform", state.expanded && "rotate-180")} />
        </button>
        <p className="text-[13px] text-text-3">{items.filter((item) => item.state === "review").length} ждут добавления · {items.filter((item) => item.state === "scheduled").length} в календаре</p>
      </div>
      <div id="autopilot-calendar-content">
        <p className="px-4 text-[13px] leading-relaxed text-text-2 sm:px-5">Это план автопилота. Выбери проверенные посты и добавь их в основной календарь. Во всех режимах публикация планируется только после твоего подтверждения.</p>
        {state.expanded && <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-5">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Предыдущий период" onClick={() => shift(-1)}><ChevronLeft className="h-5 w-5" /></Button>
            <p aria-live="polite" className="min-w-32 text-center text-sm font-semibold capitalize">{month ? fmt(state.anchor, { month: "long", year: "numeric" }) : `${fmt(days[0], { day: "numeric", month: "short" })} — ${fmt(days[6], { day: "numeric", month: "short" })}`}</p>
            <Button variant="ghost" size="icon" aria-label="Следующий период" onClick={() => shift(1)}><ChevronRight className="h-5 w-5" /></Button>
            <Button variant="ghost" size="sm" onClick={() => setState({ ...state, anchor: dayKey(new Date()) })}>Сегодня</Button>
          </div>
          <div className="flex gap-1" role="group" aria-label="Вид календаря">
            {([['week', 'Неделя'], ['month', 'Месяц']] as const).map(([view, label]) => <Button key={view} variant={state.view === view ? "primary" : "ghost"} size="sm" aria-pressed={state.view === view} onClick={() => setState({ ...state, view })}>{label}</Button>)}
          </div>
        </div>}
        <div className={cn("mt-4 grid grid-cols-1 gap-px bg-line md:grid-cols-7", !state.expanded && "max-h-[26rem] overflow-y-auto md:max-h-none")}>
          {days.map((key) => {
            const entries = items.filter((item) => dayKey(item.scheduledAt) === key);
            return <div key={key} className={cn("min-w-0 bg-surface p-3", month ? "md:min-h-32" : "md:min-h-44", month && key.slice(0, 7) !== state.anchor.slice(0, 7) && "bg-surface-inset", entries.length === 0 && month && "hidden md:block")}>
              <p className={cn("mb-2 text-[13px] font-semibold capitalize", key === dayKey(new Date()) ? "text-brand" : "text-text-3")}>{fmt(key, { weekday: "short", day: "numeric" })}</p>
              {entries.length === 0 ? <p className="text-xs text-text-3">Нет постов</p> : <div className="space-y-2">{entries.map((item) => <div key={item.id} className={cn("rounded-sm border p-2", item.state === "review" ? "border-brand/20 bg-info-soft" : item.state === "attention" ? "border-danger/20 bg-danger-soft" : "border-line bg-surface-inset")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold tabular-nums">{time(item.scheduledAt)}</span>
                  {item.selectable && item.planIndex != null && <input type="checkbox" checked={selected.has(item.planIndex)} disabled={busy} onChange={() => onSelect(item.planIndex!)} aria-label={`Выбрать пост: ${item.title}`} className="h-5 w-5 accent-brand" />}
                </div>
                <button type="button" onClick={() => setOpenId(item.id)} className="mt-1 block min-h-11 w-full rounded-sm text-left focus-visible:outline-2 focus-visible:outline-brand" aria-label={`Открыть пост: ${item.title}`}>
                  <span className="line-clamp-3 text-[13px] leading-snug text-text">{item.title}</span>
                  <span className="mt-2 block text-[11px] leading-snug text-text-2">{item.statusLabel}</span>
                </button>
              </div>)}</div>}
            </div>;
          })}
        </div>
        {items.length > 0 && !items.some((item) => days.includes(dayKey(item.scheduledAt))) && <p role="status" className="px-5 py-4 text-sm text-text-2">В этом периоде нет постов. Переключи неделю или месяц.</p>}
        {items.length === 0 && <p role="status" className="px-5 py-4 text-sm text-text-2">План пока пуст. После сборки посты появятся здесь для проверки.</p>}
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
          {state.expanded ? <>
            <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5 accent-brand" checked={allSelected} disabled={busy || selectable.length === 0} onChange={() => onSelectAll(allSelected ? [] : selectable.map((item) => item.planIndex!))} />Выбрать все готовые ({selectable.length})</label>
            <Button variant="primary" disabled={busy || selectedCount === 0} loading={busy} onClick={() => onAdd()}><Check className="h-4 w-4" />Добавить в основной календарь · {selectedCount}</Button>
          </> : <Button variant="outline" size="sm" onClick={() => setState({ ...state, expanded: true })}>Развернуть календарь</Button>}
          {items.some((item) => item.postId) && <Link href="/app/calendar" className="text-[13px] font-medium text-brand underline underline-offset-4">Открыть основной календарь</Link>}
        </div>
      </div>
      {selectedItem && <PostPanel key={selectedItem.id} item={selectedItem} busy={busy} channelName={channelName} onClose={() => setOpenId(null)} onEdit={() => onEdit({ ...selectedItem, returnView: state.view, returnAnchor: state.anchor })} onAdd={() => { setOpenId(null); onAdd([selectedItem.planIndex!]); }} onReschedule={(date, localTime) => onReschedule(selectedItem, date, localTime)} />}
    </Card>
  );
}

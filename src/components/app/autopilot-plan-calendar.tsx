"use client";
// Карточка плана автопилота внутри основного календаря.
//
// Пост автопилота до подтверждения — не публикация: строки в posts нет, очередь BullMQ
// не тронута. Поэтому карточка намеренно отличается от обычной (пунктир, метка «План
// автопилота») и ведёт в диалог, где человек видит полный текст, дату и замечания и
// осознанно нажимает «Добавить в основной календарь».

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Check, Pencil, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import { localScheduleFieldsForInstant } from "@/lib/timezone-schedule";
import { cn, fmtDateTime, fmtTime } from "@/lib/utils";
import type { AutopilotCalendarPlanItem } from "@/lib/autopilot-calendar-plan.mjs";

const TONE: Record<AutopilotCalendarPlanItem["state"], string> = {
  ready: "text-brand",
  expired: "text-fire-text",
  blocked: "text-text-3",
};

const MARKER: Record<AutopilotCalendarPlanItem["state"], string> = {
  ready: "border-brand/45 bg-brand/5 hover:border-brand/70 hover:bg-brand/10",
  expired: "border-fire/40 bg-fire-soft hover:border-fire/60",
  blocked: "border-line bg-surface-inset hover:border-text-3/40",
};

function planTitle(item: AutopilotCalendarPlanItem) {
  const title = item.topic.trim();
  if (title) return title;
  const line = item.text.split("\n").find((entry) => entry.trim()) ?? "";
  return line.trim().slice(0, 120) || "Пост автопилота";
}

/** Компактная карточка для сетки дня и списка. */
export function AutopilotPlanCard({
  item,
  calendarTimezone,
  onOpen,
  className,
}: {
  item: AutopilotCalendarPlanItem;
  calendarTimezone: string;
  onOpen: () => void;
  className?: string;
}) {
  const title = planTitle(item);
  return (
    <button
      type="button"
      data-autopilot-plan-card={item.key}
      onClick={onOpen}
      aria-label={`План автопилота: ${title}. ${item.statusLabel}. Открыть карточку`}
      className={cn(
        "flex min-h-11 w-full cursor-pointer flex-col gap-1 rounded-sm border border-dashed p-2 text-left",
        "transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        MARKER[item.state],
        className,
      )}
    >
      <span className="flex items-center gap-1 whitespace-nowrap text-[10px] font-bold uppercase tracking-wide text-brand">
        <Sparkles className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
        План автопилота
      </span>
      <span className="nums text-[12px] font-bold text-text-2 tabular-nums">
        {fmtTime(item.scheduledAt, calendarTimezone)}
      </span>
      <span className="line-clamp-3 text-[13px] font-semibold leading-snug text-text">{title}</span>
      <span className={cn("text-[11px] font-semibold", TONE[item.state])}>{item.statusLabel}</span>
    </button>
  );
}

/** Диалог подтверждения: показать ровно то, что уйдёт в календарь. */
export function AutopilotPlanDialog({
  item,
  busy,
  calendarTimezone,
  onClose,
  onAdd,
  onReschedule,
}: {
  item: AutopilotCalendarPlanItem;
  busy: boolean;
  calendarTimezone: string;
  onClose: () => void;
  onAdd: () => void;
  onReschedule: (localDate: string, localTime: string) => Promise<boolean>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const { overlayRef, dialogRef, onKeyDown } = useModalFocus({
    open: true,
    initialFocusRef: closeRef,
    onEscape: onClose,
    busy,
  });
  const schedule = localScheduleFieldsForInstant(item.scheduledAt, calendarTimezone);
  const [editingTime, setEditingTime] = useState(false);
  const [date, setDate] = useState(schedule.localDate);
  const [time, setTime] = useState(schedule.localTime.slice(0, 5));
  const title = planTitle(item);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[80] flex justify-end bg-black/40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="autopilot-plan-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex h-dvh w-full max-w-xl flex-col bg-surface shadow-lift"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <p className="text-[13px] font-semibold text-text-2">
            {item.channelTitle ?? "Канал"} · {item.statusLabel}
          </p>
          <Button ref={closeRef} variant="ghost" size="icon" disabled={busy} onClick={onClose} aria-label="Закрыть карточку плана">
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto overscroll-contain p-5 sm:p-6">
          <div className="rounded-sm border border-dashed border-brand/45 bg-brand/5 p-3 text-[13px] leading-relaxed text-text-2">
            Это план автопилота на {fmtDateTime(item.scheduledAt, calendarTimezone)}. Публикация появится
            в основном календаре и уйдёт в канал только после твоего подтверждения.
          </div>
          <h3 id="autopilot-plan-title" className="text-xl font-bold text-text">{title}</h3>
          <p className="nums text-sm text-text-2">{fmtDateTime(item.scheduledAt, calendarTimezone)}</p>
          <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-text">{item.text}</div>
          {item.issues.length > 0 && (
            <div role="status" className="rounded-md bg-info-soft p-4 text-sm text-info-text">
              {item.issues.map((issue) => <p key={issue} className="mt-1 first:mt-0">{issue}</p>)}
            </div>
          )}
          {item.editable && (
            <div className="rounded-md border border-line p-4">
              <Button variant="ghost" size="sm" disabled={busy} aria-expanded={editingTime} onClick={() => setEditingTime((value) => !value)}>
                <Pencil className="h-4 w-4" aria-hidden />Изменить дату и время
              </Button>
              {editingTime && (
                <form
                  className="mt-3 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onReschedule(date, time).then((ok) => { if (ok) setEditingTime(false); });
                  }}
                >
                  <div className="flex flex-wrap gap-3">
                    <label className="min-w-0 flex-1 text-sm">
                      Дата
                      <input type="date" required value={date} disabled={busy} onChange={(event) => setDate(event.target.value)} className="mt-1 block min-h-11 w-full rounded-sm border border-line bg-surface p-2" />
                    </label>
                    <label className="text-sm">
                      Время
                      <input type="time" required value={time} disabled={busy} onChange={(event) => setTime(event.target.value)} className="mt-1 block min-h-11 w-full rounded-sm border border-line bg-surface p-2" />
                    </label>
                  </div>
                  <p className="text-[12px] text-text-3">Часовой пояс проекта: {calendarTimezone}.</p>
                  <Button type="submit" variant="primary" size="sm" loading={busy}>Сохранить время</Button>
                </form>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Button variant="primary" disabled={busy || !item.selectable} loading={busy} onClick={onAdd}>
            <Check className="h-4 w-4" aria-hidden />Добавить в основной календарь
          </Button>
          <a
            href={`/app/autopilot?${new URLSearchParams({
              ...(item.channelId ? { channel: String(item.channelId) } : {}),
              plan: String(item.planId),
              item: String(item.index),
            }).toString()}`}
            className="inline-flex min-h-11 items-center gap-1 rounded-sm px-3 text-[13px] font-semibold text-brand underline underline-offset-4"
          >
            <CalendarDays className="h-4 w-4" aria-hidden />Открыть в автопилоте
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}

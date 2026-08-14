"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarClock, Pencil, Trash2 } from "lucide-react";

import { PublicationFollowupSection } from "@/components/app/publication-followup-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { BodyText, H2, H3, HelperText, SecondaryText } from "@/components/ui/typography";
import { fmtDateTime } from "@/lib/utils";
import {
  inspectLocalSchedule,
  localScheduleFieldsForInstant,
  resolveLocalSchedule,
  type ScheduleDisambiguation,
} from "@/lib/timezone-schedule";

export type PublicationActionTarget = {
  operationId: number;
  operationStatus: string;
  postStatus: string;
  scheduleRevision: number;
  scheduledAt: string;
  timezone: string;
  scheduledOffset: string | null;
  scheduleDisambiguation: ScheduleDisambiguation;
  text: string;
};

export type PublicationRescheduleInput = ReturnType<typeof resolveLocalSchedule>;

function localDateTimeValue(target: PublicationActionTarget | null) {
  if (!target) return "";
  try {
    const local = localScheduleFieldsForInstant(target.scheduledAt, target.timezone);
    return `${local.localDate}T${local.localTime}`;
  } catch {
    return "";
  }
}

export function PublicationActionsDialog({
  target,
  busy,
  onClose,
  onEdit,
  onOpenReviewDraft,
  onCancel,
  onReschedule,
  canManageSchedule,
}: {
  target: PublicationActionTarget | null;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  onOpenReviewDraft: (draftId: number) => void;
  onCancel: () => void;
  onReschedule: (schedule: PublicationRescheduleInput) => void;
  canManageSchedule: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [localDateTime, setLocalDateTime] = useState(() =>
    localDateTimeValue(target),
  );
  const [disambiguation, setDisambiguation] = useState<ScheduleDisambiguation>(
    target?.scheduleDisambiguation ?? "reject",
  );
  const [confirmCancel, setConfirmCancel] = useState(false);

  const scheduleInspection = useMemo(() => {
    const [localDate = "", localTime = ""] = localDateTime.split("T");
    if (!localDate || !localTime || !target) return null;
    return inspectLocalSchedule({ localDate, localTime, timezone: target.timezone });
  }, [localDateTime, target]);

  useEffect(() => {
    if (!target) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = requestAnimationFrame(() => (firstActionRef.current ?? dialogRef.current)?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, [target]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!target || !dialog) return;
    const inerted: Array<{ element: HTMLElement; previous: boolean }> = [];
    let current: HTMLElement = dialog;
    while (current.parentElement) {
      const parent = current.parentElement;
      for (const sibling of parent.children) {
        if (sibling !== current && sibling instanceof HTMLElement) {
          inerted.push({ element: sibling, previous: sibling.hasAttribute("inert") });
          sibling.setAttribute("inert", "");
        }
      }
      if (parent === document.body) break;
      current = parent;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      for (const item of inerted) {
        if (!item.previous) item.element.removeAttribute("inert");
      }
      document.body.style.overflow = previousOverflow;
    };
  }, [target]);

  if (!target) return null;
  const cancelled = target.operationStatus === "cancelled";
  const inProgress = target.postStatus === "publishing";
  const publicationSettled = ["published", "published_unverified", "missing", "deleted_external"].includes(target.postStatus);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-md border-2 border-line bg-surface p-5 shadow-card"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (!busy) onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
            "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
          ) ?? [])];
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <H2 id={titleId}>
          Управление публикацией
        </H2>
        <SecondaryText id={descriptionId} className="mt-2 text-pretty">
          {cancelled
            ? "Публикация отменена и больше не будет отправлена старой задачей. Её можно перенести или вернуть в редактор."
            : publicationSettled
              ? "Основная отправка завершена или требует внешней сверки. Дополнительные действия показаны отдельно ниже."
              : `Запланировано на ${fmtDateTime(target.scheduledAt)}. Действия применяются ко всем каналам этой публикации.`}
        </SecondaryText>
        <BodyText className="mt-3 line-clamp-3 rounded-sm bg-surface-2 p-3">
          {target.text}
        </BodyText>

        {!publicationSettled && canManageSchedule && <div className="mt-5 grid gap-3">
          <div className="rounded-sm border border-line p-3">
            <H3>Редактировать</H3>
            <SecondaryText className="mt-1 text-pretty">
              Аврора сначала отменит запланированную отправку, а затем создаст новый черновик с тем же текстом и медиа.
            </SecondaryText>
            <Button
              ref={firstActionRef}
              variant="soft"
              className="mt-3 w-full sm:w-auto"
              disabled={busy}
              onClick={onEdit}
            >
              <Pencil className="h-4 w-4" aria-hidden />
              Редактировать
            </Button>
          </div>

          <div className="rounded-sm border border-line p-3">
            <label htmlFor={`${titleId}-when`} className="type-label text-text">
              Перенести
            </label>
            <SecondaryText className="mt-1 text-pretty">
              Предыдущая дата перестанет действовать. Публикация отправится только в новое время.
            </SecondaryText>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <Input
                id={`${titleId}-when`}
                type="datetime-local"
                value={localDateTime}
                disabled={busy}
                onChange={(event) => {
                  setLocalDateTime(event.target.value);
                  setDisambiguation("reject");
                }}
                className="min-w-0 flex-1"
              />
              <Button
                variant="soft"
                disabled={
                  busy
                  || !localDateTime
                  || scheduleInspection == null
                  || ["invalid_timezone", "invalid_local_time", "nonexistent"].includes(scheduleInspection.kind)
                  || (scheduleInspection.kind === "ambiguous" && disambiguation === "reject")
                }
                onClick={() => {
                  const [localDate = "", localTime = ""] = localDateTime.split("T");
                  onReschedule(resolveLocalSchedule({
                    localDate,
                    localTime,
                    timezone: target.timezone,
                    disambiguation,
                  }));
                }}
              >
                <CalendarClock className="h-4 w-4" aria-hidden />
                Перенести
              </Button>
            </div>
            <HelperText className="mt-2 text-text-2">
              Часовой пояс: <span className="font-semibold text-text">{target.timezone}</span>
            </HelperText>
            {scheduleInspection?.kind === "nonexistent" && (
              <HelperText role="alert" tone="danger" className="mt-2 font-semibold">
                Такого местного времени нет из-за перехода на летнее время. Выберите другое.
              </HelperText>
            )}
            {scheduleInspection?.kind === "ambiguous" && (
              <fieldset className="mt-3 rounded-sm border border-line p-3">
                <legend className="type-label px-1 text-text">
                  Это время повторяется дважды
                </legend>
                <HelperText className="mb-2 text-text-2">
                  Выберите нужное смещение — сервер не станет угадывать.
                </HelperText>
                {(["earlier", "later"] as const).map((value) => (
                  <label key={value} className="type-label flex min-h-11 cursor-pointer items-center gap-2 text-text">
                    <input
                      type="radio"
                      name={`${titleId}-disambiguation`}
                      value={value}
                      checked={disambiguation === value}
                      disabled={busy}
                      onChange={() => setDisambiguation(value)}
                    />
                    {value === "earlier" ? "Первый вариант" : "Второй вариант"}
                    {` (${scheduleInspection[value].offset})`}
                  </label>
                ))}
              </fieldset>
            )}
          </div>

          {!cancelled && (
            <div className="rounded-sm border border-danger/30 bg-danger-soft p-3">
              {confirmCancel ? (
                <>
                  <H3 tone="danger">Точно отменить?</H3>
                  <HelperText tone="danger" className="mt-1">
                    Сервер остановит все ещё не начавшиеся назначения этой операции.
                  </HelperText>
                  <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button variant="ghost" disabled={busy} onClick={() => setConfirmCancel(false)}>
                      Оставить запланированной
                    </Button>
                    <Button variant="danger" loading={busy} onClick={onCancel}>
                      Отменить публикацию
                    </Button>
                  </div>
                </>
              ) : (
                <Button
                  variant="danger"
                  className="w-full sm:w-auto"
                  disabled={busy}
                  onClick={() => setConfirmCancel(true)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  Отменить публикацию
                </Button>
              )}
            </div>
          )}

          {inProgress && (
            <HelperText role="status" tone="warning" className="rounded-sm bg-fire-soft p-3 font-semibold">
              Публикация уже готовится к отправке. Если запрос в социальную сеть начался, Аврора сообщит, что отменить его уже нельзя.
            </HelperText>
          )}
        </div>}

        <PublicationFollowupSection
          operationId={target.operationId}
          onUpdateRequested={onOpenReviewDraft}
        />

        <div className="mt-5 flex justify-end">
          <Button variant="ghost" disabled={busy} onClick={onClose}>Закрыть</Button>
        </div>
      </div>
    </div>
  );
}

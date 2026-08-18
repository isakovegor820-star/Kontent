"use client";

import { useEffect, useId, useRef } from "react";
import { Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { BodyText, H2, H3, SecondaryText } from "@/components/ui/typography";
import { fmtDateTime } from "@/lib/utils";

export type CalendarDraftActionTarget = {
  id: number;
  version: number;
  text: string;
  scheduledAt?: string;
  timezone: string;
  statusLabel: string;
  networkLabels: string[];
  channelTitle?: string;
  focusAfterDeleteId?: string;
  focusAfterCancelId?: string;
};

export function CalendarDraftActionsDialog({
  target,
  canEdit,
  onClose,
  onEdit,
  onDelete,
}: {
  target: CalendarDraftActionTarget | null;
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const previewTitleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!target) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = requestAnimationFrame(() => {
      (canEdit ? primaryActionRef.current : closeRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      const previous = previousFocusRef.current;
      requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, [canEdit, target]);

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
  const networkLabel = target.networkLabels.length > 0
    ? target.networkLabels.join(", ")
    : "Канал не выбран";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 p-3 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overscroll-contain overflow-y-auto rounded-md border-2 border-line bg-surface p-5 shadow-card sm:max-h-[calc(100dvh-2rem)]"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
            "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
          ) ?? [])];
          if (!focusable.length) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <H2 id={titleId}>Черновик публикации</H2>
        <SecondaryText id={descriptionId} className="mt-2 max-w-[65ch] text-pretty">
          {canEdit
            ? "Проверь текст и выбери действие. Редактор откроется только по отдельной кнопке."
            : "Проверь текст и параметры. Изменение доступно участникам с правом редактирования."}
        </SecondaryText>

        <dl className="mt-4 grid gap-3 rounded-sm bg-surface-2 p-3 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="type-caption font-semibold text-text-3">Дата и время</dt>
            <dd className="type-body mt-1 text-text">
              {target.scheduledAt
                ? fmtDateTime(target.scheduledAt, target.timezone)
                : "Не выбраны"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="type-caption font-semibold text-text-3">Статус</dt>
            <dd className="mt-1"><Badge tone="neutral">{target.statusLabel}</Badge></dd>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <dt className="type-caption font-semibold text-text-3">Куда публикуем</dt>
            <dd className="type-body mt-1 break-words text-text">
              {target.channelTitle ? `${target.channelTitle} · ${networkLabel}` : networkLabel}
            </dd>
          </div>
        </dl>

        <section className="mt-5" aria-labelledby={previewTitleId}>
          <H3 id={previewTitleId}>Текст публикации</H3>
          <BodyText className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-sm bg-surface-2 p-3 text-pretty">
            {target.text.trim() || "Текст пока не добавлен."}
          </BodyText>
        </section>

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {canEdit && (
            <Button ref={primaryActionRef} variant="primary" className="w-full" onClick={onEdit}>
              <Pencil className="h-4 w-4" strokeWidth={2} aria-hidden />
              Редактировать черновик
            </Button>
          )}
          <Button ref={closeRef} variant="secondary" className="w-full" onClick={onClose}>
            Закрыть
          </Button>
          {canEdit && (
            <Button
              variant="danger"
              className="w-full sm:col-span-2"
              aria-haspopup="dialog"
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
              Удалить черновик
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

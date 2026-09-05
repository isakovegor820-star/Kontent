"use client";

import { useId, useRef } from "react";

import { Button, type ButtonVariant } from "@/components/ui/button";
import { useModalFocus } from "./use-modal-focus";
import { H2, SecondaryText } from "@/components/ui/typography";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Accessible confirmation with initial focus, Escape and a two-button focus trap. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Отмена",
  confirmVariant = "danger",
  busy = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { overlayRef, dialogRef, onKeyDown } = useModalFocus({ open, initialFocusRef: cancelRef, onEscape: onCancel, busy });

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-center justify-center overscroll-contain bg-black/45 p-4"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
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
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-md border-2 border-line bg-surface p-5 shadow-card"
        onKeyDown={onKeyDown}
      >
        <H2 id={titleId}>
          {title}
        </H2>
        <SecondaryText id={descriptionId} className="mt-2 text-pretty">
          {description}
        </SecondaryText>
        {error ? <p role="alert" className="mt-3 rounded-sm bg-danger-soft p-3 text-sm text-danger-text">{error}</p> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            loading={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useId, useRef } from "react";

import { Button } from "@/components/ui/button";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import { H2, SecondaryText } from "@/components/ui/typography";
import { plural } from "@/lib/utils";

const MSK = "Europe/Moscow";

export interface ScheduleCoverage {
  count: number;
  until: string | null;
}

function scheduleConflictDescription(coverage: ScheduleCoverage | null): string {
  const count = Number(coverage?.count) || 0;
  const until = coverage?.until
    ? new Date(coverage.until).toLocaleDateString("ru-RU", { timeZone: MSK, day: "numeric", month: "long" })
    : null;
  return `В календаре уже стоит ${count} ${plural(count, "пост", "поста", "постов")}`
    + (until ? ` — они запланированы до ${until}.` : ".")
    + " Реши, что делать с новым планом: он не должен незаметно заменить уже одобренное.";
}

// Выбор судьбы уже запланированных постов перед новой сборкой. Раньше любой новый
// план молча сносил старую неделю — этот диалог закрывает гонку до того, как случится.
export function ScheduleConflictDialog({
  open,
  coverage,
  busy,
  onContinue,
  onReplace,
  onClose,
}: {
  open: boolean;
  coverage: ScheduleCoverage | null;
  busy: boolean;
  onContinue: () => void;
  onReplace: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const continueRef = useRef<HTMLButtonElement>(null);
  const { overlayRef, dialogRef, onKeyDown } = useModalFocus({
    open,
    initialFocusRef: continueRef,
    onEscape: onClose,
    busy,
  });

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-center justify-center overscroll-contain bg-black/45 p-4"
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
        onKeyDown={onKeyDown}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-[560px] overflow-y-auto overscroll-contain rounded-md border-2 border-line bg-surface p-5 text-text shadow-card"
      >
        <H2 id={titleId}>В календаре уже есть посты автопилота</H2>
        <SecondaryText id={descriptionId} className="mt-2 text-pretty leading-relaxed">
          {scheduleConflictDescription(coverage)}
        </SecondaryText>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button
            ref={continueRef}
            type="button"
            disabled={busy}
            onClick={onContinue}
            className="rounded-md border border-line bg-surface-inset p-4 text-left transition-colors hover:border-brand disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="block text-[14px] font-bold text-text">Продолжить после запланированных</span>
            <span className="mt-1 block text-[12px] leading-relaxed text-text-3">
              Текущие посты останутся в календаре, новый план встанет после их конца.
            </span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onReplace}
            className="rounded-md border border-line p-4 text-left transition-colors hover:border-danger disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="block text-[14px] font-bold text-danger-text">Заменить запланированные</span>
            <span className="mt-1 block text-[12px] leading-relaxed text-text-3">
              Ещё не вышедшие посты будут отменены, новый план начнётся со завтра.
            </span>
          </button>
        </div>
        <div className="mt-5 flex justify-end border-t border-line pt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
        </div>
      </div>
    </div>
  );
}

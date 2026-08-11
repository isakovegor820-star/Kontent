"use client";

import { Check, RotateCcw, ShieldCheck } from "lucide-react";

import type { TypographySuggestion } from "@/lib/legal-typographer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<TypographySuggestion["kind"], string> = {
  brand_term: "Словарь бренда",
  dash: "Тире",
  quotes: "Кавычки",
  range: "Диапазон",
  spacing: "Пробел",
  unbreakable: "Перенос строки",
};

export function TypographerPanel({
  suggestions,
  selectedIds,
  onSelectionChange,
  onApplySelected,
  onApplySafe,
  onUndo,
  canUndo = false,
  busy = false,
}: {
  suggestions: readonly TypographySuggestion[];
  selectedIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  onApplySelected: () => void;
  onApplySafe: () => void;
  onUndo: () => void;
  canUndo?: boolean;
  busy?: boolean;
}) {
  const selected = new Set(selectedIds);
  const safeCount = suggestions.filter((item) => item.safe).length;
  const selectedCount = suggestions.filter((item) => selected.has(item.id)).length;

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectionChange(suggestions.filter((item) => next.has(item.id)).map((item) => item.id));
  };

  return (
    <section aria-labelledby="typographer-title" className="border-t border-line pt-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="typographer-title" className="text-lg font-bold tracking-[-0.015em] text-text">
            Типограф и словарь
          </h2>
          <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-text-2">
            Проверьте каждую замену. Ссылки, номера дел, статьи и точные цитаты остаются без изменений.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canUndo || busy}
          onClick={onUndo}
          className="self-start"
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          Отменить правки
        </Button>
      </div>

      <p className="sr-only" aria-live="polite">
        {suggestions.length === 0
          ? "Замены не найдены"
          : `Найдено замен: ${suggestions.length}. Выбрано: ${selectedCount}.`}
      </p>

      {suggestions.length === 0 ? (
        <div className="mt-5 flex min-h-20 items-center gap-3 border-y border-line py-4 text-sm text-text-2">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success-soft text-success-text">
            <Check className="h-5 w-5" aria-hidden />
          </span>
          <p><span className="font-semibold text-text">Текст оформлен.</span> Безопасных замен не найдено.</p>
        </div>
      ) : (
        <>
          <ul className="mt-5 divide-y divide-line border-y border-line" aria-label="Предлагаемые замены">
            {suggestions.map((item) => {
              const inputId = `typography-${item.id}`;
              return (
                <li key={item.id} className="grid min-w-0 gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <label htmlFor={inputId} className="group flex min-h-11 min-w-0 cursor-pointer items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center">
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={(event) => toggle(item.id, event.currentTarget.checked)}
                        className="h-5 w-5 rounded border-line-strong accent-brand focus-visible:ring-4 focus-visible:ring-brand/15"
                      />
                    </span>
                    <span className="min-w-0 pt-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-text">{KIND_LABEL[item.kind]}</span>
                        {item.safe ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-success-text">
                            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                            Безопасная правка
                          </span>
                        ) : (
                          <span className="text-xs font-semibold text-fire-text">Нужна проверка</span>
                        )}
                      </span>
                      <span className="mt-1 block break-words text-sm leading-relaxed text-text-2">
                        {item.explanation}
                      </span>
                    </span>
                  </label>
                  <div className="ml-14 grid min-w-0 gap-2 text-sm leading-relaxed sm:grid-cols-2 md:ml-0 md:w-[min(38rem,42vw)]">
                    <del className="min-w-0 break-words rounded-xs bg-danger-soft px-3 py-2 text-danger-text decoration-current">
                      <span className="sr-only">Было: </span>{item.before.replaceAll("\u00a0", " ")}
                    </del>
                    <ins className="min-w-0 break-words rounded-xs bg-success-soft px-3 py-2 text-success-text no-underline">
                      <span className="sr-only">Станет: </span>{item.after.replaceAll("\u00a0", " ")}
                    </ins>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="outline"
              disabled={safeCount === 0 || busy}
              onClick={onApplySafe}
              className="w-full sm:w-auto"
            >
              Применить безопасные
              <span className="tabular-nums" aria-hidden>({safeCount})</span>
            </Button>
            <Button
              type="button"
              variant="solid"
              loading={busy}
              disabled={selectedCount === 0}
              onClick={onApplySelected}
              className={cn("w-full sm:w-auto", selectedCount === 0 && "opacity-50")}
            >
              Применить выбранные
              <span className="tabular-nums" aria-hidden>({selectedCount})</span>
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

import type { Interpretation, ReportView } from "./types";

/**
 * Интерпретация Авроры — объяснение цифр, а не источник истины.
 * Прячем под капот детали модели: пользователю важен вывод, а не слот движка.
 */
export function InterpretationBlock({
  interpretation,
  status,
  compact = false,
  onRetry,
  retrying = false,
}: {
  interpretation: Interpretation | null;
  status: ReportView["interpretationStatus"];
  compact?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  if (!interpretation) {
    if (status === "pending") {
      return <p className="type-caption mt-3 text-text-3" role="status">Аврора объясняет результаты — это займёт минуту.</p>;
    }
    if (status === "failed") {
      return (
        <div className="mt-3">
          <p className="type-caption text-text-2">Объяснение не получилось. Цифры и рекомендации выше остаются в силе.</p>
          {onRetry && (
            <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={retrying} onClick={onRetry}>
              {retrying ? "Запускаем…" : "Повторить объяснение"}
            </Button>
          )}
        </div>
      );
    }
    return null;
  }

  return (
    <section
      className={cn("rounded-sm border border-brand/20 bg-info-soft/40 p-4", compact ? "mt-3" : "mt-5")}
      aria-label="Интерпретация Авроры"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">Интерпретация Авроры</Badge>
        <span className="type-caption text-text-3">объяснение к цифрам</span>
      </div>
      <p className="type-secondary mt-2 text-text">{interpretation.summary}</p>
      {interpretation.whatItMeans.length > 0 && (
        <ul className="mt-3 space-y-1">
          {interpretation.whatItMeans.map((item, index) => (
            <li key={index} className="type-caption text-text-2">• {item}</li>
          ))}
        </ul>
      )}
      {interpretation.startWith.length > 0 && (
        <div className="mt-3">
          <p className="type-label text-text">С чего начать</p>
          <ol className="mt-1 space-y-1.5">
            {interpretation.startWith.map((item, index) => (
              <li key={item.key} className="type-caption text-text-2">
                <span className="font-semibold text-text">{index + 1}. {item.title || item.key}</span>
                {item.priority && (
                  <Badge tone={item.priority === "P0" ? "danger" : item.priority === "P1" ? "fire" : "neutral"} className="ml-2">
                    {item.priority}
                  </Badge>
                )}
                <span className="block text-text-3">{item.why}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {interpretation.watchOut.length > 0 && (
        <p className="type-caption mt-3 text-text-3">Ограничения: {interpretation.watchOut.join(" ")}</p>
      )}
      <p className="type-caption mt-2 text-text-3">{interpretation.disclaimer}</p>
    </section>
  );
}

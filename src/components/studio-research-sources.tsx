"use client";

// Блок «Источники» под ответом Авроры в Студии контента.
//
// Компонент намеренно презентационный: он ничего не грузит и ничем не управляет,
// а получает готовую модель из lib/studio-research-view. Так чат остаётся с одним
// состоянием на сообщениях, а разбор заголовков проверяется тестом без DOM.

import { Globe } from "lucide-react";

import { Badge } from "@/components/ui/primitives";
import type { StudioResearchView } from "@/lib/studio-research-view";

/** Строка прогресса, пока текста ещё нет: заголовки пришли раньше тела стрима. */
export function StudioResearchProgress({ label }: { label: string }) {
  return (
    <p role="status" className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-text-2">
      <Globe className="h-3.5 w-3.5 shrink-0 text-brand motion-safe:animate-pulse" aria-hidden />
      {label}
    </p>
  );
}

/**
 * Источники под готовым ответом.
 *
 * null и status === "none" — Аврора в интернет не ходила: не показываем ничего.
 * findings === 0 — исследование было, но проверяемых фактов нет: говорим честно.
 */
export function StudioResearchSources({ research }: { research: StudioResearchView | null | undefined }) {
  if (!research || research.status === "none" || !research.used) return null;

  return (
    <section aria-label="Источники" className="mt-3 max-w-[72ch] rounded-sm border border-line bg-surface-inset px-3 py-2.5">
      <h3
        // Причина исследования — из заголовка ответа; это пояснение, а не отдельный текст.
        title={research.reason || undefined}
        className="flex flex-wrap items-center gap-2 text-[12px] font-bold tracking-wide text-text-2 uppercase"
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
        Источники
      </h3>

      {research.failed ? (
        <p className="mt-2 text-[12px] leading-relaxed text-text-2">
          Поиск в интернете не сработал: поисковик не ответил или страницы не открылись.
          Это сбой на нашей стороне, а не отсутствие данных в интернете — попробуйте повторить запрос или уточнить формулировку.
        </p>
      ) : research.nothingVerified ? (
        <p className="mt-2 text-[12px] leading-relaxed text-text-2">
          Аврора искала в открытом интернете, но не нашла подтверждаемых источников по этому запросу.
          Ответ не опирается на свежие публикации — проверьте факты перед публикацией.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {research.sources.map((source, index) => (
            <li key={`${source.url}:${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-words font-semibold text-brand underline decoration-brand/35 underline-offset-4 hover:decoration-brand"
              >
                {source.label}
              </a>
              {source.date ? <span className="text-text-3">— {source.date}</span> : null}
              {source.tier ? <Badge tone="neutral">{source.tier}</Badge> : null}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[11px] text-text-3">{research.countsLine}</p>
    </section>
  );
}

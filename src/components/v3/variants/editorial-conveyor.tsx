"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, RefreshCw, Send, Zap } from "lucide-react";
import { useReducedMotion } from "motion/react";

type ConveyorPhase = "signal" | "draft" | "published";

const PHASE_INDEX: Record<ConveyorPhase, number> = {
  signal: 0,
  draft: 1,
  published: 2,
};

const PHASE_STATUS: Record<ConveyorPhase, string> = {
  signal: "Аврора нашла растущую тему у конкурента.",
  draft: "Материал подготовлен в голосе канала.",
  published: "Пост опубликован в Telegram.",
};

export function EditorialConveyor() {
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState<ConveyorPhase>("published");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const activeTimers = timers.current;
    return () => activeTimers.forEach(clearTimeout);
  }, []);

  function showJourney() {
    timers.current.forEach(clearTimeout);
    timers.current = [];

    if (reduceMotion) {
      setPhase("published");
      return;
    }

    setPhase("signal");
    timers.current.push(setTimeout(() => setPhase("draft"), 650));
    timers.current.push(setTimeout(() => setPhase("published"), 1350));
  }

  const current = PHASE_INDEX[phase];
  const busy = phase !== "published";

  return (
    <div className="av4-conveyor" data-phase={phase}>
      <div className="av4-conveyor__head">
        <p>От сигнала до публикации</p>
        <button type="button" onClick={showJourney} disabled={busy} className="av4-replay">
          <RefreshCw className="h-4 w-4" strokeWidth={2.4} aria-hidden />
          {busy ? "Аврора работает" : "Показать путь"}
        </button>
      </div>

      <p className="sr-only" aria-live="polite">
        {PHASE_STATUS[phase]}
      </p>

      <div className="av4-conveyor__flow" aria-label="Путь публикации от сигнала до Telegram">
        <article className={`av4-node av4-signal ${current >= 0 ? "is-ready" : ""}`}>
          <p className="av4-node__label">Найден сигнал</p>
          <div className="av4-signal__icon" aria-hidden>
            <Zap className="h-6 w-6" fill="currentColor" strokeWidth={2.4} />
          </div>
          <strong>@svaril_sam</strong>
          <span>тема растёт быстрее обычного</span>
        </article>

        <ArrowRight
          className={`av4-flow-arrow ${current >= 1 ? "is-ready" : ""}`}
          strokeWidth={2.7}
          aria-hidden
        />

        <article className={`av4-node av4-draft ${current >= 1 ? "is-ready" : ""}`}>
          <p className="av4-node__label">Материал готов</p>
          <strong>Почему кофе горчит</strong>
          <span className="av4-draft__line" aria-hidden />
          <span className="av4-draft__line av4-draft__line--short" aria-hidden />
          <small>голос: «Кофе и код»</small>
        </article>

        <ArrowRight
          className={`av4-flow-arrow ${current >= 2 ? "is-ready" : ""}`}
          strokeWidth={2.7}
          aria-hidden
        />

        <article className={`av4-node av4-post ${current >= 2 ? "is-ready" : ""}`}>
          <header className="av4-post__header">
            <span className="av4-post__avatar" aria-hidden>
              <Send className="h-5 w-5" fill="currentColor" strokeWidth={2.2} />
            </span>
            <span>
              <strong>Кофе и код · демо</strong>
              <small>тестовый Telegram-канал</small>
            </span>
            <span className="av4-post__status">Опубликовано</span>
          </header>

          <div className="av4-post__body">
            <h2>Кофе горчит? Дело в помоле</h2>
            <p>
              Мелкий помол дольше контактирует с водой и отдаёт лишнюю горечь. Сделай его на два
              клика крупнее — вкус станет чище уже завтра утром.
            </p>
          </div>

          <footer className="av4-post__footer">
            <span>Сегодня · 12:00</span>
            <span>
              <Check className="h-4 w-4" strokeWidth={2.8} aria-hidden />
              отправлено сервером
            </span>
          </footer>
        </article>
      </div>
    </div>
  );
}

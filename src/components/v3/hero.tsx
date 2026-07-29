"use client";

// HERO v3: слева — обещание тремя строками Unbounded и одна жёлтая клавиша,
// справа — пульт-демо. Демо запускается ТОЛЬКО по клику (решение владельца):
// запрос печатается моно-шрифтом → «пишу черновик» → пост собирается →
// зелёный штамп ОПУБЛИКОВАНО. Никакого автопроигрывания и параллакса.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Zap } from "lucide-react";

const EASE = [0.22, 1, 0.36, 1] as const;
const POP = [0.34, 1.56, 0.64, 1] as const;

// Запрос, который «печатает» платформа. Показывает механику: тема + голос + опора на разведку.
const PROMPT =
  "пост: почему кофе горчит · голос канала «Кофе и код» · опора: залёт @svaril_sam ×7,8";

type Phase = "idle" | "typing" | "writing" | "done";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "жду команды",
  typing: "печатаю запрос",
  writing: "пишу черновик",
  done: "готово",
};

/* ----------------------------------------------------------- ПУЛЬТ-ДЕМО */

function DemoPanel() {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("idle");
  const [typed, setTyped] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Все таймеры в одном месте — чистим при размонтировании и перезапуске
  useEffect(() => {
    const list = timers.current;
    return () => list.forEach(clearTimeout);
  }, []);

  function run() {
    timers.current.forEach(clearTimeout);
    timers.current = [];

    if (reduce) {
      // Меньше движения — результат сразу, без печати
      setTyped(PROMPT.length);
      setPhase("done");
      return;
    }

    setTyped(0);
    setPhase("typing");

    const TICK = 24; // ~40 символов в секунду — бодро, но читаемо
    const total = PROMPT.length * TICK;
    for (let i = 1; i <= PROMPT.length; i++) {
      timers.current.push(setTimeout(() => setTyped(i), i * TICK));
    }
    timers.current.push(setTimeout(() => setPhase("writing"), total + 350));
    timers.current.push(setTimeout(() => setPhase("done"), total + 1550));
  }

  const busy = phase === "typing" || phase === "writing";

  return (
    <div className="v3-panel" aria-live="polite">
      {/* Полоса-заголовок пульта */}
      <div className="flex items-center gap-2.5 border-b-2 border-[var(--ink)] bg-[var(--ink)] px-4 py-3">
        <span aria-hidden className="h-2.5 w-2.5 bg-[var(--acc)]" />
        <span aria-hidden className="h-2.5 w-2.5 bg-[var(--paper)]" />
        <span aria-hidden className="h-2.5 w-2.5 bg-[var(--red)]" />
        <span className="v3-mono ml-2 text-[11px] font-semibold tracking-[0.14em] text-[var(--paper)] uppercase">
          live-demo.exe
        </span>
        <span className="v3-mono ml-auto text-[11px] tracking-[0.1em] text-[var(--acc)] uppercase">
          {PHASE_LABEL[phase]}
        </span>
      </div>

      <div className="p-5 sm:p-6">
        {/* Запрос: в idle — целиком как задание, при печати — по буквам */}
        <div className="border-2 border-[var(--ink)] bg-[var(--paper)] p-4">
          <p className="v3-mono text-[11px] font-semibold tracking-[0.12em] text-[var(--ink-2)] uppercase">
            &gt; запрос
          </p>
          <p className="v3-mono mt-2 min-h-[3.9em] text-[13.5px] leading-relaxed text-[var(--ink)]">
            {phase === "idle" ? PROMPT : PROMPT.slice(0, typed)}
            {phase === "typing" && <span className="v3-caret" aria-hidden />}
          </p>
        </div>

        {/* Статус «пишу черновик» */}
        {phase === "writing" && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="v3-mono mt-4 flex items-center gap-2 text-[12px] font-semibold tracking-[0.1em] uppercase"
          >
            <Zap className="h-4 w-4" strokeWidth={2.5} aria-hidden />
            пишу черновик…
          </motion.p>
        )}

        {/* Готовый пост + штамп */}
        {phase === "done" && (
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="relative mt-4"
          >
            <div className="v3-card p-4">
              <p className="text-[15px] leading-snug font-bold">Кофе горчит? Дело в помоле</p>
              <p className="mt-2 text-[14px] leading-relaxed text-[var(--ink-2)]">
                Мелкий помол — дольше контакт с водой — лишняя горечь. Сделай помол на два клика
                крупнее: вкус станет чище уже завтра утром.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="v3-chip">#кофе</span>
                <span className="v3-chip">#помол</span>
                <span className="v3-chip v3-chip--acc">опора: разведка</span>
              </div>
            </div>
            <motion.span
              initial={{ opacity: 0, scale: 1.6, rotate: -14 }}
              animate={{ opacity: 1, scale: 1, rotate: -3 }}
              transition={{ duration: 0.3, delay: 0.25, ease: POP }}
              className="v3-stamp v3-stamp--green absolute -top-3 right-3"
            >
              Опубликовано · 12:00
            </motion.span>
          </motion.div>
        )}

        {/* Клавиша запуска */}
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="v3-btn mt-5 w-full"
          aria-label={phase === "done" ? "Сгенерировать пост ещё раз" : "Сгенерировать пост"}
        >
          {phase === "done" ? "Ещё раз" : busy ? "Работаю…" : "Сгенерировать пост"}
          {!busy && <Zap className="h-4 w-4" strokeWidth={2.5} aria-hidden />}
        </button>
      </div>

      {/* Рельс шагов внизу пульта */}
      <div className="flex items-center gap-0 border-t-2 border-[var(--ink)]">
        {["01 запрос", "02 черновик", "03 публикация"].map((s, i) => {
          const on =
            (i === 0 && phase !== "idle") ||
            (i === 1 && (phase === "writing" || phase === "done")) ||
            (i === 2 && phase === "done");
          return (
            <span
              key={s}
              className={`v3-mono flex-1 border-[var(--ink)] px-2 py-2.5 text-center text-[10.5px] tracking-[0.08em] uppercase transition-colors duration-200 ${
                i > 0 ? "border-l-2" : ""
              } ${on ? "bg-[var(--acc)] font-semibold" : "bg-[var(--sheet)] text-[var(--ink-2)]"}`}
            >
              {s}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- HERO */

export function V3Hero() {
  const reduce = useReducedMotion();

  const rise = (delay: number) => ({
    initial: reduce ? false : { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.4, delay: reduce ? 0 : delay, ease: EASE },
  });

  return (
    <section className="relative overflow-hidden pt-14 pb-16 sm:pt-20 sm:pb-24">
      {/* Full-bleed: текст прижат к левому краю листа, пульт — к правому.
          Между ними — композиционный воздух, а не мёртвые поля по бокам. */}
      <div className="v3-wrap flex flex-col gap-12 lg:flex-row lg:items-center lg:justify-between lg:gap-14">
        {/* ------------------------------------------------ ЛЕВО: обещание */}
        <div className="flex w-full flex-col items-start lg:max-w-[880px] lg:flex-[1.05_1_0%]">
          <motion.p {...rise(0)} className="v3-kicker">
            Автопилот для Telegram-каналов
          </motion.p>

          {/* Три строки — три такта. Последняя забирает жёлтый маркер. */}
          <motion.h1
            {...rise(0.08)}
            className="v3-display v3-hero-title mt-6 text-[clamp(2.7rem,6.2vw,5.4rem)] leading-[0.98] font-black tracking-[-0.01em] uppercase"
          >
            <span className="block">Канал</span>
            <span className="block">ведётся</span>
            <span className="block">
              <span className="v3-marker">сам.</span>
            </span>
          </motion.h1>

          <motion.p {...rise(0.18)} className="v3-body mt-6 max-w-xl text-[17px] sm:text-lg">
            Платформа следит за конкурентами, находит залетающие темы, пишет посты{" "}
            <strong>твоим голосом</strong> и публикует их в Telegram — по расписанию, с сервера.
          </motion.p>

          <motion.div
            {...rise(0.26)}
            className="mt-9 flex w-full flex-col gap-4 sm:w-auto sm:flex-row sm:items-center"
          >
            <Link href="/register" className="v3-btn v3-btn--lg w-full sm:w-auto">
              Забрать ранний доступ
              <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
            </Link>
            <a href="#how" className="v3-btn v3-btn--ghost v3-btn--lg w-full sm:w-auto">
              Как это работает
            </a>
          </motion.div>

          {/* Честная строка: VK обещанием не торгуем */}
          <motion.p
            {...rise(0.34)}
            className="v3-mono mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11.5px] leading-relaxed tracking-[0.06em] text-[var(--ink-2)] uppercase"
          >
            <span className="flex items-center gap-2">
              <span className="v3-live-dot" aria-hidden />
              Бесплатно на старте
            </span>
            <span aria-hidden>/</span>
            <span>Без карты</span>
            <span aria-hidden>/</span>
            <span>Telegram публикует уже сейчас</span>
            <span aria-hidden>/</span>
            <span>VK — следующая волна</span>
          </motion.p>
        </div>

        {/* ---------------------------------------------- ПРАВО: пульт-демо */}
        <motion.div {...rise(0.22)} className="relative w-full lg:max-w-[940px] lg:flex-[0.95_1_0%]">
          <DemoPanel />
        </motion.div>
      </div>
    </section>
  );
}

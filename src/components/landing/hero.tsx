"use client";

// СЕКЦИЯ 1 ТЗ 8.1 — HERO. Первый экран лендинга.
// Слева — обещание одной фразой и ОДНО главное действие (ТЗ 6: «один главный экран,
// одно главное действие»; ТЗ 7.2: градиент-магнит на экране ровно один).
// Справа — живое демо (ТЗ 7.4, уровень 3) в лёгком 3D-параллаксе (уровень 4).
// Параллакс — только мышь: на тач-устройствах и при prefers-reduced-motion он выключен.

import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  animate,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import { ArrowRight, ChevronDown } from "lucide-react";
import { AuroraBackground } from "@/components/aurora-background";
import { LiveDemo } from "@/components/landing/live-demo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

// Заголовок разбит на слова: каждое выезжает из-под маски со сдвигом в 60 мс.
// Последнее слово забирает градиент — на нём весь смысл обещания.
const TITLE_WORDS = ["Канал", "ведётся,", "даже", "когда", "ты", "занят"] as const;

// Мягкий, чуть «тяжёлый» отклик — панель не дёргается за курсором, а плывёт.
const TILT_SPRING = { stiffness: 90, damping: 18, mass: 0.6 } as const;

// Параллакс включаем только там, где есть настоящий курсор. Тач его не получает (ТЗ 7.4).
const FINE_POINTER = "(hover: hover) and (pointer: fine)";

function subscribePointer(onChange: () => void) {
  const mq = window.matchMedia(FINE_POINTER);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const readPointer = () => window.matchMedia(FINE_POINTER).matches;
const readPointerOnServer = () => false;

/* --------------------------------------------------------------- СЧЁТЧИК */
// Цифры дотикивают до значения при появлении (ТЗ 7.4, уровень 2 — «счётчики цифр»).
// MotionValue как ребёнок motion-компонента: текст обновляется напрямую в DOM,
// без единого ререндера React. Первый кадр — 0 и на сервере, и на клиенте.

function CountUp({ to, delay = 0 }: { to: number; delay?: number }) {
  const reduce = useReducedMotion();
  const count = useMotionValue(0);
  const rounded = useTransform(count, (v: number) => Math.round(v));

  useEffect(() => {
    if (reduce) {
      count.set(to);
      return;
    }
    const controls = animate(count, to, { duration: 1, delay, ease: EASE });
    return () => controls.stop();
  }, [to, delay, reduce, count]);

  return <motion.span>{rounded}</motion.span>;
}

/* ----------------------------------------------------------- МИНИ-ФАКТЫ */
// Три коротких опоры из текущего продуктового сценария: время контроля, память и серверная публикация.

function Fact({ value, caption }: { value: React.ReactNode; caption: string }) {
  return (
    <div className="min-w-0">
      <p className="nums text-[24px] leading-none font-extrabold -tracking-[0.03em] text-text sm:text-[28px]">
        {value}
      </p>
      <p className="mt-1.5 text-[13px] leading-tight text-text-2">{caption}</p>
    </div>
  );
}

function FactDivider() {
  return <span aria-hidden className="h-10 w-px shrink-0 bg-line" />;
}

/* ------------------------------------------------------------------ HERO */

export function Hero() {
  const reduce = useReducedMotion();
  const finePointer = useSyncExternalStore(subscribePointer, readPointer, readPointerOnServer);

  const tilt = finePointer && !reduce;

  // Курсор → наклон панели. Только transform, никаких перерисовок макета.
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const smoothX = useSpring(pointerX, TILT_SPRING);
  const smoothY = useSpring(pointerY, TILT_SPRING);
  const rotateY = useTransform(smoothX, [-0.5, 0.5], [-6, 6]);
  const rotateX = useTransform(smoothY, [-0.5, 0.5], [6, -6]);
  const tiltTransform = useMotionTemplate`perspective(1200px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!tilt || event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    pointerX.set((event.clientX - rect.left) / rect.width - 0.5);
    pointerY.set((event.clientY - rect.top) / rect.height - 0.5);
  };

  const handlePointerLeave = () => {
    pointerX.set(0);
    pointerY.set(0);
  };

  // Общее появление: 550 мс, ease [0.22, 1, 0.36, 1], лесенкой сверху вниз
  const rise = (delay: number) => ({
    initial: reduce ? false : { opacity: 0, y: 18 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.55, delay: reduce ? 0 : delay, ease: EASE },
  });

  return (
    <section
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className="relative flex min-h-dvh items-center overflow-hidden pt-24 pb-16"
    >
      <AuroraBackground intensity="hero" grid grain />

      <div className="relative mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-14 px-5 sm:px-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-14 xl:gap-20">
        {/* ═══════════════════════════════════════════════ ЛЕВО: обещание */}
        <div className="flex flex-col items-start">
          {/* Плашка: что, почём и откуда — три честных факта до единой строчки текста.
              Живая точка не декоративная: доступ действительно открыт, кнопка ведёт в продукт. */}
          <motion.p
            {...rise(0)}
            className="glass inline-flex items-center gap-2.5 rounded-full py-2 pr-4 pl-3 text-[13px] font-semibold text-text-2"
          >
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Продукт работает · Ручной контроль · Публикация с сервера
          </motion.p>

          {/* Заголовок — слова выезжают из-под маски, stagger 60 мс */}
          <h1 className="display mt-7 flex flex-wrap gap-x-[0.22em] gap-y-[0.04em] text-[clamp(2.6rem,7vw,5.5rem)] text-text">
            {TITLE_WORDS.map((word, i) => (
              // pb — чтобы маска не срезала хвосты «ц» и запятую
              <span key={word} className="inline-block overflow-hidden pb-[0.12em]">
                <motion.span
                  initial={reduce ? false : { y: "125%" }}
                  animate={{ y: "0%" }}
                  transition={{
                    duration: 0.6,
                    delay: reduce ? 0 : 0.1 + i * 0.06,
                    ease: EASE,
                  }}
                  className={cn(
                    "inline-block",
                    i === TITLE_WORDS.length - 1 && "text-gradient",
                  )}
                >
                  {word}
                </motion.span>
              </span>
            ))}
          </h1>

          {/* Подзаголовок — весь продукт одним предложением (требование ТЗ 8.1) */}
          <motion.p
            {...rise(0.44)}
            className="mt-6 max-w-xl text-lg leading-relaxed text-text-2 sm:text-xl"
          >
            Аврора находит сильные темы, пишет посты в твоём голосе, проверяет факты
            и публикует по расписанию. Правила и последнее слово остаются за тобой.
          </motion.p>

          {/* Действия. Градиент ровно один — это и есть «магнит» (ТЗ 7.2) */}
          <motion.div
            {...rise(0.52)}
            className="mt-9 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:gap-4"
          >
            <Link href="/register" className="w-full sm:w-auto">
              <Button variant="brand" size="xl" className="glow-pulse group w-full">
                Запустить первый цикл
                <ArrowRight
                  className="h-5 w-5 transition-transform duration-200 ease-[var(--ease-soft)] group-hover:translate-x-0.5"
                  strokeWidth={2}
                  aria-hidden
                />
              </Button>
            </Link>

            <Link href="#how" className="w-full sm:w-auto">
              <Button variant="outline" size="xl" className="w-full">
                Как это работает
              </Button>
            </Link>
          </motion.div>

          {/* Честно объясняем следующий шаг и возможность остановить автопилот. */}
          <motion.p {...rise(0.58)} className="mt-4 text-[13px] leading-relaxed text-text-2">
            Почта и пароль. Канал подключишь следующим шагом. Пауза — в любой момент.
          </motion.p>

          {/* Три цифры, за которыми стоят живые тесты и разведка, а не обещания */}
          <motion.div {...rise(0.64)} className="mt-9 flex items-center gap-5 sm:gap-7">
            <Fact value={<CountUp to={15} delay={0.82} />} caption="минут контроля в неделю" />
            <FactDivider />
            <Fact value={<CountUp to={3} delay={0.92} />} caption="источника памяти" />
            <FactDivider />
            <Fact value="24/7" caption="публикация с сервера" />
          </motion.div>
        </div>

        {/* ═════════════════════════════════════════════ ПРАВО: живое демо */}
        <div className="relative">
          {/* Медленная орбита за стеклом — объём без единого килобайта 3D (ТЗ 7.4, уровень 4) */}
          <div aria-hidden className="pointer-events-none absolute inset-0 z-0 hidden lg:block">
            <div
              className="absolute top-1/2 left-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-70"
              style={{
                background:
                  "conic-gradient(from 90deg, rgb(99 102 241 / 0.22), rgb(139 92 246 / 0.14), rgb(245 158 11 / 0.08), transparent 62%, rgb(99 102 241 / 0.2))",
                filter: "blur(40px)",
                animation: "orbit 46s linear infinite",
                willChange: "transform",
              }}
            />
          </div>

          {/* Появление панели */}
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 28, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.6, delay: reduce ? 0 : 0.28, ease: EASE }}
            className="relative z-10"
          >
            {/* Наклон за курсором: ±6°, пружина, только transform */}
            <motion.div
              style={tilt ? { transform: tiltTransform } : undefined}
              className="will-change-transform"
            >
              <LiveDemo />
            </motion.div>
          </motion.div>
        </div>
      </div>

      {/* Подсказка «здесь есть что листать» — тихая, декоративная */}
      <motion.div
        aria-hidden
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: reduce ? 0 : 1.1, ease: EASE }}
        className="pointer-events-none absolute inset-x-0 bottom-7 hidden justify-center lg:flex"
      >
        <motion.div
          animate={reduce ? undefined : { y: [0, 7, 0], opacity: [0.55, 1, 0.55] }}
          transition={
            reduce ? undefined : { duration: 2.4, repeat: Infinity, ease: "easeInOut" }
          }
          className="flex flex-col items-center gap-2"
        >
          <span
            className="h-12 w-px"
            style={{ background: "linear-gradient(to bottom, transparent, var(--border-strong))" }}
          />
          <ChevronDown className="h-4 w-4 text-text-3" strokeWidth={2} />
        </motion.div>
      </motion.div>
    </section>
  );
}

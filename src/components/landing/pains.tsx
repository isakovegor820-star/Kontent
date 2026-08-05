"use client";

// Секция 2 ТЗ 8.1 — «Боль → решение».
// Три карточки-боли, каждая переворачивается в решение при скролле (3D по оси Y, ТЗ 7.4 уровень 4).
// Лицевая грань — приглушённая, как сама проблема. Обратная — стекло и градиент:
// «яркость появляется в моменты ценности» (ТЗ 7.1).
// Тон — ТЗ 7.5: просто и дружелюбно, на «ты», без жаргона.

import { useId, useSyncExternalStore } from "react";
import { motion } from "motion/react";
import {
  ArrowDown,
  Clock,
  HelpCircle,
  Lightbulb,
  Radar,
  TrendingDown,
  Zap,
} from "lucide-react";
import { AuroraBackground } from "@/components/aurora-background";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

/* -------------------------------------------------- PREFERS-REDUCED-MOTION */
// useReducedMotion() из motion/react читает медиазапрос синхронно: на сервере — null,
// при гидрации — уже true. Для пропсов анимации это норма, но здесь от него зависит
// САМА РАЗМЕТКА (переворот против стопки) — разметка бы разъехалась при гидрации.
// useSyncExternalStore решает это штатно: сервер и гидрация видят одно, клиент
// перерисовывается сразу после. Бонусом переключение настройки ОС ловится вживую.

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia(REDUCE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCE_QUERY).matches,
    () => false,
  );
}

/* ------------------------------------------------------------------ ДАННЫЕ */

type PainIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

type PainItem = {
  id: string;
  painIcon: PainIcon;
  solutionIcon: PainIcon;
  /** Боль — заголовок лицевой грани */
  pain: string;
  /** Как она выглядит изнутри — подпись под болью */
  painNote: string;
  /** Раздел платформы, который её закрывает */
  feature: string;
  /** Обещание — заголовок обратной грани */
  solutionTitle: string;
  /** Механика — чем именно закрываем */
  solution: string;
};

const ITEMS: PainItem[] = [
  {
    id: "time",
    painIcon: Clock,
    solutionIcon: Zap,
    pain: "Нет времени постить",
    painNote: "Открываешь редактор — и закрываешь. Каждый день.",
    feature: "Автопилот",
    solutionTitle: "Неделя за 15 минут",
    solution:
      "Автопилот собирает план на неделю. Ты жмёшь одну кнопку — 7 постов уходят сами.",
  },
  {
    id: "ideas",
    painIcon: HelpCircle,
    solutionIcon: Lightbulb,
    pain: "Не знаю, что снимать",
    painNote: "Идей нет, а лента ждёт.",
    feature: "Тренды",
    solutionTitle: "Идеи приходят сами",
    solution:
      "Лента идей: готовые карточки со сценарием и хуком. Один клик — черновик.",
  },
  {
    id: "rivals",
    painIcon: TrendingDown,
    solutionIcon: Radar,
    pain: "Конкуренты растут — не понимаю почему",
    painNote: "Видишь цифры, но не видишь причину.",
    feature: "Разведка",
    solutionTitle: "Видно, что у них работает",
    solution:
      "Полное досье на каждого: какие темы и форматы дают им результат — человеческим языком.",
  },
];

/* ------------------------------------------------------------------ ГРАНИ */

// Обе грани — одна и та же геометрия. Иначе переворот «дёрнется» на стыке.
const FACE = "flex h-full flex-col rounded-lg p-7 sm:p-8";
const CIRCLE = "flex h-14 w-14 shrink-0 items-center justify-center rounded-full";
const TITLE = "text-[21px] leading-tight font-extrabold -tracking-[0.02em]";

// Мягкое свечение внутри решения. Через color-mix от токенов — значит, живёт и в тёмной теме.
const SOLUTION_GLOW =
  "radial-gradient(125% 90% at 50% 0%, color-mix(in oklab, var(--brand-2) 20%, transparent) 0%, color-mix(in oklab, var(--brand-1) 8%, transparent) 45%, transparent 72%)";

/** Лицевая грань: боль. Приглушённая — цвета вполсилы, иконка в сером круге. */
function PainFace({ item, index }: { item: PainItem; index: number }) {
  const Icon = item.painIcon;

  return (
    <div className={cn(FACE, "card-plain min-h-[280px]")}>
      <div className="flex items-start justify-between gap-4">
        <span className={cn(CIRCLE, "bg-surface-inset text-text-3")}>
          <Icon className="h-6 w-6" strokeWidth={1.75} />
        </span>
        <span className="nums text-[13px] font-bold tracking-[0.14em] text-text-3">
          0{index + 1}
        </span>
      </div>

      <div className="mt-auto pt-8">
        <h3 className={cn(TITLE, "text-text-2")}>{item.pain}</h3>
        <p className="mt-3 text-[15px] leading-relaxed text-text-3">{item.painNote}</p>
      </div>
    </div>
  );
}

/** Обратная грань: решение. Стекло, градиентная иконка, свечение — «момент ценности». */
function SolutionFace({ item }: { item: PainItem }) {
  const Icon = item.solutionIcon;

  return (
    <div className={cn(FACE, "glass relative overflow-hidden")}>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: SOLUTION_GLOW }}
      />

      <div className="relative flex items-start justify-between gap-4">
        <span className={cn(CIRCLE, "bg-brand-gradient text-white shadow-glow")}>
          <Icon className="h-6 w-6" strokeWidth={2} />
        </span>
        <Badge tone="brand">{item.feature}</Badge>
      </div>

      <div className="relative mt-auto pt-8">
        <p className={cn(TITLE, "text-text")}>{item.solutionTitle}</p>
        <p className="mt-3 text-[15px] leading-relaxed text-text-2">{item.solution}</p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- КАРТОЧКИ */

/**
 * Переворот боль → решение при скролле.
 *
 * Намеренно НЕ используем backface-visibility: у Chrome есть давний баг —
 * при анимированном preserve-3d обе грrazи схлопываются ровно на 180°, и
 * карточка становится пустой. Поэтому «переворот» собран из двух граней с
 * кроссфейдом по opacity + поворотом rotateY: боль уезжает к ребру и гаснет,
 * решение приходит от ребра и проявляется. Только transform/opacity — GPU.
 */
function FlipCard({ item, index }: { item: PainItem; index: number }) {
  const delay = index * 0.12;
  const viewport = { once: true, margin: "-120px" } as const;

  return (
    <li className="relative h-full [perspective:1400px]">
      {/* Решение держит высоту карточки — оно в потоке, боль лежит поверх */}
      <motion.div
        className="h-full"
        style={{ transformOrigin: "center" }}
        initial={{ rotateY: -90, opacity: 0 }}
        whileInView={{ rotateY: 0, opacity: 1 }}
        viewport={viewport}
        transition={{ duration: 0.5, ease: EASE, delay: delay + 0.44 }}
      >
        <SolutionFace item={item} />
      </motion.div>

      <motion.div
        className="absolute inset-0"
        style={{ transformOrigin: "center" }}
        initial={{ rotateY: 0, opacity: 1 }}
        whileInView={{ rotateY: 90, opacity: 0 }}
        viewport={viewport}
        transition={{ duration: 0.46, ease: EASE, delay }}
      >
        <PainFace item={item} index={index} />
      </motion.div>
    </li>
  );
}

/** prefers-reduced-motion: ничего не крутим. Боль зачёркнута сверху, решение — снизу. */
function StackedCard({ item }: { item: PainItem }) {
  const PIcon = item.painIcon;
  const SIcon = item.solutionIcon;

  return (
    <li>
      <div className={cn(FACE, "card-plain min-h-[280px]")}>
        <div className="flex items-start gap-4">
          <span className={cn(CIRCLE, "bg-surface-inset text-text-3")}>
            <PIcon className="h-6 w-6" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 pt-1">
            <h3 className={cn(TITLE, "text-text-3 line-through decoration-2")}>{item.pain}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-text-3">{item.painNote}</p>
          </div>
        </div>

        <div className="my-7 flex items-center gap-3" aria-hidden>
          <span className="h-px flex-1 bg-line" />
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-inset text-text-3">
            <ArrowDown className="h-4 w-4" strokeWidth={2} />
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>

        <div className="flex items-start gap-4">
          <span className={cn(CIRCLE, "bg-brand-gradient text-white shadow-glow")}>
            <SIcon className="h-6 w-6" strokeWidth={2} />
          </span>
          <div className="min-w-0 pt-1">
            <p className={cn(TITLE, "text-text")}>{item.solutionTitle}</p>
            <p className="mt-2 text-[15px] leading-relaxed text-text-2">{item.solution}</p>
          </div>
        </div>
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------- СЕКЦИЯ */

export function Pains() {
  const uid = useId();

  // Человек просил меньше движения — карточки не крутятся, а лежат стопкой.
  const stacked = usePrefersReducedMotion();

  return (
    <section
      aria-labelledby={`${uid}-title`}
      className="relative isolate overflow-hidden bg-bg-section py-24 sm:py-32"
    >
      <AuroraBackground intensity="section" grid={false} />

      <div className="relative mx-auto w-full max-w-6xl px-5 sm:px-8">
        {/* ------------------------------------------------------ ЗАГОЛОВОК */}
        <motion.div
          initial={{ opacity: 0, y: 22 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: stacked ? 0 : 0.55, ease: EASE }}
          className="mx-auto max-w-2xl text-center"
        >
          <p className="text-[13px] font-bold tracking-[0.18em] text-brand uppercase">Знакомо?</p>

          <h2
            id={`${uid}-title`}
            className="display mt-5 text-[clamp(2rem,4.5vw,3.4rem)] text-text"
          >
            Три причины, по которым соцсети стоят
          </h2>

          <p className="mx-auto mt-6 max-w-lg text-[16px] leading-relaxed text-text-2">
            Каждую из них платформа закрывает не советом, а работой, которую берёт на себя.
          </p>
        </motion.div>

        {/* -------------------------------------------------------- КАРТОЧКИ */}
        <ul className="mt-14 grid gap-5 sm:mt-16 md:grid-cols-3 md:gap-6">
          {ITEMS.map((item, i) =>
            stacked ? (
              <StackedCard key={item.id} item={item} />
            ) : (
              <FlipCard key={item.id} item={item} index={i} />
            ),
          )}
        </ul>

        {/* Подсказка честна только там, где карточки действительно крутятся */}
        {!stacked && (
          <p className="mt-8 text-center text-[13px] text-text-3">
            Карточки переворачиваются сами — прокрути до конца.
          </p>
        )}
      </div>
    </section>
  );
}

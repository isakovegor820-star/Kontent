"use client";

// Секция 3 ТЗ 8.1 — «Цикл работы по шагам».
// Формула продукта (ТЗ 1): РАЗВЕДКА → ИИ-КОНТЕНТ → АВТОПОСТИНГ → РЕАКЦИИ → снова разведка, уже умнее.
// Этого замкнутого круга нет ни у одного из 8 протестированных конкурентов (ТЗ 2) — это главное
// отличие продукта, поэтому секция показывает его буквально: градиент едет по шагам вслед за
// скроллом и возвращается в начало по дуге. Каждый шаг несёт мини-демо (ТЗ 8.1, п. 3).

import { Fragment, useEffect, useId, useRef, useState } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";
import {
  ArrowDown,
  ArrowRight,
  CalendarCheck,
  Check,
  Flame,
  Radar,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { AuroraBackground } from "@/components/aurora-background";
import { Badge, TelegramIcon } from "@/components/ui/primitives";
import { cn, fmtPct } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;
const POP = [0.34, 1.56, 0.64, 1] as const;

/* ------------------------------------------------------------------ СЧЁТЧИК */
// Счётчик цифр — уровень 2 анимаций ТЗ 7.4. Тикает, когда шаг загорелся.
// Считаем на MotionValue, а не на state: цифра меняется в DOM напрямую, без ре-рендеров.

function useReachLabel(target: number, run: boolean, still: boolean | null) {
  const count = useMotionValue(0);
  const label = useTransform(count, (v: number) => `+${fmtPct(v)}`);

  useEffect(() => {
    const to = run ? target : 0;
    if (still) {
      count.set(to);
      return;
    }
    const controls = animate(count, to, {
      duration: run ? 0.9 : 0.25,
      ease: EASE,
    });
    return () => controls.stop();
  }, [count, run, still, target]);

  return label;
}

/* --------------------------------------------------------------- ЭКРАН ДЕМО */
// Мини-макет внутри карточки. Для скринридера это картинка с подписью — смысл
// шага несёт заголовок и пояснение под ним.

function DemoPanel({
  label,
  tight,
  children,
}: {
  label: string;
  tight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className="mt-4 flex h-[200px] flex-col justify-center overflow-hidden rounded-sm border border-line bg-surface-2 p-3"
    >
      <div className={cn("w-full", tight ? "space-y-1.5" : "space-y-2.5")}>{children}</div>
    </div>
  );
}

/* --------------------------------------------------- 1. РАЗВЕДКА: досье и залёт */

function ReconDemo({ active }: { active: boolean }) {
  const reduce = useReducedMotion();

  return (
    <DemoPanel label="Досье конкурента: канал «Сварил сам», залёт в 7,8 раза выше нормы и график роста">
      <div className="flex items-center gap-2.5">
        <span
          className="h-9 w-9 shrink-0 rounded-full"
          style={{ background: "linear-gradient(135deg, hsl(26 82% 64%), hsl(26 82% 46%))" }}
        />
        <div className="min-w-0">
          <p className="truncate text-[14px] leading-tight font-bold text-text">Сварил сам</p>
          <p className="truncate text-[13px] leading-tight text-text-3">@svaril_sam</p>
        </div>
      </div>

      {/* Метка залёта: загорается вместе с шагом */}
      <span
        className={cn(
          "inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-bold",
          "transition-colors duration-500 ease-[var(--ease-soft)]",
          active ? "bg-fire-soft text-fire-text" : "bg-surface-inset text-text-3",
        )}
      >
        <Flame
          className={cn(
            "h-3.5 w-3.5 transition-colors duration-500",
            active ? "text-fire-text" : "text-text-3",
          )}
          strokeWidth={2}
        />
        ×7,8 залёт
      </span>

      {/* Спарклайн. Линия «рисуется» шторой цвета панели — чистый transform, без dash-математики */}
      <div className="relative h-8 w-full">
        <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-full w-full" fill="none">
          <polygon
            points="2,26 16,24 30,25 44,20 58,22 72,15 84,11 96,5 96,32 2,32"
            className="fill-fire"
            fillOpacity={0.12}
          />
          <polyline
            points="2,26 16,24 30,25 44,20 58,22 72,15 84,11 96,5"
            className="stroke-fire"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        <motion.span
          className="absolute inset-0 origin-right bg-surface-2"
          initial={false}
          animate={{ scaleX: active ? 0 : 1 }}
          transition={reduce ? { duration: 0 } : { duration: 0.8, ease: EASE }}
        />

        <motion.span
          className="absolute h-2 w-2 translate-x-1/2 -translate-y-1/2 rounded-full bg-fire"
          style={{ right: "4%", top: 5 }}
          initial={false}
          animate={{ opacity: active ? 1 : 0 }}
          transition={reduce ? { duration: 0 } : { delay: 0.85, duration: 0.25 }}
        />
      </div>

      <p className="text-[13px] leading-snug text-text-3">71 400 просмотров при медиане 9 200</p>
    </DemoPanel>
  );
}

/* ------------------------------------------- 2. ИИ-КОНТЕНТ: карточка «Сними это» */

const SCRIPT = ["Обвинение в первой секунде", "Решение — за 40 секунд"] as const;

function AiDemo({ active }: { active: boolean }) {
  const reduce = useReducedMotion();

  return (
    <DemoPanel
      tight
      label="Карточка идеи «Сними это»: заголовок, сценарий из двух шагов и формат — видео на 40 секунд"
    >
      <p className="inline-flex items-center gap-1.5 text-[13px] font-bold text-brand">
        <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
        Сними это
      </p>

      <p className="line-2 text-[14px] leading-snug font-bold text-text">
        Кофе горчит? Дело в помоле
      </p>

      {/* Сценарий «печатается» по строкам, когда шаг активен */}
      <div className="space-y-1">
        {SCRIPT.map((line, i) => (
          <motion.p
            key={line}
            className="flex items-start gap-1.5 text-[13px] leading-snug text-text-2"
            initial={false}
            animate={{ opacity: active ? 1 : 0, x: active ? 0 : -6 }}
            transition={
              reduce ? { duration: 0 } : { duration: 0.4, delay: 0.2 + i * 0.18, ease: EASE }
            }
          >
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-brand-2" />
            {line}
          </motion.p>
        ))}
      </div>

      <span className="inline-flex w-fit items-center rounded-full bg-surface-inset px-2.5 py-1 text-[13px] font-semibold text-text-2">
        Видео · 40 сек
      </span>
    </DemoPanel>
  );
}

/* ------------------------------------ 3. АВТОПОСТИНГ: календарь и «пост вышел» */

const WEEK = [0, 1, 2, 3, 4, 5, 6];
const POST_DAY = 3;
const BUSY_DAYS = [1, 5];

function PublishDemo({ active }: { active: boolean }) {
  const reduce = useReducedMotion();
  const pop = reduce ? { duration: 0 } : { duration: 0.5, delay: 0.25, ease: POP };

  return (
    <DemoPanel label="Неделя календаря: пост запланирован на четверг и вышел сам в Telegram">
      <p className="text-[13px] font-semibold text-text-3">Твоя неделя</p>

      <div className="grid grid-cols-7 gap-1">
        {WEEK.map((d) => (
          <div
            key={d}
            className={cn(
              "relative h-11 rounded-[6px] border transition-colors duration-500",
              d === POST_DAY ? "border-brand/40 bg-info-soft" : "border-line bg-surface-inset/60",
            )}
          >
            {d === POST_DAY && (
              <motion.span
                className="absolute inset-[3px] rounded-[4px] bg-brand-gradient"
                initial={false}
                animate={
                  active
                    ? { opacity: 1, y: 0, scale: 1 }
                    : { opacity: 0, y: -12, scale: 0.9 }
                }
                transition={pop}
              />
            )}
            {BUSY_DAYS.includes(d) && (
              <span className="absolute inset-x-[3px] bottom-[3px] h-2 rounded-[3px] bg-text-3/20" />
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5">
        <motion.span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success text-white"
          initial={false}
          animate={{ scale: active ? 1 : 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.45, delay: 0.6, ease: POP }}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </motion.span>

        <span className="min-w-0 truncate text-[13px] font-bold text-success-text">пост вышел</span>

        {/* Только Telegram: значок VK здесь обещал бы публикацию, которой ещё нет */}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <span
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-full transition-colors duration-500",
              active ? "bg-info-soft text-brand" : "bg-surface-inset text-text-3",
            )}
          >
            <TelegramIcon className="h-3 w-3" />
          </span>
        </span>
      </div>
    </DemoPanel>
  );
}

/* ------------------------------------------ 4. РЕАКЦИИ: график вверх и прирост */

const BARS = [24, 32, 28, 42, 38, 54, 50, 68, 84, 100];

function ReactionsDemo({ active }: { active: boolean }) {
  const reduce = useReducedMotion();
  const reach = useReachLabel(34, active, reduce);

  return (
    <DemoPanel label="График охвата идёт вверх: плюс 34 процента">
      <p className="text-[13px] font-semibold text-text-3">Охват за неделю</p>

      {/* Столбики растут через scaleY — никаких width/height в анимации */}
      <div className="flex h-14 items-end gap-1">
        {BARS.map((h, i) => (
          <motion.span
            key={i}
            className={cn(
              "h-full flex-1 origin-bottom rounded-t-[3px]",
              i >= 7 ? "bg-brand-gradient" : "bg-surface-inset",
            )}
            initial={false}
            animate={{ scaleY: active ? h / 100 : 0.06 }}
            transition={
              reduce ? { duration: 0 } : { duration: 0.5, delay: 0.08 + i * 0.045, ease: EASE }
            }
          />
        ))}
      </div>

      <p className="flex items-center gap-1.5">
        <TrendingUp className="h-4 w-4 shrink-0 text-success-text" strokeWidth={2.25} />
        <motion.span className="nums text-[22px] leading-none font-extrabold text-success-text">
          {reach}
        </motion.span>
        <span className="text-[14px] font-semibold text-text-2">охват</span>
      </p>
    </DemoPanel>
  );
}

/* ------------------------------------------------------------------- ШАГИ */

type StepIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

type Step = {
  key: string;
  num: string;
  title: string;
  caption: string;
  icon: StepIcon;
  demo: React.ComponentType<{ active: boolean }>;
};

const STEPS: Step[] = [
  {
    key: "recon",
    num: "01",
    title: "Разведка",
    caption: "Каждые 2–3 часа проверяем конкурентов и ловим их залёты.",
    icon: Radar,
    demo: ReconDemo,
  },
  {
    key: "ai",
    num: "02",
    title: "ИИ-контент",
    caption: "ИИ берёт залёт за опору и пишет пост твоим голосом.",
    icon: Sparkles,
    demo: AiDemo,
  },
  {
    key: "publish",
    num: "03",
    title: "Автопостинг",
    caption: "Встаёт в календарь и выходит сам. Ноутбук можно закрыть.",
    icon: CalendarCheck,
    demo: PublishDemo,
  },
  {
    key: "reactions",
    num: "04",
    title: "Реакции",
    caption: "Смотрим, что зашло, и это идёт в следующую разведку.",
    icon: TrendingUp,
    demo: ReactionsDemo,
  },
];

/* --------------------------------------------------------------- КАРТОЧКА ШАГА */

function StepCard({ step, active }: { step: Step; active: boolean }) {
  const reduce = useReducedMotion();
  const Icon = step.icon;
  const Demo = step.demo;

  return (
    <motion.div
      className="relative h-full"
      initial={false}
      animate={{ opacity: active ? 1 : 0.55, scale: active && !reduce ? 1.03 : 1 }}
      transition={reduce ? { duration: 0 } : { duration: 0.45, ease: EASE }}
      style={{ zIndex: active ? 1 : 0 }}
    >
      {/* Свечение — «момент ценности» из ТЗ 7.1 */}
      <motion.span
        aria-hidden
        className="pointer-events-none absolute -inset-4 -z-10 rounded-[32px] bg-brand-gradient blur-2xl"
        initial={false}
        animate={{ opacity: active ? 0.28 : 0 }}
        transition={{ duration: 0.5, ease: EASE }}
      />
      {/* Градиентная рамка в 1px — стекло над ней даёт лёгкий фиолетовый налив */}
      <motion.span
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-[21px] bg-brand-gradient"
        initial={false}
        animate={{ opacity: active ? 1 : 0 }}
        transition={{ duration: 0.35, ease: EASE }}
      />

      <div className="glass-strong relative flex h-full flex-col rounded-lg p-4 xl:p-5">
        <div className="flex items-center gap-3">
          <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-sm bg-surface-inset">
            <motion.span
              aria-hidden
              className="absolute inset-0 rounded-sm bg-brand-gradient"
              initial={false}
              animate={{ opacity: active ? 1 : 0 }}
              transition={{ duration: 0.35, ease: EASE }}
            />
            <Icon
              className={cn(
                "relative h-5 w-5 transition-colors duration-300",
                active ? "text-white" : "text-text-3",
              )}
              strokeWidth={1.75}
            />
          </span>

          <span
            className={cn(
              "nums ml-auto text-[13px] font-extrabold transition-colors duration-500",
              active ? "text-brand" : "text-text-3",
            )}
          >
            {step.num}
          </span>
        </div>

        <h3 className="mt-3.5 text-[17px] leading-tight font-extrabold -tracking-[0.02em] text-text">
          {step.title}
        </h3>

        <Demo active={active} />

        <p className="mt-auto pt-3.5 text-[14px] leading-relaxed text-text-2">{step.caption}</p>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------- СЕКЦИЯ */

export function Cycle() {
  const reduce = useReducedMotion();
  const uid = useId();
  const gradId = `cycle-arc-${uid.replace(/:/g, "")}`;

  // Активный шаг считаем от прокрутки самой ленты: круг «едет» вместе с человеком.
  const trackRef = useRef<HTMLOListElement>(null);
  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ["start 70%", "end 40%"],
  });

  const [active, setActive] = useState(0);

  useMotionValueEvent(scrollYProgress, "change", (p) => {
    const next = Math.min(STEPS.length - 1, Math.max(0, Math.floor(p * STEPS.length)));
    setActive((cur) => (cur === next ? cur : next));
  });

  // Дуга возврата дорисовывается ровно тогда, когда загорается четвёртый шаг
  const arcDraw = useTransform(scrollYProgress, [0.72, 1], [0, 1]);
  const arcHead = useTransform(scrollYProgress, [0.93, 1], [0, 1]);

  return (
    <section
      id="cycle"
      aria-labelledby={`${uid}-title`}
      className="relative isolate overflow-hidden bg-bg py-24 sm:py-32"
    >
      <AuroraBackground intensity="section" grid={false} />

      <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
        {/* ------------------------------------------------------- ЗАГОЛОВОК */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-2xl text-center"
        >
          <Badge tone="brand">Формула продукта</Badge>

          <h2
            id={`${uid}-title`}
            className="display mt-5 text-[38px] text-text sm:text-[46px] lg:text-[52px]"
          >
            Замкнутый <span className="text-gradient">круг</span>, которого нет ни у кого
          </h2>

          <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-text-2">
            Каждый следующий пост умнее предыдущего: платформа смотрит, что зашло, и учитывает это в
            разведке.
          </p>
        </motion.div>

        {/* ----------------------------------------------------------- ЛЕНТА */}
        <ol
          ref={trackRef}
          className="mt-14 grid grid-cols-1 gap-3 sm:mt-16 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] lg:items-stretch"
        >
          {STEPS.map((step, i) => (
            <Fragment key={step.key}>
              <motion.li
                className="min-w-0"
                initial={reduce ? false : { opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.5, delay: reduce ? 0 : i * 0.07, ease: EASE }}
              >
                <StepCard step={step} active={active === i} />
              </motion.li>

              {i < STEPS.length - 1 && (
                <li
                  aria-hidden
                  className="flex items-center justify-center py-1 lg:py-0"
                >
                  <ArrowDown
                    className={cn(
                      "h-5 w-5 transition-all duration-500 ease-[var(--ease-soft)] lg:hidden",
                      active > i ? "scale-110 text-brand" : "scale-100 text-text-3/60",
                    )}
                    strokeWidth={2}
                  />
                  <ArrowRight
                    className={cn(
                      "hidden h-5 w-5 transition-all duration-500 ease-[var(--ease-soft)] lg:block",
                      active > i ? "scale-110 text-brand" : "scale-100 text-text-3/60",
                    )}
                    strokeWidth={2}
                  />
                </li>
              )}
            </Fragment>
          ))}
        </ol>

        {/* --------------------------------- ЗАМЫКАНИЕ КРУГА: дуга возврата (lg+) */}
        <div aria-hidden className="relative mt-3 hidden h-[120px] w-full lg:block">
          <svg viewBox="0 0 1200 120" className="h-[120px] w-full" fill="none">
            <defs>
              <linearGradient id={gradId} x1="1200" y1="0" x2="0" y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0%" style={{ stopColor: "var(--brand-2)" }} />
                <stop offset="100%" style={{ stopColor: "var(--brand-1)" }} />
              </linearGradient>
            </defs>

            {/* От «Реакций» вниз, налево под всей лентой и вверх — обратно в «Разведку» */}
            <motion.path
              d="M 1050 2 C 1050 90 1050 96 600 96 C 150 96 150 90 150 2"
              stroke={`url(#${gradId})`}
              strokeWidth={2}
              strokeLinecap="round"
              style={{ pathLength: reduce ? 1 : arcDraw }}
            />
            <motion.path
              d="M 141 13 L 150 2 L 159 13"
              stroke={`url(#${gradId})`}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ opacity: reduce ? 1 : arcHead }}
            />
          </svg>

          <span className="absolute bottom-[14px] left-1/2 -translate-x-1/2 rounded-full border border-line bg-bg px-3 py-1.5 text-[14px] font-bold text-brand">
            уже умнее
          </span>
        </div>

        {/* ------------------------------------ ЗАМЫКАНИЕ КРУГА: на мобиле (стрелка) */}
        <div aria-hidden className="mt-3 flex justify-center lg:hidden">
          <ArrowDown className="h-5 w-5 text-brand" strokeWidth={2} />
        </div>

        {/* ----------------------------------------------------------- АКЦЕНТ */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.5, ease: EASE }}
          className="mt-6 flex flex-col items-center gap-5 text-center lg:mt-2"
        >
          <div className="glass inline-flex items-center gap-3 rounded-full py-2.5 pr-6 pl-2.5">
            <motion.span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-white"
              animate={reduce ? {} : { rotate: 360 }}
              transition={{ duration: 6, ease: "linear", repeat: Infinity }}
            >
              <RefreshCw className="h-[18px] w-[18px]" strokeWidth={2.25} />
            </motion.span>
            <span className="text-[16px] font-extrabold -tracking-[0.01em] text-text sm:text-[18px]">
              и снова разведка, уже умнее
            </span>
          </div>

          {/* Честный аргумент из разведки рынка (ТЗ 2) — не маркетинговый туман */}
          <p className="max-w-xl text-[15px] leading-relaxed text-text-2 sm:text-[16px]">
            Мы протестировали 8 сервисов. У кого-то есть постинг, у кого-то разведка — но круг не
            замыкает никто. Поэтому их ИИ пишет вслепую, а наш — с опорой на то, что уже сработало у
            тебя.
          </p>
        </motion.div>
      </div>
    </section>
  );
}

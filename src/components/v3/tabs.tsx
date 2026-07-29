"use client";

// ЦЕНТРАЛЬНЫЙ БЛОК v3 — вкладочный пульт «Как это работает».
// Сливает бывшие секции Cycle и HowTo в один пульт: 5 вкладок-клавиш,
// каждая = пункты (въезжают каскадом) + живое мини-демо.
// Выбранный таб «вдавлен» в пульт (радио-метафора). Клавиатура: ← → Home End.
import { useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Check, RefreshCw } from "lucide-react";
import { V3Reveal } from "./reveal";

const EASE = [0.22, 1, 0.36, 1] as const;

/* --------------------------------------------------------- МИНИ-ДЕМО */

function TgGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M21.9 4.6c.2-1-.6-1.7-1.5-1.3L2.7 9.9c-1 .4-1 1.9.1 2.2l4.3 1.4 1.6 5.1c.3 1 1.5 1.2 2.2.5l2.3-2.3 4.4 3.2c.8.6 2 .2 2.2-.8l2.1-14.6Z" />
    </svg>
  );
}

function DemoFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="img"
      aria-label={label}
      className="v3-card flex min-h-[240px] flex-col justify-center gap-3 p-5 2xl:min-h-[300px] 2xl:gap-4 2xl:p-7"
    >
      {children}
    </div>
  );
}

function ReconDemo() {
  return (
    <DemoFrame label="Досье конкурента: канал «Сварил сам», залёт в 7,8 раза выше нормы и график роста">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-[var(--ink)] bg-[var(--acc)] text-[13px] font-black">
          СС
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px] leading-tight font-bold">Сварил сам</p>
          <p className="v3-mono truncate text-[11.5px] text-[var(--ink-2)]">@svaril_sam</p>
        </div>
        <span className="v3-chip v3-chip--acc ml-auto">×7,8 залёт</span>
      </div>

      <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-10 w-full" fill="none">
        <polygon
          points="2,26 16,24 30,25 44,20 58,22 72,15 84,11 96,5 96,32 2,32"
          fill="var(--acc)"
          fillOpacity={0.3}
        />
        <polyline
          points="2,26 16,24 30,25 44,20 58,22 72,15 84,11 96,5"
          stroke="var(--ink)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <p className="v3-mono text-[11.5px] tracking-[0.04em] text-[var(--ink-2)] uppercase">
        71 400 просмотров · медиана 9 200
      </p>
    </DemoFrame>
  );
}

function AiDemo() {
  return (
    <DemoFrame label="Карточка идеи «Сними это»: заголовок, сценарий из двух шагов и формат">
      <span className="v3-chip v3-chip--acc w-fit">Сними это</span>
      <p className="text-[16px] leading-snug font-bold">Кофе горчит? Дело в помоле</p>
      <ul className="space-y-1.5">
        {["Хук в первой секунде", "Решение — за 40 секунд"].map((line) => (
          <li key={line} className="flex items-start gap-2 text-[14px] text-[var(--ink-2)]">
            <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 bg-[var(--ink)]" />
            {line}
          </li>
        ))}
      </ul>
      <span className="v3-chip w-fit">Видео · 40 сек</span>
    </DemoFrame>
  );
}

function PublishDemo() {
  const POST_DAY = 3;
  const BUSY = [1, 5];
  return (
    <DemoFrame label="Неделя календаря: пост запланирован на четверг и вышел сам в Telegram">
      <p className="v3-mono text-[11px] font-semibold tracking-[0.1em] text-[var(--ink-2)] uppercase">
        Твоя неделя
      </p>
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: 7 }, (_, d) => (
          <div
            key={d}
            className={`relative h-11 border-2 border-[var(--ink)] ${
              d === POST_DAY ? "bg-[var(--acc)]" : "bg-[var(--paper)]"
            }`}
          >
            {d === POST_DAY && (
              <Check className="absolute inset-0 m-auto h-5 w-5" strokeWidth={3} aria-hidden />
            )}
            {BUSY.includes(d) && (
              <span className="absolute inset-x-[3px] bottom-[3px] h-2 bg-[var(--ink)] opacity-15" />
            )}
          </div>
        ))}
      </div>
      <p className="flex items-center gap-2 text-[14px] font-bold text-[var(--green)]">
        <span className="flex h-6 w-6 items-center justify-center border-2 border-[var(--ink)] bg-[var(--green)] text-white">
          <Check className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden />
        </span>
        пост вышел
        <span className="v3-mono ml-auto flex items-center gap-1.5 text-[11px] font-medium text-[var(--ink-2)]">
          <TgGlyph className="h-3.5 w-3.5" />
          12:00
        </span>
      </p>
    </DemoFrame>
  );
}

const BARS = [24, 32, 28, 42, 38, 54, 50, 68, 84, 100];

function ReactionsDemo() {
  const reduce = useReducedMotion();
  return (
    <DemoFrame label="График охвата идёт вверх: плюс 34 процента">
      <p className="v3-mono text-[11px] font-semibold tracking-[0.1em] text-[var(--ink-2)] uppercase">
        Охват за неделю
      </p>
      <div className="flex h-16 items-end gap-1.5">
        {BARS.map((h, i) => (
          <motion.span
            key={i}
            className={`h-full flex-1 border border-[var(--ink)] ${
              i >= 7 ? "bg-[var(--acc)]" : "bg-[var(--ink)]"
            }`}
            initial={false}
            animate={{ scaleY: h / 100 }}
            style={{ transformOrigin: "bottom" }}
            transition={reduce ? { duration: 0 } : { duration: 0.4, delay: 0.05 + i * 0.04, ease: EASE }}
          />
        ))}
      </div>
      <p className="flex items-baseline gap-2">
        <span className="v3-display text-[26px] font-black text-[var(--green)]">+34%</span>
        <span className="v3-mono text-[11px] tracking-[0.08em] text-[var(--ink-2)] uppercase">
          охват
        </span>
      </p>
    </DemoFrame>
  );
}

const START_STEPS = [
  { num: "1", time: "2 минуты", title: "Подключи канал", note: "Бот получает ровно одно право — публиковать." },
  { num: "2", time: "1 минута", title: "Добавь конкурентов", note: "2–3 ссылки — через час досье готово." },
  { num: "3", time: "15 мин в неделю", title: "Подтверждай готовое", note: "Одна кнопка — дальше сервер сам." },
] as const;

function StartDemo() {
  return (
    <div className="flex flex-col gap-3" role="img" aria-label="Три шага старта: подключи канал, добавь конкурентов, подтверждай готовые посты">
      {START_STEPS.map((s) => (
        <div key={s.num} className="v3-card flex items-center gap-3.5 p-3.5">
          <span className="v3-display flex h-9 w-9 shrink-0 items-center justify-center border-2 border-[var(--ink)] bg-[var(--acc)] text-[15px] font-black">
            {s.num}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14.5px] font-bold">{s.title}</p>
            <p className="truncate text-[13px] text-[var(--ink-2)]">{s.note}</p>
          </div>
          <span className="v3-chip shrink-0">{s.time}</span>
        </div>
      ))}
      <Link href="/register" className="v3-btn mt-1 w-full">
        Забрать ранний доступ
        <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden />
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------ ДАННЫЕ */

type Tab = {
  id: string;
  label: string;
  lead: string;
  bullets: string[];
  Demo: () => React.JSX.Element;
};

const TABS: Tab[] = [
  {
    id: "recon",
    label: "Разведка",
    lead: "Платформа смотрит за конкурентами, пока ты занимаешься делом.",
    bullets: [
      "Конкуренты под наблюдением каждые 2–3 часа",
      "Ловим залёты — в 7–8 раз выше их медианы",
      "Досье человеческим языком: что забрать себе",
    ],
    Demo: ReconDemo,
  },
  {
    id: "ai",
    label: "ИИ-контент",
    lead: "Не текст ради текста, а пост с опорой на то, что уже работает.",
    bullets: [
      "Пишет твоим голосом — учится на твоих постах",
      "Опора на то, что уже зашло у тебя и у конкурентов",
      "Карточка «Сними это»: хук, сценарий, формат",
    ],
    Demo: AiDemo,
  },
  {
    id: "publish",
    label: "Автопостинг",
    lead: "Ноутбук можно закрыть — публикует сервер.",
    bullets: [
      "План недели одной кнопкой в Telegram-боте",
      "Посты выходят сами, по расписанию",
      "Сбой? Три попытки и честное письмо в бот",
    ],
    Demo: PublishDemo,
  },
  {
    id: "reactions",
    label: "Реакции",
    lead: "Круг замыкается: итоги идут в следующую разведку.",
    bullets: [
      "Видно, что зашло: охват, прирост, сохранения",
      "Удачные темы усиливаются, слабые уходят",
      "Каждый следующий пост умнее предыдущего",
    ],
    Demo: ReactionsDemo,
  },
  {
    id: "start",
    label: "Старт за 5 минут",
    lead: "От регистрации до первого запланированного поста.",
    bullets: [
      "Подключи канал — бот получает право только публиковать",
      "Добавь 2–3 конкурента обычными ссылками",
      "Подтверждай готовые посты — 15 минут в неделю",
    ],
    Demo: StartDemo,
  },
];

/* ------------------------------------------------------------ СЕКЦИЯ */

export function V3Tabs() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Клавиатурная навигация по WAI-ARIA tabs pattern
  function onKeyDown(e: React.KeyboardEvent) {
    const last = TABS.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = active === last ? 0 : active + 1;
    if (e.key === "ArrowLeft") next = active === 0 ? last : active - 1;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  const tab = TABS[active];

  return (
    <section id="how" aria-labelledby="v3-how-title" className="border-y-2 border-[var(--ink)] bg-[var(--sheet)] py-20 sm:py-28">
      <div className="v3-wrap">
        <V3Reveal className="mx-auto max-w-2xl text-center">
          <p className="v3-kicker v3-kicker--center justify-center">Формула продукта</p>
          <h2
            id="v3-how-title"
            className="v3-display mt-6 text-[clamp(1.9rem,4.4vw,3.2rem)] leading-[1.04] font-black uppercase"
          >
            Замкнутый круг, которого нет ни у кого
          </h2>
          <p className="v3-body mx-auto mt-5 max-w-xl text-[16px]">
            Разведка → ИИ-контент → автопостинг → реакции → снова разведка, уже умнее.
          </p>
        </V3Reveal>

        <V3Reveal delay={0.08} className="mt-12">
          <div className="v3-panel">
            {/* Полоса вкладок: на мобиле — скролл-ряд клавиш */}
            <div
              role="tablist"
              aria-label="Как работает платформа"
              onKeyDown={onKeyDown}
              className="flex gap-3 overflow-x-auto border-b-2 border-[var(--ink)] bg-[var(--paper)] p-4"
            >
              {TABS.map((t, i) => (
                <button
                  key={t.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  role="tab"
                  id={`v3-tab-${t.id}`}
                  aria-selected={active === i}
                  aria-controls={`v3-panel-${t.id}`}
                  tabIndex={active === i ? 0 : -1}
                  onClick={() => setActive(i)}
                  className="v3-tab"
                >
                  <span className="v3-mono text-[10px] opacity-60">0{i + 1}</span>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Контент вкладки: смена — резкий сдвиг, пункты каскадом */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab.id}
                role="tabpanel"
                id={`v3-panel-${tab.id}`}
                aria-labelledby={`v3-tab-${tab.id}`}
                initial={reduce ? false : { opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduce ? undefined : { opacity: 0, x: -24 }}
                transition={{ duration: 0.18, ease: EASE }}
                className="grid items-center gap-8 p-6 sm:p-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)] 2xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] 2xl:gap-14 2xl:p-12"
              >
                <div>
                  <p className="v3-display text-[clamp(1.15rem,2.2vw,1.5rem)] leading-snug font-bold">
                    {tab.lead}
                  </p>
                  <motion.ul
                    className="mt-6 space-y-3"
                    initial="hidden"
                    animate="show"
                    variants={{
                      hidden: {},
                      show: { transition: { staggerChildren: reduce ? 0 : 0.05 } },
                    }}
                  >
                    {tab.bullets.map((b) => (
                      <motion.li
                        key={b}
                        variants={{
                          hidden: reduce ? {} : { opacity: 0, x: 18 },
                          show: { opacity: 1, x: 0 },
                        }}
                        transition={{ duration: 0.25, ease: EASE }}
                        className="flex items-start gap-3 text-[15.5px] leading-relaxed"
                      >
                        <span
                          aria-hidden
                          className="mt-[7px] h-2.5 w-2.5 shrink-0 border border-[var(--ink)] bg-[var(--acc)]"
                        />
                        {b}
                      </motion.li>
                    ))}
                  </motion.ul>
                </div>

                <motion.div
                  initial={reduce ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: reduce ? 0 : 0.12, ease: EASE }}
                >
                  <tab.Demo />
                </motion.div>
              </motion.div>
            </AnimatePresence>
          </div>
        </V3Reveal>

        {/* Замыкание круга + честный аргумент из разведки рынка */}
        <V3Reveal delay={0.1} className="mt-10 flex flex-col items-center gap-5 text-center">
          <p className="v3-chip v3-chip--ink">
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
            и снова разведка, уже умнее
          </p>
          <p className="v3-body max-w-xl text-[15.5px]">
            Мы протестировали 8 сервисов. У кого-то есть постинг, у кого-то разведка — но круг не
            замыкает никто. Поэтому их ИИ пишет вслепую, а наш —{" "}
            <strong>с опорой на то, что уже сработало у тебя</strong>.
          </p>
        </V3Reveal>
      </div>
    </section>
  );
}

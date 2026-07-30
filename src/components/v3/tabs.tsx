"use client";

// ЦЕНТРАЛЬНЫЙ БЛОК v3 — интерактивный редакционный конвейер.
// Все четыре этапа видны одной линией; выбранный этап раскрывает рабочий лист,
// решение системы и живое мини-демо. Клавиатура: ← → Home End.
import { useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  BarChart3,
  Check,
  FileText,
  RefreshCw,
  Search,
  Send,
  type LucideIcon,
} from "lucide-react";
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

const START_STEPS = ["Подключи канал", "Добавь конкурентов", "Подтверди направление"] as const;

/* ------------------------------------------------------------ ДАННЫЕ */

type Tab = {
  id: string;
  num: string;
  label: string;
  action: string;
  metric: string;
  metricLabel: string;
  stamp: string;
  lead: string;
  bullets: string[];
  decision: string;
  Icon: LucideIcon;
  Demo: () => React.JSX.Element;
};

const TABS: Tab[] = [
  {
    id: "recon",
    num: "01",
    label: "Сигнал",
    action: "Находит сигнал",
    metric: "×7,8",
    metricLabel: "выше медианы",
    stamp: "Найдено",
    lead: "Платформа смотрит за конкурентами, пока ты занимаешься делом.",
    bullets: [
      "Конкуренты под наблюдением каждые 2–3 часа",
      "Ловим залёты — в 7–8 раз выше их медианы",
      "Досье человеческим языком: что забрать себе",
    ],
    decision: "Сигнал передан редактору: забрать механику хука, не копируя материал.",
    Icon: Search,
    Demo: ReconDemo,
  },
  {
    id: "ai",
    num: "02",
    label: "Материал",
    action: "Собирает материал",
    metric: "40 сек",
    metricLabel: "готовый сценарий",
    stamp: "Готово",
    lead: "Не текст ради текста, а пост с опорой на то, что уже работает.",
    bullets: [
      "Пишет твоим голосом — учится на твоих постах",
      "Опора на то, что уже зашло у тебя и у конкурентов",
      "Карточка «Сними это»: хук, сценарий, формат",
    ],
    decision: "Материал собран в голосе канала и готов к подтверждению.",
    Icon: FileText,
    Demo: AiDemo,
  },
  {
    id: "publish",
    num: "03",
    label: "Публикация",
    action: "Выпускает пост",
    metric: "12:00",
    metricLabel: "точно по плану",
    stamp: "Опубликовано",
    lead: "Ноутбук можно закрыть — публикует сервер.",
    bullets: [
      "План недели одной кнопкой в Telegram-боте",
      "Посты выходят сами, по расписанию",
      "Сбой? Три попытки и честное письмо в бот",
    ],
    decision: "Пост опубликован. Теперь система ждёт реальные реакции аудитории.",
    Icon: Send,
    Demo: PublishDemo,
  },
  {
    id: "reactions",
    num: "04",
    label: "Реакция",
    action: "Считывает реакцию",
    metric: "+34%",
    metricLabel: "рост охвата",
    stamp: "Усилить",
    lead: "Круг замыкается: итоги идут в следующую разведку.",
    bullets: [
      "Видно, что зашло: охват, прирост, сохранения",
      "Удачные темы усиливаются, слабые уходят",
      "Каждый следующий пост умнее предыдущего",
    ],
    decision: "Рабочая механика сохранена — следующий цикл начнётся уже с этим знанием.",
    Icon: BarChart3,
    Demo: ReactionsDemo,
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
  const ActiveIcon = tab.Icon;

  return (
    <section
      id="how"
      aria-labelledby="v3-how-title"
      className="v3-cycle-section border-y-2 border-[var(--ink)] bg-[var(--sheet)] py-20 sm:py-28"
    >
      <div className="v3-wrap">
        <V3Reveal className="v3-cycle-intro">
          <div>
            <p className="v3-kicker">Редакционный конвейер</p>
            <h2
              id="v3-how-title"
              className="v3-display mt-6 text-[clamp(2.15rem,4.7vw,4.35rem)] leading-[0.98] font-black uppercase"
            >
              От сигнала — до сильного поста
            </h2>
          </div>
          <div className="v3-cycle-intro__copy">
            <span className="v3-cycle-intro__index">03 / Как это работает</span>
            <p className="v3-body text-[16px] sm:text-[17px]">
              Четыре этапа работают как одна редакция: находят сигнал, собирают материал,
              публикуют и возвращают реакцию в следующий выпуск.
            </p>
          </div>
        </V3Reveal>

        <V3Reveal delay={0.08} className="mt-12 sm:mt-16">
          <div className="v3-cycle-machine">
            <div className="v3-cycle-statusbar">
              <span className="v3-cycle-statusbar__live">
                <span aria-hidden />
                Конвейер работает
              </span>
              <span>Выпуск №0048</span>
              <span>Сигнал → материал → канал → реакция</span>
              <span className="v3-cycle-statusbar__last">Редакция онлайн</span>
            </div>

            <div className="v3-conveyor-workspace">
              <div
                role="tablist"
                aria-label="Редакционный конвейер Авроры"
                onKeyDown={onKeyDown}
                className="v3-conveyor-track"
              >
                <motion.span
                  className="v3-conveyor-marker"
                  animate={{ x: `${active * 100}%` }}
                  transition={reduce ? { duration: 0 } : { duration: 0.22, ease: EASE }}
                  aria-hidden
                >
                  <span />
                </motion.span>

                {TABS.map((t, i) => {
                  const Icon = t.Icon;
                  return (
                    <button
                      key={t.id}
                      ref={(el) => {
                        tabRefs.current[i] = el;
                      }}
                      type="button"
                      role="tab"
                      id={`v3-tab-${t.id}`}
                      aria-selected={active === i}
                      aria-controls={`v3-panel-${t.id}`}
                      tabIndex={active === i ? 0 : -1}
                      onClick={() => setActive(i)}
                      className="v3-conveyor-step"
                    >
                      <span className="v3-conveyor-step__topline">
                        <span>Этап {t.num}</span>
                        <Icon className="h-4 w-4" strokeWidth={2.6} aria-hidden />
                      </span>
                      <strong className="v3-conveyor-step__number">{t.num}</strong>
                      <span className="v3-conveyor-step__label">{t.label}</span>
                      <small>{t.action}</small>
                      <span className="v3-conveyor-step__metric">
                        <b>{t.metric}</b>
                        {t.metricLabel}
                      </span>
                    </button>
                  );
                })}

              </div>

              <AnimatePresence mode="wait" initial={false}>
                <motion.aside
                  key={tab.id}
                  role="tabpanel"
                  id={`v3-panel-${tab.id}`}
                  aria-labelledby={`v3-tab-${tab.id}`}
                  initial={reduce ? false : { x: 72 }}
                  animate={{ x: 0 }}
                  exit={reduce ? undefined : { x: -72 }}
                  transition={{ duration: 0.18, ease: EASE }}
                  className="v3-conveyor-sheet"
                >
                  <div className="v3-conveyor-sheet__head">
                    <span className="v3-conveyor-sheet__folio">Лист {tab.num} / 04</span>
                    <span className="v3-conveyor-sheet__title">
                      <ActiveIcon className="h-5 w-5" strokeWidth={2.7} aria-hidden />
                      Сейчас в работе: {tab.label}
                    </span>
                    <span className={`v3-conveyor-stamp v3-conveyor-stamp--${tab.id}`}>
                      {tab.stamp}
                    </span>
                  </div>

                  <div className="v3-conveyor-sheet__body">
                    <div className="v3-conveyor-sheet__copy">
                      <div className="v3-conveyor-sheet__metric">
                        <strong>{tab.metric}</strong>
                        <span>{tab.metricLabel}</span>
                      </div>
                      <p>{tab.lead}</p>
                      <motion.ul
                        initial="hidden"
                        animate="show"
                        variants={{
                          hidden: {},
                          show: { transition: { staggerChildren: reduce ? 0 : 0.05 } },
                        }}
                      >
                        {tab.bullets.map((bullet) => (
                          <motion.li
                            key={bullet}
                            variants={{
                              hidden: reduce ? {} : { opacity: 0, x: 16 },
                              show: { opacity: 1, x: 0 },
                            }}
                            transition={{ duration: 0.24, ease: EASE }}
                          >
                            <span aria-hidden />
                            {bullet}
                          </motion.li>
                        ))}
                      </motion.ul>
                    </div>

                    <motion.div
                      initial={reduce ? false : { x: 34 }}
                      animate={{ x: 0 }}
                      transition={{ duration: 0.28, delay: reduce ? 0 : 0.1, ease: EASE }}
                    >
                      <tab.Demo />
                    </motion.div>
                  </div>

                  <div className="v3-conveyor-sheet__decision">
                    <RefreshCw className="h-4 w-4" strokeWidth={2.7} aria-hidden />
                    <span>
                      <small>Решение системы</small>
                      {tab.decision}
                    </span>
                  </div>
                </motion.aside>
              </AnimatePresence>
            </div>

            <div className="v3-conveyor-return">
              <span className="v3-conveyor-return__corner" aria-hidden>↑</span>
              <span className="v3-conveyor-return__line" aria-hidden />
              <span className="v3-conveyor-return__text">
                <RefreshCw className="h-4 w-4" strokeWidth={2.8} aria-hidden />
                Следующий материал становится точнее
              </span>
              <span className="v3-conveyor-return__line" aria-hidden />
              <span className="v3-conveyor-return__corner" aria-hidden>┘</span>
            </div>
          </div>
        </V3Reveal>

        <V3Reveal delay={0.1} className="mt-6">
          <div className="v3-cycle-start">
            <div className="v3-cycle-start__title">
              <span>05 / Запуск</span>
              <strong>Первый цикл — за 5 минут</strong>
            </div>
            <ol>
              {START_STEPS.map((step, index) => (
                <li key={step}>
                  <span>0{index + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
            <Link href="/register" className="v3-btn v3-btn--ink">
              Запустить первый цикл бесплатно
              <ArrowRight className="h-4 w-4" strokeWidth={2.6} aria-hidden />
            </Link>
          </div>
        </V3Reveal>
      </div>
    </section>
  );
}

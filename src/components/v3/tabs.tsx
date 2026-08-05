"use client";

// Компактное объяснение рабочего цикла Авроры.
// Четыре этапа переключают один результат без повторов и тяжёлой UI-хроматики.
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
      className="v3-card v3-compact-demo flex min-h-[200px] flex-col justify-center gap-3 p-5 2xl:p-6"
    >
      {children}
    </div>
  );
}

function ReconDemo() {
  return (
    <DemoFrame label="Демонстрационное досье канала с отмеченным сигналом роста">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-[var(--ink)] bg-[var(--acc)] text-[13px] font-black">
          СС
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px] leading-tight font-bold">Демо-канал</p>
          <p className="v3-mono truncate text-[12px] text-[var(--ink-2)]">@demo_channel</p>
        </div>
        <span className="v3-chip v3-chip--acc ml-auto">Сигнал найден</span>
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

      <p className="v3-mono text-[12px] tracking-[0.04em] text-[var(--ink-2)] uppercase">
        Необычный рост отмечен · данные демонстрационные
      </p>
    </DemoFrame>
  );
}

function AiDemo() {
  return (
    <DemoFrame label="Карточка идеи для публикации: заголовок, сценарий из двух шагов и формат">
      <span className="v3-chip v3-chip--acc w-fit">Создать публикацию</span>
      <p className="text-[16px] leading-snug font-bold">Кофе горчит? Дело в помоле</p>
      <ul className="space-y-1.5">
        {["Хук в первой строке", "Короткое решение без воды"].map((line) => (
          <li key={line} className="flex items-start gap-2 text-[14px] text-[var(--ink-2)]">
            <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 bg-[var(--ink)]" />
            {line}
          </li>
        ))}
      </ul>
      <span className="v3-chip w-fit">Формат определён</span>
    </DemoFrame>
  );
}

function PublishDemo() {
  const POST_DAY = 3;
  const BUSY = [1, 5];
  return (
    <DemoFrame label="Неделя календаря: пост запланирован на четверг и вышел сам в Telegram">
      <p className="v3-mono text-[12px] font-semibold tracking-[0.1em] text-[var(--ink-2)] uppercase">
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
        <span className="v3-mono ml-auto flex items-center gap-1.5 text-[12px] font-medium text-[var(--ink-2)]">
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
    <DemoFrame label="Демонстрационный график: система отметила растущую тему">
      <p className="v3-mono text-[12px] font-semibold tracking-[0.1em] text-[var(--ink-2)] uppercase">
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
        <span className="v3-display text-[24px] font-black text-[var(--green)]">Рост замечен</span>
        <span className="v3-mono text-[12px] tracking-[0.08em] text-[var(--ink-2)] uppercase">
          усилить тему
        </span>
      </p>
    </DemoFrame>
  );
}

/* ------------------------------------------------------------ ДАННЫЕ */

type Tab = {
  id: string;
  num: string;
  label: string;
  lead: string;
  bullets: string[];
  outcome: string;
  Icon: LucideIcon;
  Demo: () => React.JSX.Element;
};

const TABS: Tab[] = [
  {
    id: "recon",
    num: "01",
    label: "Сигнал",
    lead: "Платформа смотрит за конкурентами, пока ты занимаешься делом.",
    bullets: [
      "Конкуренты проверяются по расписанию",
      "Посты с необычным ростом получают отдельный сигнал",
    ],
    outcome: "В редактор уходит идея — не копия чужого поста.",
    Icon: Search,
    Demo: ReconDemo,
  },
  {
    id: "ai",
    num: "02",
    label: "Материал",
    lead: "Не текст ради текста, а пост с опорой на то, что уже работает.",
    bullets: [
      "Пишет твоим голосом — учится на твоих постах",
      "Опора на то, что уже зашло у тебя и у конкурентов",
    ],
    outcome: "Получаешь черновик в голосе своего канала.",
    Icon: FileText,
    Demo: AiDemo,
  },
  {
    id: "publish",
    num: "03",
    label: "Публикация",
    lead: "Ноутбук можно закрыть — публикует сервер.",
    bullets: [
      "План недели одной кнопкой в Telegram-боте",
      "Посты выходят сами, по расписанию",
    ],
    outcome: "Пост выходит по расписанию, даже когда ты офлайн.",
    Icon: Send,
    Demo: PublishDemo,
  },
  {
    id: "reactions",
    num: "04",
    label: "Реакция",
    lead: "Круг замыкается: итоги идут в следующую разведку.",
    bullets: [
      "Видно, какие темы отработали сильнее",
      "Удачные темы усиливаются, слабые уходят",
    ],
    outcome: "Удачный приём сохраняется для следующего материала.",
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
      className="v3-cycle-section border-y-2 border-[var(--ink)] bg-[var(--sheet)] py-14 sm:py-16"
    >
      <div className="v3-wrap">
        <V3Reveal className="v3-cycle-intro">
          <div>
            <p className="v3-kicker">Как это работает</p>
            <h2
              id="v3-how-title"
              className="v3-display mt-6 text-[clamp(2.15rem,4.7vw,4.35rem)] leading-[0.98] font-black uppercase"
            >
              4 шага. Один готовый пост.
            </h2>
          </div>
          <div className="v3-cycle-intro__copy">
            <span className="v3-cycle-intro__index">Один замкнутый цикл</span>
            <p className="v3-body text-[16px] sm:text-[17px]">
              Аврора связывает поиск темы, черновик, публикацию и обратную связь. Ты задаёшь
              правила и сохраняешь последнее слово.
            </p>
          </div>
        </V3Reveal>

        <V3Reveal delay={0.08} className="mt-10 sm:mt-12">
          <div className="v3-compact-cycle">
            <div
              role="tablist"
              aria-label="Рабочий цикл Авроры"
              onKeyDown={onKeyDown}
              className="v3-compact-cycle__tabs"
            >
              {TABS.map((item, index) => {
                const Icon = item.Icon;
                return (
                  <button
                    key={item.id}
                    ref={(element) => {
                      tabRefs.current[index] = element;
                    }}
                    type="button"
                    role="tab"
                    id={`v3-tab-${item.id}`}
                    aria-selected={active === index}
                    aria-controls={`v3-panel-${item.id}`}
                    tabIndex={active === index ? 0 : -1}
                    onClick={() => setActive(index)}
                  >
                    <span>{item.num}</span>
                    <strong>{item.label}</strong>
                    <Icon aria-hidden strokeWidth={2.5} />
                  </button>
                );
              })}
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab.id}
                role="tabpanel"
                id={`v3-panel-${tab.id}`}
                aria-labelledby={`v3-tab-${tab.id}`}
                className="v3-compact-cycle__panel"
                initial={reduce ? false : { opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -12 }}
                transition={{ duration: 0.2, ease: EASE }}
              >
                <div className="v3-compact-cycle__copy">
                  <span className="v3-compact-cycle__eyebrow">
                    <ActiveIcon aria-hidden strokeWidth={2.6} />
                    Этап {tab.num} · {tab.label}
                  </span>
                  <h3>{tab.lead}</h3>
                  <ul>
                    {tab.bullets.map((bullet) => (
                      <li key={bullet}>
                        <Check aria-hidden strokeWidth={3} />
                        {bullet}
                      </li>
                    ))}
                  </ul>
                  <div className="v3-compact-cycle__outcome">
                    <RefreshCw aria-hidden strokeWidth={2.7} />
                    <span>
                      <small>На выходе</small>
                      <strong>{tab.outcome}</strong>
                    </span>
                  </div>
                </div>

                <motion.div
                  className="v3-compact-cycle__preview"
                  initial={reduce ? false : { x: 22 }}
                  animate={{ x: 0 }}
                  transition={{ duration: 0.24, ease: EASE }}
                >
                  <tab.Demo />
                </motion.div>
              </motion.div>
            </AnimatePresence>

            <div className="v3-compact-cycle__footer">
              <p>
                <strong>Аврора ведёт цикл.</strong> Ты контролируешь результат.
              </p>
              <Link href="/register" className="v3-btn v3-btn--ink">
                Запустить первый цикл
                <ArrowRight className="h-4 w-4" strokeWidth={2.6} aria-hidden />
              </Link>
            </div>
          </div>
        </V3Reveal>
      </div>
    </section>
  );
}

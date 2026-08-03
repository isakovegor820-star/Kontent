"use client";

import { useState } from "react";
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
import styles from "./how-variants.module.css";

export type HowVariant = 1 | 2 | 3 | 4;

type Step = {
  num: string;
  short: string;
  verb: string;
  object: string;
  description: string;
  result: string;
  Icon: LucideIcon;
};

const STEPS: Step[] = [
  {
    num: "01",
    short: "Сигнал",
    verb: "Находит",
    object: "сильную тему",
    description: "Отмечает необычный рост у выбранных каналов и объясняет, что именно сработало.",
    result: "Есть направление для нового материала.",
    Icon: Search,
  },
  {
    num: "02",
    short: "Материал",
    verb: "Пишет",
    object: "твоим голосом",
    description: "Берёт факты из твоих источников, а подачу — из редакционного профиля канала.",
    result: "Черновик готов к твоей проверке.",
    Icon: FileText,
  },
  {
    num: "03",
    short: "Выпуск",
    verb: "Публикует",
    object: "по расписанию",
    description: "После подтверждения ставит материал в очередь и выпускает его с сервера.",
    result: "Пост выходит, даже когда ноутбук закрыт.",
    Icon: Send,
  },
  {
    num: "04",
    short: "Реакция",
    verb: "Запоминает",
    object: "что сработало",
    description: "Возвращает результат выпуска в следующий цикл, чтобы не начинать заново.",
    result: "Следующий материал получает более точную опору.",
    Icon: BarChart3,
  },
];

const VARIANT_NAMES = ["Полоса", "Глаголы", "Цикл", "Разворот"] as const;
const EASE = [0.22, 1, 0.36, 1] as const;

function VariantNav({ active }: { active: HowVariant }) {
  return (
    <header className={styles.nav}>
      <Link href="/" className={styles.brand} aria-label="Вернуться на главную Авроры">
        <span>А</span>
        Аврора
      </Link>
      <p>4 варианта блока «Как это работает»</p>
      <nav aria-label="Варианты дизайна">
        {VARIANT_NAMES.map((name, index) => {
          const value = (index + 1) as HowVariant;
          return (
            <Link
              key={name}
              href={`/how/${value}`}
              aria-current={active === value ? "page" : undefined}
            >
              <span>0{value}</span>
              {name}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function Cta() {
  return (
    <Link href="/register" className={styles.cta}>
      Запустить первый цикл
      <ArrowRight aria-hidden />
    </Link>
  );
}

function EditorialStrip() {
  const [active, setActive] = useState(0);
  const reduce = useReducedMotion();
  const step = STEPS[active];

  return (
    <section className={`${styles.variant} ${styles.editorial}`} aria-labelledby="how-v1-title">
      <div className={styles.eyebrow}>
        <span>Вариант 01</span>
        <span>Чистая редакционная полоса</span>
      </div>
      <div className={styles.editorialIntro}>
        <h1 id="how-v1-title">
          Канал проходит
          <mark>четыре шага.</mark>
        </h1>
        <p>
          Аврора ведёт материал от найденной темы до следующего выпуска. Ты подключаешься там,
          где нужен контроль.
        </p>
      </div>

      <div className={styles.editorialBody}>
        <div className={styles.editorialSteps} role="tablist" aria-label="Этапы цикла">
          {STEPS.map((item, index) => (
            <button
              key={item.num}
              type="button"
              role="tab"
              aria-selected={active === index}
              onClick={() => setActive(index)}
            >
              <span>{item.num}</span>
              <strong>{item.short}</strong>
              <small>{item.verb}</small>
              <ArrowRight aria-hidden />
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.article
            key={step.num}
            className={styles.editorialResult}
            initial={reduce ? false : { opacity: 0, x: 28 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? undefined : { opacity: 0, x: -20 }}
            transition={{ duration: 0.24, ease: EASE }}
          >
            <step.Icon aria-hidden />
            <p>{step.num} / {step.short}</p>
            <h2>
              {step.verb}
              <span>{step.object}</span>
            </h2>
            <p>{step.description}</p>
            <strong>
              <Check aria-hidden />
              {step.result}
            </strong>
          </motion.article>
        </AnimatePresence>
      </div>

      <div className={styles.editorialFooter}>
        <p>Один материал движется дальше — без четырёх разных сервисов.</p>
        <Cta />
      </div>
    </section>
  );
}

export function V3KineticHow({ production = false }: { production?: boolean }) {
  const [active, setActive] = useState(0);
  const reduce = useReducedMotion();
  const step = STEPS[active];
  const Heading = production ? "h2" : "h1";

  return (
    <section
      id={production ? "how" : undefined}
      className={`${styles.variant} ${styles.kinetic}`}
      aria-labelledby="how-v2-title"
    >
      <div className={styles.eyebrow}>
        <span>{production ? "Механика продукта" : "Вариант 02"}</span>
        <span>{production ? "Как работает Аврора" : "Кинетические глаголы"}</span>
      </div>
      <Heading id="how-v2-title" className={styles.visuallyHidden}>
        Кинетические глаголы
      </Heading>

      <div className={styles.verbStage}>
        <div className={styles.verbList} role="tablist" aria-label="Действия Авроры">
          {STEPS.map((item, index) => (
            <button
              key={item.num}
              id={`how-v2-tab-${item.num}`}
              type="button"
              role="tab"
              aria-selected={active === index}
              aria-controls={`how-v2-panel-${item.num}`}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onClick={() => setActive(index)}
            >
              <strong>{item.verb}</strong>
              {active === index ? (
                <motion.i
                  layoutId="kinetic-verb-marker"
                  aria-hidden
                  transition={{ duration: reduce ? 0 : 0.24, ease: EASE }}
                />
              ) : null}
            </button>
          ))}
        </div>

        <div className={styles.verbCanvas} data-active={active}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.article
              key={step.num}
              id={`how-v2-panel-${step.num}`}
              className={styles.verbResult}
              role="tabpanel"
              aria-labelledby={`how-v2-tab-${step.num}`}
              initial={reduce ? false : { opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: -16 }}
              transition={{ duration: 0.24, ease: EASE }}
            >
              <div className={styles.verbResultMeta}>
                <span className={styles.verbResultIcon}>
                  <step.Icon aria-hidden />
                </span>
                <span>{step.short}</span>
              </div>
              <h2>{step.object}</h2>
              <p>{step.description}</p>
              <strong>{step.result}</strong>
            </motion.article>
          </AnimatePresence>

          <div className={styles.verbProgress} aria-hidden>
            {STEPS.map((item, index) => (
              <span key={item.num} data-state={index === active ? "active" : index < active ? "past" : "next"} />
            ))}
          </div>
        </div>
      </div>

      <div className={styles.kineticFooter}>
        <Cta />
      </div>
    </section>
  );
}

function LivingCycle() {
  const [active, setActive] = useState(0);
  const reduce = useReducedMotion();
  const step = STEPS[active];

  return (
    <section className={`${styles.variant} ${styles.cycle}`} aria-labelledby="how-v3-title">
      <div className={styles.eyebrow}>
        <span>Вариант 03</span>
        <span>Живой замкнутый цикл</span>
      </div>
      <div className={styles.cycleIntro}>
        <h1 id="how-v3-title">
          Выпуск закончился.
          <mark>Следующий уже начался.</mark>
        </h1>
        <p>Реакция аудитории не теряется — она возвращается в поиск следующей темы.</p>
      </div>

      <div className={styles.orbitLayout}>
        <div className={styles.orbit}>
          <motion.div
            className={styles.orbitPulse}
            animate={reduce ? undefined : { rotate: 360 }}
            transition={{ duration: 14, repeat: Infinity, ease: "linear" }}
            aria-hidden
          />
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step.num}
              className={styles.orbitCenter}
              initial={reduce ? false : { opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? undefined : { opacity: 0, scale: 1.06 }}
              transition={{ duration: 0.22, ease: EASE }}
            >
              <step.Icon aria-hidden />
              <span>{step.num} / {step.short}</span>
              <strong>{step.verb}</strong>
              <p>{step.object}</p>
            </motion.div>
          </AnimatePresence>
          {STEPS.map((item, index) => (
            <button
              key={item.num}
              type="button"
              data-slot={index}
              aria-pressed={active === index}
              onClick={() => setActive(index)}
            >
              <span>{item.num}</span>
              <strong>{item.short}</strong>
            </button>
          ))}
        </div>

        <motion.aside
          key={step.result}
          className={styles.cycleResult}
          initial={reduce ? false : { opacity: 0, x: 22 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.22, ease: EASE }}
        >
          <span>Что происходит</span>
          <p>{step.description}</p>
          <strong>
            <RefreshCw aria-hidden />
            {step.result}
          </strong>
          <Cta />
        </motion.aside>
      </div>
    </section>
  );
}

function MagazineSpread() {
  const [active, setActive] = useState(0);
  const reduce = useReducedMotion();
  const step = STEPS[active];

  return (
    <section className={`${styles.variant} ${styles.magazine}`} aria-labelledby="how-v4-title">
      <div className={styles.eyebrow}>
        <span>Вариант 04</span>
        <span>Журнальный разворот</span>
      </div>
      <div className={styles.magazineGrid}>
        <header>
          <p>Ты задаёшь голос и границы.</p>
          <h1 id="how-v4-title">
            Аврора держит
            <mark>движение.</mark>
          </h1>
          <Cta />
        </header>

        <div className={styles.magazineSteps}>
          {STEPS.map((item, index) => (
            <button
              key={item.num}
              type="button"
              aria-pressed={active === index}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onClick={() => setActive(index)}
            >
              <span>{item.num}</span>
              <strong>{item.verb}</strong>
              <p>{item.object}</p>
              <item.Icon aria-hidden />
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step.num}
            className={styles.magazineResult}
            initial={reduce ? false : { opacity: 0, clipPath: "inset(0 100% 0 0)" }}
            animate={{ opacity: 1, clipPath: "inset(0 0% 0 0)" }}
            exit={reduce ? undefined : { opacity: 0, clipPath: "inset(0 0 0 100%)" }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            <span>Результат этапа</span>
            <strong>{step.result}</strong>
            <p>{step.description}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

export function HowVariants({ variant }: { variant: HowVariant }) {
  return (
    <div className={styles.lab}>
      <VariantNav active={variant} />
      <main id="main">
        {variant === 1 && <EditorialStrip />}
        {variant === 2 && <V3KineticHow />}
        {variant === 3 && <LivingCycle />}
        {variant === 4 && <MagazineSpread />}
      </main>
    </div>
  );
}

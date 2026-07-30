"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BookOpenCheck,
  Check,
  Pause,
  Radar,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import {
  AnimatePresence,
  motion,
  type MotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";
import styles from "./scroll-finale.module.css";

export type ScrollFinaleVariant = 1 | 2 | 3;

const CONTROL_STEPS = [
  {
    code: "01",
    title: "Голос",
    eyebrow: "Не безликий ИИ",
    text: "Аврора собирает редакционный профиль из опубликованных материалов: ритм, лексику, длину фраз и привычную подачу.",
    stat: "Твой стиль остаётся узнаваемым",
    Icon: BookOpenCheck,
  },
  {
    code: "02",
    title: "Источники",
    eyebrow: "Факты отдельно от стиля",
    text: "База знаний отвечает за фактуру, разведка — за сильные инфоповоды. Аврора не смешивает источник и авторскую манеру.",
    stat: "Понятно, откуда взялся материал",
    Icon: Radar,
  },
  {
    code: "03",
    title: "Правила",
    eyebrow: "Редакционная граница",
    text: "Стоп-темы, обращения, CTA, эмодзи и формулировки проверяются до публикации — по правилам конкретного канала.",
    stat: "Каждый материал проходит контроль",
    Icon: SlidersHorizontal,
  },
  {
    code: "04",
    title: "Режим",
    eyebrow: "Решение остаётся у тебя",
    text: "Аврора готовит очередь и публикует с сервера по расписанию. Процесс можно остановить, поправить и снова запустить.",
    stat: "Автопилот, а не потеря управления",
    Icon: Pause,
  },
] as const;

const CONTRACT_STEPS = [
  {
    code: "01",
    label: "Личные сообщения",
    verdict: "Не нужны",
    text: "Для работы с каналом Авроре не требуется читать твою личную переписку.",
  },
  {
    code: "02",
    label: "Случайная публикация",
    verdict: "Не проходит",
    text: "Материал движется только по выбранному сценарию и расписанию канала.",
  },
  {
    code: "03",
    label: "Нарушение правил",
    verdict: "Будет показано",
    text: "Контроль качества отмечает проблему до того, как материал уйдёт в канал.",
  },
  {
    code: "04",
    label: "Нужно остановить",
    verdict: "Одна команда",
    text: "Очередь можно поставить на паузу и вернуть ручной контроль без потери материалов.",
  },
] as const;

function useActiveStep(progress: MotionValue<number>, count: number) {
  const [active, setActive] = useState(0);

  useMotionValueEvent(progress, "change", (latest) => {
    const next = Math.min(count - 1, Math.floor(latest * count));
    setActive((current) => (current === next ? current : next));
  });

  return active;
}

function FinaleSwitcher({ active }: { active: ScrollFinaleVariant }) {
  return (
    <nav className={styles.switcher} aria-label="Переключатель финальных сцен">
      <span>Финальная сцена</span>
      {([1, 2, 3] as const).map((variant) => (
        <Link
          href={`/finale/${variant}#finale`}
          aria-current={variant === active ? "page" : undefined}
          key={variant}
        >
          {variant}
        </Link>
      ))}
    </nav>
  );
}

function ControlDeckFinale() {
  const sectionRef = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end end"],
  });
  const active = useActiveStep(scrollYProgress, CONTROL_STEPS.length);
  const step = CONTROL_STEPS[active];

  return (
    <section
      ref={sectionRef}
      id="finale"
      className={`${styles.finale} ${styles.control}`}
      aria-labelledby="finale-control-title"
    >
      <div className={styles.stickyScene}>
        <div className={styles.sceneTopline}>
          <span>01 / Пульт управления</span>
          <span>Листай — пульт соберётся сам ↓</span>
        </div>

        <div className={styles.controlGrid}>
          <header className={styles.controlIntro}>
            <p className={styles.kicker}>Не отдавай канал алгоритму</p>
            <h2 id="finale-control-title">
              Ты задаёшь
              <mark>правила.</mark>
            </h2>
            <p>Аврора берёт на себя движение. Решения, границы и голос остаются твоими.</p>
          </header>

          <ol className={styles.stepRail} aria-label="Настройки Авроры">
            {CONTROL_STEPS.map((item, index) => (
              <li key={item.code} data-active={index === active}>
                <span>{item.code}</span>
                <strong>{item.title}</strong>
                <i aria-hidden />
              </li>
            ))}
          </ol>

          <div className={styles.console}>
            <motion.div
              className={styles.consoleProgress}
              style={{ scaleY: reduce ? 1 : scrollYProgress }}
              aria-hidden
            />
            <div className={styles.consoleHead}>
              <span>Аврора / Настройка {step.code}</span>
              <span className={styles.liveDot}>Активно</span>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step.code}
                className={styles.consoleBody}
                initial={reduce ? false : { opacity: 0, x: 44, rotate: 0.8 }}
                animate={{ opacity: 1, x: 0, rotate: 0 }}
                exit={reduce ? undefined : { opacity: 0, x: -36, rotate: -0.8 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              >
                <step.Icon aria-hidden strokeWidth={2.4} />
                <p>{step.eyebrow}</p>
                <h3>{step.title}</h3>
                <div className={styles.consoleRule} />
                <p className={styles.consoleText}>{step.text}</p>
                <div className={styles.consoleStamp}>
                  <Check aria-hidden strokeWidth={3} />
                  {step.stat}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        <div className={styles.sceneFooter}>
          <span>{String(active + 1).padStart(2, "0")} / 04</span>
          <Link href="/register">
            Настроить свой канал <ArrowRight aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}

function ManifestoFinale() {
  const sectionRef = useRef<HTMLElement>(null);
  const [phase, setPhase] = useState(0);
  const [complete, setComplete] = useState(false);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end end"],
  });
  const lineOneX = useTransform(scrollYProgress, [0, 0.38], ["-42vw", "0vw"]);
  const lineOneY = useTransform(scrollYProgress, [0, 0.38], [90, 0]);
  const lineOneRotate = useTransform(scrollYProgress, [0, 0.38], [-5, 0]);
  const lineTwoX = useTransform(scrollYProgress, [0.08, 0.5], ["46vw", "0vw"]);
  const lineTwoY = useTransform(scrollYProgress, [0.08, 0.5], [-80, 0]);
  const lineTwoRotate = useTransform(scrollYProgress, [0.08, 0.5], [5, 0]);
  const lineThreeX = useTransform(scrollYProgress, [0.22, 0.64], ["-48vw", "0vw"]);
  const lineThreeScale = useTransform(scrollYProgress, [0.22, 0.64], [1.55, 1]);
  const lineThreeRotate = useTransform(scrollYProgress, [0.22, 0.64], [-7, -1]);
  const copyScale = useTransform(scrollYProgress, [0.68, 0.91], [1, 0.82]);
  const copyOpacity = useTransform(scrollYProgress, [0.76, 0.91], [1, 0.13]);
  const ghostX = useTransform(scrollYProgress, [0, 1], ["18vw", "-54vw"]);
  const factsOpacity = useTransform(scrollYProgress, [0.58, 0.75, 0.89], [0, 1, 1]);
  const factsY = useTransform(scrollYProgress, [0.58, 0.75], [58, 0]);

  useMotionValueEvent(scrollYProgress, "change", (latest) => {
    const nextPhase = latest < 0.28 ? 0 : latest < 0.62 ? 1 : 2;
    setPhase((current) => (current === nextPhase ? current : nextPhase));
    setComplete((current) => {
      const next = latest > 0.92;
      return current === next ? current : next;
    });
  });

  const phaseLabel = ["Разброс", "Сборка", "Ритм"][phase];

  return (
    <section
      ref={sectionRef}
      id="finale"
      className={`${styles.finale} ${styles.manifesto} ${complete ? styles.manifestoComplete : ""}`}
      aria-labelledby="finale-manifesto-title"
    >
      <div className={styles.stickyScene}>
        <div className={styles.sceneTopline}>
          <span>Кинетический манифест</span>
          <span>{phaseLabel}</span>
        </div>

        <motion.div
          className={styles.manifestoGhost}
          style={reduce ? undefined : { x: ghostX }}
          aria-hidden
        >
          АВРОРА АВРОРА
        </motion.div>

        <motion.div
          className={styles.manifestoCopy}
          style={reduce ? undefined : { scale: copyScale, opacity: copyOpacity }}
          data-phase={phase}
        >
          <div className={styles.manifestoLine}>
            <motion.p
              className={styles.manifestoPair}
              style={
                reduce ? undefined : { x: lineOneX, y: lineOneY, rotate: lineOneRotate }
              }
            >
              <span className={styles.manifestoOutline}>Канал</span>
              <span className={styles.manifestoStamp}>не должен</span>
            </motion.p>
          </div>
          <div className={styles.manifestoLine}>
            <motion.p
              className={styles.manifestoPair}
              style={
                reduce ? undefined : { x: lineTwoX, y: lineTwoY, rotate: lineTwoRotate }
              }
            >
              <span className={styles.manifestoAnchor}>зависеть</span>
              <span className={styles.manifestoRibbon}>от твоего</span>
            </motion.p>
          </div>
          <div className={styles.manifestoLine}>
            <motion.p
              style={
                reduce
                  ? undefined
                  : { x: lineThreeX, scale: lineThreeScale, rotate: lineThreeRotate }
              }
            >
              <mark>настроения.</mark>
            </motion.p>
          </div>
          <h2 id="finale-manifesto-title" className="sr-only">
            Канал не должен зависеть от твоего настроения
          </h2>
        </motion.div>

        <motion.div
          className={styles.manifestoFacts}
          style={reduce ? undefined : { opacity: factsOpacity, y: factsY }}
        >
          <article>
            <strong>Факты</strong>
            <p>разведка и база знаний дают материал</p>
          </article>
          <article>
            <strong>Голос</strong>
            <p>редакционный профиль сохраняет твою подачу</p>
          </article>
          <article>
            <strong>Ритм</strong>
            <p>сервер публикует по расписанию без ноутбука</p>
          </article>
        </motion.div>

        <motion.div
          className={styles.manifestoAction}
          style={reduce ? undefined : { opacity: factsOpacity }}
        >
          <p>Ты живёшь. Канал не замолкает.</p>
          <Link href="/register">
            Запустить Аврору <ArrowRight aria-hidden />
          </Link>
        </motion.div>

        <AnimatePresence>
          {complete && (
            <motion.div
              className={styles.manifestoTakeover}
              initial={reduce ? false : { clipPath: "inset(100% 0 0 0)" }}
              animate={{ clipPath: "inset(0% 0 0 0)" }}
              exit={reduce ? undefined : { clipPath: "inset(100% 0 0 0)" }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className={styles.manifestoTakeoverRail} aria-hidden>
                Разведка · Голос · Проверка · Публикация · Реакция ·
              </div>
              <p>Механика собрана · Канал держит ритм</p>
              <h3>
                Ты живёшь.
                <mark>Канал не замолкает.</mark>
              </h3>
              <p>
                Аврора находит материал, пишет твоим голосом, проверяет и публикует — пока ты
                занимаешься своей жизнью.
              </p>
              <Link href="/register">
                Запустить постоянный ритм <ArrowRight aria-hidden />
              </Link>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

function ContractFinale() {
  const sectionRef = useRef<HTMLElement>(null);
  const [complete, setComplete] = useState(false);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end end"],
  });
  const active = useActiveStep(scrollYProgress, CONTRACT_STEPS.length);
  const step = CONTRACT_STEPS[active];
  const scanTop = useTransform(scrollYProgress, [0, 1], ["7%", "91%"]);

  useMotionValueEvent(scrollYProgress, "change", (latest) => {
    setComplete((current) => {
      const next = latest > 0.93;
      return current === next ? current : next;
    });
  });

  return (
    <section
      ref={sectionRef}
      id="finale"
      className={`${styles.finale} ${styles.contract} ${complete ? styles.contractComplete : ""}`}
      aria-labelledby="finale-contract-title"
    >
      <div className={styles.stickyScene}>
        <div className={styles.contractGhost} aria-hidden>
          КОНТРОЛЬ
        </div>
        <motion.div
          className={styles.scanLine}
          style={reduce ? { top: "50%" } : { top: scanTop }}
          aria-hidden
        >
          <span>Скан {String(active + 1).padStart(2, "0")}</span>
        </motion.div>
        <div className={styles.sceneTopline}>
          <span>03 / Протокол владельца</span>
          <span>
            Проверка границ · {String(active + 1).padStart(2, "0")} / 04
          </span>
        </div>

        <div className={styles.contractGrid}>
          <header>
            <div className={styles.shieldDevice} aria-hidden>
              <i />
              <i />
              <ShieldCheck strokeWidth={2.5} />
            </div>
            <p className={styles.kicker}>Что Аврора не забирает</p>
            <h2 id="finale-contract-title">
              Канал
              <mark>всё ещё твой.</mark>
            </h2>
            <p className={styles.contractLead}>
              Аврора получает доступ к работе — не к твоей жизни и не к праву решать за тебя.
            </p>
          </header>

          <ol className={styles.contractList}>
            {CONTRACT_STEPS.map((item, index) => (
              <li
                key={item.code}
                data-active={index === active}
                data-verified={index <= active}
              >
                <span>{item.code}</span>
                <p>{item.label}</p>
                <strong>
                  {index <= active && <Check aria-hidden strokeWidth={3} />}
                  {index <= active ? "Проверено" : "Ожидает"}
                </strong>
              </li>
            ))}
          </ol>

          <div className={styles.verdictPanel} aria-live="polite">
            <div className={styles.verdictGrid} aria-hidden />
            <motion.span
              key={`code-${step.code}`}
              className={styles.verdictCode}
              initial={reduce ? false : { opacity: 0, scale: 1.35, x: 28 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
            >
              {step.code}
            </motion.span>
            <div className={styles.verdictIcon}>
              <ScanSearch aria-hidden strokeWidth={2.25} />
              <span>Проверка {step.code}</span>
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                className={styles.verdictCopy}
                key={step.code}
                initial={reduce ? false : { opacity: 0, x: 48, skewX: -2 }}
                animate={{ opacity: 1, x: 0, skewX: 0 }}
                exit={reduce ? undefined : { opacity: 0, x: -38, skewX: 2 }}
                transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              >
                <span>{step.label}</span>
                <h3>{step.verdict}</h3>
                <p>{step.text}</p>
              </motion.div>
            </AnimatePresence>
            <motion.div
              className={styles.approvedStamp}
              key={`stamp-${step.code}`}
              initial={reduce ? false : { scale: 1.5, rotate: 7, opacity: 0 }}
              animate={{ scale: 1, rotate: -2, opacity: 1 }}
              transition={{ type: "spring", stiffness: 360, damping: 20 }}
            >
              {step.code} / Граница сохранена
            </motion.div>
          </div>
        </div>

        <div className={styles.sceneFooter}>
          <span>
            Контроль остаётся у владельца канала · {String(active + 1).padStart(2, "0")} / 04
          </span>
          <Link href="/register">
            Подключить безопасно <ArrowRight aria-hidden />
          </Link>
        </div>

        <AnimatePresence>
          {complete && (
            <motion.div
              className={styles.finalTakeover}
              initial={reduce ? false : { clipPath: "inset(50% 0 50% 0)" }}
              animate={{ clipPath: "inset(0% 0 0% 0)" }}
              exit={reduce ? undefined : { clipPath: "inset(50% 0 50% 0)" }}
              transition={{ duration: 0.46, ease: [0.22, 1, 0.36, 1] }}
            >
              <motion.div
                className={styles.finalCheck}
                initial={reduce ? false : { scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: -3 }}
                transition={{ type: "spring", stiffness: 260, damping: 16, delay: 0.2 }}
              >
                <Check aria-hidden strokeWidth={3.5} />
              </motion.div>
              <p>04 / 04 · Все границы сохранены</p>
              <h3>
                Канал остаётся
                <mark>твоим.</mark>
              </h3>
              <p>
                Аврора забирает рутину. Голос, правила и последнее слово остаются у владельца.
              </p>
              <Link href="/register">
                Отдать Авроре рутину <ArrowRight aria-hidden />
              </Link>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

export function V3ScrollFinale({
  variant,
  showSwitcher = false,
}: {
  variant: ScrollFinaleVariant;
  showSwitcher?: boolean;
}) {
  return (
    <>
      {variant === 1 && <ControlDeckFinale />}
      {variant === 2 && <ManifestoFinale />}
      {variant === 3 && <ContractFinale />}
      {showSwitcher && <FinaleSwitcher active={variant} />}
    </>
  );
}

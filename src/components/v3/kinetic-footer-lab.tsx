"use client";

import { useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { RotateCcw, Send, Sparkles } from "lucide-react";
import styles from "./kinetic-footer-lab.module.css";

export type FooterInteractionVariant = 1 | 2 | 3;

const LETTERS = [..."АВРОРА"] as const;
const LAYERS = ["Тикер", "Пульс", "Сетка", "Круги", "Глитч", "Инверсия"] as const;
const SUPPORT_TG = "https://t.me/kontenfkv_bot";

function InteractionSwitcher({ active }: { active: FooterInteractionVariant }) {
  return (
    <nav className={styles.switcher} aria-label="Переключатель механик футера" data-temporary-switcher>
      <Link href="/footer/1#footer" className={styles.backLink}>← Дизайны</Link>
      <span>Механика</span>
      {([1, 2, 3] as const).map((variant) => (
        <Link
          key={variant}
          href={`/footer/3/${variant}#footer`}
          aria-current={variant === active ? "page" : undefined}
        >
          {variant}
        </Link>
      ))}
    </nav>
  );
}

function LabMeta() {
  return (
    <div className={styles.meta}>
      <p>Ты задаёшь тон. Аврора держит ритм.</p>
      <nav aria-label="Разделы лендинга">
        <a href="#how">Как работает</a>
        <a href="#quality">Контроль</a>
        <a href="#memory">Память</a>
        <a href="#faq">Вопросы</a>
      </nav>
      <a href={SUPPORT_TG} className={styles.telegram}>
        <Send aria-hidden />
        @kontenfkv_bot
      </a>
      <span>© 2026 · Сделано в России</span>
    </div>
  );
}

function LabTop({
  number,
  title,
  status,
}: {
  number: string;
  title: string;
  status: string;
}) {
  return (
    <header className={styles.topbar}>
      <span>{number} / {title}</span>
      <strong>{status}</strong>
    </header>
  );
}

function WakeFooter({ footerId }: { footerId: string }) {
  const reduced = useReducedMotion();
  const [charged, setCharged] = useState<boolean[]>(() => LETTERS.map(() => false));
  const count = charged.filter(Boolean).length;
  const awake = count === LETTERS.length;

  function charge(index: number) {
    if (awake || charged[index]) return;
    setCharged((current) => current.map((value, itemIndex) => value || itemIndex === index));
  }

  function reset() {
    setCharged(LETTERS.map(() => false));
  }

  return (
    <footer id={footerId} className={`${styles.footer} ${styles.wake} ${awake ? styles.wakeFinale : ""}`}>
      <LabTop
        number="01"
        title="Разбуди Аврору"
        status={awake ? "Система проснулась" : `Заряд ${count} / 6`}
      />

      <div className={styles.wakeHint}>
        <span>Нажми на каждую букву</span>
        <div aria-hidden>{LETTERS.map((_, index) => <i key={index} className={charged[index] ? styles.dotActive : ""} />)}</div>
      </div>

      <div className={styles.wakeGrid} aria-label="Разбудить буквы Авроры">
        {LETTERS.map((letter, index) => (
          <div
            key={`${letter}-${index}`}
            className={`${styles.wakeCell} ${charged[index] ? styles.charged : ""}`}
            data-effect={index}
            style={{ "--letter-index": index } as CSSProperties}
          >
            <button
              type="button"
              aria-pressed={charged[index]}
              aria-label={`${charged[index] ? "Заряжена" : "Зарядить"} буква ${letter}, ${index + 1} из 6`}
              onClick={() => charge(index)}
              disabled={awake}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong aria-hidden>{letter}</strong>
              <i aria-hidden />
            </button>
          </div>
        ))}
      </div>

      <AnimatePresence>
        {awake && (
          <motion.div
            className={styles.awakeMessage}
            initial={reduced ? false : { scale: 1.45, rotate: -7 }}
            animate={{ scale: 1, rotate: -1.5 }}
            exit={reduced ? undefined : { scale: 0.75, opacity: 0 }}
            transition={{ type: "spring", stiffness: 250, damping: 18 }}
          >
            <Sparkles aria-hidden />
            <span>Канал в движении</span>
            <button type="button" onClick={reset}>
              Ещё раз
              <RotateCcw aria-hidden />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <LabMeta />
    </footer>
  );
}

function PhysicsFooter({ footerId }: { footerId: string }) {
  const reduced = useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const [resetKey, setResetKey] = useState(0);
  const [moved, setMoved] = useState<boolean[]>(() => LETTERS.map(() => false));
  const [pulse, setPulse] = useState<number | null>(null);
  const movedCount = moved.filter(Boolean).length;

  function markMoved(index: number) {
    setMoved((current) => current.map((value, itemIndex) => value || itemIndex === index));
  }

  function reset() {
    setResetKey((value) => value + 1);
    setMoved(LETTERS.map(() => false));
    setPulse(null);
  }

  return (
    <footer id={footerId} className={`${styles.footer} ${styles.physics}`}>
      <LabTop number="02" title="Типографическая физика" status={`${movedCount} / 6 сдвинуто`} />

      <div className={styles.physicsTools}>
        <p>Тащи, бросай или просто нажимай на буквы</p>
        <button type="button" onClick={reset}>
          Вернуть на место
          <RotateCcw aria-hidden />
        </button>
      </div>

      <div ref={stage} className={styles.physicsStage} aria-label="Подвижные буквы Авроры">
        <div className={styles.physicsGrid} aria-hidden />
        {LETTERS.map((letter, index) => (
          <motion.button
            key={`${resetKey}-${letter}-${index}`}
            type="button"
            className={`${styles.physicsLetter} ${moved[index] ? styles.physicsMoved : ""}`}
            aria-label={`Подвижная буква ${letter}, ${index + 1} из 6`}
            drag={!reduced}
            dragConstraints={stage}
            dragElastic={0.28}
            dragMomentum
            dragTransition={{ bounceStiffness: 260, bounceDamping: 17 }}
            whileDrag={{ scale: 1.16, rotate: index % 2 ? 7 : -7, zIndex: 20 }}
            animate={
              pulse === index && !reduced
                ? { y: [0, -58, 8, 0], rotate: [0, -8, 5, 0], scale: [1, 1.12, 0.96, 1] }
                : { scale: 1 }
            }
            transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            onClick={() => {
              markMoved(index);
              setPulse(index);
            }}
            onAnimationComplete={() => setPulse((current) => current === index ? null : current)}
            onDragEnd={() => markMoved(index)}
            style={{ "--letter-index": index } as CSSProperties}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong aria-hidden>{letter}</strong>
          </motion.button>
        ))}
        <p className={styles.physicsCaption}>У каждой буквы есть вес. У бренда — характер.</p>
      </div>

      <LabMeta />
    </footer>
  );
}

function SequencerFooter({ footerId }: { footerId: string }) {
  const reduced = useReducedMotion();
  const [layers, setLayers] = useState<boolean[]>(() => LETTERS.map(() => false));
  const count = layers.filter(Boolean).length;
  const live = count === LETTERS.length;

  function toggle(index: number) {
    setLayers((current) => current.map((value, itemIndex) => itemIndex === index ? !value : value));
  }

  const sceneClass = [
    styles.sequence,
    layers[0] ? styles.tickerOn : "",
    layers[1] ? styles.pulseOn : "",
    layers[2] ? styles.gridOn : "",
    layers[3] ? styles.ringsOn : "",
    layers[4] ? styles.glitchOn : "",
    layers[5] ? styles.invertOn : "",
    live ? styles.sequenceLive : "",
  ].filter(Boolean).join(" ");

  return (
    <footer id={footerId} className={`${styles.footer} ${sceneClass}`}>
      <LabTop number="03" title="Визуальный секвенсор" status={live ? "Aurora live" : `${count} / 6 слоёв`} />

      <div className={styles.sequenceTicker} aria-hidden>
        <div>
          <span>АВРОРА · КАНАЛ В ДВИЖЕНИИ · </span>
          <span>АВРОРА · КАНАЛ В ДВИЖЕНИИ · </span>
          <span>АВРОРА · КАНАЛ В ДВИЖЕНИИ · </span>
          <span>АВРОРА · КАНАЛ В ДВИЖЕНИИ · </span>
        </div>
      </div>

      <div className={styles.sequenceStage}>
        <div className={styles.sequenceGrid} aria-hidden />
        <div className={styles.sequenceRings} aria-hidden><i /><i /><i /></div>
        <div className={styles.sequenceBeam} aria-hidden />
        <div className={styles.sequenceLetters} aria-label="Слои визуального секвенсора">
          {LETTERS.map((letter, index) => (
            <button
              key={`${letter}-${index}`}
              type="button"
              aria-pressed={layers[index]}
              aria-label={`${layers[index] ? "Выключить" : "Включить"} слой ${LAYERS[index]}`}
              onClick={() => toggle(index)}
              className={layers[index] ? styles.layerActive : ""}
              style={{ "--letter-index": index } as CSSProperties}
            >
              <span>{LAYERS[index]}</span>
              <strong aria-hidden>{letter}</strong>
              <i aria-hidden>{layers[index] ? "ON" : "OFF"}</i>
            </button>
          ))}
        </div>

        <AnimatePresence>
          {live && (
            <motion.div
              className={styles.liveStamp}
              initial={reduced ? false : { opacity: 0, scale: 1.8, rotate: 8 }}
              animate={{ opacity: 1, scale: 1, rotate: -2 }}
              exit={reduced ? undefined : { opacity: 0, scale: 0.7 }}
            >
              Все системы работают
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <LabMeta />
    </footer>
  );
}

export function V3KineticFooterLab({
  variant,
  showSwitcher = true,
  footerId = "footer",
}: {
  variant: FooterInteractionVariant;
  showSwitcher?: boolean;
  footerId?: string;
}) {
  return (
    <>
      {showSwitcher && <InteractionSwitcher active={variant} />}
      {variant === 1 ? (
        <WakeFooter footerId={footerId} />
      ) : variant === 2 ? (
        <PhysicsFooter footerId={footerId} />
      ) : (
        <SequencerFooter footerId={footerId} />
      )}
    </>
  );
}

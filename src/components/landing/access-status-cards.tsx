"use client";

import type { PointerEvent } from "react";
import {
  CalendarRange,
  Check,
  Send,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from "motion/react";
import styles from "./reference-landing.module.css";

const EASE = [0.22, 1, 0.36, 1] as const;

type AccessCard = {
  icon: LucideIcon;
  tone: "editor" | "telegram" | "vk";
  title: string;
  note: string;
  features: readonly string[];
};

const ACCESS_CARDS: readonly AccessCard[] = [
  {
    icon: CalendarRange,
    tone: "editor",
    title: "Редактор и контент-план",
    note: "Основной рабочий контур для подготовки юридического контента.",
    features: [
      "Черновики и календарь",
      "Источники и доказательства",
      "Настройки тона, включая необязательный мат",
    ],
  },
  {
    icon: Send,
    tone: "telegram",
    title: "Telegram",
    note: "Подключение канала, расписание и серверная публикация.",
    features: [
      "Публикация по расписанию",
      "Статусы и история операций",
      "Повторная попытка без дублей",
    ],
  },
  {
    icon: UsersRound,
    tone: "vk",
    title: "ВКонтакте",
    note: "Доступность зависит от настроенного приложения и тестового сообщества.",
    features: [
      "Подключение сообщества",
      "Проверка разрешений",
      "Статус готовности внутри проекта",
    ],
  },
] as const;

function AccessStatusCard({ card, index }: { card: AccessCard; index: number }) {
  const reduceMotion = useReducedMotion() ?? false;
  const rotateX = useMotionValue(0);
  const rotateY = useMotionValue(0);
  const smoothRotateX = useSpring(rotateX, { stiffness: 240, damping: 24 });
  const smoothRotateY = useSpring(rotateY, { stiffness: 240, damping: 24 });
  const Icon = card.icon;

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    if (reduceMotion || event.pointerType !== "mouse") return;

    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const horizontal = x / rect.width - 0.5;
    const vertical = y / rect.height - 0.5;

    rotateX.set(vertical * -3.2);
    rotateY.set(horizontal * 3.2);
    event.currentTarget.style.setProperty("--access-light-x", `${x}px`);
    event.currentTarget.style.setProperty("--access-light-y", `${y}px`);
  }

  function resetPointer(event: PointerEvent<HTMLElement>) {
    rotateX.set(0);
    rotateY.set(0);
    event.currentTarget.style.removeProperty("--access-light-x");
    event.currentTarget.style.removeProperty("--access-light-y");
  }

  return (
    <motion.article
      className={`${styles.priceCard} ${styles.accessCard}`}
      data-access-card={card.tone}
      initial={reduceMotion ? false : { opacity: 0, y: 24, scale: 0.975 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      whileHover={reduceMotion ? undefined : { y: -7 }}
      viewport={{ once: true, margin: "-70px" }}
      transition={{
        duration: reduceMotion ? 0 : 0.56,
        delay: reduceMotion ? 0 : index * 0.11,
        ease: EASE,
      }}
      style={{
        rotateX: smoothRotateX,
        rotateY: smoothRotateY,
        transformPerspective: 1000,
      }}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetPointer}
    >
      <span className={styles.accessLight} aria-hidden="true" />
      <div className={styles.accessCardHeader}>
        <span className={styles.accessIcon} aria-hidden="true">
          <Icon />
        </span>
        <span className={styles.accessSignal} aria-hidden="true"><i /></span>
      </div>
      <h3>{card.title}</h3>
      <p className={styles.planNote}>{card.note}</p>
      <motion.ul
        initial={reduceMotion ? false : "hidden"}
        whileInView="visible"
        viewport={{ once: true, margin: "-55px" }}
        variants={{
          hidden: {},
          visible: {
            transition: {
              delayChildren: 0.2 + index * 0.1,
              staggerChildren: 0.085,
            },
          },
        }}
      >
        {card.features.map((feature) => (
          <motion.li
            key={feature}
            variants={{
              hidden: { opacity: 0, x: -8 },
              visible: { opacity: 1, x: 0, transition: { duration: 0.34, ease: EASE } },
            }}
          >
            <span className={styles.accessCheck} aria-hidden="true"><Check /></span>
            <span>{feature}</span>
          </motion.li>
        ))}
      </motion.ul>
    </motion.article>
  );
}

export function AccessStatusCards() {
  return (
    <div className={`${styles.pricingGrid} ${styles.accessGrid}`}>
      {ACCESS_CARDS.map((card, index) => (
        <AccessStatusCard card={card} index={index} key={card.title} />
      ))}
    </div>
  );
}

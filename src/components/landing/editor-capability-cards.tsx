"use client";

import type { CSSProperties, PointerEvent } from "react";
import {
  Check,
  FileCheck2,
  History,
  Link2,
  LockKeyhole,
  Scale,
  type LucideIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import styles from "./reference-landing.module.css";

const EASE = [0.22, 1, 0.36, 1] as const;

type Capability = {
  accent: string;
  icon: LucideIcon;
  scene: "evidence" | "sources" | "history";
  title: string;
  text: string;
};

const CAPABILITIES: readonly Capability[] = [
  {
    accent: "#2563ff",
    icon: FileCheck2,
    scene: "evidence",
    title: "Карточка доказательства",
    text: "Тип, содержание, источник и дата актуальности хранятся вместе с настройками материала.",
  },
  {
    accent: "#0787a8",
    icon: Scale,
    scene: "sources",
    title: "Юридические источники",
    text: "Публичные ленты и разрешённые подключения отделены от закрытых и неподтверждённых данных.",
  },
  {
    accent: "#6557d9",
    icon: History,
    scene: "history",
    title: "История согласования",
    text: "Комментарии и решения относятся к конкретной версии и не теряются после правок.",
  },
] as const;

function EvidenceScene() {
  return (
    <div className={styles.capabilityScene} data-capability-scene="evidence" aria-hidden="true">
      <div className={styles.sceneTopline}>
        <span>Доказательство</span>
        <b><Check /> связано</b>
      </div>
      <div className={styles.proofStack}>
        <span className={styles.proofBackSheet} />
        <div className={styles.proofSheet}>
          <span className={styles.proofFold} />
          <i className={styles.proofTitleLine} />
          <i className={styles.proofTextLine} />
          <i className={styles.proofTextLine} />
          <span className={styles.proofMeta}><b>тип</b><b>источник</b><b>дата</b></span>
          <span className={styles.proofScan} />
        </div>
        <span className={styles.proofLink}><Link2 /></span>
      </div>
    </div>
  );
}

function SourcesScene() {
  return (
    <div className={styles.capabilityScene} data-capability-scene="sources" aria-hidden="true">
      <div className={styles.sceneTopline}>
        <span>Контур источника</span>
        <b><Check /> разрешён</b>
      </div>
      <div className={styles.sourceMap}>
        <div className={`${styles.sourceNode} ${styles.sourceNodeOpen}`}><i />публичный</div>
        <span className={`${styles.sourcePath} ${styles.sourcePathOpen}`}><i /></span>
        <div className={styles.sourceGate}><Scale /></div>
        <span className={`${styles.sourcePath} ${styles.sourcePathClosed}`} />
        <div className={`${styles.sourceNode} ${styles.sourceNodeClosed}`}><LockKeyhole />закрытый</div>
        <span className={styles.sourceVerdict}><Check /> в материале</span>
      </div>
    </div>
  );
}

function HistoryScene() {
  return (
    <div className={styles.capabilityScene} data-capability-scene="history" aria-hidden="true">
      <div className={styles.sceneTopline}>
        <span>Версии материала</span>
        <b>03 версии</b>
      </div>
      <div className={styles.versionStack}>
        <span className={styles.versionRail}><i /></span>
        <div className={styles.versionRow}><i />v.01 <span>черновик</span></div>
        <div className={styles.versionRow}><i />v.02 <span>комментарий</span></div>
        <div className={`${styles.versionRow} ${styles.versionRowCurrent}`}><i />v.03 <span><Check /> согласовано</span></div>
      </div>
    </div>
  );
}

function CapabilityScene({ scene }: Pick<Capability, "scene">) {
  if (scene === "evidence") return <EvidenceScene />;
  if (scene === "sources") return <SourcesScene />;
  return <HistoryScene />;
}

function CapabilityCard({ capability, index }: { capability: Capability; index: number }) {
  const reduceMotion = useReducedMotion() ?? false;
  const Icon = capability.icon;

  function moveSpotlight(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--capability-x", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--capability-y", `${event.clientY - rect.top}px`);
  }

  function clearSpotlight(event: PointerEvent<HTMLElement>) {
    event.currentTarget.style.removeProperty("--capability-x");
    event.currentTarget.style.removeProperty("--capability-y");
  }

  return (
    <motion.article
      className={styles.editorCapabilityCard}
      data-editor-capability={capability.scene}
      // Keep the initial target identical on the server and during hydration.
      // useReducedMotion() is null on the server, so branching here produces
      // different inline styles for visitors who prefer reduced motion.
      initial={{ opacity: 0, y: 26, scale: 0.98 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      whileHover={reduceMotion ? undefined : { y: -6 }}
      viewport={{ once: true, margin: "-70px" }}
      transition={{
        duration: reduceMotion ? 0 : 0.58,
        delay: reduceMotion ? 0 : index * 0.1,
        ease: EASE,
      }}
      style={{ "--capability-accent": capability.accent } as CSSProperties}
      onPointerMove={moveSpotlight}
      onPointerLeave={clearSpotlight}
    >
      <span className={styles.capabilitySpotlight} aria-hidden="true" />
      <div className={styles.capabilityCardMeta}>
        <span className={styles.editorCapabilityIcon} aria-hidden="true"><Icon /></span>
        <span className={styles.capabilityIndex}>контур {String(index + 1).padStart(2, "0")}</span>
      </div>
      <CapabilityScene scene={capability.scene} />
      <div className={styles.capabilityCopy}>
        <h3>{capability.title}</h3>
        <p>{capability.text}</p>
      </div>
    </motion.article>
  );
}

export function EditorCapabilityCards() {
  return (
    <div className={styles.editorCapabilityGrid}>
      {CAPABILITIES.map((capability, index) => (
        <CapabilityCard capability={capability} index={index} key={capability.title} />
      ))}
    </div>
  );
}

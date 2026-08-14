"use client";

import { useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Lightbulb, Radar, Zap } from "lucide-react";
import { AirWave } from "@/components/landing/air-wave";

const EASE = [0.22, 1, 0.36, 1] as const;

type IslandIcon = React.ComponentType<{
  className?: string;
  strokeWidth?: number;
  "aria-hidden"?: boolean;
}>;

type Island = {
  id: string;
  feature: string;
  title: string;
  description: string;
  icon: IslandIcon;
};

const ISLANDS: Island[] = [
  {
    id: "autopilot",
    feature: "Автопилот",
    title: "Неделя за 15 минут",
    description:
      "Аврора собирает план на неделю. Ты подтверждаешь его — публикации выходят по расписанию.",
    icon: Zap,
  },
  {
    id: "trends",
    feature: "Тренды",
    title: "Идеи приходят сами",
    description:
      "Готовые темы, сценарии и хуки появляются в ленте идей. Один выбор — и черновик готов.",
    icon: Lightbulb,
  },
  {
    id: "reconnaissance",
    feature: "Разведка",
    title: "Видно, что работает",
    description:
      "Аврора показывает сильные темы и форматы конкурентов — понятно, без таблиц и догадок.",
    icon: Radar,
  },
];

function GlassIsland({
  island,
  index,
  reduceMotion,
}: {
  island: Island;
  index: number;
  reduceMotion: boolean;
}) {
  const Icon = island.icon;

  return (
    <motion.li
      className="glass-island"
      data-island={island.id}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-90px" }}
      transition={{
        duration: reduceMotion ? 0 : 0.55,
        delay: reduceMotion ? 0 : index * 0.1,
        ease: EASE,
      }}
    >
      <span className="glass-island__sheen" aria-hidden="true" />

      <div className="glass-island__topline">
        <span className="glass-island__icon" aria-hidden="true">
          <Icon className="h-7 w-7" strokeWidth={1.8} aria-hidden={true} />
        </span>
        <span className="glass-island__number nums" aria-hidden="true">
          0{index + 1}
        </span>
      </div>

      <div className="glass-island__content">
        <span className="glass-island__label">{island.feature}</span>
        <h3>{island.title}</h3>
        <p>{island.description}</p>
      </div>
    </motion.li>
  );
}

export function Pains() {
  const uid = useId();
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <section
      aria-labelledby={`${uid}-title`}
      className="glass-islands-section relative isolate overflow-hidden py-24 sm:py-32"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_8%,rgb(255_255_255_/_0.94),transparent_38%),linear-gradient(180deg,#f5f9ff_0%,#fbfdff_52%,#f3f8ff_100%)]"
      />
      <AirWave className="glass-islands-wave" />
      <span className="glass-islands-light-path" aria-hidden="true" />

      <div className="relative z-10 mx-auto w-full max-w-[1180px] px-5 sm:px-8">
        <motion.header
          initial={reduceMotion ? false : { opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: reduceMotion ? 0 : 0.58, ease: EASE }}
          className="mx-auto max-w-[790px] text-center"
        >
          <p className="text-[13px] font-bold tracking-[0.18em] text-brand uppercase">
            Знакомо?
          </p>

          <h2
            id={`${uid}-title`}
            className="display mt-5 text-[clamp(2.15rem,5vw,4rem)] text-text text-balance"
          >
            Три причины, по которым соцсети стоят
          </h2>

          <p className="mx-auto mt-6 max-w-[610px] text-[16px] leading-[1.6] text-text-2 text-pretty sm:text-[17px]">
            План, идеи и разведку Аврора берёт на себя. Тебе остаётся выбрать и
            подтвердить.
          </p>
        </motion.header>

        <ol
          className="glass-islands-list mt-14 sm:mt-16"
          aria-label="Что Аврора берёт на себя"
        >
          {ISLANDS.map((island, index) => (
            <GlassIsland
              key={island.id}
              island={island}
              index={index}
              reduceMotion={reduceMotion}
            />
          ))}
        </ol>
      </div>
    </section>
  );
}

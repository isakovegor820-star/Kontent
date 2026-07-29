"use client";

// Единый таб-бар «Разведки». Три вкладки — три разные работы:
//   Сигналы    — живой радар: кто пишет о тебе и твоей теме (слитые Радар + Упоминания);
//   Конкуренты — досье на соседей: кто растёт и за счёт чего;
//   Тренды     — что залетает в нише, источник идей.
// Активная вкладка — пилюля на пружине, под ней — плавно сменяющаяся подсказка
// «зачем это», чтобы лиду не пришлось гадать. Иконки в фирменных тонах зон.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Flame, Radar, ScanSearch } from "lucide-react";

import { cn } from "@/lib/utils";

const TABS = [
  {
    href: "/app/recon",
    label: "Сигналы",
    icon: ScanSearch,
    tone: "text-info-text",
    purpose:
      "Живой радар: кто прямо сейчас пишет о тебе, твоём бренде и твоей теме — в Telegram, VK и у конкурентов. Успевай отвечать, пока горячо.",
  },
  {
    href: "/app/competitors",
    label: "Конкуренты",
    icon: Radar,
    tone: "text-brand",
    purpose:
      "Досье на соседей по нише: кто растёт и за счёт чего — просмотры, ритм публикаций, хитовые посты. Забирай лучшее себе.",
  },
  {
    href: "/app/trends",
    label: "Тренды",
    icon: Flame,
    tone: "text-fire-text",
    purpose:
      "Что залетает в твоей нише прямо сейчас и у кого учиться. Лови волну раньше других — и снимай первым.",
  },
] as const;

export function ReconTabs() {
  const pathname = usePathname();
  const active =
    TABS.find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`)) ?? TABS[0];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Разведка"
        className="inline-flex flex-wrap gap-1 rounded-sm border border-line bg-surface-inset p-1"
      >
        {TABS.map((t) => {
          const isActive = t.href === active.href;
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              role="tab"
              aria-selected={isActive}
              className={cn(
                "relative inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] px-3.5 py-2 text-[13px] font-semibold",
                "transition-colors duration-200",
                isActive ? "text-text" : "text-text-2 hover:text-text",
              )}
            >
              {/* Пилюля активной вкладки: пружина, а не мгновенная смена фона */}
              {isActive && (
                <motion.span
                  layoutId="recon-tab-pill"
                  className="absolute inset-0 rounded-[9px] bg-surface shadow-soft"
                  transition={{ type: "spring", bounce: 0.18, duration: 0.35 }}
                />
              )}
              <Icon
                className={cn("relative h-4 w-4", isActive ? t.tone : "text-text-3")}
                strokeWidth={2.25}
                aria-hidden
              />
              <span className="relative">{t.label}</span>
            </Link>
          );
        })}
      </div>
      {/* Подсказка «зачем эта вкладка» — мягко переливается при смене */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={active.href}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
          className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-text-3"
        >
          {active.purpose}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

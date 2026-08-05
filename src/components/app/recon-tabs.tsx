"use client";

// Единый таб-бар «Разведки». Три вкладки — три разные работы:
//   Поиск      — ручной поиск и алерты по уже собранным постам ниши;
//   Конкуренты — досье на соседей: кто растёт и за счёт чего;
//   Тренды     — что залетает в нише, источник идей.
// Активная вкладка — пилюля на пружине, под ней — плавно сменяющаяся подсказка
// «зачем это», чтобы лиду не пришлось гадать. Иконки в фирменных тонах зон.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Flame, Radar, Search } from "lucide-react";

import {
  APP_ROUTES,
  appRouteLabel,
  getActiveReconTabRouteId,
  type ReconTabRouteId,
} from "@/lib/app-routes";
import { cn } from "@/lib/utils";

const TABS: readonly {
  routeId: ReconTabRouteId;
  icon: typeof Search;
  tone: string;
  purpose: string;
}[] = [
  {
    routeId: "recon",
    icon: Search,
    tone: "text-info-text",
    purpose:
      "Поиск по уже собранным постам конкурентов и трендов. Находи нужные темы и сохраняй полезные механики.",
  },
  {
    routeId: "competitors",
    icon: Radar,
    tone: "text-brand",
    purpose:
      "Досье на соседей по нише: кто растёт и за счёт чего — просмотры, ритм публикаций, хитовые посты. Забирай лучшее себе.",
  },
  {
    routeId: "trends",
    icon: Flame,
    tone: "text-fire-text",
    purpose:
      "Свежие публикации выбранных Telegram-каналов — отдельно от проверенных залётов. Видно, что вышло сегодня и когда источники обновлялись.",
  },
];

export function ReconTabs() {
  const pathname = usePathname();
  const activeRouteId = getActiveReconTabRouteId(pathname);
  const active = TABS.find((tab) => tab.routeId === activeRouteId) ?? TABS[0];

  return (
    <div>
      <nav
        aria-label="Разделы разведки"
        className="inline-flex flex-wrap gap-1 rounded-sm border border-line bg-surface-inset p-1"
      >
        {TABS.map((t) => {
          const route = APP_ROUTES[t.routeId];
          const isActive = t.routeId === activeRouteId;
          const Icon = t.icon;
          return (
            <Link
              key={t.routeId}
              href={route.href}
              aria-current={isActive ? "page" : undefined}
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
              <span className="relative">{appRouteLabel(t.routeId, "tab")}</span>
            </Link>
          );
        })}
      </nav>
      {/* Подсказка «зачем эта вкладка» — мягко переливается при смене */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={active.routeId}
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

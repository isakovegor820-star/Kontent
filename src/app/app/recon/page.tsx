"use client";

// «Разведка → Сигналы». Единый экран мониторинга: слитые Радар (поиск по нише + алерты)
// и Упоминания (слежение за брендом/темой в TG и VK). Сверху — «Пульс ниши»: четыре
// тайла, которые сразу отвечают на вопрос «что нового?». Ниже — две зоны с яркими
// заголовками вместо бесшовной склейки. Таб-бар ведёт на Конкурентов и Тренды.

import { useCallback, useState } from "react";
import { MotionConfig, motion } from "motion/react";
import { Activity, AtSign, Bell, ScanSearch, Search } from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { ReconTabs } from "@/components/app/recon-tabs";
import { MentionsInner } from "@/app/app/mentions/page";
import { RadarInner } from "@/app/app/radar/page";
import { cn, fmtAgo } from "@/lib/utils";

/* ------------------------------------------------------------------ ТИПЫ */

type MentionStats = { mentions: { found_at: string }[]; queries: { is_active: boolean }[] };
type AlertStats = { alerts: { is_active: boolean }[] };

/* ------------------------------------------------------------ КИРПИЧИКИ */

/** Заголовок зоны: иконка в тональной подложке + название + «зачем эта зона». */
function ZoneHeader({
  icon,
  tone,
  title,
  caption,
}: {
  icon: React.ReactNode;
  tone: "info" | "brand";
  title: string;
  caption: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-sm",
          tone === "info" ? "bg-info-soft text-info-text" : "bg-brand-gradient text-white",
        )}
      >
        {icon}
      </div>
      <div>
        <h2 className="text-[15px] font-bold text-text">{title}</h2>
        <p className="text-[13px] text-text-3">{caption}</p>
      </div>
    </div>
  );
}

/** Тайл пульса: число + подпись + иконка. null → скелетон (данные ещё едут). */
function PulseTile({
  icon,
  tone,
  value,
  label,
}: {
  icon: React.ReactNode;
  tone: string;
  value: string | number | null;
  label: string;
}) {
  return (
    <div className="card-plain flex items-center gap-2.5 rounded-md px-3 py-2.5">
      <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-sm", tone)}>
        {icon}
      </div>
      <div className="min-w-0">
        {value === null ? (
          <div className="skeleton h-4 w-10" />
        ) : (
          <p className="text-[16px] font-bold leading-tight text-text">{value}</p>
        )}
        <p className="truncate text-[11px] leading-tight text-text-3">{label}</p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- ЭКРАН */

export default function ReconPage() {
  // Статы поднимаем из внутренних компонентов через onStats — без дублирующих запросов.
  // Производные (Date.now!) считаем внутри колбэка, а не в рендере: рендер должен быть чистым.
  const [pulse, setPulse] = useState<{ week: number; queries: number; last: string } | null>(null);
  const [aStats, setAStats] = useState<AlertStats | null>(null);
  // Стабильные колбэки: иначе useCallback загрузчиков внутри пересоздавался бы каждый рендер.
  const handleMentionStats = useCallback((s: MentionStats) => {
    const now = Date.now();
    setPulse({
      week: s.mentions.filter((m) => now - new Date(m.found_at).getTime() < 7 * 86_400_000).length,
      queries: s.queries.filter((q) => q.is_active).length,
      last: s.mentions.length
        ? fmtAgo(s.mentions.reduce((max, m) => (m.found_at > max ? m.found_at : max), ""))
        : "—",
    });
  }, []);
  const handleAlertStats = useCallback((s: AlertStats) => setAStats(s), []);

  const activeAlerts = aStats ? aStats.alerts.filter((a) => a.is_active).length : null;

  return (
    <AppShell
      title="Разведка"
      subtitle="Всё, что происходит в твоей нише: кто пишет о тебе, кто растёт рядом и что залетает."
    >
      <MotionConfig reducedMotion="user">
        <div className="mx-auto w-full">
          <ReconTabs />

          {/* Пульс ниши: чем живёт тема прямо сейчас */}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <PulseTile
              icon={<AtSign className="h-4 w-4" />}
              tone="bg-info-soft text-info-text"
              value={pulse?.week ?? null}
              label="Упоминаний за неделю"
            />
            <PulseTile
              icon={<ScanSearch className="h-4 w-4" />}
              tone="bg-success-soft text-success-text"
              value={pulse?.queries ?? null}
              label="Активных запросов"
            />
            <PulseTile
              icon={<Bell className="h-4 w-4" />}
              tone="bg-fire-soft text-fire-text"
              value={activeAlerts}
              label="Алертов по словам"
            />
            <PulseTile
              icon={<Activity className="h-4 w-4" />}
              tone="bg-surface-inset text-text-2"
              value={pulse?.last ?? null}
              label="Последний сигнал"
            />
          </div>

          {/* Зона «Сигналы»: слежение за брендом и темой */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
            className="mt-6"
          >
            <ZoneHeader
              icon={<AtSign className="h-4 w-4" />}
              tone="info"
              title="Сигналы"
              caption="Кто и где упоминает тебя и твою тему — проверяем каждый час."
            />
          </motion.div>
        </div>

        {/* Форма слежения + лента упоминаний */}
        <MentionsInner onStats={handleMentionStats} />

        {/* Зона «Поиск по нише»: ручная разведка + алерты */}
        <div className="mx-auto w-full">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", bounce: 0.15, duration: 0.4, delay: 0.08 }}
            className="mt-10"
          >
            <ZoneHeader
              icon={<Search className="h-4 w-4" />}
              tone="brand"
              title="Поиск по нише"
              caption="Ищи по постам конкурентов и трендов вручную и собирай алерты на ключевые слова."
            />
          </motion.div>
        </div>
        <RadarInner onStats={handleAlertStats} />
      </MotionConfig>
    </AppShell>
  );
}

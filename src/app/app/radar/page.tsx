"use client";

import { RadarInner } from "./radar-inner";
import { AppShell } from "@/components/app/shell";
import { ReconTabs } from "@/components/app/recon-tabs";

export default function RadarPage() {
  return (
    <AppShell
      title="Поиск по нише"
      subtitle="Ищи реальные Telegram-каналы, публикации и тренды по любой теме."
    >
      <ReconTabs />
      <RadarInner />
    </AppShell>
  );
}

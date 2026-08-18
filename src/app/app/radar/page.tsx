"use client";

import { RadarInner } from "./radar-inner";
import { AppShell } from "@/components/app/shell";

export default function RadarPage() {
  return (
    <AppShell
      title="Поиск по нише"
      subtitle="Ищи Telegram-каналы, публикации и тренды без фиксированного лимита выдачи."
    >
      <RadarInner />
    </AppShell>
  );
}

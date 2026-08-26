"use client";

import { AppShell } from "@/components/app/shell";
import { RadarInner } from "./radar-inner";

export default function RadarPage() {
  return (
    <AppShell
      title="Радар"
      subtitle="Ищи Telegram-каналы, публикации и тренды по своей нише."
    >
      <RadarInner />
    </AppShell>
  );
}

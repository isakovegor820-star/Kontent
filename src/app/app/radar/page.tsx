"use client";

import { AppShell } from "@/components/app/shell";
import { RadarInner } from "./radar-inner";

export default function RadarPage() {
  return (
    <AppShell
      title="Радар"
      subtitle="Ищи людей, бренды, сайты, Telegram-каналы, публикации и тренды в открытых источниках."
    >
      <RadarInner />
    </AppShell>
  );
}

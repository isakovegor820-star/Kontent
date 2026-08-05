"use client";

import { RadarInner } from "./radar-inner";
import { AppShell } from "@/components/app/shell";

export default function RadarPage() {
  return (
    <AppShell
      title="Радар"
      subtitle="Полнотекстовый поиск по нише и алерты по ключевым словам."
    >
      <RadarInner />
    </AppShell>
  );
}

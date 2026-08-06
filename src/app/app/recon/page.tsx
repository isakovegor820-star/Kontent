import { AppShell } from "@/components/app/shell";
import { ReconTabs } from "@/components/app/recon-tabs";
import { RadarInner } from "@/app/app/radar/radar-inner";

export default function ReconPage() {
  return (
    <AppShell
      title="Конкуренты и тренды"
      subtitle="Ищи реальные Telegram-каналы, публикации и тренды по любой теме."
    >
      <ReconTabs />
      <RadarInner />
    </AppShell>
  );
}

import { AppShell } from "@/components/app/shell";
import { ReconTabs } from "@/components/app/recon-tabs";
import { RadarInner } from "@/app/app/radar/radar-inner";

export default function ReconPage() {
  return (
    <AppShell
      title="Конкуренты и тренды"
      subtitle="Смотри, что публикуют другие, какие темы набирают внимание и что можно адаптировать для себя."
    >
      <ReconTabs />
      <RadarInner />
    </AppShell>
  );
}

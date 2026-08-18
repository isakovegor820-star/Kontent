import { AppShell } from "@/components/app/shell";
import { RadarInner } from "@/app/app/radar/radar-inner";

export default function ReconPage() {
  return (
    <AppShell
      title="Конкуренты и тренды"
      subtitle="Ищи Telegram-каналы, публикации и тренды без фиксированного лимита выдачи."
    >
      <RadarInner />
    </AppShell>
  );
}

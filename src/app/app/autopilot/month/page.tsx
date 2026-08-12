import { AppShell } from "@/components/app/shell";
import { MonthlyCampaignPlanner } from "@/components/app/monthly-campaign-planner";

export default function MonthlyAutopilotPage() {
  return (
    <AppShell
      title="Кампания на месяц"
      subtitle="Сначала согласуй темы месяца, затем готовь подробные материалы ближайшей недели."
    >
      <MonthlyCampaignPlanner />
    </AppShell>
  );
}

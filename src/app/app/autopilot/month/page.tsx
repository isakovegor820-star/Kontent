import { AppShell } from "@/components/app/shell";
import { MonthlyCampaignPlanner } from "@/components/app/monthly-campaign-planner";

export default function MonthlyAutopilotPage() {
  return (
    <AppShell
      title="Кампания на месяц"
      subtitle="Сетка тем на весь месяц. Полные тексты первой недели — только после согласования."
    >
      <MonthlyCampaignPlanner />
    </AppShell>
  );
}

import { AppShell } from "@/components/app/shell";
import { MonthlyCampaignPlanner } from "@/components/app/monthly-campaign-planner";

export default function MonthlyAutopilotPage() {
  return (
    <AppShell
      title="Кампания на месяц"
      subtitle="Запас тем на каждый день месяца. После согласования Аврора готовит выбранный темп постов на первую неделю."
    >
      <MonthlyCampaignPlanner />
    </AppShell>
  );
}

import type { WorkspaceRequestFence, WorkspaceRequestTicket } from "./client-workspace-isolation";

export function monthlyDetailRequestIdentity(campaignId: number): string {
  return `monthly-campaign:${campaignId}`;
}

export function isCurrentMonthlyDetailRequest(
  fence: WorkspaceRequestFence,
  ticket: WorkspaceRequestTicket,
  selectedCampaignId: number | null,
): boolean {
  return fence.isCurrent(
    ticket,
    selectedCampaignId ? monthlyDetailRequestIdentity(selectedCampaignId) : null,
  );
}

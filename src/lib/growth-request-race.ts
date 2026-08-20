import type { WorkspaceRequestFence, WorkspaceRequestTicket } from "./client-workspace-isolation";

export function growthRequestIdentity(channelId: number): string {
  return `growth-channel:${channelId}`;
}

export function isCurrentGrowthRequest(
  fence: WorkspaceRequestFence,
  ticket: WorkspaceRequestTicket,
  selectedChannelId: number | null,
): boolean {
  return fence.isCurrent(
    ticket,
    selectedChannelId ? growthRequestIdentity(selectedChannelId) : null,
  );
}

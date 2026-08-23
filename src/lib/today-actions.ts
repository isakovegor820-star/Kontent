import { appDraftActionHref } from "./app-routes";
import {
  createOpportunitySourceContext,
  createPublishedPostSourceContext,
  isContentIntelligenceError,
} from "./content-intelligence";
import { loadTodayBoard, type TodaySmartAction } from "./today";
import { DraftValidationError } from "./server-drafts";

export class TodayActionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "TodayActionError";
  }
}

export async function performTodaySmartAction(input: {
  actorUserId: number;
  channelId: number;
  fingerprint: string;
  actionKind: TodaySmartAction["kind"];
}) {
  if (!Number.isSafeInteger(input.channelId) || input.channelId <= 0) throw new TodayActionError("bad_channel");
  if (!/^[0-9a-f]{64}$/u.test(input.fingerprint)) throw new TodayActionError("bad_fingerprint");
  const board = await loadTodayBoard({ actorUserId: input.actorUserId, channelId: input.channelId });
  const item = board.items.find((candidate) => candidate.fingerprint === input.fingerprint);
  if (!board.enabled || !item?.smartAction) throw new TodayActionError("action_not_found");
  if (item.smartAction.kind !== input.actionKind) throw new TodayActionError("action_changed");

  try {
    if (item.smartAction.kind === "create_opportunity_draft" || item.smartAction.kind === "fill_calendar_gap") {
      const result = await createOpportunitySourceContext({
        actorUserId: input.actorUserId,
        opportunityId: item.smartAction.subjectId,
      });
      const baseHref = appDraftActionHref("create", result.draftId);
      const href = item.smartAction.kind === "fill_calendar_gap" && item.smartAction.scheduledLocalDate
        ? `${baseHref}&calendarDate=${encodeURIComponent(item.smartAction.scheduledLocalDate)}`
        : baseHref;
      return { href, created: result.created };
    }
    const result = await createPublishedPostSourceContext({
      actorUserId: input.actorUserId,
      postId: item.smartAction.subjectId,
      channelId: input.channelId,
      mode: item.smartAction.kind === "continue_post" ? "continue" : "improve",
    });
    return { href: appDraftActionHref("create", result.draftId), created: result.created };
  } catch (error) {
    if (isContentIntelligenceError(error)) throw new TodayActionError(error.code);
    if (error instanceof DraftValidationError) {
      throw new TodayActionError(error.code === "source_context_not_found" ? "action_source_unavailable" : "action_changed");
    }
    throw error;
  }
}

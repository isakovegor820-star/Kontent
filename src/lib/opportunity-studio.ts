type OpportunityStudioHrefInput = {
  growthMoveId: number;
  opportunityId: number;
  channelId: number;
};

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * URLs carry only project-owned identifiers. The Studio loads the trusted prompt and
 * evidence from the server, so public source text never becomes executable URL input.
 */
export function opportunityStudioHref(input: OpportunityStudioHrefInput): string {
  const params = new URLSearchParams({
    growthMove: String(positiveInteger(input.growthMoveId, "growthMoveId")),
    opportunity: String(positiveInteger(input.opportunityId, "opportunityId")),
    channel: String(positiveInteger(input.channelId, "channelId")),
    intent: "create",
  });
  return `/app/studio?${params.toString()}`;
}

/** Stable keys make refresh/retry replay one AI result instead of spending twice. */
export function studioGrowthMoveGenerationIdentity(growthMoveId: number) {
  const id = positiveInteger(growthMoveId, "growthMoveId");
  const requestKey = `studio_growth_move_${id}`;
  return {
    requestKey,
    resultClientKey: `draft_result_${requestKey}`,
  } as const;
}

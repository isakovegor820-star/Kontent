import type { StudioChatGeneration } from "./studio-chat-session";

const SAFE_IDENTITY_PART = /^[A-Za-z0-9:_-]+$/;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * Both keys are deterministic. A browser refresh can therefore replay the staged AI
 * result and the draft POST without calling the provider or creating another draft.
 */
export function studioReferenceGenerationIdentity(draftId: number, version: number) {
  const requestKey = `studio_reference_${positiveInteger(draftId, "draftId")}_v${positiveInteger(version, "version")}`;
  return {
    requestKey,
    resultClientKey: `draft_result_${requestKey}`,
  } as const;
}

export function validStudioReferenceResultKey(value: string): boolean {
  return value.length >= 16 && value.length <= 160 && SAFE_IDENTITY_PART.test(value);
}


/** Recover only an explicitly requested new operation in this exact source/channel. */
export function recoverStudioReferenceGenerationIdentity(
  input: { draftId: number; version: number; channelId: number },
  generations: Iterable<StudioChatGeneration>,
) {
  const original = studioReferenceGenerationIdentity(input.draftId, input.version);
  const chosen = [...generations].filter((generation) =>
    generation.referenceDraftId === input.draftId && generation.referenceDraftVersion === input.version
    && generation.referenceIntent === "create" && generation.channelId === input.channelId
    && Number.isSafeInteger(generation.requestCreatedAt) && Number(generation.requestCreatedAt) > 0
    && typeof generation.requestKey === "string" && /^[A-Za-z0-9:_-]{8,96}$/u.test(generation.requestKey))
    .sort((a, b) => Number(b.requestCreatedAt) - Number(a.requestCreatedAt))[0];
  if (!chosen?.requestKey) return { ...original, generation: undefined };
  return { requestKey: chosen.requestKey, resultClientKey: `draft_result_${chosen.requestKey}`, generation: chosen };
}

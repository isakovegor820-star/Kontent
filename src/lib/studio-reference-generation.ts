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

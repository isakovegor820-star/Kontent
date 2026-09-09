/** UTF-16 code-unit bound shared by editorial intent and its immutable validation receipt. */
export const AI_VALIDATION_TOPIC_MAX_LENGTH = 1800;

/** Keep the established bound without creating a split surrogate in JSONB metadata. */
export function editorialValidationTopic(text: string): string {
  let end = Math.min(text.length, AI_VALIDATION_TOPIC_MAX_LENGTH);
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return text.slice(0, end);
}

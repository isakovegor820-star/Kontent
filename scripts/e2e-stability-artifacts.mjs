export function selectFreshJourneyFailureDetail({
  resultError,
  resultModifiedAtMs,
  journeyStartedAtMs,
  output,
}) {
  const freshResult = Number.isFinite(resultModifiedAtMs)
    && Number.isFinite(journeyStartedAtMs)
    && resultModifiedAtMs >= journeyStartedAtMs;
  const detail = freshResult ? String(resultError || "").trim() : "";
  if (detail) return `: ${detail.slice(0, 2_000)}`;

  const fallback = String(output || "")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Error:"))
    .at(-1)
    ?.replace(/^Error:\s*/u, "")
    .slice(0, 2_000);
  return fallback ? `: ${fallback}` : "";
}

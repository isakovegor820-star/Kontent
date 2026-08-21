// Reader-facing Autopilot text must never expose the private research trail. Older plans
// may already contain a footer, so the same boundary is applied in preview and scheduling.

const SOURCE_FOOTER = /(?:\n\s*){1,3}(?:источник|первоисточник)\s*:\s*[^\n]{1,200}(?:\nhttps?:\/\/\S+)?\s*$/iu;

export function sanitizeAutopilotPublicText(value) {
  return String(value ?? "")
    .replace(SOURCE_FOOTER, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

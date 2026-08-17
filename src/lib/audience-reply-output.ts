import {
  AUDIENCE_REPLY_RISKS,
  AUDIENCE_REPLY_TONES,
  type GeneratedAudienceReply,
} from "./audience-assistant";

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.replace(/\r\n?/gu, "\n").trim();
  return result && result.length <= max ? result : null;
}

export function parseGeneratedAudienceReply(value: string): GeneratedAudienceReply | null {
  const unfenced = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>;
    const reply = clean(parsed.reply, 8_000);
    const guidance = clean(parsed.guidance, 2_000);
    const tone = parsed.tone;
    const riskLevel = parsed.riskLevel;
    if (
      !reply || !guidance
      || !AUDIENCE_REPLY_TONES.includes(tone as GeneratedAudienceReply["tone"])
      || !AUDIENCE_REPLY_RISKS.includes(riskLevel as GeneratedAudienceReply["riskLevel"])
    ) return null;
    return {
      reply,
      guidance,
      tone: tone as GeneratedAudienceReply["tone"],
      riskLevel: riskLevel as GeneratedAudienceReply["riskLevel"],
    };
  } catch {
    return null;
  }
}

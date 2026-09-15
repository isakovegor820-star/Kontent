import { createHash } from "node:crypto";

/**
 * Competitor discovery is allowed to fail closed. An empty, retryable result is safer
 * than silently teaching the trend feed from an unrelated channel.
 */
export function confirmedDiscoveryTopic(brief) {
  if (brief?.ready !== true) return "";
  const topic = String(brief?.niche || "").replace(/\s+/gu, " ").trim().slice(0, 300);
  return topic.length >= 3 ? topic : "";
}

/**
 * The classifier is deliberately binary. Explanations and prefix matches are rejected:
 * a public Telegram post is untrusted input and must not be able to smuggle in a verdict.
 */
export function parseStrictTopicVerdict(value) {
  const answer = String(value || "").normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
  if (/^да[.!]?$/u.test(answer)) return true;
  if (/^нет[.!]?$/u.test(answer)) return false;
  return null;
}

/**
 * Topic confirmation must enqueue a different job from the eager connect-time pass.
 * Including a topic fingerprint also makes a later niche change trigger fresh discovery.
 */
export function competitorDiscoveryJobId({ userId, channelId, topic }) {
  const fingerprint = createHash("sha256")
    .update(String(topic || "").normalize("NFKC").trim().toLocaleLowerCase("ru-RU"))
    .digest("hex")
    .slice(0, 16);
  return `discover-topic-${userId}-${channelId}-${fingerprint}`;
}

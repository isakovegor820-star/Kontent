import type { AutopilotSettings } from "./autopilot";
import type { Brief } from "./brief";
import type { PostQuality } from "./post-quality.mjs";

export const CHANNEL_COPY_GROUPS = [
  "channel",
  "author",
  "voice",
  "structure",
  "constraints",
  "autopilot",
] as const;

export type ChannelCopyGroup = (typeof CHANNEL_COPY_GROUPS)[number];

export type ChannelConfigurationForCopy = {
  brief: Brief;
  settings: AutopilotSettings;
};

const VOICE_KEYS: Array<keyof PostQuality> = [
  "preset", "tone", "energy", "energyLevel", "warmth", "inspiration", "provocation",
  "formality", "expertise", "authorVoice", "persona", "address", "humor", "humorLevel",
  "opinionSharpness", "profanity", "profanityLevel", "languageLevel", "languageComplexity",
  "originality", "styleExamples",
];

const STRUCTURE_KEYS: Array<keyof PostQuality> = [
  "minChars", "maxChars", "hookRequired", "hookMaxChars", "maxParagraphSentences",
  "sentenceRhythm", "requireConclusion", "listPolicy", "listIntensity", "boldPolicy",
  "boldIntensity", "formatStyle", "directSpeech", "hookStyle", "hookIntensity",
  "quoteIntensity", "sceneIntensity", "readerDialogue",
];

const CONSTRAINT_KEYS: Array<keyof PostQuality> = [
  "factsPolicy", "factShare", "minCitationShare", "personalStoryShare", "trendFocus",
  "audienceExpertise", "postGoal", "disclaimerRequired", "disclaimerText", "ctaStyle",
  "ctaIntensity", "ctaEveryPosts", "interactivity", "salesMaxPercent", "emojiPolicy",
  "maxEmojis", "hashtagsPolicy", "maxHashtags", "allowedEmoji", "brandedHashtags",
  "sourceLinkIntensity", "mentionIntensity", "visualIntensity", "visualDetail", "linkRules",
  "visualDirection", "competitorTopics", "forbiddenPhrases", "forbiddenTopics",
  "qualityThreshold", "retryLimit",
];

function copyQualityKeys(
  target: PostQuality,
  source: PostQuality,
  keys: Array<keyof PostQuality>,
): PostQuality {
  const next = { ...target } as PostQuality;
  for (const key of keys) {
    (next as unknown as Record<string, unknown>)[key] = structuredClone(source[key]);
  }
  next.preset = "custom";
  return next;
}

export function mergeChannelConfiguration(
  source: ChannelConfigurationForCopy,
  target: ChannelConfigurationForCopy,
  selected: Iterable<ChannelCopyGroup>,
): ChannelConfigurationForCopy {
  const groups = new Set(selected);
  let quality = structuredClone(target.brief.quality);
  if (groups.has("voice")) quality = copyQualityKeys(quality, source.brief.quality, VOICE_KEYS);
  if (groups.has("structure")) quality = copyQualityKeys(quality, source.brief.quality, STRUCTURE_KEYS);
  if (groups.has("constraints")) quality = copyQualityKeys(quality, source.brief.quality, CONSTRAINT_KEYS);

  const brief: Brief = {
    ...structuredClone(target.brief),
    ...(groups.has("channel") ? {
      niche: source.brief.niche,
      audience: source.brief.audience,
      rubrics: structuredClone(source.brief.rubrics),
      formats: structuredClone(source.brief.formats),
      authorRole: source.brief.authorRole,
      goal: source.brief.goal,
      cta: source.brief.cta,
      taboo: source.brief.taboo,
    } : {}),
    ...(groups.has("author") ? { profileAnswers: structuredClone(source.brief.profileAnswers) } : {}),
    quality,
    ready: true,
    source: "manual",
  };
  return {
    brief,
    settings: groups.has("autopilot")
      ? { ...structuredClone(source.settings), enabled: false, mode: "confirm" }
      : structuredClone(target.settings),
  };
}

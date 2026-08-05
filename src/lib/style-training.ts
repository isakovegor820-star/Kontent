import type { PostQuality } from "./post-quality.mjs";

export interface StyleTrainingResult {
  samples: string[];
  confidence: "low" | "medium" | "high";
  summary: string[];
  patch: Partial<PostQuality>;
}

const clean = (value: unknown, max = 2500) =>
  String(value ?? "").replace(/\r/g, "").trim().slice(0, max);

export function splitStyleSamples(value: string): string[] {
  return value
    .split(/\n\s*---\s*\n/u)
    .map((sample) => clean(sample))
    .filter((sample) => sample.length >= 20)
    .slice(0, 5);
}

function matches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

export function analyzeStyleSamples(value: string): StyleTrainingResult | null {
  const samples = splitStyleSamples(value);
  if (!samples.length) return null;

  const joined = samples.join("\n\n");
  const sentences = joined
    .split(/[.!?…]+(?:[»”"')\]]|\s|$)/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const words = joined.match(/[\p{L}\p{N}]+/gu) ?? [];
  const avgSentenceWords = words.length / Math.max(1, sentences.length);
  const paragraphs = joined.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  const avgParagraphChars = joined.length / Math.max(1, paragraphs.length);
  const emojis = matches(joined, /\p{Extended_Pictographic}/gu);
  const hashtags = matches(joined, /(^|\s)#[\p{L}\p{N}_]+/gu);
  const exclamations = matches(joined, /!/gu);
  const questions = matches(joined, /\?/gu);
  const informal = matches(joined.toLocaleLowerCase("ru"), /(?:^|[^\p{L}])(?:ты|тебя|тебе|тобой|твой|твоя|твои|твоего|твоей)(?!\p{L})/gu);
  const formal = matches(joined.toLocaleLowerCase("ru"), /(?:^|[^\p{L}])(?:вы|вас|вам|вами|ваш|ваша|ваши|вашего|вашей)(?!\p{L})/gu);
  const firstPerson = matches(joined.toLocaleLowerCase("ru"), /(?:^|[^\p{L}])(?:я|мне|меня|мой|моя|моё|мои)(?!\p{L})/gu);
  const companyVoice = matches(joined.toLocaleLowerCase("ru"), /(?:^|[^\p{L}])(?:мы|нам|нас|наш|наша|наши)(?!\p{L})/gu);
  const maxEmojis = Math.min(20, Math.max(...samples.map((sample) => matches(sample, /\p{Extended_Pictographic}/gu))));
  const maxHashtags = Math.min(10, Math.max(...samples.map((sample) => matches(sample, /(^|\s)#[\p{L}\p{N}_]+/gu))));

  const address: PostQuality["address"] | null = informal >= 2 && informal > formal * 1.5
    ? "ты"
    : formal >= 2 && formal > informal * 1.5
      ? "вы"
      : null;
  const energy = avgSentenceWords <= 10 || (exclamations + questions) / Math.max(1, sentences.length) > 0.18
    ? "Живая и энергичная, с коротким ритмом"
    : avgSentenceWords >= 18
      ? "Спокойная и развёрнутая, без суеты"
      : "Ровная и разговорная, с естественным ритмом";
  const rhythm = avgSentenceWords <= 10
    ? "короткие предложения"
    : avgSentenceWords >= 18
      ? "развёрнутые предложения"
      : "смешанный ритм предложений";
  const paragraphStyle = avgParagraphChars <= 180 ? "короткие абзацы" : "содержательные абзацы";
  const addressLabel = address === "ты" ? "обращение на «ты»" : address === "вы" ? "обращение на «вы»" : "без устойчивого обращения";
  const emojiLabel = emojis === 0 ? "без эмодзи" : `до ${maxEmojis} эмодзи в посте`;
  const hashtagLabel = hashtags === 0 ? "без хэштегов" : `до ${maxHashtags} хэштегов`;

  return {
    samples,
    confidence: samples.length >= 4 ? "high" : samples.length >= 2 ? "medium" : "low",
    summary: [rhythm, paragraphStyle, addressLabel, emojiLabel, hashtagLabel],
    patch: {
      preset: "custom",
      styleExamples: samples,
      energy,
      energyLevel: avgSentenceWords <= 10 ? 76 : avgSentenceWords >= 18 ? 30 : 50,
      sentenceRhythm: avgSentenceWords <= 10 ? 22 : avgSentenceWords >= 18 ? 78 : 50,
      readerDialogue: Math.min(100, Math.round((questions / Math.max(1, sentences.length)) * 260)),
      maxParagraphSentences: avgParagraphChars <= 180 ? 2 : avgParagraphChars <= 320 ? 3 : 4,
      authorVoice: firstPerson > companyVoice * 1.4 ? 2 : companyVoice > firstPerson * 1.4 ? 1 : 0,
      ...(address ? { address } : {}),
      emojiPolicy: emojis === 0 ? "none" : maxEmojis <= 3 ? "restrained" : "active",
      maxEmojis,
      hashtagsPolicy: hashtags === 0 ? "none" : "restrained",
      maxHashtags,
    },
  };
}

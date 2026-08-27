import type { PostQuality } from "./post-quality.mjs";

export const SETTINGS_PREVIEW_DAILY_LIMIT = 10;

export type AppliedSettingReport = {
  id: string;
  label: string;
  status: "applied" | "not_configured";
  detail: string;
};

export function buildSettingsApplicationReport(input: {
  profile: string;
  quality: PostQuality;
  styleSamples: string[];
}): AppliedSettingReport[] {
  const quality = input.quality;
  const hasBrandDictionary = input.profile.includes("Словарь бренда проекта:");
  const hasDetailedAuthorProfile = input.profile.includes("Профиль автора")
    || input.profile.includes("Биография")
    || input.profile.includes("Экспертиза");
  return [
    {
      id: "channel_context",
      label: "Канал и аудитория",
      status: input.profile.trim() ? "applied" : "not_configured",
      detail: input.profile.trim()
        ? "Тема, аудитория, цель и роль автора переданы модели."
        : "Бриф канала пока пуст.",
    },
    {
      id: "author_profile",
      label: "Образ и экспертиза автора",
      status: hasDetailedAuthorProfile ? "applied" : "not_configured",
      detail: hasDetailedAuthorProfile
        ? "Заполненные ответы анкеты автора вошли в контекст."
        : "Подробная анкета автора пока не заполнена.",
    },
    {
      id: "voice",
      label: "Голос и стиль",
      status: "applied",
      detail: `${quality.tone}; обращение: ${quality.address}; энергия ${quality.energyLevel}/100; теплота ${quality.warmth}/100.`,
    },
    {
      id: "structure",
      label: "Структура и формат",
      status: "applied",
      detail: `${quality.minChars}–${quality.maxChars} знаков; до ${quality.maxParagraphSentences} предложений в абзаце; хук ${quality.hookRequired ? "обязателен" : "не обязателен"}.`,
    },
    {
      id: "constraints",
      label: "Качество и ограничения",
      status: "applied",
      detail: `Порог ${quality.qualityThreshold}/100; стоп-фраз: ${quality.forbiddenPhrases.length}; стоп-тем: ${quality.forbiddenTopics.length}; эмодзи до ${quality.maxEmojis}.`,
    },
    {
      id: "style_samples",
      label: "Примеры авторского голоса",
      status: input.styleSamples.length ? "applied" : "not_configured",
      detail: input.styleSamples.length
        ? `Передано образцов: ${input.styleSamples.length}.`
        : "Подтверждённых примеров пока нет.",
    },
    {
      id: "brand_dictionary",
      label: "Словарь бренда",
      status: hasBrandDictionary ? "applied" : "not_configured",
      detail: hasBrandDictionary
        ? "Канонические написания и запреты переданы модели и будут перепроверены типографом."
        : "В словаре пока нет активных правил.",
    },
  ];
}

// Compact Autopilot controls shared by the UI, API and standalone worker.
// They tune presentation only; factual and legal safety rules remain owned by the brief.

export const DEFAULT_AUTOPILOT_QUICK_SETTINGS = Object.freeze({
  newsPerWeek: 3,
  detail: 2,
  energy: 2,
  emoji: 1,
});

const boundedInteger = (value, min, max, fallback) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

export function normalizeAutopilotQuickSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    newsPerWeek: boundedInteger(source.newsPerWeek, 0, 7, DEFAULT_AUTOPILOT_QUICK_SETTINGS.newsPerWeek),
    detail: boundedInteger(source.detail, 1, 3, DEFAULT_AUTOPILOT_QUICK_SETTINGS.detail),
    energy: boundedInteger(source.energy, 1, 3, DEFAULT_AUTOPILOT_QUICK_SETTINGS.energy),
    emoji: boundedInteger(source.emoji, 0, 2, DEFAULT_AUTOPILOT_QUICK_SETTINGS.emoji),
  };
}

export function autopilotNewsPostCount(settings, weeks, total) {
  const normalized = normalizeAutopilotQuickSettings(settings);
  const horizon = Math.max(1, Math.round(Number(weeks) || 1));
  return Math.min(Math.max(0, Math.round(Number(total) || 0)), normalized.newsPerWeek * horizon);
}

export function applyAutopilotQuickSettingsToQuality(rawQuality, settings) {
  const style = normalizeAutopilotQuickSettings(settings);
  const lengths = {
    1: { minChars: 400, maxChars: 750 },
    2: { minChars: 700, maxChars: 1_150 },
    3: { minChars: 1_000, maxChars: 1_650 },
  };
  const emoji = {
    0: { emojiPolicy: "none", maxEmojis: 0 },
    1: { emojiPolicy: "restrained", maxEmojis: 1 },
    2: { emojiPolicy: "active", maxEmojis: 3 },
  };
  return { ...rawQuality, ...lengths[style.detail], ...emoji[style.emoji] };
}

export function autopilotEnergyPrompt(settings) {
  const { energy } = normalizeAutopilotQuickSettings(settings);
  if (energy === 1) return "Подача спокойная: ровный тон, минимум эмоциональных усилителей.";
  if (energy === 3) return "Подача живая: быстрый ритм и сильный хук, но без кликбейта и истерики.";
  return "Подача разговорная: лёгкий естественный ритм без канцелярита и лишнего пафоса.";
}

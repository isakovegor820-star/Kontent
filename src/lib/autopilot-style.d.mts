export interface AutopilotQuickSettings {
  newsPerWeek: number;
  detail: number;
  energy: number;
  emoji: number;
}

export const DEFAULT_AUTOPILOT_QUICK_SETTINGS: Readonly<AutopilotQuickSettings>;
export function normalizeAutopilotQuickSettings(value: unknown): AutopilotQuickSettings;
export function autopilotNewsPostCount(settings: unknown, weeks: unknown, total: unknown): number;
export function applyAutopilotQuickSettingsToQuality(
  rawQuality: Record<string, unknown>,
  settings: unknown,
): Record<string, unknown>;
export function autopilotEnergyPrompt(settings: unknown): string;

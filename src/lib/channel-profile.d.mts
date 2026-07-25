// Типы для channel-profile.mjs (общий чистый модуль профиля канала).
// Позволяют TS-роутам и клиентским страницам импортировать @/lib/channel-profile.mjs
// со строгой типизацией (тот же паттерн, что у token-crypto.mjs).

export interface ChannelProfile {
  niche: string;
  topics: string[];
  services: string;
  prices: string;
  audience: string;
  tone: string;
  taboos: string;
  goal: string;
}

export interface ProfileField {
  key: keyof ChannelProfile;
  label: string;
  hint: string;
}

export const PROFILE_FIELDS: ProfileField[];

export function emptyProfile(): ChannelProfile;
export function normalizeProfile(raw: unknown): ChannelProfile;
export function isMeaningfulProfile(p: ChannelProfile | null | undefined): boolean;
export function buildExtractionMessages(
  channelTitle: string | null,
  posts: string[],
): { system: string; user: string };
export function parseProfile(aiText: string): ChannelProfile | null;
export function profileToSourceText(p: ChannelProfile): string;
export function profileFromInterview(a: {
  about?: string;
  services?: string;
  prices?: string;
  taboos?: string;
  tone?: string;
  goal?: string;
}): ChannelProfile;

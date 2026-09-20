import type { PostSettings } from "./post-settings";

export type ContentLanguage = "ru" | "en";

/**
 * Detects the language that dominates actual prose. Short labels, URLs and mixed
 * product names deliberately fall back to the saved publication setting.
 */
export function inferContentLanguage(text: string): ContentLanguage | null {
  const prose = String(text)
    .replace(/\b(?:https?:\/\/|www\.)\S+/giu, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, " ");
  const letters = prose.match(/[A-Za-zА-Яа-яЁё]/gu) ?? [];
  if (letters.length < 12) return null;
  let latin = 0;
  let cyrillic = 0;
  for (const letter of letters) {
    if (/[A-Za-z]/u.test(letter)) latin += 1;
    else cyrillic += 1;
  }
  if (latin >= 8 && latin >= cyrillic * 1.5) return "en";
  if (cyrillic >= 8 && cyrillic >= latin * 1.5) return "ru";
  return null;
}

/** Editor actions transform the visible post, so its language wins over stale settings. */
export function postSettingsForSourceLanguage(
  settings: PostSettings,
  sourceText: string,
): PostSettings {
  const language = inferContentLanguage(sourceText);
  return language && language !== settings.language
    ? { ...settings, language }
    : settings;
}

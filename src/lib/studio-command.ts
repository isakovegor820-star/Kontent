import type { AiCommand } from "./ai";

/** Определяет формат по явной команде, не путая «вопрос» с «опросом». */
export function pickStudioCommand(text: string): AiCommand {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.some((word) => word.startsWith("план"))) return "plan";
  if (words.some((word) => word.startsWith("сценар") || word.startsWith("видео"))) return "script";
  if (words.some((word) => word.startsWith("сократ"))) return "shorten";
  if (words.some((word) => word.startsWith("перепиш"))) return "rewrite";
  if (words.some((word) => word.startsWith("картинк"))) return "image";
  if (words.some((word) => /^опрос(?:ы|а|у|ом|е|ов|ами|ах)?$/u.test(word) || word.startsWith("голосован"))) {
    return "poll";
  }
  if (words.some((word) => word.startsWith("лонгрид") || word.startsWith("длинн"))) return "longread";
  return "write";
}

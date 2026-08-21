// Границы предложений в русском тексте. Отдельный модуль без зависимостей: одно и то же
// разбиение нужно и проверке качества, и полировщику формы, а импортировать их друг из
// друга нельзя.
//
// Точка не всегда конец мысли: «ст. 213», «т. д.», «п. 4» — сокращения. Поэтому границей
// считаем только переход к новому предложению: заглавная буква, открывающая кавычка или
// тире прямой речи после пробела.

/** @param {string} text @returns {string[]} */
export function splitSentences(text) {
  const value = String(text ?? "").trim();
  if (!value) return [];
  const chars = [...value];
  const sentences = [];
  let buffer = "";
  for (let i = 0; i < chars.length; i += 1) {
    buffer += chars[i];
    if (!/[.!?…]/u.test(chars[i])) continue;
    let end = i + 1;
    while (end < chars.length && /[.!?…»”"')\]]/u.test(chars[end])) {
      buffer += chars[end];
      end += 1;
    }
    i = end - 1;
    const rest = chars.slice(end).join("");
    if (!rest.trim()) break;
    if (/^\s/u.test(rest) && /^(?:[«"“(]?\p{Lu}|[—–]\s)/u.test(rest.trimStart())) {
      sentences.push(buffer.trim());
      buffer = "";
    }
  }
  if (buffer.trim()) sentences.push(buffer.trim());
  return sentences;
}

/** @param {string} text @returns {number} */
export function countSentences(text) {
  const count = splitSentences(text).length;
  return count || (String(text ?? "").trim() ? 1 : 0);
}

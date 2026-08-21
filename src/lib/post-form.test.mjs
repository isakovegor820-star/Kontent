import { describe, expect, it } from "vitest";

import { padDraftToMinimum, prepareAutopilotDraftForm } from "./autopilot-quality.mjs";
import { finishPostForm, normalizePostForm } from "./post-form.mjs";
import { presetQuality, validatePostQuality } from "./post-quality.mjs";
import { countSentences } from "./ru-sentences.mjs";

const grounded = { supportCount: 1, citedShare: 1, invented: [] };
const codesOf = (text, quality, context = grounded) =>
  validatePostQuality(text, quality, context).violations.map((violation) => violation.code);

// Черновик в том виде, в каком его отдаёт модель: остаток промпта в первой строке, простыня
// вместо абзацев, эмодзи и хэштеги сверх лимита, восклицания и ни одного дисклеймера.
const rawModelDraft = () =>
  [
    "Хук: Долги по кредитам не исчезают сами, и это стоит признать до того, как приставы придут к вам домой!!!",
    "Списание долга через банкротство выглядит как крайняя мера, но на практике это обычная процедура с понятными правилами. 🔥 Человек перестаёт платить, потому что доход упал, а платежи остались прежними. Банк передаёт долг коллекторам, начинаются звонки и письма. Дальше дело уходит в суд, и вот там уже появляется исполнительный лист. ✅ Именно в этот момент многие впервые задумываются о процедуре, хотя обсуждать её стоило гораздо раньше. 🎯",
    "Разбираться в процедуре лучше спокойно и по порядку. Сначала стоит собрать все требования кредиторов в один список, чтобы понимать общую картину. Затем нужно честно посмотреть на имущество и доходы, потому что от этого зависит ход дела. ⚖️ После этого имеет смысл обсудить ситуацию со специалистом, который уже вёл похожие дела. 📌 Такой порядок помогает не принимать решения в панике. ❌",
    "Главное — не тянуть до последнего дня. Чем раньше вы посмотрите на ситуацию целиком, тем больше остаётся спокойных вариантов. Решение, принятое заранее, почти всегда обходится дешевле того, которое принимают под давлением. #банкротство #долги",
  ].join("\n\n");

describe("форма поста приводится кодом, а не замечанием проверки", () => {
  it("черновик со сбитой формой проходит проверку на 100 после полировки", () => {
    const legal = presetQuality("legal");
    const before = validatePostQuality(rawModelDraft(), legal, grounded);
    expect(before.passed).toBe(false);

    const polished = prepareAutopilotDraftForm(rawModelDraft(), legal);
    const after = validatePostQuality(polished, legal, grounded);
    expect(after.violations).toEqual([]);
    expect(after.score).toBe(100);
    expect(after.passed).toBe(true);
  });

  it("не выдумывает содержание: полировка только убирает и переставляет", () => {
    const legal = presetQuality("legal");
    const polished = prepareAutopilotDraftForm(rawModelDraft(), legal);
    // Дисклеймер профиля добавляется дословно, всё остальное — слова исходного черновика.
    const added = polished.replace(legal.disclaimerText, "");
    for (const word of ["коллекторам", "исполнительный", "приставы", "кредиторов"]) {
      expect(added).toContain(word);
    }
    expect(added).not.toMatch(/Хук\s*:/iu);
    expect(added).not.toMatch(/#\p{L}+/u);
    expect(added).not.toMatch(/!{2,}/u);
  });

  it("длинный хук делит по границе клауз, сохраняя союз", () => {
    const legal = presetQuality("legal");
    const polished = prepareAutopilotDraftForm(rawModelDraft(), legal);
    const [hook, second] = polished.split("\n\n");
    expect(hook.length).toBeLessThanOrEqual(legal.hookMaxChars);
    expect(hook).toBe("Долги по кредитам не исчезают сами.");
    expect(second).toBe("И это стоит признать до того, как приставы придут к вам домой!");
  });

  it("повторная полировка ничего не меняет", () => {
    const legal = presetQuality("legal");
    const once = prepareAutopilotDraftForm(rawModelDraft(), legal);
    expect(prepareAutopilotDraftForm(once, legal)).toBe(once);
  });

  it("обязательный дисклеймер остаётся дословно и не съедается подрезкой объёма", () => {
    const legal = presetQuality("legal");
    const long = `${"Порядок действий здесь важнее скорости. ".repeat(60)}`;
    const polished = prepareAutopilotDraftForm(long, legal);
    expect(polished).toContain(legal.disclaimerText);
    expect(polished.length).toBeLessThanOrEqual(legal.maxChars);
    expect(codesOf(polished, legal)).not.toContain("disclaimer");
  });

  it("жирное выделение ставит код, если профиль его требует", () => {
    const quality = { ...presetQuality("expert"), boldPolicy: "required" };
    const finished = finishPostForm("Первый абзац.\n\nВторой абзац.\n\nВывод короткий.", quality);
    expect(finished).toContain("**Вывод короткий.**");
    expect(codesOf(finished, quality)).not.toContain("bold");
  });

  it("списки снимает, когда профиль их запрещает", () => {
    const quality = { ...presetQuality("expert"), listPolicy: "avoid" };
    const normalized = normalizePostForm(
      "Что проверить сначала.\n\n— первый пункт\n— второй пункт\n\nВывод короткий.",
      quality,
    );
    expect(codesOf(normalized, quality)).not.toContain("list");
    expect(normalized).toContain("Первый пункт.");
  });
});

describe("правила, которые раньше не срабатывали", () => {
  it("предложения считаются по границам, а не по точке перед концом строки", () => {
    expect(countSentences("Раз. Два. Три.")).toBe(3);
    expect(countSentences("Смотрите ст. 213 ГК РФ. Там всё написано.")).toBe(2);
    expect(countSentences("Одно предложение без точки")).toBe(1);
    expect(countSentences("")).toBe(0);
  });

  it("простыня из пяти предложений в абзаце теперь видна проверке", () => {
    const expert = presetQuality("expert");
    const sheet = "Первое. Второе. Третье. Четвёртое. Пятое.";
    expect(codesOf(sheet, expert)).toContain("dense_paragraph");
    expect(codesOf(normalizePostForm(sheet, expert), expert)).not.toContain("dense_paragraph");
  });

  it("служебную метку ловит в начале строки и не трогает обычную речь", () => {
    const expert = presetQuality("expert");
    expect(codesOf("Хук: короткая строка\n\nДальше текст.", expert)).toContain("meta_labels");
    expect(codesOf("Вывод: беречь документы.", expert)).toContain("meta_labels");
    expect(codesOf("Отсюда вывод: проверяйте документы заранее.", expert)).not.toContain(
      "meta_labels",
    );
  });

  it("добивка объёма говорит с читателем на языке канала", () => {
    for (const preset of ["expert", "legal"]) {
      const quality = presetQuality(preset);
      expect(quality.address).toBe("вы");
      const padded = padDraftToMinimum("Короткий текст про сроки.", 300, 1200, quality.address);
      expect(padded.length).toBeGreaterThanOrEqual(300);
      expect(codesOf(padded, quality)).not.toContain("address");
    }
  });

  it("канал на «ты» получает добивку на «ты»", () => {
    const quality = { ...presetQuality("expert"), address: "ты" };
    const padded = padDraftToMinimum("Короткий текст про сроки.", 300, 1200, "ты");
    expect(padded).toMatch(/тебя|тебе|твоей/u);
    expect(codesOf(padded, quality)).not.toContain("address");
  });
});

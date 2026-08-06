import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "./ai-provider";
import {
  DEFAULT_POST_SETTINGS,
  POST_PRESETS,
  POST_TARGET_RULES,
  applyPostPreset,
  buildPostSettingsSummary,
  buildPostRepairInstructions,
  buildPostSettingsPrompt,
  compactPostSettings,
  normalizePostSettings,
  patchPostSettings,
  postLengthRange,
  postSettingsOutputTokens,
  resolvePostTarget,
  validatePostSettingsConflicts,
  validatePostSettingsResult,
  type PostSettings,
  type PostTarget,
} from "./post-settings";

describe("настройки публикации", () => {
  it("держит все платформенные форматы и 12 назначенческих пресетов в одном реестре", () => {
    expect(Object.keys(POST_TARGET_RULES)).toEqual([
      "instagram_post",
      "instagram_reel",
      "telegram_channel",
      "vk_community",
      "youtube_title",
      "youtube_description",
      "youtube_community",
    ]);
    expect(POST_PRESETS).toHaveLength(12);
    expect(new Set(POST_PRESETS.map((preset) => preset.id)).size).toBe(12);
  });

  it("мигрирует пустые и старые настройки в безопасный Auto без исключений", () => {
    expect(normalizePostSettings(null)).toEqual(DEFAULT_POST_SETTINGS);
    expect(normalizePostSettings({ version: 0, platform: "tg", tone: "старое поле" })).toEqual(DEFAULT_POST_SETTINGS);
    expect(compactPostSettings(DEFAULT_POST_SETTINGS)).toEqual({ version: 1 });
  });

  it("пресет не сбрасывает площадку и аудиторию, а ручная правка делает профиль custom", () => {
    const initial = normalizePostSettings({
      target: "instagram_reel",
      audience: "предприниматели после первого запуска",
      requiredFacts: ["Дата конференции — 14 сентября"],
    });
    const selling = applyPostPreset(initial, "selling");
    expect(selling).toMatchObject({
      target: "instagram_reel",
      audience: "предприниматели после первого запуска",
      preset: "selling",
      goal: "sale",
      cta: "buy",
    });
    expect(selling.requiredFacts).toEqual(["Дата конференции — 14 сентября"]);

    const custom = patchPostSettings(selling, { emojiMode: "none" });
    expect(custom).toMatchObject({ preset: "custom", emojiMode: "none", emojiMax: 0 });
    expect(custom.target).toBe("instagram_reel");
  });

  it("разрешает конфликты диапазона и платформенного предела детерминированно", () => {
    const title = normalizePostSettings({
      target: "youtube_title",
      length: "custom",
      customMinChars: 160,
      customMaxChars: 20,
    });
    expect(title.customMinChars).toBe(20);
    expect(title.customMaxChars).toBe(100);
    expect(postLengthRange(title)).toEqual([20, 100]);

    const noDecoration = normalizePostSettings({ emojiMode: "none", emojiMax: 12, hashtags: "none", hashtagCount: 10 });
    expect(noDecoration).toMatchObject({ emojiMax: 0, hashtagCount: 0 });
    expect(noDecoration.allowedEmojis).toEqual([]);
  });

  it("разрешает Auto по подключённой сети, но уважает явный формат", () => {
    expect(resolvePostTarget(DEFAULT_POST_SETTINGS, "instagram")).toBe("instagram_post");
    expect(resolvePostTarget(DEFAULT_POST_SETTINGS, "youtube")).toBe("youtube_community");
    expect(resolvePostTarget(DEFAULT_POST_SETTINGS, "vk")).toBe("vk_community");
    expect(resolvePostTarget({ target: "youtube_title" }, "tg")).toBe("youtube_title");
  });

  it("в Auto уважает команды «короче» и «лонгрид»", () => {
    expect(postLengthRange({ target: "telegram_channel" }, "tg", "shorten")).toEqual([250, 700]);
    expect(postLengthRange({ target: "telegram_channel" }, "tg", "longread")).toEqual([1600, 3600]);
  });
});

describe("платформенный prompt builder", () => {
  const promptFor = (target: PostTarget) => buildPostSettingsPrompt({
    target,
    goal: "engagement",
    audience: "руководители продуктовых команд",
    length: "short",
    cta: "comment",
    emojiMode: "none",
    hashtags: "none",
  });

  it("собирает разные правила для Instagram, Telegram, VK и трёх форматов YouTube", () => {
    const instagram = promptFor("instagram_post");
    const telegram = promptFor("telegram_channel");
    const vk = promptFor("vk_community");
    const title = promptFor("youtube_title");
    const description = promptFor("youtube_description");
    const community = promptFor("youtube_community");

    expect(instagram).toContain("Instagram · публикация");
    expect(instagram).toContain("дополняет визуал");
    expect(telegram).toContain("Telegram · канал");
    expect(telegram).toContain("самостоятельное сообщение автора");
    expect(vk).toContain("VK · сообщество");
    expect(vk).toContain("более подробный разбор");
    expect(title).toContain("одну строку без кавычек");
    expect(description).toContain("5000 байт UTF-8");
    expect(community).toContain("диалог со зрителями");
    expect(new Set([instagram, telegram, vk, title, description, community]).size).toBe(6);
  });

  it("включает точные факты, слова, упоминания и ссылки без служебного шума", () => {
    const prompt = buildPostSettingsPrompt({
      target: "telegram_channel",
      requiredFacts: ["Конференция состоится 14 сентября"],
      keywords: ["AI Product"],
      mentions: ["@aurora"],
      links: ["https://example.com/register"],
      forbiddenWords: ["революционный"],
    });
    expect(prompt).toContain("Конференция состоится 14 сентября");
    expect(prompt).toContain("AI Product");
    expect(prompt).toContain("@aurora");
    expect(prompt).toContain("https://example.com/register");
    expect(prompt).toContain("революционный");
    expect(prompt).toContain("не имитируй шрифт Unicode-символами");
  });
});

describe("программная поствалидация", () => {
  const exact = (patch: Partial<PostSettings> = {}) => normalizePostSettings({
    target: "telegram_channel",
    length: "custom",
    customMinChars: 20,
    customMaxChars: 500,
    emojiMode: "none",
    hashtags: "none",
    cta: "none",
    ...patch,
  });

  it("проверяет ноль эмодзи, хэштеги, запрещённые слова и служебные метки", () => {
    const result = validatePostSettingsResult(
      "Хук: В современном мире продукт меняется 🚀 #AI",
      exact({ forbiddenWords: ["продукт меняется"] }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      "emoji", "hashtags", "forbidden_phrase", "meta_labels",
    ]));
  });

  it("проверяет обязательный факт, слово, ссылку и выбранный CTA", () => {
    const result = validatePostSettingsResult(
      "Приходите на конференцию — обсудим продуктовые решения.",
      exact({
        requiredFacts: ["14 сентября"],
        keywords: ["AI Product"],
        links: ["https://example.com"],
        cta: "click",
      }),
    );
    expect(result.passed).toBe(false);
    expect(buildPostRepairInstructions(result)).toEqual(expect.arrayContaining([
      expect.stringContaining("14 сентября"),
      expect.stringContaining("AI Product"),
      expect.stringContaining("https://example.com"),
      expect.stringContaining("призыва"),
    ]));
  });

  it("считает лимит описания YouTube в байтах UTF-8, а не в JS-символах", () => {
    const text = "я".repeat(2600);
    const result = validatePostSettingsResult(text, {
      target: "youtube_description",
      length: "custom",
      customMinChars: 1,
      customMaxChars: 5000,
      emojiMode: "none",
      hashtags: "none",
      cta: "none",
    });
    expect(result.metrics.chars).toBe(2600);
    expect(result.metrics.bytes).toBe(5200);
    expect(result.violations).toContainEqual(expect.objectContaining({ code: "platform_limit" }));
  });

  it("принимает готовый материал, соблюдающий точные крайние значения", () => {
    const result = validatePostSettingsResult(
      "Конференция состоится 14 сентября. В программе — AI Product. Подробности: https://example.com",
      exact({
        requiredFacts: ["14 сентября"],
        keywords: ["AI Product"],
        links: ["https://example.com"],
      }),
    );
    expect(result.passed).toBe(true);
    expect(result.metrics).toMatchObject({ emojis: 0, hashtags: 0 });
  });

  it("ставит явную длину из сообщения выше диапазона Auto", () => {
    const settings = normalizePostSettings({
      target: "telegram_channel",
      length: "auto",
      emojiMode: "none",
      hashtags: "none",
      cta: "none",
    });
    const short = "Сильная идея требует не большего текста, а большей точности.";
    expect(validatePostSettingsResult(short, settings).passed).toBe(false);
    expect(validatePostSettingsResult(short, settings, { task: "Напиши пост до 100 знаков" }).passed).toBe(true);

    const prompt = buildPostSettingsPrompt(settings, { task: "Сделай текст на 100 знаков" });
    expect(prompt).toContain("85–115 знаков");
  });
});

describe("интеграционный путь схема → системный промпт → валидатор", () => {
  it("передаёт настройки формата в общий prompt builder и проверяет тот же контракт", () => {
    const settings = normalizePostSettings({
      target: "youtube_title",
      length: "custom",
      customMinChars: 20,
      customMaxChars: 70,
      emojiMode: "none",
      hashtags: "none",
      cta: "none",
      forbiddenWords: ["шок"],
    });
    const system = buildSystemPrompt({
      kind: "write",
      task: "Заголовок конференции",
      network: "youtube",
      postSettings: settings,
      grounding: "platform",
    });
    expect(system).toContain("YouTube · заголовок");
    expect(system).toContain("20–70 знаков");
    expect(system).not.toContain("Сборка поста по умолчанию");

    expect(validatePostSettingsResult("Как ИИ меняет работу продуктовых команд", settings).passed).toBe(true);
    expect(validatePostSettingsResult("ШОК: ИИ изменит всё!!!", settings).passed).toBe(false);
  });
});

describe("маркетинговый бриф публикации", () => {
  it("сохраняет старые настройки и не записывает новые Auto-поля как шум", () => {
    const migrated = normalizePostSettings({ target: "telegram_channel", goal: "education" });
    expect(migrated).toMatchObject({
      promotionType: "auto",
      messageCount: "one",
      factStrictness: "off",
      qualityMode: "balanced",
      outputParts: ["main"],
    });
    expect(compactPostSettings(migrated)).toEqual({ version: 1, target: "telegram_channel", goal: "education" });
  });

  it("предупреждает о неполном продающем оффере, но не блокирует генерацию", () => {
    const conflicts = validatePostSettingsConflicts({ goal: "sale", promotionName: "Аврора" });
    expect(conflicts).toContainEqual(expect.objectContaining({ code: "incomplete_offer", severity: "warning" }));
    expect(conflicts.some((item) => item.severity === "error")).toBe(false);
  });

  it("блокирует объективные конфликты до платного вызова", () => {
    const conflicts = validatePostSettingsConflicts({
      cta: "none",
      primaryMetric: "sales",
      urgency: "deadline",
      priceMode: "required",
    });
    expect(conflicts.map((item) => item.code)).toEqual(expect.arrayContaining(["cta_metric", "urgency_reason", "required_price"]));
    expect(conflicts.filter((item) => item.severity === "error")).toHaveLength(3);
  });

  it("строит prompt по приоритетам задача → оффер → аудитория → доказательства → стиль", () => {
    const prompt = buildPostSettingsPrompt({
      target: "telegram_channel",
      goal: "sale",
      mainIdea: "контекст важнее красивого промпта",
      promotionName: "Аврора",
      offer: "пробный период",
      mainBenefit: "пост за 10 минут",
      audienceProblem: "ИИ пишет шаблонно",
      objection: "обычный чат справится так же",
      proofs: [{ id: "p1", type: "case", text: "Кейс клиента подтверждён", source: "https://example.com/case", required: true, validAt: "2026-07-01", allowClientName: false, allowParaphrase: false }],
      qualityMode: "maximum",
    });
    expect(prompt.indexOf("2. ЗАДАЧА")).toBeLessThan(prompt.indexOf("3. ПРОДУКТ"));
    expect(prompt.indexOf("3. ПРОДУКТ")).toBeLessThan(prompt.indexOf("4. МОТИВАЦИЯ"));
    expect(prompt).toContain("никогда не придумывай отзывы, цифры, исследования");
    expect(prompt).toContain("мысленно создай три разные концепции");
  });

  it("валидирует дословное обязательное доказательство и кодовое слово", () => {
    const settings = normalizePostSettings({
      target: "telegram_channel",
      length: "custom",
      customMinChars: 1,
      customMaxChars: 500,
      emojiMode: "none",
      hashtags: "none",
      cta: "reply",
      ctaCodeword: "АУДИТ",
      proofs: [{ id: "p1", type: "product_fact", text: "14 сентября", required: true, allowParaphrase: false }],
    });
    const failed = validatePostSettingsResult("Напишите мне — пришлю условия.", settings);
    expect(failed.violations.map((item) => item.code)).toEqual(expect.arrayContaining(["required_proof", "cta_codeword"]));
    expect(validatePostSettingsResult("14 сентября напишите мне слово АУДИТ — пришлю условия.", settings).passed).toBe(true);
  });

  it("считает лимиты только по основному посту при расширенной комплектации", () => {
    const settings = normalizePostSettings({
      target: "youtube_title",
      length: "custom",
      customMinChars: 10,
      customMaxChars: 70,
      emojiMode: "none",
      hashtags: "none",
      cta: "none",
      outputParts: ["main", "hooks", "visual_brief"],
    });
    const result = validatePostSettingsResult("Как создать сильный AI-продукт\n---\n## Хуки\n" + "Длинный материал ".repeat(30), settings);
    expect(result.passed).toBe(true);
    expect(result.metrics.chars).toBe("Как создать сильный AI-продукт".length);
    expect(postSettingsOutputTokens(settings)).toBeGreaterThan(postSettingsOutputTokens({ ...settings, outputParts: ["main"] }));
  });

  it("собирает понятное резюме «Что понял ИИ»", () => {
    const summary = buildPostSettingsSummary({
      goal: "sale",
      audience: "владельцы малого бизнеса",
      promotionName: "подписка Авроры",
      price: "2 990 ₽",
      mainBenefit: "публикации за 10 минут",
      objection: "ИИ пишет шаблонно",
      cta: "click",
    }, "telegram");
    expect(summary).toContain("владельцы малого бизнеса");
    expect(summary).toContain("подписка Авроры (2 990 ₽)");
    expect(summary).toContain("ИИ пишет шаблонно");
    expect(summary).toContain("Telegram");
  });
});

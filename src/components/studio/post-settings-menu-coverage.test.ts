// Контракт реестра настроек публикации.
//
// Диалог «Настройки» рисует поля из `post-settings-fields.ts`. Если в модели
// появится ключ, которого нет в реестре, пользователь просто не сможет его
// настроить — и никто этого не заметит. Тест закрывает ровно эту дыру.

import { describe, expect, it } from "vitest";

import {
  POST_SETTINGS_FIELDS,
  POST_SETTINGS_GROUPS,
  fieldsForGroup,
  isTechnicalField,
  searchFields,
  visibleFields,
  type PostSettingsGroupId,
} from "@/lib/post-settings-fields";
import { automaticPostSettings, normalizePostSettings } from "@/lib/post-settings";
import { fieldIsOverridden, overriddenFieldKeys } from "@/components/studio/post-settings-menu";

const modelKeys = Object.keys(normalizePostSettings({})).sort();
const registryKeys = POST_SETTINGS_FIELDS.map((field) => String(field.key)).sort();

describe("реестр настроек публикации", () => {
  it("покрывает каждый ключ модели ровно один раз", () => {
    expect(registryKeys).toEqual([...new Set(registryKeys)].sort());
    const missing = modelKeys.filter((key) => !registryKeys.includes(key));
    const extra = registryKeys.filter((key) => !modelKeys.includes(key));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("не прячет живые настройки под видом служебных", () => {
    // Служебные ключи перечислены явно: добавить новый «мёртвый» ключ можно только
    // осознанно, вместе с этим списком.
    expect(
      POST_SETTINGS_FIELDS.filter(isTechnicalField)
        .map((field) => field.key)
        .sort(),
    ).toEqual(["hideCriticalResult", "version"]);
  });

  it("каждая группа существует и что-то показывает при автонастройках", () => {
    const ids = new Set(POST_SETTINGS_GROUPS.map((group) => group.id));
    for (const field of POST_SETTINGS_FIELDS) {
      expect(ids.has(field.group), `группа ${field.group} для поля ${String(field.key)}`).toBe(true);
    }
    const auto = automaticPostSettings();
    for (const group of POST_SETTINGS_GROUPS) {
      expect(fieldsForGroup(group.id as PostSettingsGroupId, auto).length, `группа ${group.id}`).toBeGreaterThan(0);
    }
  });

  it("выпадающие списки всегда с вариантами", () => {
    for (const field of POST_SETTINGS_FIELDS) {
      if (field.kind !== "select") continue;
      // target и preset собирают список на месте: у них зависят от площадки подписи.
      if (field.key === "target" || field.key === "preset") continue;
      expect(field.options?.length ?? 0, `варианты для ${String(field.key)}`).toBeGreaterThan(1);
    }
  });

  it("условные поля появляются только тогда, когда реально работают", () => {
    const auto = automaticPostSettings();
    // Скрыты по умолчанию, появляются вместе со своим режимом.
    const revealedBy: Array<[string, Partial<typeof auto>]> = [
      ["customMinChars", { length: "custom" }],
      ["customMaxChars", { length: "custom" }],
      ["emojiMax", { emojiMode: "custom" }],
      ["hashtagCount", { hashtags: "custom" }],
      ["urgencyReason", { urgency: "deadline" }],
      [
        "proofCount",
        {
          proofs: [
            {
              id: "p1",
              type: "number",
              text: "12 клиентов",
              source: "CRM",
              validAt: "",
              required: false,
              allowClientName: false,
              allowParaphrase: true,
            },
          ] as never,
        },
      ],
    ];
    for (const [key, patch] of revealedBy) {
      const field = POST_SETTINGS_FIELDS.find((item) => String(item.key) === key);
      expect(field, `поле ${key} есть в реестре`).toBeTruthy();
      expect(field!.visibleWhen?.(auto), `${key} скрыто по умолчанию`).toBeFalsy();
      expect(field!.visibleWhen?.({ ...auto, ...patch }), `${key} видно при своих настройках`).toBeTruthy();
    }
    // Видны по умолчанию, исчезают вместе с выключенным блоком оригинальности.
    const hiddenBy: Array<[string, Partial<typeof auto>]> = [
      ["similarityLevel", { requireNewAngle: false }],
      ["originalityDepth", { requireNewAngle: false }],
      ["avoidRepetitions", { requireNewAngle: false }],
      ["price", { priceMode: "never" }],
      ["allowedEmojis", { emojiMode: "none" }],
    ];
    for (const [key, patch] of hiddenBy) {
      const field = POST_SETTINGS_FIELDS.find((item) => String(item.key) === key);
      expect(field, `поле ${key} есть в реестре`).toBeTruthy();
      expect(field!.visibleWhen?.(auto), `${key} видно по умолчанию`).toBeTruthy();
      expect(field!.visibleWhen?.({ ...auto, ...patch }), `${key} скрыто при выключенном блоке`).toBeFalsy();
    }
  });

  it("считает только реально изменённые правила", () => {
    const auto = automaticPostSettings();
    expect(overriddenFieldKeys(auto)).toEqual([]);
    expect(fieldIsOverridden(auto, "emojiMode")).toBe(false);

    const changed = normalizePostSettings({ ...auto, emojiMode: "none", hashtags: "none", address: "вы" });
    const overridden = overriddenFieldKeys(changed);
    expect(overridden).toContain("emojiMode");
    expect(overridden).toContain("hashtags");
    expect(overridden).toContain("address");
    expect(fieldIsOverridden(changed, "goal")).toBe(false);
  });

  it("ищет настройки по подписи, подсказке, ключу и вариантам ответа", () => {
    const auto = automaticPostSettings();
    expect(searchFields("эмодзи", auto).map((field) => field.key)).toContain("emojiMode");
    expect(searchFields("hashtags", auto).map((field) => field.key)).toContain("hashtags");
    expect(searchFields("уровень метафор", auto).map((field) => field.key)).toContain("metaphorLevel");
    expect(searchFields("Не использовать", auto).length).toBeGreaterThan(1);
    expect(searchFields("  ", auto)).toEqual([]);
    expect(searchFields("Такого-поля-нет", auto)).toEqual([]);
  });

  it("служебные ключи не попадают в интерфейс, но остаются в реестре", () => {
    const auto = automaticPostSettings();
    const visibleKeys = visibleFields(auto).map((field) => String(field.key));
    expect(visibleKeys).not.toContain("version");
    expect(visibleKeys).not.toContain("hideCriticalResult");
    expect(registryKeys).toContain("version");
    expect(registryKeys).toContain("hideCriticalResult");
  });

  it("в простом режиме есть все настройки, которые чаще всего меняют пост", () => {
    const simple = new Set(POST_SETTINGS_FIELDS.filter((field) => field.simple).map((field) => String(field.key)));
    for (const key of [
      "target",
      "goal",
      "length",
      "cta",
      "language",
      "formality",
      "address",
      "profanityMode",
      "emojiMode",
      "hashtags",
      "similarityLevel",
      "qualityMode",
    ]) {
      expect(simple.has(key), `простой режим показывает ${key}`).toBe(true);
    }
  });
});

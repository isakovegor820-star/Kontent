import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  LEGAL_VISUAL_TEMPLATES,
  LegalVisualValidationError,
  deserializeLegalVisualConfig,
  serializeLegalVisualConfig,
  validateLegalVisualConfig,
  type LegalVisualConfig,
  type LegalVisualFormat,
} from "./legal-visual-model";
import {
  LEGAL_VISUAL_DIMENSIONS,
  LegalVisualRenderBlockedError,
  buildLegalVisualCardSvg,
  inspectLegalVisualConfig,
  renderLegalVisualCarousel,
} from "./legal-visual-render";

const goodColors = {
  background: "#f7f8fc",
  surface: "#ffffff",
  text: "#121827",
  mutedText: "#566074",
  accent: "#5b45e8",
  critical: "#c43a45",
};

function configFor(format: LegalVisualFormat = "1:1"): LegalVisualConfig {
  return {
    schemaVersion: 1,
    id: "visual-kit-1",
    projectId: "legal-project-1",
    revision: 3,
    name: "Памятка для бизнеса",
    format,
    brand: {
      name: "ТехнологИИ Права",
      logo: null,
      colors: goodColors,
      allowedFonts: ["aurora-sans", "legal-serif"],
      font: "aurora-sans",
      signature: "ТехнологИИ Права",
    },
    cards: [
      {
        id: "hook-card",
        order: 1,
        role: "hook",
        template: "key_number",
        eyebrow: "Новый срок",
        title: "Когда нужно ответить на претензию",
        theses: ["Срок считают со следующего рабочего дня"],
        emphasis: "30 дней",
        image: null,
        cta: null,
        sourceNote: "",
      },
      {
        id: "context-card",
        order: 2,
        role: "context",
        template: "what_changed",
        eyebrow: "Сравнение",
        title: "Что изменилось для компании",
        theses: ["Ответ можно было направить позже", "Теперь срок закреплён в договоре"],
        emphasis: "",
        image: null,
        cta: null,
        sourceNote: "",
      },
      {
        id: "cta-card",
        order: 3,
        role: "cta",
        template: "checklist",
        eyebrow: "Проверка",
        title: "Что сделать сегодня",
        theses: ["Найдите условие о сроке", "Назначьте ответственного", "Сохраните подтверждение отправки"],
        emphasis: "",
        image: null,
        cta: { label: "Сохранить чек-лист", url: "https://example.ru/checklist" },
        sourceNote: "",
      },
    ],
  };
}

describe("legal visual model", () => {
  it("ships eleven distinct legal layouts for the requested product categories", () => {
    expect(LEGAL_VISUAL_TEMPLATES.map((template) => template.name)).toEqual([
      "Что изменилось",
      "3 действия",
      "Сроки",
      "Ошибка бизнеса",
      "Вывод суда",
      "Миф / факт",
      "Чек-лист",
      "Вопрос / ответ",
      "Цифра",
      "Анонс",
      "Кейс",
    ]);
    expect(new Set(LEGAL_VISUAL_TEMPLATES.map((template) => template.layout))).toHaveLength(11);
  });

  it("validates brand, carousel bounds and a continuous explicit card order", () => {
    const valid = validateLegalVisualConfig(configFor());
    expect(valid.brand.allowedFonts).toEqual(["aurora-sans", "legal-serif"]);
    expect(valid.cards.map((card) => card.order)).toEqual([1, 2, 3]);

    const invalid = structuredClone(configFor()) as unknown as Record<string, unknown>;
    const brand = invalid.brand as Record<string, unknown>;
    brand.font = "downloaded-user-font";
    const cards = invalid.cards as Array<Record<string, unknown>>;
    cards[1].order = 1;
    expect(() => validateLegalVisualConfig(invalid)).toThrow(LegalVisualValidationError);
    try {
      validateLegalVisualConfig(invalid);
    } catch (error) {
      expect((error as LegalVisualValidationError).issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(["brand.font", "cards.1.order"]),
      );
    }

    const tooShort = configFor();
    tooShort.cards = tooShort.cards.slice(0, 2);
    expect(() => validateLegalVisualConfig(tooShort)).toThrow(LegalVisualValidationError);
    const tooLong = configFor();
    tooLong.cards = Array.from({ length: 8 }, (_, index) => ({
      ...tooLong.cards[index % 3],
      id: `card-${index + 1}`,
      order: index + 1,
    }));
    expect(() => validateLegalVisualConfig(tooLong)).toThrow(LegalVisualValidationError);
  });

  it("round-trips editable card content and order through a stable persistence snapshot", () => {
    const original = configFor("4:5");
    original.cards = [original.cards[2], original.cards[0], original.cards[1]].map((card, index) => ({
      ...card,
      order: index + 1,
    }));
    const first = serializeLegalVisualConfig(original);
    const restored = deserializeLegalVisualConfig(first);
    const second = serializeLegalVisualConfig(restored);

    expect(second).toBe(first);
    expect(restored.cards.map((card) => card.id)).toEqual(["cta-card", "hook-card", "context-card"]);
    expect(restored.cards[0].cta?.label).toBe("Сохранить чек-лист");
    expect(restored.cards[1].emphasis).toBe("30 дней");
  });
});

describe("legal visual safety and fit inspection", () => {
  it("escapes hostile text while preserving Cyrillic as editable SVG text", () => {
    const config = configFor();
    config.cards[0].title = '<script>alert("чужой код")</script> & вывод суда';
    config.cards[0].theses = ["ООО «Ромашка» > истец & ответчик"];
    const svg = buildLegalVisualCardSvg(config, "hook-card");

    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;alert(&quot;чужой код&quot;)&lt;/script&gt; &amp; вывод суда");
    expect(svg).toContain("ООО «Ромашка» &gt; истец &amp; ответчик");
    expect(svg).not.toContain("javascript:");
  });

  it("reports deterministic overflow and safe-area errors before refusing export", async () => {
    const config = configFor();
    config.cards[0].title = "Очень длинный юридический заголовок ".repeat(25);
    const first = inspectLegalVisualConfig(config);
    const second = inspectLegalVisualConfig(config);

    expect(second).toEqual(first);
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "title_overflow", severity: "error", cardId: "hook-card" }),
      expect.objectContaining({ code: "safe_area_violation", severity: "error", cardId: "hook-card" }),
    ]));
    await expect(renderLegalVisualCarousel(config)).rejects.toBeInstanceOf(LegalVisualRenderBlockedError);
  });
});

describe("legal visual PNG rendering", () => {
  it("keeps all eleven template SVGs structurally renderable", async () => {
    for (const template of LEGAL_VISUAL_TEMPLATES) {
      const config = configFor();
      config.cards[0] = {
        ...config.cards[0],
        template: template.key,
        theses: ["Первый подтверждённый тезис", "Второй подтверждённый тезис", "Третий подтверждённый тезис"],
      };
      const svg = buildLegalVisualCardSvg(config, "hook-card");
      const metadata = await sharp(Buffer.from(svg)).metadata();
      expect(metadata).toMatchObject({ format: "svg", width: 1_080, height: 1_080 });
    }
  });

  it.each(["1:1", "4:5", "9:16"] as const)(
    "renders every ordered %s carousel card to exact PNG dimensions",
    async (format) => {
      const config = configFor(format);
      const rendered = await renderLegalVisualCarousel(config);
      const dimensions = LEGAL_VISUAL_DIMENSIONS[format];

      expect(rendered.cards).toHaveLength(3);
      expect(rendered.cards.map((card) => [card.cardId, card.order])).toEqual([
        ["hook-card", 1],
        ["context-card", 2],
        ["cta-card", 3],
      ]);
      for (const card of rendered.cards) {
        const metadata = await sharp(card.png).metadata();
        expect(metadata).toMatchObject({
          format: "png",
          width: dimensions.width,
          height: dimensions.height,
        });
        expect(card.sha256).toBe(createHash("sha256").update(card.png).digest("hex"));
      }
      expect(rendered.configSnapshot).toContain("Памятка для бизнеса");
      expect(rendered.configSha256).toHaveLength(64);
    },
    30_000,
  );

  it("produces byte-identical PNGs for the same validated config", async () => {
    const config = configFor("1:1");
    const first = await renderLegalVisualCarousel(config);
    const second = await renderLegalVisualCarousel(config);

    expect(second.configSnapshot).toBe(first.configSnapshot);
    expect(second.cards.map((card) => card.sha256)).toEqual(first.cards.map((card) => card.sha256));
    for (let index = 0; index < first.cards.length; index += 1) {
      expect(second.cards[index].png.equals(first.cards[index].png)).toBe(true);
    }
  }, 30_000);
});

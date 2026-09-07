import { describe, expect, it } from "vitest";
import {
  assertSafeMediaUrl,
  buildMediaPromptContext,
  buildNavyMediaPayload,
  detectMediaMime,
  mediaModelAccess,
  parseMediaDataUrl,
  validateMediaInput,
} from "./media-generation.mjs";

describe("media generation contract", () => {
  it("keeps only allowlisted image settings", () => {
    const parsed = validateMediaInput({
      kind: "image",
      prompt: "Обложка для поста",
      model: "unknown",
      aspectRatio: "99:1",
      quality: "ultra",
      style: "unknown",
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toMatchObject({ model: "nano-banana-2", aspectRatio: "1:1", quality: "medium", style: "natural" });
  });

  it("normalizes the selected server channel and does not require client profile text", () => {
    const parsed = validateMediaInput({
      kind: "image",
      prompt: "Редакционная обложка",
      channelId: 18,
      niche: "кофе",
    });
    expect(parsed.value).toMatchObject({ channelId: 18 });
    expect(parsed.value).not.toHaveProperty("niche");
    expect(parsed.value).not.toHaveProperty("tone");
  });

  it("builds an async Navy video payload", () => {
    const parsed = validateMediaInput({ kind: "video", prompt: "Автор открывает ноутбук", seconds: 8 });
    const payload = buildNavyMediaPayload({
      ...parsed.value,
      aspect_ratio: parsed.value.aspectRatio,
      negative_prompt: parsed.value.negativePrompt,
    });
    expect(payload).toMatchObject({ model: "veo-3.1", aspect_ratio: "9:16", seconds: 8, sync: false });
    expect(payload.prompt).toContain("ОГРАНИЧЕНИЯ");
  });

  it("builds a versioned server-authoritative visual prompt", () => {
    const context = buildMediaPromptContext({
      prompt: "Один юрист разбирает сложный договор",
      sourceText: "Пост объясняет, как проверить договор до подписания.",
      exactText: "Проверь договор",
      niche: "кофейня из браузера",
      tone: "агрессивный из браузера",
    }, {
      platform: "tg",
      brandProfile: "Ниша канала: юридические технологии\nТон: спокойный\nЦвет: #334455",
      visualDirection: "Лаконичная юридическая инфографика с одним акцентным цветом",
      visualDetail: 82,
    });
    const payload = buildNavyMediaPayload({
      kind: "image",
      model: "nano-banana-2",
      prompt: "legacy prompt",
      prompt_context: context,
      aspect_ratio: "9:16",
      quality: "medium",
      style: "editorial",
      negative_prompt: "водяные знаки",
    });

    expect(payload.prompt).toContain("[aurora-media-prompt v3]");
    expect(payload.prompt).toContain("Telegram; формат 9:16");
    expect(payload.prompt).toContain("БЕЗОПАСНЫЕ ЗОНЫ");
    expect(payload.prompt).toContain("РАЗМЕЩЕНИЕ ОБЪЕКТА");
    expect(payload.prompt).toContain("КОМПОЗИЦИЯ");
    expect(payload.prompt).toContain("единая сцена от края до края");
    expect(payload.prompt).toContain("Не помещай его внутрь рамки");
    expect(payload.prompt).toContain("СВЕТ");
    expect(payload.prompt).toContain("ПАЛИТРА БРЕНДА");
    expect(payload.prompt).toContain("#334455");
    expect(payload.prompt).toContain("Лаконичная юридическая инфографика с одним акцентным цветом");
    expect(payload.prompt).toContain("высокая полезная детализация");
    expect(payload.prompt).toContain("«Проверь договор»");
    expect(payload.prompt).toContain("не придумывай логотипы, названия, имена, числа");
    expect(payload.prompt).not.toContain("кофейня из браузера");
    expect(payload.prompt).not.toContain("агрессивный из браузера");
    expect(payload.negative_prompt).toContain("invented logos");
    expect(payload.negative_prompt).toContain("black borders");
    expect(payload.negative_prompt).toContain("letterbox");
  });

  it("forbids all text when exact text was not explicitly requested", () => {
    const payload = buildNavyMediaPayload({
      kind: "image",
      model: "nano-banana-2",
      prompt: "Обложка без текста",
      prompt_context: buildMediaPromptContext({ prompt: "Обложка без текста" }),
      aspect_ratio: "1:1",
      quality: "low",
      style: "minimal",
    });
    expect(payload.prompt).toContain("не добавляй надписи, буквы, слова или цифры");
  });

  it("supports Nano Banana with an allowlisted vertical format", () => {
    const parsed = validateMediaInput({
      kind: "image",
      prompt: "Редакционная обложка для поста",
      model: "nano-banana-2",
      aspectRatio: "9:16",
    });
    expect(parsed.value).toMatchObject({ model: "nano-banana-2", aspectRatio: "9:16" });
  });

  it("blocks an Ultra video model for a Max provider key", () => {
    const access = mediaModelAccess("video", "veo-3.1", "Max", {
      endpoint: "/v1/images/generations",
      premium: true,
      required_plan: "Ultra",
    });
    expect(access).toEqual({ available: false, reason: "plan_required", requiredPlan: "Ultra" });
    expect(mediaModelAccess("video", "veo-3.1", "Ultra", {
      endpoint: "/v1/images/generations",
      premium: true,
      required_plan: "Ultra",
    }).available).toBe(true);
  });

  it("rejects private and carrier-grade download addresses", () => {
    expect(() => assertSafeMediaUrl("https://172.20.1.4/file.png")).toThrow("unsafe_media_url");
    expect(() => assertSafeMediaUrl("https://100.64.1.4/file.png")).toThrow("unsafe_media_url");
    expect(assertSafeMediaUrl("https://cdn.example.com/file.png").hostname).toBe("cdn.example.com");
    expect(assertSafeMediaUrl("https://fc-public.example.com/file.png").hostname).toBe("fc-public.example.com");
  });

  it("accepts only bounded base64 media with the requested kind", () => {
    const encoded = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).toString("base64");
    expect(parseMediaDataUrl(`data:image/png;base64,${encoded}`, "image", 100)).toMatchObject({
      mime: "image/png",
      base64: encoded,
    });
    expect(() => parseMediaDataUrl(`data:image/png;base64,${encoded}`, "video", 100)).toThrow("bad_media_data_url");
    expect(() => parseMediaDataUrl(`data:image/png;base64,${encoded}`, "image", 1)).toThrow("file_too_large");
  });

  it("detects an mp4 by its signature", () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
    expect(detectMediaMime(bytes, "application/octet-stream", "video")).toBe("video/mp4");
  });

  it("does not trust a media content-type without a matching signature", () => {
    const html = new TextEncoder().encode("<html>not an image</html>");
    expect(() => detectMediaMime(html, "image/png", "image")).toThrow("bad_media_type");
  });
});

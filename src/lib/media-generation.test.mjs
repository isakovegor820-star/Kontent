import { describe, expect, it } from "vitest";
import { buildNavyMediaPayload, detectMediaMime, validateMediaInput } from "./media-generation.mjs";

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
    expect(parsed.value).toMatchObject({ model: "flux", aspectRatio: "1:1", quality: "medium", style: "natural" });
  });

  it("builds an async Navy video payload", () => {
    const parsed = validateMediaInput({ kind: "video", prompt: "Автор открывает ноутбук", seconds: 8 });
    const payload = buildNavyMediaPayload({
      ...parsed.value,
      aspect_ratio: parsed.value.aspectRatio,
      negative_prompt: parsed.value.negativePrompt,
    });
    expect(payload).toMatchObject({ model: "veo-3.1", aspect_ratio: "9:16", seconds: 8, sync: false });
    expect(payload.prompt).toContain("Не добавляй факты");
  });

  it("detects an mp4 by its signature", () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
    expect(detectMediaMime(bytes, "application/octet-stream", "video")).toBe("video/mp4");
  });
});


// Тесты чистых парсеров Instagram-клиента.
import { describe, it, expect } from "vitest";
import { parseIgUser, parsePublishResult, detectMediaType } from "./instagram.mjs";

describe("parseIgUser", () => {
  it("разбирает профиль", () => {
    expect(parseIgUser({ id: "178", username: "brand", media_count: 42 })).toEqual({
      id: "178",
      username: "brand",
      mediaCount: 42,
    });
  });
  it("null без id", () => {
    expect(parseIgUser({ username: "x" })).toBeNull();
    expect(parseIgUser(null)).toBeNull();
  });
  it("переживает отсутствие media_count", () => {
    expect(parseIgUser({ id: "1", username: "u" })).toEqual({
      id: "1",
      username: "u",
      mediaCount: null,
    });
  });
});

describe("parsePublishResult", () => {
  it("строит ссылку на пост", () => {
    expect(parsePublishResult({ id: "1790" })).toEqual({
      mediaId: "1790",
      url: "https://www.instagram.com/p/1790/",
    });
  });
  it("null на мусор", () => {
    expect(parsePublishResult({})).toBeNull();
  });
});

describe("detectMediaType", () => {
  it("видео по расширению и полю videoUrl", () => {
    expect(detectMediaType("https://cdn/v.mp4")).toBe("video");
    expect(detectMediaType({ videoUrl: "https://cdn/x" })).toBe("video");
  });
  it("изображение по умолчанию и по imageUrl", () => {
    expect(detectMediaType("https://cdn/pic.jpg")).toBe("image");
    expect(detectMediaType({ imageUrl: "https://cdn/x" })).toBe("image");
  });
  it("null без медиа", () => {
    expect(detectMediaType(null)).toBeNull();
    expect(detectMediaType({})).toBeNull();
  });
});

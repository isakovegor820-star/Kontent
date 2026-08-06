// Тесты чистых парсеров Instagram-клиента.
import { afterEach, describe, it, expect, vi } from "vitest";
import { parseIgUser, parsePublishResult, detectMediaType, publishMedia } from "./instagram.mjs";

afterEach(() => vi.unstubAllGlobals());

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

describe("publishMedia ambiguous delivery", () => {
  it("preserves creation identity and does not repeat media_publish after a lost response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "creation-7" }))
      .mockRejectedValueOnce(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishMedia("secret-token", "account-1", {
      caption: "Test",
      media: "https://cdn.example/photo.jpg",
    });

    expect(result).toMatchObject({
      ok: false,
      outcome: "delivery_unknown",
      deliveryUnknown: true,
      retryable: false,
      providerOperationId: "creation-7",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("media_publish"))).toHaveLength(1);
  });
});

// Тесты чистых парсеров YouTube-клиента. Формат ответов Google стабилен, но парсим
// защитно (любое поле может отсутствовать) — поэтому покрыто, как vk.ts.
import { afterEach, describe, it, expect, vi } from "vitest";
import { parseChannel, parseUploadResult, resolveMediaBytes, uploadVideo } from "./youtube.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("parseChannel", () => {
  it("разбирает канал из channels?mine=true", () => {
    const raw = {
      items: [
        {
          id: "UC123",
          snippet: {
            title: "Мой канал",
            customUrl: "@mychannel",
            thumbnails: { medium: { url: "https://img/m.jpg" } },
          },
        },
      ],
    };
    expect(parseChannel(raw)).toEqual({
      id: "UC123",
      title: "Мой канал",
      handle: "mychannel",
      avatar: "https://img/m.jpg",
    });
  });

  it("возвращает null без items или без id", () => {
    expect(parseChannel({ items: [] })).toBeNull();
    expect(parseChannel({ items: [{ snippet: { title: "x" } }] })).toBeNull();
    expect(parseChannel(null)).toBeNull();
  });

  it("переживает отсутствие customUrl и аватара", () => {
    const raw = { items: [{ id: "UC1", snippet: { title: "T" } }] };
    expect(parseChannel(raw)).toEqual({ id: "UC1", title: "T", handle: "", avatar: null });
  });
});

describe("parseUploadResult", () => {
  it("строит ссылку на видео по id", () => {
    expect(parseUploadResult({ id: "abc123" })).toEqual({
      videoId: "abc123",
      url: "https://www.youtube.com/watch?v=abc123",
    });
  });
  it("null на мусор", () => {
    expect(parseUploadResult({})).toBeNull();
    expect(parseUploadResult(null)).toBeNull();
  });
});

describe("resolveMediaBytes", () => {
  it("разбирает data:URL", async () => {
    const dataUrl = "data:video/mp4;base64," + Buffer.from("hello").toString("base64");
    const { buffer, contentType } = await resolveMediaBytes(dataUrl);
    expect(contentType).toBe("video/mp4");
    expect(buffer.toString("utf8")).toBe("hello");
  });

  it("принимает готовый Uint8Array", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { buffer } = await resolveMediaBytes(bytes);
    expect(buffer.length).toBe(3);
  });

  it("downloads only through the pinned public-network client with a byte ceiling", async () => {
    const fetchPublicBuffer = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { "content-type": "video/webm; charset=binary" },
      buffer: Buffer.from("video"),
    }));

    const resolved = await resolveMediaBytes("https://cdn.example/video.webm", {
      maxBytes: 16,
      fetchPublicBuffer,
    });

    expect(resolved).toMatchObject({ contentType: "video/webm" });
    expect(fetchPublicBuffer).toHaveBeenCalledWith(
      "https://cdn.example/video.webm",
      expect.objectContaining({ maxBytes: 16, httpsOnly: true, maxRedirects: 4 }),
    );
  });

  it("rejects private URL targets and oversized in-memory sources", async () => {
    await expect(resolveMediaBytes("https://127.0.0.1/video.mp4", { maxBytes: 16 }))
      .rejects.toMatchObject({ code: "private_address" });
    await expect(resolveMediaBytes(new Uint8Array(17), { maxBytes: 16 }))
      .rejects.toMatchObject({ code: "youtube_media_too_large" });
    const oversizedData = `data:video/mp4;base64,${Buffer.alloc(17).toString("base64")}`;
    await expect(resolveMediaBytes(oversizedData, { maxBytes: 16 }))
      .rejects.toMatchObject({ code: "youtube_media_too_large" });
  });

  it("rejects non-video payload declarations", async () => {
    const dataUrl = `data:text/html;base64,${Buffer.from("<html>").toString("base64")}`;
    await expect(resolveMediaBytes(dataUrl, { maxBytes: 64 }))
      .rejects.toMatchObject({ code: "youtube_media_type_invalid" });
  });

  it("бросается на пустой источник", async () => {
    await expect(resolveMediaBytes(null)).rejects.toThrow();
    await expect(resolveMediaBytes({})).rejects.toThrow();
  });
});

describe("uploadVideo ambiguous delivery", () => {
  it("does not start a second upload when the final PUT response is lost", async () => {
    const sessionUrl = "https://upload.example/session-redacted";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { location: sessionUrl } }))
      .mockRejectedValueOnce(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadVideo("secret-token", {
      title: "Test",
      media: new Uint8Array([1, 2, 3]),
    });

    expect(result).toMatchObject({
      ok: false,
      outcome: "delivery_unknown",
      deliveryUnknown: true,
      retryable: false,
      providerOperationId: sessionUrl,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
});

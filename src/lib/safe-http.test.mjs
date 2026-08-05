import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import {
  SafeHttpError,
  fetchPublicBuffer,
  isPublicAddress,
  parsePublicHttpUrl,
  resolvePublicTarget,
  validatePublicRedirect,
} from "./safe-http.mjs";

describe("safe public HTTP", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.4.2",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "0:0:0:0:0:0:0:1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
  ])("блокирует служебный адрес %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "разрешает публичный адрес %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it("блокирует hostname, если хотя бы один DNS-ответ внутренний", async () => {
    const lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(resolvePublicTarget(new URL("https://example.test/rss"), lookup)).rejects.toMatchObject({
      code: "private_address",
    });
  });

  it("нормализует скобки публичного IPv6 literal без повторного DNS lookup", async () => {
    const lookup = vi.fn();
    await expect(resolvePublicTarget(
      new URL("https://[2606:4700:4700::1111]/"),
      lookup,
    )).resolves.toEqual({ address: "2606:4700:4700::1111", family: 6 });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("не принимает credentials и посторонние протоколы", () => {
    expect(() => parsePublicHttpUrl("file:///etc/passwd")).toThrow(SafeHttpError);
    expect(() => parsePublicHttpUrl("https://user:pass@example.com/rss")).toThrow(SafeHttpError);
  });

  it("не допускает HTTP downgrade для бинарного provider media", async () => {
    await expect(fetchPublicBuffer("http://cdn.example.test/result.png", {
      httpsOnly: true,
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
    })).rejects.toMatchObject({ code: "bad_protocol" });
  });

  it("обрывает request по абсолютному wall-clock deadline, даже без idle event", async () => {
    vi.useFakeTimers();
    try {
      let request;
      const requestFn = vi.fn(() => {
        request = new EventEmitter();
        request.setTimeout = vi.fn();
        request.end = vi.fn();
        request.destroy = vi.fn((error) => queueMicrotask(() => request.emit("error", error)));
        return request;
      });
      const pending = fetchPublicBuffer("https://example.test/file", {
        timeoutMs: 50,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        requestFn,
      });
      const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(51);
      await rejected;
      expect(request.destroy).toHaveBeenCalledWith(expect.objectContaining({ code: "timeout" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("включает DNS resolution в абсолютный deadline", async () => {
    vi.useFakeTimers();
    try {
      const requestFn = vi.fn();
      const pending = fetchPublicBuffer("https://example.test/file", {
        timeoutMs: 50,
        lookupFn: () => new Promise(() => undefined),
        requestFn,
      });
      const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(51);
      await rejected;
      expect(requestFn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("останавливает redirect до запроса к хосту за разрешённой границей", async () => {
    expect(() => validatePublicRedirect(
      "https://outside.example.test/private",
      new URL("https://source.example.test/start"),
      (next) => next.hostname === "source.example.test",
    )).toThrow(expect.objectContaining({ code: "redirect_forbidden" }));
  });
});

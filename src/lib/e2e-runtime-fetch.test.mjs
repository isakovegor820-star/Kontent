import { describe, expect, it, vi } from "vitest";
import { createE2eRuntimeFetch } from "../../scripts/e2e-runtime-fetch.mjs";

describe("disposable runtime outbound boundary", () => {
  it("blocks unknown external hosts and nonfixture Telegram credentials before network delegation", () => {
    const network = vi.fn(); const fetch = createE2eRuntimeFetch("http://127.0.0.1:12345", network);
    for (const url of ["https://api.telegram.org/bot123:real/sendMessage", "https://example.com/", "https://127.0.0.1.example.com/", "https://api.vk.com/unexpected"]) {
      expect(() => fetch(url)).toThrow();
    }
    expect(network).not.toHaveBeenCalled();
    expect(() => createE2eRuntimeFetch("https://real.example.com", network)).toThrow(/loopback/);
  });
  it("redirects the exact fake Telegram account and preserves a Request body", async () => {
    const network = vi.fn(async (request) => ({ url: request.url, body: await request.text(), method: request.method }));
    const fetch = createE2eRuntimeFetch("http://127.0.0.1:12345", network);
    const result = await fetch(new Request("https://api.telegram.org/bot9000000000:e2e-fake-token-not-live/getChatMember", {
      method: "POST", body: JSON.stringify({ chat_id: -123, user_id: 42 }), headers: { "content-type": "application/json" },
    }));
    expect(result).toEqual({ url: "http://127.0.0.1:12345/bot9000000000:e2e-fake-token-not-live/getChatMember", body: '{"chat_id":-123,"user_id":42}', method: "POST" });
  });
  it("maps every enabled external discovery source to synthetic empty search", async () => {
    const network = vi.fn((url) => String(url)); const fetch = createE2eRuntimeFetch("http://127.0.0.1:12345", network);
    for (const host of ["search.brave.com", "search.yahoo.com", "html.duckduckgo.com"]) {
      expect(await fetch(`https://${host}/search?q=synthetic`)).toBe("http://127.0.0.1:12345/discovery-empty?format=html");
    }
    expect(await fetch("https://www.bing.com/search?format=rss&q=synthetic")).toBe("http://127.0.0.1:12345/discovery-empty?format=rss");
    expect(network).toHaveBeenCalledTimes(4);
  });
  it("retains VK, mail, loopback and inline-data fixture routes", async () => {
    const network = vi.fn((url) => String(url)); const fetch = createE2eRuntimeFetch("http://127.0.0.1:12345", network);
    expect(await fetch("https://api.vk.com/method/wall.post")).toBe("http://127.0.0.1:12345/vk/method/wall.post");
    expect(await fetch("https://api.resend.com/emails")).toBe("http://127.0.0.1:12345/resend/emails");
    expect(await fetch("http://127.0.0.1:12345/api")).toBe("http://127.0.0.1:12345/api");
    expect(await fetch("data:text/plain,fixture")).toBe("data:text/plain,fixture");
  });
  it("keeps synthetic public Telegram reads local without allowing other channels", async () => {
    const network = vi.fn((url) => String(url)); const fetch = createE2eRuntimeFetch("http://127.0.0.1:12345", network);
    expect(await fetch("https://t.me/s/qa_competitor_a?before=42")).toBe("http://127.0.0.1:12345/telegram-public-fixture/s/qa_competitor_a?before=42");
    expect(await fetch("https://t.me/aurora_critical_qa/801")).toBe("http://127.0.0.1:12345/telegram-public-fixture/aurora_critical_qa/801");
    expect(() => fetch("https://t.me/s/unexpected_channel")).toThrow(/external fetch blocked/);
    expect(network).toHaveBeenCalledTimes(2);
  });
});

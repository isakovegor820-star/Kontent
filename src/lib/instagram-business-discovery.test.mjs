import { describe, expect, it, vi } from "vitest";
import {
  fetchInstagramBusinessDiscovery,
  instagramDiscoveryErrorText,
  normalizeInstagramBusinessDiscovery,
} from "./instagram-business-discovery.mjs";

describe("Instagram Business Discovery", () => {
  it("normalizes a professional profile and recent media", () => {
    expect(normalizeInstagramBusinessDiscovery({
      business_discovery: {
        id: "88",
        username: "NASA",
        name: "NASA",
        profile_picture_url: "https://cdn.example/avatar.jpg",
        followers_count: 12,
        media_count: 2,
        media: { data: [{ id: "m1", caption: "Launch", like_count: 7, comments_count: 2,
          media_type: "IMAGE", permalink: "https://www.instagram.com/p/x/", timestamp: "2026-08-14T12:00:00Z" }] },
      },
    })).toMatchObject({ username: "nasa", followersCount: 12, posts: [{ id: "m1", likes: 7, comments: 2 }] });
  });

  it("uses the official graph field and never falls back to scraping", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(decodeURIComponent(String(url))).toContain("business_discovery.username(nasa)");
      return { ok: true, json: async () => ({ business_discovery: { id: "88", username: "nasa", media: { data: [] } } }) };
    });
    const result = await fetchInstagramBusinessDiscovery({
      accessToken: "secret",
      ownAccountId: "11",
      username: "nasa",
      graphBase: "https://graph.facebook.com/v24.0",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("explains the missing professional connection", async () => {
    expect((await fetchInstagramBusinessDiscovery({ username: "nasa" })).code).toBe("instagram_connection_missing");
    expect(instagramDiscoveryErrorText("instagram_connection_missing")).toContain("Business/Creator");
  });
});

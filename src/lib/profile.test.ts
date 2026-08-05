import { describe, expect, it } from "vitest";

import {
  normalizeAvatar,
  parseProfileUpdate,
  profileReauthMethod,
} from "./profile";
import { profileUpdateFingerprint } from "./profile-server";

describe("profile input", () => {
  it("normalizes the existing content brief fields without creating another profile model", () => {
    const parsed = parseProfileUpdate({
      requestKey: "profile:request:1",
      channelId: 42,
      name: "  Анна  ",
      avatar: "https://cdn.example.test/avatar.png",
      brief: {
        niche: "  Право для бизнеса ",
        audience: " Владельцы компаний ",
        goal: "Консультации",
        rubrics: ["Практика", "Практика"],
        formats: ["Видео", "Текст"],
        authorRole: "Партнёр юридической фирмы",
      },
    });

    expect(parsed).toEqual({
      ok: true,
      value: expect.objectContaining({
        name: "Анна",
        channelId: 42,
        brief: expect.objectContaining({
          niche: "Право для бизнеса",
          rubrics: ["Практика"],
          formats: ["Видео", "Текст"],
          authorRole: "Партнёр юридической фирмы",
        }),
      }),
    });
  });

  it("rejects non-HTTPS avatars, incomplete briefs and mismatched idempotency keys", () => {
    expect(normalizeAvatar("http://example.test/a.png")).toBeNull();
    expect(parseProfileUpdate({ requestKey: "profile:a", channelId: 1, name: "А", brief: {} })).toMatchObject({ ok: false });
    expect(parseProfileUpdate({
      requestKey: "profile:one",
      channelId: 1,
      name: "А",
      brief: { niche: "Право", audience: "Бизнес" },
    }, "profile:two")).toEqual({ ok: false, error: "bad_request_key" });
  });

  it("produces stable fingerprints and chooses an explicit reauthentication method", () => {
    const input = {
      channelId: 1,
      name: "Анна",
      avatar: "",
      brief: { niche: "Право", audience: "Бизнес", goal: "", rubrics: [], formats: [], authorRole: "" },
    };
    expect(profileUpdateFingerprint(input)).toBe(profileUpdateFingerprint(structuredClone(input)));
    expect(profileReauthMethod({ password_hash: "hash", tg_id: 1, vk_id: null })).toBe("password");
    expect(profileReauthMethod({ password_hash: null, tg_id: 1, vk_id: null })).toBe("telegram");
    expect(profileReauthMethod({ password_hash: null, tg_id: null, vk_id: 2 })).toBe("vk");
  });
});

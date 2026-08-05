import { describe, expect, it, vi } from "vitest";

import type { DraftCreateInput, ServerDraft } from "./draft-types";
import { createReviewedTrendDraft } from "./trend-draft-review";

function serverDraft(overrides: Partial<ServerDraft> = {}): ServerDraft {
  return {
    id: 41,
    text: "Проверенный человеком текст",
    media: null,
    scheduled_at: null,
    origin: "ai",
    source_ref: { kind: "trend", id: "9", label: "Канал конкурента" },
    client_key: "draft_test_review_1234",
    version: 3,
    review_policy_version: 1,
    ai_validation: null,
    human_review: null,
    created_at: "2026-08-02T12:00:00.000Z",
    updated_at: "2026-08-02T12:00:00.000Z",
    destinations: [
      {
        channel_id: 7,
        network: "tg",
        title: "Технологии права",
        handle: "techlaw",
        is_active: true,
      },
    ],
    ...overrides,
  };
}

const input = {
  text: "Проверенный человеком текст",
  trendId: 9,
  sourceLabel: "Канал конкурента",
  channelId: 7,
  clientKey: "draft_test_review_1234",
  humanAcknowledged: true,
};

describe("reviewed trend draft transfer", () => {
  it("does not mutate server state before explicit human acknowledgement", async () => {
    const create = vi.fn();
    const attest = vi.fn();

    await expect(
      createReviewedTrendDraft(
        { ...input, humanAcknowledged: false },
        { create, attest },
      ),
    ).rejects.toMatchObject({ code: "review_required" });
    expect(create).not.toHaveBeenCalled();
    expect(attest).not.toHaveBeenCalled();
  });

  it("creates an AI-origin server draft and attests its exact returned version", async () => {
    const draft = serverDraft();
    const reviewed = serverDraft({
      version: 4,
      human_review: {
        policy_version: 1,
        draft_version: 4,
        attested_at: "2026-08-02T12:01:00.000Z",
      },
    });
    const create = vi.fn(async (write: DraftCreateInput) => {
      expect(write.origin).toBe("ai");
      return { draft, created: true };
    });
    const attest = vi.fn(async () => reviewed);

    await expect(createReviewedTrendDraft(input, { create, attest })).resolves.toEqual(reviewed);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      origin: "ai",
      aiValidation: null,
      channelIds: [7],
      sourceRef: { kind: "trend", id: "9", label: "Канал конкурента" },
    }));
    expect(attest).toHaveBeenCalledWith(41, 3);
  });

  it("reuses an idempotent replay only when its server review is already current", async () => {
    const reviewed = serverDraft({
      version: 4,
      human_review: {
        policy_version: 1,
        draft_version: 4,
        attested_at: "2026-08-02T12:01:00.000Z",
      },
    });
    const create = vi.fn(async () => ({ draft: reviewed, created: false }));
    const attest = vi.fn();

    await expect(createReviewedTrendDraft(input, { create, attest })).resolves.toEqual(reviewed);
    expect(attest).not.toHaveBeenCalled();
  });

  it("fails closed for a replay whose content no longer matches", async () => {
    const create = vi.fn(async () => ({
      draft: serverDraft({ text: "Изменено в другой вкладке" }),
      created: false,
    }));

    await expect(
      createReviewedTrendDraft(input, { create, attest: vi.fn() }),
    ).rejects.toMatchObject({ code: "draft_conflict" });
  });
});

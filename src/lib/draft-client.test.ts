import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activeComposerNetworks,
  attestServerDraftReview,
  claimUnownedLegacyDraft,
  createServerDraft,
  createDraftClientKey,
  deleteDraftAfterAck,
  DRAFT_AUTOSAVE_DELAY_MS,
  draftMatchesWrite,
  DraftRequestError,
  isRecoverableLegacyDraft,
  isUnownedLegacyDraftCandidate,
  reusableAcknowledgedDraft,
  resolveAcknowledgedDraftRevision,
  runSingleDraftSave,
  scheduleDraftAutosave,
  shouldAutosaveDraft,
} from "./draft-client";
import type { Post } from "./types";

describe("draft client coordination", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares one in-flight request across rapid double save", async () => {
    const holder: { current: Promise<number> | null } = { current: null };
    let resolve!: (value: number) => void;
    const work = vi.fn(
      () => new Promise<number>((done) => {
        resolve = done;
      }),
    );

    const first = runSingleDraftSave(holder, work);
    const second = runSingleDraftSave(holder, work);
    await Promise.resolve();

    expect(first).toBe(second);
    expect(work).toHaveBeenCalledOnce();
    resolve(41);
    await expect(first).resolves.toBe(41);
    await Promise.resolve();
    expect(holder.current).toBeNull();
  });

  it("creates an API-safe idempotency key", () => {
    expect(createDraftClientKey()).toMatch(/^draft_[A-Za-z0-9-]{16,}$/);
  });

  it("POSTs full draft context in JSON and keeps it out of the request URL", async () => {
    const text = "Полный текст референса с фактами и промптом";
    const input = {
      clientKey: "draft_library-reference-1234567890",
      text,
      media: null,
      tracking: {
        shortLinkId: 12,
        shortUrlPath: "/r/abcdefghijklmnopqrst",
        destination: "https://example.test/consultation",
        utmValues: { utm_campaign: "bankruptcy_august" },
        placement: "cta" as const,
      },
      scheduledAt: null,
      origin: "competitor" as const,
      sourceRef: { kind: "competitor" as const, id: "9", label: "Конкурент" },
      channelIds: [11],
      aiValidation: null,
    };
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => {
      void _request;
      void _init;
      return new Response(JSON.stringify({
        ok: true,
        created: true,
        draft: { id: 41 },
      }), { status: 201, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createServerDraft(input)).resolves.toMatchObject({
      created: true,
      draft: { id: 41 },
    });

    const [requestUrl, init] = fetchMock.mock.calls[0];
    expect(String(requestUrl)).toBe("/api/drafts");
    expect(new URL(String(requestUrl), "https://aurora.test").search).toBe("");
    expect(JSON.parse(String(init?.body))).toEqual(input);
    expect(String(requestUrl)).not.toContain(text);
  });

  it("keeps only account-owned recovery copies and excludes demo or unowned legacy", () => {
    const post = (id: string, legacyOwnerUserId?: number): Post => ({
      id,
      legacyOwnerUserId,
      text: "Текст",
      networks: ["tg"],
      scheduledAt: null,
      status: "draft",
      origin: "manual",
      createdAt: "2026-08-01T10:00:00.000Z",
    });
    expect(isRecoverableLegacyDraft(post("post_q1", 7), 7)).toBe(false);
    expect(isRecoverableLegacyDraft(post("post_fut_2", 7), 7)).toBe(false);
    expect(isRecoverableLegacyDraft(post("post_k8f3abc"), 7)).toBe(false);
    expect(isRecoverableLegacyDraft(post("post_k8f3abc", 8), 7)).toBe(false);
    expect(isRecoverableLegacyDraft(post("post_k8f3abc", 7), 7)).toBe(true);
  });

  it("offers an unowned old copy without auto-importing or claiming another account's copy", () => {
    const post = (legacyOwnerUserId?: number): Post => ({
      id: "post_old-browser-copy",
      legacyOwnerUserId,
      text: "Старый локальный черновик",
      networks: ["tg"],
      scheduledAt: null,
      status: "draft",
      origin: "manual",
      createdAt: "2025-10-01T10:00:00.000Z",
    });

    const unowned = post();
    expect(isUnownedLegacyDraftCandidate(unowned)).toBe(true);
    expect(isRecoverableLegacyDraft(unowned, 7)).toBe(false);

    const claimed = claimUnownedLegacyDraft(unowned, 7);
    expect(claimed).toMatchObject({ legacyOwnerUserId: 7 });
    expect(isRecoverableLegacyDraft(claimed!, 7)).toBe(true);
    expect(isRecoverableLegacyDraft(claimed!, 8)).toBe(false);

    const otherAccount = post(8);
    expect(isUnownedLegacyDraftCandidate(otherAccount)).toBe(false);
    expect(claimUnownedLegacyDraft(otherAccount, 7)).toBeNull();
    expect(otherAccount.legacyOwnerUserId).toBe(8);
  });

  it("does not enable or preview VK by default in a Telegram-only account", () => {
    expect(activeComposerNetworks([
      { id: 11, network: "tg", title: "TG", handle: "tg", is_active: true },
      { id: 12, network: "vk", title: "VK", handle: null, is_active: false },
    ])).toEqual(["tg"]);
  });

  it("detects changed local content on an idempotent create replay", () => {
    const draft = {
      id: 41,
      text: "Старая версия",
      media: null,
      tracking: {
        shortLinkId: 12,
        shortUrlPath: "/r/abcdefghijklmnopqrst",
        destination: "https://example.test/consultation",
        utmValues: { utm_campaign: "bankruptcy_august" },
        placement: "cta" as const,
      },
      scheduled_at: null,
      origin: "manual" as const,
      purpose: "publishable" as const,
      source_ref: null,
      generation_result_id: null,
      generation_binding_valid: false,
      client_key: "draft_key_1234567890",
      version: 1,
      review_policy_version: 1 as const,
      ai_validation: null,
      human_review: null,
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-01T10:00:00.000Z",
      destinations: [{ channel_id: 11, network: "tg" as const, title: "TG", handle: "tg", is_active: true }],
    };
    const write = {
      text: "Новая версия",
      media: null,
      scheduledAt: null,
      origin: "manual" as const,
      sourceRef: null,
      channelIds: [11],
      aiValidation: null,
      tracking: {
        shortLinkId: 12,
        shortUrlPath: "/r/abcdefghijklmnopqrst",
        destination: "https://example.test/consultation",
        utmValues: { utm_campaign: "bankruptcy_august" },
        placement: "cta" as const,
      },
    };
    expect(draftMatchesWrite(draft, write)).toBe(false);
    expect(draftMatchesWrite(draft, { ...write, text: "Старая версия" })).toBe(true);
    expect(draftMatchesWrite({
      ...draft,
      tracking: {
        ...draft.tracking,
        destination: "https://example.test/consultation?utm_campaign=bankruptcy_august",
      },
    }, { ...write, text: "Старая версия" })).toBe(true);
    expect(draftMatchesWrite(draft, {
      ...write,
      text: "Старая версия",
      tracking: { ...write.tracking, shortLinkId: 13, shortUrlPath: "/r/zyxwvutsrqponmlkjihg" },
    })).toBe(false);

    const carouselItems = [
      { assetId: "41", label: "Карточка 1", url: "/api/media/assets/41", mimeType: "image/png" as const },
      { assetId: "42", label: "Карточка 2", url: "/api/media/assets/42", mimeType: "image/png" as const },
      { assetId: "43", label: "Карточка 3", url: "/api/media/assets/43", mimeType: "image/png" as const },
    ];
    expect(draftMatchesWrite({
      ...draft,
      media: {
        kind: "carousel",
        hue: 255,
        items: carouselItems.map((item) => ({
          url: item.url,
          label: item.label,
          mimeType: item.mimeType,
          assetId: item.assetId,
        })),
        label: "Пять карточек",
        renderOperationId: 17,
      },
    }, {
      ...write,
      text: "Старая версия",
      media: {
        kind: "carousel",
        label: "Пять карточек",
        hue: 255,
        renderOperationId: 17,
        items: carouselItems,
      },
    })).toBe(true);

    expect(resolveAcknowledgedDraftRevision({
      draft,
      currentWrite: { ...write, text: "Старая версия" },
      requestRevision: 4,
      currentRevision: 5,
    })).toEqual({ revision: 5, current: true, mismatchFields: [] });
    expect(resolveAcknowledgedDraftRevision({
      draft,
      currentWrite: write,
      requestRevision: 4,
      currentRevision: 5,
    })).toEqual({ revision: 4, current: false, mismatchFields: ["text"] });

    expect(resolveAcknowledgedDraftRevision({
      draft: { ...draft, origin: "manual", source_ref: null },
      currentWrite: {
        ...write,
        text: "Старая версия",
        origin: "autopilot" as const,
        sourceRef: { kind: "monthly_campaign", campaignId: 10, planId: 20, itemId: 30 } as never,
      },
      requestRevision: 4,
      currentRevision: 5,
    })).toEqual({ revision: 5, current: true, mismatchFields: [] });
  });

  it("debounces one autosave for the next unattempted local revision", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const cancelStale = scheduleDraftAutosave(save);

    await vi.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_DELAY_MS / 2);
    cancelStale();
    const cancelCurrent = scheduleDraftAutosave(save);

    await vi.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_DELAY_MS - 1);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();

    cancelCurrent();
  });

  it("never autosaves a conflict or repeats the same failed revision", () => {
    const base = {
      hydrated: true,
      revision: 4,
      lastSavedRevision: 3,
      lastAttemptedRevision: 3,
      saveState: "idle" as const,
      hasText: true,
      hasDestinations: true,
      scheduleValid: true,
      busy: false,
    };

    expect(shouldAutosaveDraft(base)).toBe(true);
    expect(shouldAutosaveDraft({ ...base, lastAttemptedRevision: 4, saveState: "failed" })).toBe(false);
    expect(shouldAutosaveDraft({ ...base, revision: 5, saveState: "conflict" })).toBe(false);
    expect(shouldAutosaveDraft({
      ...base,
      revision: 5,
      lastAttemptedRevision: 4,
      saveState: "offline",
    })).toBe(true);
  });

  it("does not remove a draft locally before the versioned DELETE ACK", async () => {
    let acknowledge!: () => void;
    const remove = vi.fn(
      () => new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
    );
    const onAcknowledged = vi.fn();

    const deletion = deleteDraftAfterAck(41, 7, onAcknowledged, remove);
    await Promise.resolve();
    expect(remove).toHaveBeenCalledWith(41, 7);
    expect(onAcknowledged).not.toHaveBeenCalled();

    acknowledge();
    await deletion;
    expect(onAcknowledged).toHaveBeenCalledWith(41);
  });

  it("keeps the local draft when DELETE is rejected", async () => {
    const onAcknowledged = vi.fn();
    await expect(
      deleteDraftAfterAck(41, 6, onAcknowledged, async () => {
        throw new DraftRequestError("conflict", 409, "version_conflict");
      }),
    ).rejects.toMatchObject({ kind: "conflict", status: 409 });
    expect(onAcknowledged).not.toHaveBeenCalled();
  });

  it("changes review state only from the versioned server ACK", async () => {
    const acknowledged = {
      id: 41,
      text: "AI-текст",
      media: null,
      scheduled_at: null,
      origin: "ai" as const,
      purpose: "needs_review" as const,
      source_ref: null,
      generation_result_id: 81,
      generation_binding_valid: false,
      client_key: "draft_key_1234567890",
      version: 4,
      review_policy_version: 1 as const,
      ai_validation: null,
      human_review: {
        policy_version: 1 as const,
        draft_version: 4,
        attested_at: "2026-08-01T12:05:00.000Z",
      },
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-01T12:05:00.000Z",
      destinations: [],
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, draft: acknowledged }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(attestServerDraftReview(41, 3)).resolves.toEqual(acknowledged);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/drafts/41/review",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ version: 3 }),
      }),
    );
  });

  it("reuses an unchanged reviewed snapshot instead of invalidating its ACK with a no-op PATCH", () => {
    const reviewed = {
      id: 41,
      text: "AI-текст",
      media: null,
      scheduled_at: "2026-08-05T10:00:00.000Z",
      origin: "ai" as const,
      purpose: "needs_review" as const,
      source_ref: null,
      generation_result_id: 81,
      generation_binding_valid: false,
      client_key: "draft_key_1234567890",
      version: 4,
      review_policy_version: 1 as const,
      ai_validation: null,
      human_review: {
        policy_version: 1 as const,
        draft_version: 4,
        attested_at: "2026-08-01T12:05:00.000Z",
      },
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-01T12:05:00.000Z",
      destinations: [],
    };

    expect(reusableAcknowledgedDraft({
      draft: reviewed,
      draftId: 41,
      draftVersion: 4,
      revision: 7,
      lastSavedRevision: 7,
    })).toBe(reviewed);
    expect(reusableAcknowledgedDraft({
      draft: reviewed,
      draftId: 41,
      draftVersion: 4,
      revision: 8,
      lastSavedRevision: 7,
    })).toBeNull();
    expect(reusableAcknowledgedDraft({
      draft: reviewed,
      draftId: 41,
      draftVersion: 3,
      revision: 7,
      lastSavedRevision: 7,
    })).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";

const editorialMocks = vi.hoisted(() => ({
  recordDraftRevisionInTransaction: vi.fn(async () => undefined),
}));

vi.mock("./editorial-approval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./editorial-approval")>();
  return { ...actual, recordDraftRevisionInTransaction: editorialMocks.recordDraftRevisionInTransaction };
});

import type { DraftCreateInput, DraftUpdateInput } from "./draft-types";
import {
  attestDraftReviewForUser,
  createDraftForUser,
  DraftConflictError,
  DraftValidationError,
  parseDraftCreateInput,
  parseDraftUpdateInput,
  updateDraftForUser,
} from "./server-drafts";

const input: DraftCreateInput = {
  clientKey: "draft_12345678-1234-4234-9234-123456789abc",
  text: "Текст черновика",
  media: null,
  scheduledAt: "2026-08-05T10:00:00.000Z",
  schedule: {
    localDate: "2026-08-05",
    localTime: "12:00",
    timezone: "Europe/Amsterdam",
    disambiguation: "reject",
    offset: "+02:00",
  },
  origin: "manual",
  sourceRef: null,
  channelIds: [11],
  aiValidation: null,
  generationResultId: null,
};

const row = {
  id: "41",
  project_id: "7",
  text: input.text,
  media: null,
  scheduled_at: input.scheduledAt,
  scheduled_timezone: input.schedule?.timezone ?? null,
  scheduled_local_date: input.schedule?.localDate ?? null,
  scheduled_local_time: input.schedule?.localTime ?? null,
  scheduled_offset: input.schedule?.offset ?? null,
  scheduled_disambiguation: input.schedule?.disambiguation ?? null,
  origin: input.origin,
  purpose: "publishable",
  source_ref: null,
  generation_result_id: null,
  generation_result_hash: null,
  receipt_result_hash: null,
  receipt_payload: null,
  client_key: input.clientKey,
  version: "3",
  review_policy_version: "1",
  ai_validation: null,
  human_reviewed_version: null,
  human_reviewed_at: null,
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-01T12:00:00.000Z",
  destinations: [
    {
      channel_id: "11",
      network: "tg",
      title: "Канал",
      handle: "channel",
      is_active: true,
    },
  ],
};

function fakePool(query: ReturnType<typeof vi.fn>) {
  const release = vi.fn();
  return {
    pool: { connect: vi.fn(async () => ({ query, release })) },
    release,
  };
}

describe("draft input boundary", () => {
  it("normalizes a valid create and rejects duplicate/unowned-shaped destination input", () => {
    expect(parseDraftCreateInput(input)).toEqual(input);
    expect(() => parseDraftCreateInput({ ...input, channelIds: [11, 11] })).toThrowError(
      new DraftValidationError("bad_destinations"),
    );
    expect(() => parseDraftCreateInput({ ...input, clientKey: "short" })).toThrowError(
      new DraftValidationError("bad_client_key"),
    );
  });

  it("requires an optimistic version for updates", () => {
    expect(parseDraftUpdateInput({ ...input, version: 7 })).toMatchObject({ version: 7 });
    expect(() => parseDraftUpdateInput({ ...input, version: 0 })).toThrowError(
      new DraftValidationError("bad_version"),
    );
  });

  it("accepts an idea origin with semantic metadata and separate provenance", () => {
    const parsed = parseDraftCreateInput({
      ...input,
      origin: "idea",
      sourceRef: {
        kind: "idea",
        id: "81",
        label: "Идея Авроры",
        topic: "Ошибки в договоре поставки",
        hook: "Вопрос читателю",
        structure: "Проблема → решение",
        provenance: { kind: "content_idea", id: "9", label: "Открытый источник" },
      },
    });

    expect(parsed).toMatchObject({
      origin: "idea",
      sourceRef: {
        kind: "idea",
        topic: "Ошибки в договоре поставки",
        provenance: { kind: "content_idea", id: "9" },
      },
    });
  });
});

describe("server draft transactions", () => {
  it("rebuilds source text, topic and provenance from the owned server record", async () => {
    let insertedParams: unknown[] | undefined;
    const canonicalRef = {
      kind: "reference",
      id: "55",
      label: "Право без подмены",
      topic: "Исполнительский иммунитет защищает жильё должника.",
      provenance: {
        kind: "competitor_post",
        id: "55",
        label: "Право без подмены",
        url: "https://t.me/legal/77",
      },
    };
    const sourceInput: DraftCreateInput = {
      ...input,
      origin: "competitor",
      text: "ПОДДЕЛЬНЫЙ ТЕКСТ ПРО КОФЕ",
      sourceRef: {
        kind: "competitor",
        id: "55",
        label: "Поддельный источник",
        topic: "Конференция по искусственному интеллекту",
      },
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("select id from channels")) return { rowCount: 1, rows: [{ id: "11" }] };
      if (sql.includes("from competitor_posts post")) {
        return {
          rowCount: 1,
          rows: [{
            id: "55",
            text: "Исполнительский иммунитет защищает жильё должника.",
            title: "Право без подмены",
            handle: "legal",
            tg_msg_id: "77",
          }],
        };
      }
      if (sql.includes("insert into drafts")) {
        insertedParams = params;
        return { rowCount: 1, rows: [{ id: "41", project_id: "7" }] };
      }
      if (sql.includes("select d.id")) {
        return {
          rowCount: 1,
          rows: [{
            ...row,
            text: "Исполнительский иммунитет защищает жильё должника.",
            origin: "competitor",
            purpose: "source_context",
            source_ref: canonicalRef,
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    const { pool } = fakePool(query);

    const result = await createDraftForUser(5, sourceInput, pool as never);

    expect(result.draft).toMatchObject({
      text: "Исполнительский иммунитет защищает жильё должника.",
      purpose: "source_context",
      source_ref: canonicalRef,
    });
    expect(insertedParams?.[1]).toBe("Исполнительский иммунитет защищает жильё должника.");
    expect(insertedParams?.[5]).toBe("source_context");
    expect(JSON.parse(String(insertedParams?.[6]))).toEqual(canonicalRef);
    expect(editorialMocks.recordDraftRevisionInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      { draftId: 41, actorUserId: 5, projectId: 7 },
    );
  });

  it("rebuilds an internet trend from the owned verified radar result", async () => {
    let insertedParams: unknown[] | undefined;
    const canonicalRef = {
      kind: "trend",
      id: "91",
      label: "Рыбалка каждый день",
      topic: "Как выбрать место для летней рыбалки",
      provenance: {
        kind: "radar_result",
        id: "91",
        label: "Рыбалка каждый день",
        url: "https://t.me/fishing_public/345",
      },
    };
    const sourceInput: DraftCreateInput = {
      ...input,
      origin: "trend",
      text: "Подменённый текст",
      sourceRef: {
        kind: "trend",
        id: "91",
        label: "Поддельное название",
        provenance: { kind: "radar_result", id: "91" },
      },
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("select id from channels")) return { rowCount: 1, rows: [{ id: "11" }] };
      if (sql.includes("from radar_search_results result")) {
        expect(params).toEqual(["91", 5, 11]);
        return {
          rowCount: 1,
          rows: [{
            id: "91",
            text: "Как выбрать место для летней рыбалки",
            description: null,
            title: "Рыбалка каждый день",
            handle: "fishing_public",
            url: "https://t.me/fishing_public/345",
          }],
        };
      }
      if (sql.includes("insert into drafts")) {
        insertedParams = params;
        return { rowCount: 1, rows: [{ id: "41", project_id: "7" }] };
      }
      if (sql.includes("select d.id")) {
        return {
          rowCount: 1,
          rows: [{
            ...row,
            text: "Как выбрать место для летней рыбалки",
            origin: "trend",
            purpose: "source_context",
            source_ref: canonicalRef,
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    const { pool } = fakePool(query);

    const result = await createDraftForUser(5, sourceInput, pool as never);

    expect(result.draft).toMatchObject({
      text: "Как выбрать место для летней рыбалки",
      source_ref: canonicalRef,
    });
    expect(insertedParams?.[1]).toBe("Как выбрать место для летней рыбалки");
    expect(JSON.parse(String(insertedParams?.[6]))).toEqual(canonicalRef);
  });

  it("creates an RSS item as an immutable server-owned source context", async () => {
    let insertedParams: unknown[] | undefined;
    const canonicalRef = {
      kind: "rss",
      id: "88",
      label: "Юридические новости",
      topic: "Новые правила исполнительского производства",
      provenance: {
        kind: "rss_item",
        id: "88",
        label: "Юридические новости",
        url: "https://example.test/news/88",
      },
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("select id from channels")) return { rowCount: 1, rows: [{ id: "11" }] };
      if (sql.includes("from rss_items item")) {
        return {
          rowCount: 1,
          rows: [{
            id: "88",
            title: "Новые правила исполнительского производства",
            summary: "Разбираем изменения и сроки вступления в силу.",
            link: "https://example.test/news/88",
            feed_title: "Юридические новости",
          }],
        };
      }
      if (sql.includes("insert into drafts")) {
        insertedParams = params;
        return { rowCount: 1, rows: [{ id: "41", project_id: "7" }] };
      }
      if (sql.includes("select d.id")) {
        return {
          rowCount: 1,
          rows: [{
            ...row,
            text: "Новые правила исполнительского производства\n\nРазбираем изменения и сроки вступления в силу.",
            origin: "rss",
            purpose: "source_context",
            source_ref: canonicalRef,
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    const { pool } = fakePool(query);

    const result = await createDraftForUser(5, {
      ...input,
      clientKey: "rss_item_source:88",
      origin: "rss",
      text: "CLIENT TEXT MUST NOT WIN",
      sourceRef: { kind: "rss", id: "88", label: "Поддельная подпись" },
    }, pool as never);

    expect(result.draft).toMatchObject({
      origin: "rss",
      purpose: "source_context",
      source_ref: canonicalRef,
    });
    expect(insertedParams?.[1]).toContain("Разбираем изменения");
    expect(insertedParams?.[5]).toBe("source_context");
  });

  it("returns the existing row for an idempotency-key replay without replacing destinations", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rowCount: 1, rows: [{ id: "11" }] };
      if (sql.includes("insert into drafts")) return { rowCount: 0, rows: [] };
      if (sql.includes("select id from drafts where")) return { rowCount: 1, rows: [{ id: "41" }] };
      if (sql.includes("select d.id")) return { rowCount: 1, rows: [row] };
      return { rowCount: 0, rows: [] };
    });
    const { pool, release } = fakePool(query);

    const result = await createDraftForUser(5, input, pool as never);

    expect(result).toMatchObject({ created: false, draft: { id: 41, version: 3 } });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("delete from draft_destinations"))).toBe(false);
    expect(query).toHaveBeenCalledWith("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a destination not owned and active before inserting anything", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const { pool } = fakePool(query);

    await expect(createDraftForUser(5, input, pool as never)).rejects.toMatchObject({
      code: "bad_destinations",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into drafts"))).toBe(false);
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it("rejects a media asset owned by another user", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rowCount: 1, rows: [{ id: "11" }] };
      if (sql.includes("select kind from media_assets")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const { pool } = fakePool(query);

    await expect(createDraftForUser(5, {
      ...input,
      media: { kind: "image", label: "Картинка", hue: 42, assetId: "99" },
    }, pool as never)).rejects.toMatchObject({ code: "bad_media" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into drafts"))).toBe(false);
  });

  it("turns a stale PATCH into a conflict carrying the current server version", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rowCount: 1, rows: [{ id: "11" }] };
      if (sql.includes("update drafts")) return { rowCount: 0, rows: [] };
      if (sql.includes("select d.id")) return { rowCount: 1, rows: [row] };
      return { rowCount: 0, rows: [] };
    });
    const { pool } = fakePool(query);
    const update: DraftUpdateInput = { ...input, version: 2 };

    const error = await updateDraftForUser(5, 41, update, pool as never).catch((reason) => reason);
    expect(error).toBeInstanceOf(DraftConflictError);
    expect(error.current).toMatchObject({ id: 41, version: 3 });
    expect(query).toHaveBeenCalledWith("rollback");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("delete from draft_destinations"))).toBe(false);
  });

  it("detaches visible provenance after a human changes AI-generated text", async () => {
    let selected = 0;
    let updatedParams: unknown[] | undefined;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("select d.id")) {
        selected += 1;
        return {
          rowCount: 1,
          rows: [{
            ...row,
            text: selected === 1 ? "Исходный AI-текст" : "Полностью новый текст автора",
            origin: "ai",
            purpose: "needs_review",
            source_ref: selected === 1
              ? { kind: "rss", id: "88", label: "Юридические новости" }
              : null,
            generation_result_id: "91",
            version: selected === 1 ? "3" : "4",
          }],
        };
      }
      if (sql.includes("select id from channels")) return { rowCount: 1, rows: [{ id: "11" }] };
      if (sql.includes("update drafts")) {
        updatedParams = params;
        return { rowCount: 1, rows: [{ id: "41" }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const { pool } = fakePool(query);

    const updated = await updateDraftForUser(5, 41, {
      ...input,
      version: 3,
      origin: "ai",
      text: "Полностью новый текст автора",
      sourceRef: null,
      generationResultId: null,
    }, pool as never);

    expect(updated).toMatchObject({ version: 4, source_ref: null, generation_binding_valid: false });
    expect(updatedParams?.[7]).toBeNull();
  });

  it("ACKs human review by advancing and binding the exact AI draft version", async () => {
    const aiValidation = {
      version: 1,
      status: "not_checked",
      requiresReview: true,
      blockerCodes: [],
      provenance: {
        validatorVersion: "fact-ledger-v1",
        ledgerHash: "fl1-1234abcd",
        checkedAt: "2026-08-01T11:55:00.000Z",
        coverage: "deterministic",
        semanticEntailment: "not_checked",
        rulesRun: ["unsupported_claim"],
        sourceIds: ["brief:1"],
      },
    };
    let selected = 0;
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes("select d.id")) {
        selected += 1;
        return {
          rowCount: 1,
          rows: [{
            ...row,
            origin: "ai",
            purpose: "needs_review",
            generation_result_id: "91",
            ai_validation: aiValidation,
            version: selected === 1 ? "3" : "4",
            human_reviewed_version: selected === 1 ? null : "4",
            human_reviewed_at:
              selected === 1 ? null : "2026-08-01T12:05:00.000Z",
          }],
        };
      }
      if (sql.includes("update drafts")) return { rowCount: 1, rows: [{ id: "41" }] };
      return { rowCount: 0, rows: [] };
    });
    const { pool } = fakePool(query);

    const reviewed = await attestDraftReviewForUser(5, 41, 3, pool as never);

    expect(reviewed).toMatchObject({
      id: 41,
      version: 4,
      human_review: { policy_version: 1, draft_version: 4 },
    });
    const mutation = query.mock.calls.find(([sql]) => String(sql).includes("update drafts"));
    expect(mutation?.[1]).toEqual([41, 5, 3, 1]);
    expect(query).toHaveBeenCalledWith("commit");
  });
});

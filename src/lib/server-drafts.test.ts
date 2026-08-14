import { beforeEach, describe, expect, it, vi } from "vitest";

const editorialMocks = vi.hoisted(() => ({
  recordDraftRevisionInTransaction: vi.fn(async () => undefined),
}));
const projectMocks = vi.hoisted(() => ({
  requireSelectedProjectPermission: vi.fn(async (_db: unknown, userId: number) => ({
    projectId: 7,
    userId,
    role: "owner" as const,
    version: 1,
  })),
}));

vi.mock("./editorial-approval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./editorial-approval")>();
  return { ...actual, recordDraftRevisionInTransaction: editorialMocks.recordDraftRevisionInTransaction };
});
vi.mock("./project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: projectMocks.requireSelectedProjectPermission };
});

import type { DraftCreateInput, DraftUpdateInput } from "./draft-types";
import { ProjectAccessError } from "./project-permissions";
import {
  attestDraftReviewForUser,
  createDraftForUser,
  deleteDraftForUser,
  DraftConflictError,
  DraftNotFoundError,
  DraftValidationError,
  generationDestinationIsSelected,
  getDraftForUser,
  listDraftsForUser,
  parseDraftCreateInput,
  parseDraftUpdateInput,
  updateDraftForUser,
} from "./server-drafts";

describe("generated draft destinations", () => {
  it("keeps provenance tied to its generation channel while allowing additional destinations", () => {
    expect(generationDestinationIsSelected([11], 11)).toBe(true);
    expect(generationDestinationIsSelected([11, 22, 33], 11)).toBe(true);
    expect(generationDestinationIsSelected([22, 33], 11)).toBe(false);
  });
});

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
  tracking: null,
};

const row = {
  id: "41",
  project_id: "7",
  author_user_id: "5",
  author_name: "Анна Юрист",
  editorial_state: "in_review",
  text: input.text,
  media: null,
  tracking: {},
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

beforeEach(() => {
  projectMocks.requireSelectedProjectPermission.mockClear();
  projectMocks.requireSelectedProjectPermission.mockImplementation(async (_db: unknown, userId: number) => ({
    projectId: 7,
    userId,
    role: "owner" as const,
    version: 1,
  }));
  editorialMocks.recordDraftRevisionInTransaction.mockClear();
});

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

  it("adopts a server-created autopilot draft as a human-editable manual revision", () => {
    expect(parseDraftUpdateInput({
      ...input,
      origin: "autopilot",
      sourceRef: {
        kind: "monthly_campaign",
        campaignId: 10,
        planId: 20,
        itemId: 30,
      },
      version: 7,
    })).toMatchObject({
      origin: "manual",
      sourceRef: null,
      version: 7,
    });
  });

  it("accepts an ordered 3–7 image carousel and rejects duplicate or undersized albums", () => {
    const carousel = {
      kind: "carousel" as const,
      label: "Юридическая памятка",
      hue: 255,
      renderOperationId: 88,
      items: [1, 2, 3].map((assetId) => ({
        assetId: String(assetId),
        label: `Карточка ${assetId}`,
        url: `/api/media/assets/${assetId}`,
        mimeType: "image/png" as const,
      })),
    };
    expect(parseDraftCreateInput({ ...input, media: carousel })).toMatchObject({
      media: { kind: "carousel", renderOperationId: 88, items: [{ assetId: "1" }, { assetId: "2" }, { assetId: "3" }] },
    });
    expect(() => parseDraftCreateInput({ ...input, media: { ...carousel, items: carousel.items.slice(0, 2) } }))
      .toThrowError(new DraftValidationError("bad_media"));
    expect(() => parseDraftCreateInput({ ...input, media: { ...carousel, items: [carousel.items[0], carousel.items[0], carousel.items[2]] } }))
      .toThrowError(new DraftValidationError("bad_media"));
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

  it("normalizes a structured tracking choice and rejects client-owned project or slug fields", () => {
    const tracking = {
      shortLinkId: null,
      shortUrlPath: null,
      destination: "https://example.test/consultation",
      utmValues: { utm_source: "telegram", utm_campaign: "споры" },
      placement: "post",
    } as const;
    expect(parseDraftCreateInput({ ...input, tracking })).toMatchObject({ tracking });
    expect(() => parseDraftCreateInput({
      ...input,
      tracking: { ...tracking, projectId: 999 },
    })).toThrowError(new DraftValidationError("bad_tracking"));
    expect(() => parseDraftCreateInput({
      ...input,
      tracking: { ...tracking, slug: "client-controlled" },
    })).toThrowError(new DraftValidationError("bad_tracking"));
    expect(() => parseDraftCreateInput({
      ...input,
      tracking: { ...tracking, shortLinkId: 3, shortUrlPath: "/r/too-short" },
    })).toThrowError(new DraftValidationError("bad_tracking"));
  });
});

describe("server draft transactions", () => {
  it("reads PostgreSQL date-only schedule fields as ISO text", async () => {
    const selects: string[] = [];
    const query = vi.fn(async (sql: string) => {
      selects.push(sql.replace(/\s+/gu, " ").trim());
      return { rowCount: 1, rows: [row] };
    });
    const db = { query };

    await expect(listDraftsForUser(5, db as never)).resolves.toHaveLength(1);
    await expect(getDraftForUser(5, 41, db as never)).resolves.toMatchObject({
      scheduled_local_date: "2026-08-05",
    });

    expect(selects).toHaveLength(2);
    for (const sql of selects) {
      expect(sql).toContain("d.scheduled_local_date::text as scheduled_local_date");
    }
  });

  it("lists and reads the selected project for every active teammate without a user tenant filter", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("d.project_id = $1");
      expect(sql).not.toContain("d.user_id = $1");
      expect(sql).toContain("draft_author.id = d.user_id");
      expect(sql).toContain("editorial_workflow.project_id = d.project_id");
      if (sql.includes("limit 200")) {
        expect(sql).toContain("operation.approved_revision_id is not null");
        expect(sql).toContain("operation.status in ('queued', 'published_unverified', 'published')");
      }
      if (params?.length === 1) return { rowCount: 1, rows: [row] };
      expect(params).toEqual([7, 41]);
      return { rowCount: 1, rows: [row] };
    });
    const db = { query };

    await expect(listDraftsForUser(5, db as never)).resolves.toMatchObject([{
      id: 41,
      author_user_id: 5,
      author_name: "Анна Юрист",
      editorial_state: "in_review",
    }]);
    await expect(getDraftForUser(5, 41, db as never)).resolves.toMatchObject({ id: 41 });
    await expect(getDraftForUser(6, 41, db as never)).resolves.toMatchObject({ id: 41 });

    expect(projectMocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      db,
      5,
      "project.read",
    );
    expect(query.mock.calls.filter(([, params]) => (params as unknown[])?.length === 2))
      .toHaveLength(2);
  });

  it("does not expose a draft from another project and stops before SQL without membership", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("d.project_id = $1");
      expect(params).toEqual([7, 91]);
      return { rowCount: 0, rows: [] };
    });
    await expect(getDraftForUser(5, 91, { query } as never)).resolves.toBeNull();

    projectMocks.requireSelectedProjectPermission.mockRejectedValueOnce(
      new ProjectAccessError("membership_required"),
    );
    const forbiddenQuery = vi.fn();
    await expect(getDraftForUser(99, 41, { query: forbiddenQuery } as never)).rejects.toMatchObject({
      code: "membership_required",
    });
    expect(forbiddenQuery).not.toHaveBeenCalled();
  });

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
    expect(insertedParams?.[1]).toBe(7);
    expect(insertedParams?.[2]).toBe("Исполнительский иммунитет защищает жильё должника.");
    expect(insertedParams?.[7]).toBe("source_context");
    expect(JSON.parse(String(insertedParams?.[8]))).toEqual(canonicalRef);
    expect(editorialMocks.recordDraftRevisionInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      { draftId: 41, actorUserId: 5, projectId: 7 },
    );
    expect(projectMocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      5,
      "content.create",
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
    expect(insertedParams?.[2]).toBe("Как выбрать место для летней рыбалки");
    expect(JSON.parse(String(insertedParams?.[8]))).toEqual(canonicalRef);
  });

  it("creates an RSS item as an immutable server-owned source context", async () => {
    let insertedParams: unknown[] | undefined;
    const canonicalRef = {
      kind: "rss",
      id: "88",
      label: "Юридические новости",
      topic: "Новые правила исполнительского производства",
      factualGrounding: "curated_legal_source",
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
            source_kind: "legal_opportunity",
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
      clientKey: "rss_item_source:88:channel:11:variant:standard",
      origin: "rss",
      text: "CLIENT TEXT MUST NOT WIN",
      sourceRef: { kind: "rss", id: "88", label: "Поддельная подпись" },
    }, pool as never);

    expect(result.draft).toMatchObject({
      origin: "rss",
      purpose: "source_context",
      source_ref: canonicalRef,
    });
    expect(insertedParams?.[2]).toContain("Разбираем изменения");
    expect(insertedParams?.[7]).toBe("source_context");
    const rssLookup = query.mock.calls.find(([sql]) => String(sql).includes("from rss_items item"));
    expect(String(rssLookup?.[0])).toContain("source_channel.project_id = destination_channel.project_id");
    expect(rssLookup?.[1]).toEqual(["88", 5, 11]);
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

  it("rebuilds a selected short link from the selected project instead of trusting client metadata", async () => {
    let insertedParams: unknown[] | undefined;
    const canonicalTracking = {
      shortLinkId: 88,
      shortUrlPath: "/r/abcdefghijklmnopqrstuvwxyz123456",
      destination: "https://example.test/consultation?utm_source=telegram",
      utmValues: { utm_source: "telegram" },
      placement: "post",
    } as const;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("select id from channels")) {
        expect(params).toEqual([7, [11]]);
        return { rowCount: 1, rows: [{ id: "11" }] };
      }
      if (sql.includes("from short_links")) {
        expect(params).toEqual([88, 7]);
        return {
          rowCount: 1,
          rows: [{
            id: "88",
            slug: "abcdefghijklmnopqrstuvwxyz123456",
            destination_url: canonicalTracking.destination,
            utm_values: canonicalTracking.utmValues,
          }],
        };
      }
      if (sql.includes("insert into drafts")) {
        insertedParams = params;
        return { rowCount: 1, rows: [{ id: "41", project_id: "7" }] };
      }
      if (sql.includes("select d.id")) {
        return { rowCount: 1, rows: [{ ...row, tracking: canonicalTracking }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const { pool } = fakePool(query);

    const result = await createDraftForUser(23, {
      ...input,
      tracking: {
        shortLinkId: 88,
        shortUrlPath: "/r/this-client-path-is-valid-but-ignored",
        destination: "https://attacker.example/wrong",
        utmValues: { utm_source: "spoofed" },
        placement: "post",
      },
    }, pool as never);

    expect(result.draft.tracking).toEqual(canonicalTracking);
    expect(JSON.parse(String(insertedParams?.[4]))).toEqual(canonicalTracking);
    expect(insertedParams?.[0]).toBe(23);
    expect(insertedParams?.[1]).toBe(7);
  });

  it("rejects a short link from another project before inserting a draft", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rowCount: 1, rows: [{ id: "11" }] };
      if (sql.includes("from short_links")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const { pool } = fakePool(query);

    await expect(createDraftForUser(5, {
      ...input,
      tracking: {
        shortLinkId: 999,
        shortUrlPath: "/r/abcdefghijklmnopqrstuvwxyz123456",
        destination: "https://example.test/",
        utmValues: {},
        placement: "post",
      },
    }, pool as never)).rejects.toMatchObject({ code: "bad_tracking" });
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
    expect(updatedParams?.[1]).toBe(7);
    expect(editorialMocks.recordDraftRevisionInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      { draftId: 41, actorUserId: 5, projectId: 7 },
    );
  });

  it("persists a monthly autopilot draft as a manual revision without changing its id", async () => {
    let selected = 0;
    let updatedParams: unknown[] | undefined;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("select d.id")) {
        selected += 1;
        return {
          rowCount: 1,
          rows: [{
            ...row,
            text: selected === 1 ? "План месяца" : "Текст после правки автора",
            origin: selected === 1 ? "autopilot" : "manual",
            purpose: selected === 1 ? "needs_review" : "publishable",
            source_ref: selected === 1
              ? { kind: "monthly_campaign", campaignId: 10, planId: 20, itemId: 30 }
              : null,
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
      origin: "manual",
      text: "Текст после правки автора",
      sourceRef: null,
    }, pool as never);

    expect(updated).toMatchObject({ id: 41, version: 4, origin: "manual", source_ref: null });
    expect(updatedParams?.[5]).toBe("manual");
    expect(editorialMocks.recordDraftRevisionInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      { draftId: 41, actorUserId: 5, projectId: 7 },
    );
  });

  it("preserves tracking for a legacy PATCH that omits the field and records the new revision", async () => {
    const existingTracking = {
      shortLinkId: null,
      shortUrlPath: null,
      destination: "https://example.test/consultation",
      utmValues: { utm_source: "telegram" },
      placement: "post",
    } as const;
    let selected = 0;
    let updatedParams: unknown[] | undefined;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("select d.id")) {
        selected += 1;
        return {
          rowCount: 1,
          rows: [{ ...row, version: selected === 1 ? "3" : "4", tracking: existingTracking }],
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
    const { tracking: _legacyMissingTracking, ...legacyInput } = input;
    void _legacyMissingTracking;

    const updated = await updateDraftForUser(19, 41, {
      ...legacyInput,
      version: 3,
    }, pool as never);

    expect(updated.tracking).toEqual(existingTracking);
    expect(JSON.parse(String(updatedParams?.[17]))).toEqual(existingTracking);
    expect(editorialMocks.recordDraftRevisionInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      { draftId: 41, actorUserId: 19, projectId: 7 },
    );
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
    expect(mutation?.[1]).toEqual([41, 7, 3, 1]);
    const audit = query.mock.calls.find(([sql]) => String(sql).includes("draft.human_review_attested"));
    expect(audit?.[1]).toEqual([
      7,
      5,
      "41",
      3,
      JSON.stringify({ policyVersion: 1 }),
      "draft:41:human-review:4",
    ]);
    expect(query).toHaveBeenCalledWith("commit");
    expect(projectMocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      5,
      "content.edit",
    );
  });

  it("deletes only from the selected project and treats user id as the actor", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("delete from drafts")) {
        expect(sql).toContain("project_id = $2");
        expect(sql).not.toContain("user_id = $2");
        expect(params).toEqual([41, 7, 3]);
        return { rowCount: 1, rows: [{ id: "41" }] };
      }
      return { rowCount: 0, rows: [] };
    });
    const { pool } = fakePool(query);

    await expect(deleteDraftForUser(23, 41, 3, pool as never)).resolves.toBeUndefined();
    expect(projectMocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      23,
      "content.edit",
    );
    const audit = query.mock.calls.find(([sql]) => String(sql).includes("draft.deleted"));
    expect(audit?.[1]).toEqual([7, 23, "41", 3, "draft:41:deleted:3"]);
  });

  it("returns not found instead of crossing projects on a delete miss", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("delete from drafts")) return { rowCount: 0, rows: [] };
      if (sql.includes("select d.id")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const { pool } = fakePool(query);
    await expect(deleteDraftForUser(5, 91, 1, pool as never)).rejects.toBeInstanceOf(
      DraftNotFoundError,
    );
  });
});

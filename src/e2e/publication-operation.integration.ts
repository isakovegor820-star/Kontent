import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import pg from "pg";
import { Temporal } from "@js-temporal/polyfill";

import { migrate } from "../../scripts/migrate.mjs";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  getSessionUser: vi.fn(),
  add: vi.fn(),
  probePublication: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getPool: () => mocks.getPool() }));
vi.mock("@/lib/session", () => ({ getSessionUser: (...args: unknown[]) => mocks.getSessionUser(...args) }));
vi.mock("@/lib/readiness-probes", () => ({
  probeRedisAndPublicationWorker: (...args: unknown[]) => mocks.probePublication(...args),
}));
vi.mock("@/lib/queue", async (original) => {
  const actual = await original<typeof import("@/lib/queue")>();
  return { ...actual, getPublishQueue: () => ({ add: mocks.add }) };
});

import { POST } from "@/app/api/publication-operations/route";
import { reconcilePublicationOutbox } from "@/lib/publication-outbox.mjs";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
  || target.pathname.slice(1) !== "aurora_publication_gate_test") {
  throw new Error("Gate 6 integration requires disposable local aurora_publication_gate_test database");
}
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 10 });
let userId = 0;
let otherUserId = 0;
let channels: number[] = [];
const acceptedJobs = new Set<string>();

function request(draftId: number, draftVersion: number, key: string, fingerprint?: string) {
  return new NextRequest("http://localhost/api/publication-operations", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      draftId,
      draftVersion,
      timezone: "Europe/Moscow",
      operationFingerprint: fingerprint,
    }),
  });
}

async function createDraft(text: string, version = 1) {
  const future = new Date(Date.now() + 2 * 60 * 60_000);
  future.setSeconds(0, 0);
  const zoned = Temporal.Instant.from(future.toISOString()).toZonedDateTimeISO("Europe/Moscow");
  const draftId = Number((await pool.query(
    `insert into drafts
       (user_id, text, scheduled_at, scheduled_timezone, scheduled_local_date,
        scheduled_local_time, scheduled_offset, scheduled_disambiguation,
        origin, purpose, client_key, version)
     values ($1, $2, $3, 'Europe/Moscow', $4, $5, $6, 'reject',
             'manual', 'publishable', $7, $8) returning id`,
    [
      userId,
      text,
      future,
      zoned.toPlainDate().toString(),
      zoned.toPlainTime().toString().slice(0, 5),
      zoned.offset,
      `draft_gate6_${crypto.randomUUID()}`,
      version,
    ],
  )).rows[0].id);
  for (const channelId of channels) {
    await pool.query("insert into draft_destinations (draft_id, channel_id) values ($1, $2)", [draftId, channelId]);
  }
  return draftId;
}

beforeAll(async () => {
  mocks.getPool.mockReturnValue(pool);
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  userId = Number((await pool.query(
    "insert into users (email, name) values ('qa-publication@example.test', 'QA Publication') returning id",
  )).rows[0].id);
  otherUserId = Number((await pool.query(
    "insert into users (email, name) values ('qa-publication-other@example.test', 'QA Publication Other') returning id",
  )).rows[0].id);
  channels = (await Promise.all(["A", "B"].map(async (title) => Number((await pool.query(
    `insert into channels (user_id, network, title, handle, is_active)
     values ($1, 'tg', $2, $3, true) returning id`,
    [userId, `QA ${title}`, `qa_gate6_${title.toLowerCase()}`],
  )).rows[0].id))));
});

afterAll(async () => { await pool.end(); });

beforeEach(() => {
  acceptedJobs.clear();
  mocks.getSessionUser.mockResolvedValue({ id: userId });
  mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
  mocks.add.mockImplementation(async (_name: string, _data: unknown, options: { jobId?: string }) => {
    if (options.jobId) acceptedJobs.add(options.jobId);
    return { id: options.jobId };
  });
});

describe("immutable multi-destination publication operation", () => {
  it("keeps one revision after partial enqueue and conflicts after the draft changes", async () => {
    const draftId = await createDraft("Revision one");
    let call = 0;
    mocks.add.mockImplementation(async (_name: string, _data: unknown, options: { jobId?: string }) => {
      call += 1;
      if (call === 2) throw new Error("queue B unavailable");
      if (options.jobId) acceptedJobs.add(options.jobId);
      return { id: options.jobId };
    });
    const first = await POST(request(draftId, 1, "gate6:partial:operation"));
    expect(first.status).toBe(207);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ ok: false, operationStatus: "partial", draftVersion: 1 });
    expect(firstBody.destinations.map((item: { queueStatus: string }) => item.queueStatus).sort()).toEqual([
      "enqueued",
      "failed",
    ]);

    await pool.query(
      `update drafts set text = 'Revision two', scheduled_at = scheduled_at + interval '1 hour',
          version = version + 1 where id = $1`,
      [draftId],
    );
    const jobsBefore = mocks.add.mock.calls.length;
    const conflict = await POST(request(draftId, 2, "gate6:partial:operation", firstBody.fingerprint));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: "idempotency_fingerprint_conflict" });
    expect(mocks.add).toHaveBeenCalledTimes(jobsBefore);

    const posts = await pool.query(
      `select text, publication_draft_version, channel_id
         from posts where publication_operation_id = $1 order by channel_id`,
      [firstBody.operationId],
    );
    expect(posts.rows).toHaveLength(2);
    expect(posts.rows.every((row) => row.text === "Revision one" && Number(row.publication_draft_version) === 1)).toBe(true);
    const durableParts = await pool.query(
      `select pp.post_id, pp.part_index, pp.part_type, pp.payload_hash, pp.entity_length
         from publication_parts pp
         join posts p on p.id = pp.post_id
        where p.publication_operation_id = $1
        order by pp.post_id, pp.part_index`,
      [firstBody.operationId],
    );
    expect(durableParts.rows).toHaveLength(2);
    expect(durableParts.rows.every((row) =>
      row.part_index === 0
      && row.part_type === "text"
      && /^[0-9a-f]{64}$/u.test(String(row.payload_hash).trim())
      && Number(row.entity_length) === "Revision one".length,
    )).toBe(true);
  });

  it("retries a due failed destination with the original immutable revision", async () => {
    const draftId = await createDraft("Original retry text");
    let call = 0;
    mocks.add.mockImplementation(async (_name: string, _data: unknown, options: { jobId?: string }) => {
      call += 1;
      if (call === 2) throw new Error("queue B unavailable");
      if (options.jobId) acceptedJobs.add(options.jobId);
      return { id: options.jobId };
    });
    const firstBody = await (await POST(request(draftId, 1, "gate6:retry:operation"))).json();
    await pool.query(
      "update publication_outbox set next_attempt_at = now() where operation_id = $1 and status = 'failed'",
      [firstBody.operationId],
    );
    const replay = await POST(request(draftId, 1, "gate6:retry:operation", firstBody.fingerprint));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ ok: true, operationStatus: "queued", replayed: true });
    expect((await pool.query(
      "select count(*)::int as count from posts where publication_operation_id = $1",
      [firstBody.operationId],
    )).rows[0].count).toBe(2);
  });

  it("linearizes parallel keys into one operation and one destination row each", async () => {
    const draftId = await createDraft("Parallel immutable text");
    const [left, right] = await Promise.all([
      POST(request(draftId, 1, "gate6:parallel:left")),
      POST(request(draftId, 1, "gate6:parallel:right")),
    ]);
    expect([left.status, right.status].every((status) => status === 200 || status === 201)).toBe(true);
    const operations = await pool.query(
      "select count(*)::int as count from publication_operations where draft_id = $1 and draft_version = 1",
      [draftId],
    );
    const posts = await pool.query(
      `select count(*)::int as count from posts p join publication_operations o on o.id = p.publication_operation_id
        where o.draft_id = $1 and o.draft_version = 1`,
      [draftId],
    );
    expect(operations.rows[0].count).toBe(1);
    expect(posts.rows[0].count).toBe(2);
  });

  it("does not expose another owner's draft or destinations", async () => {
    const draftId = await createDraft("Owned text");
    mocks.getSessionUser.mockResolvedValue({ id: otherUserId });
    const response = await POST(request(draftId, 1, "gate6:ownership:test"));
    expect(response.status).toBe(404);
    expect((await pool.query(
      "select count(*)::int as count from publication_operations where user_id = $1",
      [otherUserId],
    )).rows[0].count).toBe(0);
  });

  it("honors the persisted retry time and parallel reconcilers enqueue a due row once", async () => {
    const draftId = await createDraft("Outbox timing proof");
    mocks.add.mockRejectedValue(new Error("queue unavailable"));
    const created = await POST(request(draftId, 1, "gate8:outbox:timing"));
    expect(created.status).toBe(207);
    const body = await created.json();
    const failed = await pool.query(
      `select id, post_id, next_attempt_at from publication_outbox
        where operation_id = $1 and status = 'failed' order by id`,
      [body.operationId],
    );
    expect(failed.rows).toHaveLength(2);

    const enqueue = vi.fn(async () => ({ id: "accepted" }));
    const tooEarly = await reconcilePublicationOutbox({
      pool,
      operationId: body.operationId,
      enqueue,
      now: () => new Date(Date.now() + 1_000),
    });
    expect(tooEarly).toMatchObject({ scanned: 0, enqueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();

    await pool.query(
      `update publication_outbox set status = 'enqueued' where id = $1`,
      [failed.rows[0].id],
    );
    await pool.query(
      `update publication_outbox set next_attempt_at = now() - interval '1 second' where id = $1`,
      [failed.rows[1].id],
    );
    const [left, right] = await Promise.all([
      reconcilePublicationOutbox({ pool, operationId: body.operationId, enqueue }),
      reconcilePublicationOutbox({ pool, operationId: body.operationId, enqueue }),
    ]);
    expect(left.enqueued + right.enqueued).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((await pool.query(
      `select count(*)::int as count from publication_outbox
        where operation_id = $1 and status = 'enqueued'`,
      [body.operationId],
    )).rows[0].count).toBe(2);
  });
});

import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { migrate } from "../../scripts/migrate.mjs";
import {
  deliverAudienceReply,
  updateAudienceInquiry,
} from "@/lib/audience-assistant";
import {
  AUDIENCE_DELIVERY_LEASE_SECONDS,
  AUDIENCE_STALE_ALL_DELIVERIES_SQL,
} from "@/lib/audience-delivery-contract.mjs";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
  || target.pathname.slice(1) !== "aurora_audience_gate_test") {
  throw new Error("Audience delivery integration requires disposable local aurora_audience_gate_test database");
}

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 8 });
let ownerId = 0;
let publisherId = 0;
let authorId = 0;
let projectId = 0;

async function createInquiry(reply = "Спасибо за вопрос. Сейчас уточним детали.") {
  return Number((await pool.query<{ id: string }>(
    `insert into bot_client_inquiries (
       project_id, external_chat_id, external_message_id, incoming_text,
       suggested_reply, source_type, status
     ) values ($1, -1004442502121, 71, 'А сколько это стоит?', $2, 'comment', 'reply_ready')
     returning id`,
    [projectId, reply],
  )).rows[0].id);
}

async function deliveryState(inquiryId: number) {
  return (await pool.query<{
    status: string;
    delivery_error_code: string | null;
    version: string;
    sent_external_message_id: string | null;
  }>(
    `select status, delivery_error_code, version, sent_external_message_id
       from bot_client_inquiries where id = $1`,
    [inquiryId],
  )).rows[0];
}

beforeAll(async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });

  const users = await pool.query<{ id: string }>(
    `insert into users (email, name)
     values ('audience-owner@example.test', 'Audience Owner'),
            ('audience-publisher@example.test', 'Audience Publisher'),
            ('audience-author@example.test', 'Audience Author')
     returning id`,
  );
  [ownerId, publisherId, authorId] = users.rows.map((row) => Number(row.id));
  projectId = Number((await pool.query<{ id: string }>(
    `insert into projects (name, timezone, created_by_user_id, personal_owner_user_id)
     values ('Audience delivery gate', 'UTC', $1, $1) returning id`,
    [ownerId],
  )).rows[0].id);
  await pool.query(
    `insert into project_members (project_id, user_id, role, status)
     values ($1,$2,'owner','active'), ($1,$3,'publisher','active'), ($1,$4,'author','active')`,
    [projectId, ownerId, publisherId, authorId],
  );
  await pool.query(
    `insert into user_project_preferences (user_id, selected_project_id)
     values ($1,$4), ($2,$4), ($3,$4)`,
    [ownerId, publisherId, authorId, projectId],
  );
});

afterAll(async () => {
  await pool.end();
});

describe.sequential("audience delivery on disposable PostgreSQL", () => {
  it("linearizes concurrent sends and replays the committed request without another provider call", async () => {
    const inquiryId = await createInquiry();
    let releaseProvider = () => {};
    let markProviderStarted = () => {};
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const telegramRequest = vi.fn(async () => {
      markProviderStarted();
      await providerGate;
      return { ok: true, result: { message_id: 72 } };
    });
    const requestKey = "audience-delivery:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    const first = deliverAudienceReply({
      actorUserId: ownerId,
      inquiryId,
      expectedVersion: 1,
      requestKey,
      reply: "Спасибо за вопрос. Сейчас уточним детали.",
      pool,
      telegramRequest,
    });
    await providerStarted;
    await expect(deliverAudienceReply({
      actorUserId: ownerId,
      inquiryId,
      expectedVersion: 1,
      requestKey: "audience-delivery:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      reply: "Спасибо за вопрос. Сейчас уточним детали.",
      pool,
      telegramRequest,
    })).rejects.toMatchObject({ code: "delivery_in_progress" });
    releaseProvider();
    await expect(first).resolves.toMatchObject({ replayed: false, inquiry: { status: "sent" } });
    await expect(deliverAudienceReply({
      actorUserId: ownerId,
      inquiryId,
      expectedVersion: 1,
      requestKey,
      reply: "Спасибо за вопрос. Сейчас уточним детали.",
      pool,
      telegramRequest,
    })).resolves.toMatchObject({ replayed: true, inquiry: { status: "sent" } });
    expect(telegramRequest).toHaveBeenCalledOnce();
  });

  it("quarantines an ambiguous network outcome until a publisher resolves it explicitly", async () => {
    const inquiryId = await createInquiry("Проверяем информацию.");
    const failedKey = "audience-delivery:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await expect(deliverAudienceReply({
      actorUserId: ownerId,
      inquiryId,
      expectedVersion: 1,
      requestKey: failedKey,
      reply: "Проверяем информацию.",
      pool,
      telegramRequest: vi.fn(async () => { throw new Error("socket closed after write"); }),
    })).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(await deliveryState(inquiryId)).toMatchObject({
      status: "failed",
      delivery_error_code: "delivery_unknown",
      version: "3",
    });

    const blockedProvider = vi.fn(async () => ({ ok: true, result: { message_id: 73 } }));
    await expect(deliverAudienceReply({
      actorUserId: publisherId,
      inquiryId,
      expectedVersion: 3,
      requestKey: "audience-delivery:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      reply: "Проверяем информацию.",
      pool,
      telegramRequest: blockedProvider,
    })).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(blockedProvider).not.toHaveBeenCalled();

    await expect(updateAudienceInquiry({
      actorUserId: publisherId,
      inquiryId,
      expectedVersion: 3,
      status: "pending",
      pool,
    })).resolves.toMatchObject({ status: "pending", version: 4 });
    await expect(deliverAudienceReply({
      actorUserId: publisherId,
      inquiryId,
      expectedVersion: 4,
      requestKey: "audience-delivery:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      reply: "Проверяем информацию.",
      pool,
      telegramRequest: blockedProvider,
    })).resolves.toMatchObject({ inquiry: { status: "sent", version: 6 } });

    const actions = (await pool.query<{ action: string; code: string | null; resolution: string | null }>(
      `select action, safe_data->>'code' as code, safe_data->>'resolution' as resolution
         from audit_events where project_id = $1 and entity_id = $2::text order by id`,
      [projectId, inquiryId],
    )).rows;
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "audience.reply.delivery_failed", code: "delivery_unknown" }),
      expect.objectContaining({ action: "audience.reply.delivery_resolved", resolution: "retry" }),
      expect.objectContaining({ action: "audience.reply.sent" }),
    ]));
  });

  it("treats malformed success as unknown and recovers an abandoned lease after restart", async () => {
    const malformedId = await createInquiry();
    await expect(deliverAudienceReply({
      actorUserId: ownerId,
      inquiryId: malformedId,
      expectedVersion: 1,
      requestKey: "audience-delivery:ffffffff-ffff-4fff-8fff-ffffffffffff",
      reply: "Спасибо за вопрос. Сейчас уточним детали.",
      pool,
      telegramRequest: vi.fn(async () => ({ ok: true, result: {} })),
    })).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(await deliveryState(malformedId)).toMatchObject({
      status: "failed",
      delivery_error_code: "delivery_unknown",
    });

    const staleId = await createInquiry();
    await pool.query(
      `update bot_client_inquiries
          set status = 'approved', delivery_request_key = $2,
              provider_started_at = now() - interval '3 minutes'
        where id = $1`,
      [staleId, "audience-delivery:11111111-2222-4333-8444-555555555555"],
    );
    const recovered = await pool.query(
      AUDIENCE_STALE_ALL_DELIVERIES_SQL,
      [AUDIENCE_DELIVERY_LEASE_SECONDS, 500],
    );
    expect(recovered.rowCount).toBeGreaterThanOrEqual(1);
    expect(await deliveryState(staleId)).toMatchObject({
      status: "failed",
      delivery_error_code: "delivery_unknown",
      version: "2",
    });
  });

  it("rejects an author before any provider side effect", async () => {
    const inquiryId = await createInquiry();
    const telegramRequest = vi.fn(async () => ({ ok: true, result: { message_id: 74 } }));
    await expect(deliverAudienceReply({
      actorUserId: authorId,
      inquiryId,
      expectedVersion: 1,
      requestKey: "audience-delivery:99999999-9999-4999-8999-999999999999",
      reply: "Спасибо за вопрос. Сейчас уточним детали.",
      pool,
      telegramRequest,
    })).rejects.toMatchObject({ code: "permission_denied" });
    expect(telegramRequest).not.toHaveBeenCalled();
    expect(await deliveryState(inquiryId)).toMatchObject({ status: "reply_ready", version: "1" });
  });

  it("recovers 1,200 abandoned deliveries exactly once under concurrent worker sweeps", async () => {
    const auditBefore = Number((await pool.query<{ count: string }>(
      `select count(*) as count from audit_events
        where project_id = $1 and action = 'audience.reply.delivery_failed'
          and safe_data->>'surface' = 'worker_recovery'`,
      [projectId],
    )).rows[0].count);
    const inserted = (await pool.query<{ id: string }>(
      `insert into bot_client_inquiries (
         project_id, external_chat_id, external_message_id, incoming_text,
         suggested_reply, source_type, status, delivery_request_key, provider_started_at
       )
       select $1, -1004442502121, 100000 + item,
              'Load recovery question ' || item::text, 'Load recovery reply',
              'comment', 'approved', 'audience-load-recovery:' || item::text,
              now() - interval '3 minutes'
         from generate_series(1, 1200) item
       returning id`,
      [projectId],
    )).rows.map((row) => Number(row.id));

    const sweeps = await Promise.all(Array.from({ length: 4 }, () => pool.query<{ id: string }>(
      AUDIENCE_STALE_ALL_DELIVERIES_SQL,
      [AUDIENCE_DELIVERY_LEASE_SECONDS, 500],
    )));
    const recoveredIds = sweeps.flatMap((result) => result.rows.map((row) => Number(row.id)));

    expect(recoveredIds).toHaveLength(1200);
    expect(new Set(recoveredIds)).toEqual(new Set(inserted));
    const states = (await pool.query<{ status: string; count: string }>(
      `select status, count(*) as count from bot_client_inquiries
        where id = any($1::bigint[]) group by status`,
      [inserted],
    )).rows;
    expect(states).toEqual([{ status: "failed", count: "1200" }]);
    const auditAfter = Number((await pool.query<{ count: string }>(
      `select count(*) as count from audit_events
        where project_id = $1 and action = 'audience.reply.delivery_failed'
          and safe_data->>'surface' = 'worker_recovery'`,
      [projectId],
    )).rows[0].count);
    expect(auditAfter - auditBefore).toBe(1200);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  audienceDeliveryLeaseExpired,
  createAudienceInquiry,
  deliverAudienceReply,
  listAudienceInquiries,
  updateAudienceInquiry,
} from "./audience-assistant";

const baseRow = {
  id: 41,
  project_id: 7,
  source_type: "comment",
  source_label: "VK · пост о запуске",
  source_url: "https://example.com/post/1",
  author_name: "Анна",
  incoming_text: "А сколько это стоит?",
  context: "Комментарий под анонсом",
  suggested_reply: null,
  reply_guidance: null,
  tone: null,
  risk_level: null,
  status: "pending",
  business_connection_id: null,
  external_chat_id: null,
  external_message_id: null,
  delivery_request_key: null,
  provider_started_at: null,
  sent_external_message_id: null,
  delivery_error_code: null,
  version: 1,
  resolved_at: null,
  created_at: "2026-08-16T10:00:00.000Z",
  updated_at: "2026-08-16T10:00:00.000Z",
};

const membership = {
  project_id: 7,
  user_id: 3,
  role: "owner",
  version: 1,
};

describe("audience assistant", () => {
  it("lists a project-scoped inbox and derives actionable counters", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from user_project_preferences")) return { rows: [membership], rowCount: 1 };
      if (sql.includes("set status = 'failed', delivery_error_code = 'delivery_unknown'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("count(*) filter")) {
        return { rows: [{ waiting: "2", ready: "1", answered: "4", dismissed: "3", high_risk: "1" }], rowCount: 1 };
      }
      if (sql.includes("from bot_client_inquiries inquiry")) return { rows: [baseRow], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(listAudienceInquiries({ actorUserId: 3, db: { query } as never }))
      .resolves.toEqual({
        inquiries: [expect.objectContaining({
          id: 41,
          sourceType: "comment",
          incomingText: "А сколько это стоит?",
          canSendViaTelegram: false,
        })],
        stats: { waiting: 2, ready: 1, answered: 4, dismissed: 3, highRisk: 1 },
        capabilities: { canCreate: true, canEdit: true, canSend: true },
      });
  });

  it("creates a manual inbox item idempotently inside the selected project", async () => {
    const query = vi.fn(async (sql: string) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("from user_project_preferences")) return { rows: [membership], rowCount: 1 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("inquiry.request_key")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert into bot_client_inquiries")) return { rows: [{ id: 41 }], rowCount: 1 };
      if (sql.includes("inquiry.id = $2")) return { rows: [baseRow], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await expect(createAudienceInquiry({
      actorUserId: 3,
      requestKey: "audience-inquiry:11111111-1111-4111-8111-111111111111",
      sourceType: "comment",
      sourceLabel: "VK · пост о запуске",
      sourceUrl: "https://example.com/post/1",
      authorName: "Анна",
      incomingText: "А сколько это стоит?",
      context: "Комментарий под анонсом",
      pool: pool as never,
    })).resolves.toMatchObject({ duplicate: false, inquiry: { id: 41 } });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("insert into bot_client_inquiries"),
      expect.arrayContaining([7, "comment", "А сколько это стоит?"]),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not mark an inquiry answered without an actual reply", async () => {
    const query = vi.fn(async (sql: string) => {
      if (["begin", "rollback"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("from user_project_preferences")) return { rows: [membership], rowCount: 1 };
      if (sql.includes("inquiry.id = $2")) return { rows: [baseRow], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await expect(updateAudienceInquiry({
      actorUserId: 3,
      inquiryId: 41,
      expectedVersion: 1,
      status: "sent",
      pool: pool as never,
    })).rejects.toMatchObject({ code: "invalid_status" });
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("lets an audience sender resolve an unknown delivery without edit permission", async () => {
    const publisherMembership = { ...membership, role: "publisher" };
    const unknown = {
      ...baseRow,
      suggested_reply: "Проверяем.",
      status: "failed",
      delivery_error_code: "delivery_unknown",
    };
    const recovered = {
      ...unknown,
      status: "pending",
      delivery_request_key: null,
      provider_started_at: null,
      delivery_error_code: null,
      version: 2,
    };
    const query = vi.fn(async (sql: string) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("from user_project_preferences")) return { rows: [publisherMembership], rowCount: 1 };
      if (sql.includes("for update of inquiry")) return { rows: [unknown], rowCount: 1 };
      if (sql.includes("set status = 'pending'")) return { rows: [], rowCount: 1 };
      if (sql.includes("inquiry.id = $2")) return { rows: [recovered], rowCount: 1 };
      if (sql.includes("audience.reply.delivery_resolved")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })) };

    await expect(updateAudienceInquiry({
      actorUserId: 3,
      inquiryId: 41,
      expectedVersion: 1,
      status: "pending",
      pool: pool as never,
    })).resolves.toMatchObject({ status: "pending", deliveryErrorCode: null, canDeliverReply: true });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("delivery_request_key = null"),
      [41, 7, 1],
    );
  });

  it("expires an abandoned provider claim instead of keeping it in progress forever", async () => {
    expect(audienceDeliveryLeaseExpired("2026-08-16T10:00:00.000Z", Date.parse("2026-08-16T10:03:00.000Z")))
      .toBe(true);
    const approved = {
      ...baseRow,
      external_chat_id: "-1004442502121",
      external_message_id: "71",
      suggested_reply: "Проверяем.",
      status: "approved",
      provider_started_at: "2026-08-16T10:00:00.000Z",
    };
    const query = vi.fn(async (sql: string) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("from user_project_preferences")) return { rows: [membership], rowCount: 1 };
      if (sql.includes("for update of inquiry")) return { rows: [approved], rowCount: 1 };
      if (sql.includes("status = 'failed', delivery_error_code = 'delivery_unknown'")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })), query };
    const telegramRequest = vi.fn();

    await expect(deliverAudienceReply({
      actorUserId: 3,
      inquiryId: 41,
      expectedVersion: 1,
      requestKey: "audience-delivery:33333333-3333-4333-8333-333333333333",
      reply: "Проверяем.",
      pool: pool as never,
      telegramRequest,
    })).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(telegramRequest).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalledWith("rollback");
  });

  it("sends a captured Telegram comment as a direct reply and records delivery", async () => {
    const captured = {
      ...baseRow,
      external_chat_id: "-1004442502121",
      external_message_id: "71",
      suggested_reply: "Спасибо! Сейчас уточним детали.",
      status: "reply_ready",
    };
    const claimed = {
      ...captured,
      status: "approved",
      suggested_reply: "Спасибо за вопрос. Сейчас уточним детали.",
      delivery_request_key: "audience-delivery:11111111-1111-4111-8111-111111111111",
      version: 2,
    };
    const sent = {
      ...claimed,
      status: "sent",
      sent_external_message_id: "72",
      resolved_at: "2026-08-16T10:05:00.000Z",
      version: 3,
    };
    const query = vi.fn(async (sql: string) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("from user_project_preferences")) return { rows: [membership], rowCount: 1 };
      if (sql.includes("for update of inquiry")) return { rows: [captured], rowCount: 1 };
      if (sql.includes("returning *")) return { rows: [claimed], rowCount: 1 };
      if (sql.includes("set status = 'sent'")) return { rows: [], rowCount: 1 };
      if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
      if (sql.includes("inquiry.id = $2")) return { rows: [sent], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })), query };
    const telegramRequest = vi.fn(async () => ({ ok: true, result: { message_id: 72 } }));

    await expect(deliverAudienceReply({
      actorUserId: 3,
      inquiryId: 41,
      expectedVersion: 1,
      requestKey: "audience-delivery:11111111-1111-4111-8111-111111111111",
      reply: "Спасибо за вопрос. Сейчас уточним детали.",
      pool: pool as never,
      telegramRequest,
    })).resolves.toMatchObject({ inquiry: { status: "sent", version: 3 }, replayed: false });
    expect(telegramRequest).toHaveBeenCalledWith("sendMessage", {
      chat_id: -1004442502121,
      text: "Спасибо за вопрос. Сейчас уточним детали.",
      reply_parameters: { message_id: 71, allow_sending_without_reply: false },
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("audience.reply.sent"))).toBe(true);
  });

  it("fails closed when Telegram delivery may have happened", async () => {
    const captured = {
      ...baseRow,
      external_chat_id: "-1004442502121",
      external_message_id: "71",
      status: "reply_ready",
    };
    const claimed = {
      ...captured,
      status: "approved",
      delivery_request_key: "audience-delivery:22222222-2222-4222-8222-222222222222",
      version: 2,
    };
    const query = vi.fn(async (sql: string) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("from user_project_preferences")) return { rows: [membership], rowCount: 1 };
      if (sql.includes("for update of inquiry")) return { rows: [captured], rowCount: 1 };
      if (sql.includes("returning *")) return { rows: [claimed], rowCount: 1 };
      if (sql.includes("delivery_error_code = $4")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })), query };

    await expect(deliverAudienceReply({
      actorUserId: 3,
      inquiryId: 41,
      expectedVersion: 1,
      requestKey: "audience-delivery:22222222-2222-4222-8222-222222222222",
      reply: "Проверяем.",
      pool: pool as never,
      telegramRequest: vi.fn(async () => { throw new Error("timeout"); }),
    })).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("delivery_error_code = $4"),
      [41, 7, "audience-delivery:22222222-2222-4222-8222-222222222222", "delivery_unknown", 3, "web"],
    );
  });

  it("treats a malformed Telegram success as unknown instead of retryable rejection", async () => {
    const captured = {
      ...baseRow,
      external_chat_id: "-1004442502121",
      external_message_id: "71",
      status: "reply_ready",
    };
    const claimed = {
      ...captured,
      status: "approved",
      delivery_request_key: "audience-delivery:44444444-4444-4444-8444-444444444444",
      version: 2,
    };
    const query = vi.fn(async (sql: string) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("from user_project_preferences")) return { rows: [membership], rowCount: 1 };
      if (sql.includes("for update of inquiry")) return { rows: [captured], rowCount: 1 };
      if (sql.includes("returning *")) return { rows: [claimed], rowCount: 1 };
      if (sql.includes("delivery_error_code = $4")) return { rows: [{ version: 3 }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })), query };

    await expect(deliverAudienceReply({
      actorUserId: 3,
      inquiryId: 41,
      expectedVersion: 1,
      requestKey: "audience-delivery:44444444-4444-4444-8444-444444444444",
      reply: "Проверяем.",
      pool: pool as never,
      telegramRequest: vi.fn(async () => ({ ok: true, result: {} })),
    })).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("audience.reply.delivery_failed"),
      [41, 7, "audience-delivery:44444444-4444-4444-8444-444444444444", "delivery_unknown", 3, "web"],
    );
  });
});

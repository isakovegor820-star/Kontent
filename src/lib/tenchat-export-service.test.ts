import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createTenChatExportForProject,
} from "./tenchat-export-service";

describe("TenChat project-scoped export service", () => {
  it("builds a manual package from exact text and project-owned media", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from draft_revisions")) return { rows: [{ id: 501, content_hash: "a".repeat(64) }] };
      if (sql.includes("from projects")) return { rows: [{ name: "Право и технологии" }] };
      if (sql.includes("insert into audit_events")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const data = Buffer.from("checked-image", "utf8");
    const loadAsset = vi.fn().mockResolvedValue({
      file_name: "card.png",
      mime_type: "image/png",
      data,
    });
    const result = await createTenChatExportForProject({
      pool: { query } as never,
      projectId: 71,
      actorUserId: 9,
      requestId: "tenchat-export-request",
      body: {
        text: "Пять пунктов для проверки договора",
        scheduledAt: "2026-08-13T09:00:00.000Z",
        assetIds: [14],
        draftId: 81,
        draftVersion: 3,
      },
      exportedAt: new Date("2026-08-12T10:00:00.000Z"),
      loadAsset,
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("where id = $1"), [71]);
    expect(loadAsset).toHaveBeenCalledWith(expect.objectContaining({
      assetId: 14,
      projectId: 71,
    }));
    expect(result.manifest).toMatchObject({
      provider: "tenchat",
      mode: "export_only",
      livePublishing: false,
      manualPublishRequired: true,
      projectName: "Право и технологии",
      assets: [{ sha256: createHash("sha256").update(data).digest("hex") }],
    });
    expect(result.bytes.includes(Buffer.from("Пять пунктов для проверки договора"))).toBe(true);
    const auditCall = query.mock.calls.find(([sql]) => sql.includes("insert into audit_events"));
    const auditParams = (auditCall as unknown as [string, unknown[]] | undefined)?.[1];
    expect(auditParams?.slice(0, 4)).toEqual([71, 9, "501", 3]);
    expect(JSON.parse(String(auditParams?.[4]))).toMatchObject({
      draftId: 81,
      draftVersion: 3,
      contentHash: "a".repeat(64),
      exportedTextSha256: createHash("sha256")
        .update("Пять пунктов для проверки договора", "utf8")
        .digest("hex"),
      packageSha256: result.sha256,
      mode: "export_only",
    });
  });

  it("accepts only project asset ids, not caller-supplied URLs or binary payloads", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: "Проект" }] });
    await expect(createTenChatExportForProject({
      pool: { query } as never,
      projectId: 71,
      actorUserId: 9,
      body: { text: "Пост", assetIds: [3, 3], draftId: 81, draftVersion: 3, assetUrl: "https://evil.example/x" } as never,
    })).rejects.toMatchObject({ code: "tenchat_export_request_invalid", status: 400 });
    expect(query).not.toHaveBeenCalled();
  });

  it("does not accept a missing cross-project asset", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("from draft_revisions")
        ? [{ id: 501, content_hash: "a".repeat(64) }]
        : [{ name: "Проект" }],
    }));
    await expect(createTenChatExportForProject({
      pool: { query } as never,
      projectId: 71,
      actorUserId: 9,
      body: { text: "Пост", assetIds: [99], draftId: 81, draftVersion: 3 },
      loadAsset: vi.fn().mockResolvedValue(null),
    })).rejects.toMatchObject({
      code: "tenchat_asset_not_found",
      status: 404,
    });
  });

  it("fails closed when the exact project draft revision does not exist", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(createTenChatExportForProject({
      pool: { query } as never,
      projectId: 71,
      actorUserId: 9,
      body: { text: "Пост", assetIds: [], draftId: 81, draftVersion: 4 },
    })).rejects.toMatchObject({ code: "tenchat_draft_revision_not_found", status: 409 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("revision.draft_version = $3"), [71, 81, 4]);
  });
});

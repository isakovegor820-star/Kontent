import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { migrate } from "../../scripts/migrate.mjs";
import { ensureDefaultPersonalProject } from "@/lib/project-context";
import {
  configureProjectTracking,
  createProjectShortLink,
  getProjectTrackingReport,
  getRedirectTarget,
  markTrackerPing,
  recordConversionEvent,
  recordTrackedClick,
  revokeProjectShortLink,
  verifyProjectTrackingSite,
} from "@/lib/tracking-service";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const target = databaseUrl ? new URL(databaseUrl) : null;
if (
  !target
  || !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
  || target.pathname.slice(1) !== "aurora_tracking_gate_test"
) {
  throw new Error("Tracking integration requires disposable local aurora_tracking_gate_test database");
}

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 8 });
const attributionSecret = "tracking-integration-attribution-secret-00000001";
const fingerprintSecret = "tracking-integration-fingerprint-secret-00000002";

beforeAll(async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
});

afterAll(async () => pool.end());

describe("tracking lifecycle with exact publication placement", () => {
  it("creates → redirects → deduplicates conversion → reports one post and isolates another project", async () => {
    const now = new Date();
    const ownerId = Number((await pool.query(
      "insert into users (email, name) values ($1, $2) returning id",
      ["tracking-owner@example.test", "Tracking owner"],
    )).rows[0].id);
    const outsiderId = Number((await pool.query(
      "insert into users (email, name) values ($1, $2) returning id",
      ["tracking-outsider@example.test", "Tracking outsider"],
    )).rows[0].id);
    const projectId = await ensureDefaultPersonalProject(pool, ownerId);
    await ensureDefaultPersonalProject(pool, outsiderId);

    const settings = await configureProjectTracking({
      pool,
      actorUserId: ownerId,
      siteOrigin: "https://law.example.ru",
      attributionWindowDays: 30,
      expectedVersion: 0,
    });
    const signal = await markTrackerPing(pool, {
      publicKey: settings.publicKey,
      requestOrigin: "https://law.example.ru",
      now,
    });
    expect(signal.status).toBe("pending_verification");
    const verified = await verifyProjectTrackingSite({
      pool,
      actorUserId: ownerId,
      expectedVersion: settings.version,
      verifyChallenge: async ({ siteOrigin, challenge }) => {
        expect(siteOrigin).toBe("https://law.example.ru");
        expect(challenge).toBe(settings.verificationFileContent);
        return true;
      },
      now,
    });
    expect(verified).toMatchObject({ verified: true, tracking: { status: "active" } });
    const link = await createProjectShortLink({
      pool,
      actorUserId: ownerId,
      destination: "https://law.example.ru/consultation",
      utmValues: { utm_source: "telegram", utm_campaign: "bankruptcy_august" },
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      idempotencyKey: "tracking:integration:link:01",
      now,
    });

    const channelId = Number((await pool.query(
      `insert into channels (project_id, user_id, network, title, handle, is_active)
       values ($1, $2, 'tg', 'Tracking channel', 'tracking_channel', true) returning id`,
      [projectId, ownerId],
    )).rows[0].id);

    const posts: number[] = [];
    const placementSlugs = ["placementtrackingpost0001", "placementtrackingpost0002"];
    for (let index = 0; index < placementSlugs.length; index += 1) {
      const operationId = Number((await pool.query(
        `insert into publication_operations
           (project_id, user_id, draft_version, idempotency_key, fingerprint, text,
            scheduled_at, destination_ids, options, status)
         values ($1, $2, 1, $3, $4, 'Post', $5, $6::jsonb, '{}'::jsonb, 'published')
         returning id`,
        [
          projectId,
          ownerId,
          `tracking-placement-operation-${index}`,
          String(index + 1).repeat(64),
          now,
          JSON.stringify([channelId]),
        ],
      )).rows[0].id);
      const postId = Number((await pool.query(
        `insert into posts
           (project_id, user_id, channel_id, text, scheduled_at, status,
            publication_operation_id, publication_draft_version)
         values ($1, $2, $3, 'Post', $4, 'published', $5, 1)
         returning id`,
        [projectId, ownerId, channelId, now, operationId],
      )).rows[0].id);
      posts.push(postId);
      const placementId = Number((await pool.query(
        `insert into short_link_placements
           (project_id, short_link_id, publication_operation_id, post_id, slug)
         values ($1, $2, $3, $4, $5) returning id`,
        [projectId, link.id, operationId, postId, placementSlugs[index]],
      )).rows[0].id);
      await pool.query(
        `insert into publication_tracking_snapshots
           (project_id, publication_operation_id, post_id, short_link_id,
            short_link_placement_id, placement, destination_url, short_url_path,
            utm_values, snapshot_hash)
         values ($1, $2, $3, $4, $5, 'cta', $6, $7, $8::jsonb, $9)`,
        [
          projectId,
          operationId,
          postId,
          link.id,
          placementId,
          link.destinationUrl,
          `/r/${placementSlugs[index]}`,
          JSON.stringify(link.utmValues),
          String(index + 3).repeat(64),
        ],
      );
    }

    const firstTarget = await getRedirectTarget(pool, placementSlugs[0], now);
    const firstClick = await recordTrackedClick({
      pool,
      target: firstTarget,
      ip: "203.0.113.10",
      userAgent: "Mozilla/5.0 Safari/605.1.15",
      referrer: "https://t.me/tracking_channel",
      attributionSecret,
      fingerprintSecret,
      now,
    });
    await recordTrackedClick({
      pool,
      target: await getRedirectTarget(pool, placementSlugs[1], now),
      ip: "203.0.113.10",
      userAgent: "Mozilla/5.0 Safari/605.1.15",
      referrer: "https://t.me/tracking_channel",
      attributionSecret,
      fingerprintSecret,
      now,
    });
    expect(firstClick.token).toBeTruthy();
    const conversionInput = {
      pool,
      publicKey: settings.publicKey,
      token: firstClick.token,
      idempotencyKey: "conversion:tracking:integration:01",
      eventType: "form_submit",
      requestOrigin: "https://law.example.ru",
      attributionSecret,
      occurredAt: now,
      now,
    };
    expect((await recordConversionEvent(conversionInput)).duplicate).toBe(false);
    expect((await recordConversionEvent(conversionInput)).duplicate).toBe(true);

    const report = await getProjectTrackingReport(pool, {
      actorUserId: ownerId,
      from: new Date(now.getTime() - 60_000),
      to: new Date(now.getTime() + 60_000),
    });
    const firstPost = report.rows.find((row) => row.postId === posts[0]);
    const secondPost = report.rows.find((row) => row.postId === posts[1]);
    expect(firstPost).toMatchObject({ totalClicks: 1, uniqueClicks: 1, confirmedConversions: 1 });
    expect(secondPost).toMatchObject({ totalClicks: 1, uniqueClicks: 1, confirmedConversions: 0 });
    expect(report.rows.filter((row) => row.confirmedConversions === 1)).toHaveLength(1);
    expect((await getProjectTrackingReport(pool, {
      actorUserId: outsiderId,
      from: new Date(now.getTime() - 60_000),
      to: new Date(now.getTime() + 60_000),
    })).rows).toEqual([]);
    await expect(revokeProjectShortLink({
      pool,
      actorUserId: outsiderId,
      linkId: link.id,
      expectedVersion: link.version,
    })).rejects.toMatchObject({ code: "not_found" });

    await revokeProjectShortLink({
      pool,
      actorUserId: ownerId,
      linkId: link.id,
      expectedVersion: link.version,
    });
    await expect(getRedirectTarget(pool, placementSlugs[0], now)).rejects.toMatchObject({
      code: "link_unavailable",
    });
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("./project-permissions", () => ({
  requireSelectedProjectPermission: vi.fn(async () => ({
    projectId: 7,
    userId: 11,
    role: "owner",
    version: 1,
  })),
}));

import { signAttribution } from "./tracked-links";
import {
  createProjectShortLink,
  getProjectTrackingReport,
  getRedirectTarget,
  isPublicTrackerAddress,
  markTrackerPing,
  normalizeTrackerOrigin,
  recordConversionEvent,
  recordTrackedClick,
  revokeProjectShortLink,
  TrackingServiceError,
  verifyProjectTrackingSite,
  verifyTrackerChallengeFile,
} from "./tracking-service";

const FINGERPRINT_SECRET = "fingerprint-secret-longer-than-thirty-two-bytes";
const ATTRIBUTION_SECRET = "attribution-secret-longer-than-thirty-two-bytes";

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number };

function transactionPool(handler: (sql: string, params: unknown[]) => QueryResult | Promise<QueryResult>) {
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      return handler(sql, params);
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) }, client };
}

describe("tracking service", () => {
  it("normalizes an exact public tracker origin and gates local origins by environment", () => {
    expect(normalizeTrackerOrigin("https://law.example.ru/", false)).toBe("https://law.example.ru");
    expect(() => normalizeTrackerOrigin("https://law.example.ru/form", false)).toThrow("invalid_origin");
    expect(() => normalizeTrackerOrigin("http://localhost:3001/", false)).toThrow("invalid_origin");
    expect(normalizeTrackerOrigin("http://localhost:3001/", true)).toBe("http://localhost:3001");
  });

  it("rejects private, loopback, link-local and documentation addresses for server verification", () => {
    for (const address of [
      "127.0.0.1", "10.0.0.1", "169.254.1.1", "172.20.1.1", "192.168.1.1",
      "100.64.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fe80::1",
      "fc00::1", "2001:db8::1", "::ffff:127.0.0.1",
    ]) expect(isPublicTrackerAddress(address), address).toBe(false);
    expect(isPublicTrackerAddress("93.184.216.34")).toBe(true);
    expect(isPublicTrackerAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("pins verification to resolved public addresses and rejects redirect escape or mismatch", async () => {
    const challenge = "aurora-site-verification=abcdefghijklmnopqrstuvwxyzABCDEFG";
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const fetchPinned = vi.fn(async () => ({ status: 200, location: null, body: challenge }));
    await expect(verifyTrackerChallengeFile({
      siteOrigin: "https://law.example.ru",
      challenge,
      resolve,
      fetchPinned,
    })).resolves.toBe(true);
    expect(fetchPinned).toHaveBeenCalledWith(expect.objectContaining({
      url: new URL("https://law.example.ru/.well-known/aurora-tracker-verification.txt"),
      addresses: [{ address: "93.184.216.34", family: 4 }],
    }));

    await expect(verifyTrackerChallengeFile({
      siteOrigin: "https://law.example.ru",
      challenge,
      resolve: vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]),
      fetchPinned,
    })).rejects.toMatchObject({ code: "verification_unavailable" });
    await expect(verifyTrackerChallengeFile({
      siteOrigin: "https://law.example.ru",
      challenge,
      resolve,
      fetchPinned: vi.fn(async () => ({ status: 302, location: "https://internal.example/secret", body: "" })),
    })).rejects.toMatchObject({ code: "verification_unavailable" });
    await expect(verifyTrackerChallengeFile({
      siteOrigin: "https://law.example.ru",
      challenge,
      resolve,
      fetchPinned: vi.fn(async () => ({ status: 200, location: null, body: `${challenge}\n` })),
    })).rejects.toMatchObject({ code: "verification_unavailable" });
  });

  it("records a public browser signal without promoting tracking to active", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        void sql;
        return { rows: [{
        status: "pending_verification",
        site_origin: "https://law.example.ru",
        public_key: "tracker_public_key_1234567890",
        attribution_window_days: 30,
        version: 2,
        verified_at: null,
        last_ping_at: "2026-08-12T10:00:00.000Z",
        signal_received_at: "2026-08-12T10:00:00.000Z",
        verification_checked_at: null,
        verification_error_code: null,
        verification_challenge: "aurora-site-verification=abcdefghijklmnopqrstuvwxyzABCDEFG",
        }] };
      }),
    };
    const result = await markTrackerPing(db as never, {
      publicKey: "tracker_public_key_1234567890",
      requestOrigin: "https://law.example.ru",
      now: new Date("2026-08-12T10:00:00.000Z"),
    });
    expect(result.status).toBe("pending_verification");
    expect(db.query.mock.calls[0]?.[0]).not.toContain("status = 'active'");
    expect(db.query.mock.calls[0]?.[0]).toContain("signal_received_at");
  });

  it("activates only after authenticated exact challenge verification and audits the result", async () => {
    const before = {
      status: "pending_verification",
      site_origin: "https://law.example.ru",
      public_key: "tracker_public_key_1234567890",
      attribution_window_days: 30,
      version: 2,
      verified_at: null,
      last_ping_at: null,
      signal_received_at: null,
      verification_checked_at: null,
      verification_error_code: null,
      verification_challenge: "aurora-site-verification=abcdefghijklmnopqrstuvwxyzABCDEFG",
    };
    const { pool, client } = transactionPool((sql) => {
      if (sql.includes("select version, site_origin, verification_challenge")) {
        return { rows: [{ version: 2, site_origin: before.site_origin, verification_challenge: before.verification_challenge }] };
      }
      if (sql.startsWith("update project_tracking_settings")) {
        return { rows: [{
          ...before,
          status: "active",
          version: 3,
          verified_at: "2026-08-12T10:00:00.000Z",
          verification_checked_at: "2026-08-12T10:00:00.000Z",
        }] };
      }
      if (sql.startsWith("insert into audit_events")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from project_tracking_settings")) return { rows: [before] };
      throw new Error(`unexpected outer SQL: ${sql}`);
    });
    const verifyChallenge = vi.fn(async () => true);
    const result = await verifyProjectTrackingSite({
      pool: { ...pool, query } as never,
      actorUserId: 11,
      expectedVersion: 2,
      verifyChallenge,
      now: new Date("2026-08-12T10:00:00.000Z"),
    });
    expect(result.verified).toBe(true);
    expect(result.tracking.status).toBe("active");
    expect(verifyChallenge).toHaveBeenCalledWith({
      siteOrigin: before.site_origin,
      challenge: before.verification_challenge,
    });
    expect(client.query.mock.calls.some(([sql, params]) =>
      String(sql).includes("insert into audit_events") && params?.[2] === "tracking.site.verified"
    )).toBe(true);
  });

  it("creates one idempotent project link and rejects reuse with another payload", async () => {
    const stored: Record<string, unknown>[] = [];
    const { pool, client } = transactionPool((sql, params) => {
      if (sql.includes("from project_members member")) {
        return { rows: [{ project_id: 7, user_id: 11, role: "owner", version: 1 }] };
      }
      if (sql.includes("from short_links") && sql.includes("request_key")) {
        return { rows: stored };
      }
      if (sql.startsWith("insert into short_links")) {
        const row = {
          id: 41,
          slug: params[5],
          destination_url: params[6],
          utm_values: JSON.parse(String(params[8])),
          template_id: params[4],
          status: "active",
          version: 1,
          expires_at: null,
          created_at: "2026-08-11T00:00:00.000Z",
          request_hash: params[3],
        };
        stored.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith("insert into audit_events")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const first = await createProjectShortLink({
      pool: pool as never,
      actorUserId: 11,
      destination: "https://law.example.ru/form",
      utmValues: { utm_source: "telegram", utm_campaign: "Август" },
      idempotencyKey: "link:create:001",
      now: new Date("2026-08-11T00:00:00.000Z"),
    });
    const replay = await createProjectShortLink({
      pool: pool as never,
      actorUserId: 11,
      destination: "https://law.example.ru/form",
      utmValues: { utm_source: "telegram", utm_campaign: "Август" },
      idempotencyKey: "link:create:001",
      now: new Date("2026-08-11T00:00:00.000Z"),
    });
    expect(replay).toEqual(first);
    expect(stored).toHaveLength(1);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("pg_advisory_xact_lock"))).toBe(true);

    await expect(createProjectShortLink({
      pool: pool as never,
      actorUserId: 11,
      destination: "https://law.example.ru/another",
      utmValues: { utm_source: "telegram" },
      idempotencyKey: "link:create:001",
      now: new Date("2026-08-11T00:00:00.000Z"),
    })).rejects.toMatchObject({ code: "idempotency_conflict" } satisfies Partial<TrackingServiceError>);
  });

  it("records every human click and computes uniqueness within the exact publication placement", async () => {
    const uniqueVisitors = new Set<string>();
    const clicks: Record<string, unknown>[] = [];
    const { pool } = transactionPool((sql, params) => {
      if (sql.startsWith("insert into short_link_unique_visitors")) {
        const key = String(params[2]);
        if (uniqueVisitors.has(key)) return { rows: [] };
        uniqueVisitors.add(key);
        return { rows: [{ dedupe_key: key }] };
      }
      if (sql.startsWith("update short_link_unique_visitors")) return { rows: [] };
      if (sql.startsWith("insert into short_link_clicks")) {
        clicks.push({ id: params[0], placement_id: params[3], is_unique: params[6], bot: params[7] });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const target = {
      linkId: 41,
      placementId: null,
      projectId: 7,
      destinationUrl: "https://law.example.ru/form?utm_source=telegram",
      attributionWindowDays: 30,
    };
    const base = {
      pool: pool as never,
      target,
      ip: "203.0.113.20",
      userAgent: "Mozilla/5.0 Safari/605.1.15",
      referrer: "https://t.me/example",
      fingerprintSecret: FINGERPRINT_SECRET,
      attributionSecret: ATTRIBUTION_SECRET,
      now: new Date("2026-08-11T12:00:00.000Z"),
    };
    const first = await recordTrackedClick(base);
    const second = await recordTrackedClick(base);
    const firstPlacement = await recordTrackedClick({
      ...base,
      target: { ...target, placementId: 71 },
    });
    const secondPlacement = await recordTrackedClick({
      ...base,
      target: { ...target, placementId: 72 },
    });
    expect(first.isUnique).toBe(true);
    expect(second.isUnique).toBe(false);
    expect(firstPlacement.isUnique).toBe(true);
    expect(secondPlacement.isUnique).toBe(true);
    expect(clicks).toHaveLength(4);
    expect(clicks.map((click) => click.is_unique)).toEqual([true, false, true, true]);
    expect(clicks.map((click) => click.placement_id)).toEqual([null, null, 71, 72]);
    expect(first.token).toBeTruthy();
  });

  it("resolves an opaque publication placement and rejects an expired reusable link", async () => {
    const activeDb = {
      query: vi.fn(async () => ({ rows: [{
        id: 41,
        placement_id: 71,
        project_id: 7,
        destination_url: "https://law.example.ru/form?utm_source=telegram",
        status: "active",
        expires_at: "2026-09-01T00:00:00.000Z",
        attribution_window_days: 30,
      }] })),
    };
    await expect(getRedirectTarget(
      activeDb as never,
      "placementtrackingpost0001",
      new Date("2026-08-11T00:00:00.000Z"),
    )).resolves.toEqual({
      linkId: 41,
      placementId: 71,
      projectId: 7,
      destinationUrl: "https://law.example.ru/form?utm_source=telegram",
      attributionWindowDays: 30,
    });
    expect(activeDb.query).toHaveBeenCalledWith(expect.stringContaining("placement.slug = $1"), [
      "placementtrackingpost0001",
    ]);

    const expiredDb = {
      query: vi.fn(async () => ({ rows: [{
        id: 41,
        placement_id: 71,
        project_id: 7,
        destination_url: "https://law.example.ru/form",
        status: "active",
        expires_at: "2026-08-11T00:00:00.000Z",
        attribution_window_days: 30,
      }] })),
    };
    await expect(getRedirectTarget(
      expiredDb as never,
      "placementtrackingpost0001",
      new Date("2026-08-11T00:00:00.000Z"),
    )).rejects.toMatchObject({ code: "link_unavailable" });

    const ambiguousDb = {
      query: vi.fn(async () => ({ rows: [
        { id: 41, placement_id: 71 },
        { id: 42, placement_id: null },
      ] })),
    };
    await expect(getRedirectTarget(
      ambiguousDb as never,
      "placementtrackingpost0001",
      new Date("2026-08-11T00:00:00.000Z"),
    )).rejects.toMatchObject({ code: "not_found" });
  });

  it("revokes one project-owned link with optimistic concurrency", async () => {
    const { pool, client } = transactionPool((sql, params) => {
      if (sql.startsWith("update short_links")) {
        expect(params).toEqual([41, 7, 3]);
        return { rows: [{ id: 41, version: 4 }] };
      }
      if (sql.startsWith("insert into audit_events")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(revokeProjectShortLink({
      pool: pool as never,
      actorUserId: 11,
      linkId: 41,
      expectedVersion: 3,
      requestId: "tracking-revoke-request",
    })).resolves.toEqual({ id: 41, status: "revoked", version: 4 });
    expect(client.query).toHaveBeenCalledWith("commit");
  });

  it("reports reused links as mutually exclusive publication placements", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from project_tracking_settings")) return { rows: [] };
        if (sql.includes("with scopes as")) {
          expect(sql).toContain("tracking.short_link_placement_id = scope.placement_id");
          expect(sql).toContain("coalesce(placement.slug, link.slug) as slug");
          expect(sql).toContain("click.id = conversion.click_id");
          expect(sql).toContain("clicks.placement_id is not distinct from scope.placement_id");
          expect(sql).toContain("where scope.placement_id is not null");
          return { rows: [
            {
              link_id: 41,
              slug: "placement_for_post_101",
              utm_values: { utm_campaign: "august" },
              post_id: 101,
              channel_id: 9,
              channel_title: "Первый канал",
              total_clicks: 3,
              unique_clicks: 2,
              confirmed_conversions: 1,
              form_opens: 0,
              form_submits: 1,
              consultations: 0,
            },
            {
              link_id: 41,
              slug: "placement_for_post_102",
              utm_values: { utm_campaign: "august" },
              post_id: 102,
              channel_id: 10,
              channel_title: "Второй канал",
              total_clicks: 4,
              unique_clicks: 3,
              confirmed_conversions: 0,
              form_opens: 0,
              form_submits: 0,
              consultations: 0,
            },
          ] };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };
    const report = await getProjectTrackingReport(db as never, {
      actorUserId: 11,
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-12T00:00:00.000Z"),
    });
    expect(report.rows.map((row) => ({
      postId: row.postId,
      slug: row.slug,
      clicks: row.totalClicks,
      conversions: row.confirmedConversions,
    }))).toEqual([
      { postId: 101, slug: "placement_for_post_101", clicks: 3, conversions: 1 },
      { postId: 102, slug: "placement_for_post_102", clicks: 4, conversions: 0 },
    ]);
    expect(report.rows.reduce((sum, row) => sum + row.totalClicks, 0)).toBe(7);
  });

  it("stores one confirmed conversion for a repeated idempotency key", async () => {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const clickId = "4ed75278-cf46-4bab-96a2-73d027a0f770";
    const token = signAttribution({ shortLinkId: 41, clickId }, ATTRIBUTION_SECRET, {
      now: Math.floor(now.getTime() / 1_000),
      ttlSeconds: 3_600,
    });
    const stored: Record<string, unknown>[] = [];
    const { pool } = transactionPool((sql, params) => {
      if (sql.includes("from short_link_clicks click")) {
        return { rows: [{
          project_id: 7,
          short_link_id: 41,
          is_likely_bot: false,
          tracker_status: "active",
          site_origin: "https://law.example.ru",
          public_key: "tracker_public_key_1234567890",
        }] };
      }
      if (sql.includes("from conversion_events") && sql.includes("idempotency_hash")) {
        return { rows: stored };
      }
      if (sql.startsWith("insert into conversion_events")) {
        const row = {
          id: "3c146330-9da9-4946-a690-4c811d429ac9",
          event_type: params[3],
          occurred_at: params[7],
          received_at: now,
          request_hash: params[5],
        };
        stored.push(row);
        return { rows: [row] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const input = {
      pool: pool as never,
      publicKey: "tracker_public_key_1234567890",
      token,
      idempotencyKey: "conversion:form:001",
      eventType: "form_submit",
      requestOrigin: "https://law.example.ru",
      attributionSecret: ATTRIBUTION_SECRET,
      now,
    };
    expect((await recordConversionEvent(input)).duplicate).toBe(false);
    expect((await recordConversionEvent(input)).duplicate).toBe(true);
    expect(stored).toHaveLength(1);
  });
});

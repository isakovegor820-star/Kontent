import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ getPool: vi.fn(), getSessionUser: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/queue", async (importOriginal) => ({ ...(await importOriginal<object>()), getStatsQueue: () => null }));
import { PUT as saveProfile } from "@/app/api/knowledge/extract-profile/route";
import { POST as generate } from "@/app/api/ai/generate/route";
import { POST as ack } from "@/app/api/ai/generate/ack/route";
import { migrate } from "../../scripts/migrate.mjs";
import { acknowledgeAiUsageResult, acquireAiUsageRequest, aiRequestFingerprint, channelAiContextFor, lookupAiUsageRequest, stageAiUsageResult } from "@/lib/ai-usage";
import { acknowledgeGenerationArtifact, beginGenerationOperation, failGenerationOperation, lookupTerminalGenerationFailure, resolveGenerationDraft, stageGenerationArtifact } from "@/lib/generation-artifacts";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const target = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "::1"].includes(target.hostname) || target.pathname !== "/aurora_s03_test") {
  throw new Error("AI authorization integration requires disposable local aurora_s03_test");
}
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 8 });
let connector = 0;
let author = 0;
let project = 0;
let channel = 0;
const validation = {
  version: 1 as const, status: "passed" as const, requiresReview: false, blockerCodes: [],
  provenance: { validatorVersion: "fact-ledger-v1", ledgerHash: "fl1-1234abcd", checkedAt: "2026-09-05T10:00:00.000Z", coverage: "deterministic+semantic" as const, semanticEntailment: "passed" as const, rulesRun: ["unsupported_claim"], sourceIds: ["source:1"] },
};
async function operation(userId: number) {
  const serverRequestId = randomUUID();
  const key = `web:${serverRequestId}`;
  const fingerprint = aiRequestFingerprint({ channel });
  const usage = await acquireAiUsageRequest(userId, "write", { reservationKey: key, fingerprint, operationId: serverRequestId }, pool);
  const input = { userId, aiUsageId: usage.reservationId!, requestKey: key, serverRequestId, requestFingerprint: fingerprint, channelId: channel, providerEngine: "fake", providerModel: "fake" };
  return { key, fingerprint, serverRequestId, usage, input };
}
async function prepared(userId: number) {
  const op = await operation(userId);
  await beginGenerationOperation(op.input, pool);
  const artifact = await stageGenerationArtifact({ userId, serverRequestId: op.serverRequestId, text: "S03_RESULT", validation, providerResult: {} }, pool);
  await stageAiUsageResult(userId, op.usage.reservationId, op.serverRequestId, { protocol: "ndjson", text: artifact.text, pipeline: "single", requestedEngine: "fake", engine: "fake", fallbackUsed: false, generationResultId: artifact.id }, pool);
  return { ...op, artifact };
}
async function revoke(userId: number) {
  await pool.query("update project_members set status = 'revoked', revoked_at = now(), version = version + 1 where project_id = $1 and user_id = $2", [project, userId]);
}
beforeAll(async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  [connector, author] = (await pool.query("insert into users (email,name) values ('s03-connector@example.test','connector'),('s03-author@example.test','author') returning id")).rows.map(r => Number(r.id));
  project = Number((await pool.query("insert into projects (name,created_by_user_id) values ('S03',$1) returning id", [connector])).rows[0].id);
  channel = Number((await pool.query("insert into channels (user_id,project_id,network,tg_chat_id,title) values ($1,$2,'tg',-100930003,'S03') returning id", [connector,project])).rows[0].id);
  await pool.query("insert into project_members (project_id,user_id,role) values ($1,$2,'owner'),($1,$3,'author')", [project,connector,author]);
  await pool.query("insert into user_project_preferences (user_id,selected_project_id) values ($1,$3),($2,$3)", [connector,author,project]);
});
beforeEach(async () => {
  mocks.getPool.mockReturnValue(pool);
  mocks.getSessionUser.mockResolvedValue({ id: connector });
  await pool.query("update projects set is_archived = false where id = $1", [project]);
  await pool.query("update project_members set status = 'active', revoked_at = null, role = case when user_id = $2 then 'owner' else 'author' end where project_id = $1", [project,connector]);
});
afterAll(async () => { await pool.end(); });

describe.sequential("S03 current project permission applies to every AI boundary", () => {
  it("lets the actual author replace the shared profile without retaining a contradictory connector copy", async () => {
    await pool.query("delete from knowledge_sources where channel_id=$1 and kind in ('profile','profile_edit')", [channel]);
    await pool.query("insert into knowledge_sources(user_id,channel_id,kind,title,raw_text) values($1,$2,'profile','Old','OLD_PROFILE')", [connector,channel]);
    mocks.getSessionUser.mockResolvedValue({id:author});
    const response=await saveProfile(new NextRequest("http://localhost/api/knowledge/extract-profile",{method:"PUT",headers:{origin:"http://localhost","content-type":"application/json"},body:JSON.stringify({channelId:channel,profile:{niche:"NEW_PROFILE"}})}));
    expect(response.status).toBe(200);
    const rows=(await pool.query("select user_id,raw_text from knowledge_sources where channel_id=$1 and kind in ('profile','profile_edit')",[channel])).rows;
    expect(rows).toHaveLength(1);expect(rows[0].raw_text).toContain("NEW_PROFILE");expect(Number(rows[0].user_id)).toBe(author);
  });
  it("refuses profile persistence if revocation wins after route admission", async () => {
    const originalConnect=pool.connect.bind(pool);
    let intercepted=false;
    const scopedPool={query:pool.query.bind(pool),connect:async()=> {
      if(!intercepted){intercepted=true;await revoke(connector);}
      return originalConnect();
    }};
    mocks.getPool.mockReturnValue(scopedPool);
    const response=await saveProfile(new NextRequest("http://localhost/api/knowledge/extract-profile",{method:"PUT",headers:{origin:"http://localhost","content-type":"application/json"},body:JSON.stringify({channelId:channel,profile:{niche:"AFTER_REVOKE_PROFILE"}})}));
    expect(intercepted).toBe(true);expect(response.status).toBe(403);
    expect((await pool.query("select count(*)::int n from knowledge_sources where channel_id=$1 and raw_text like '%AFTER_REVOKE_PROFILE%'",[channel])).rows[0].n).toBe(0);
  });
  it("lets an active author use the channel connected by another member and start generation", async () => {
    expect(await channelAiContextFor(author, channel, 10, pool)).toMatchObject({ id: channel });
    const op = await operation(author);
    expect(await beginGenerationOperation(op.input, pool)).toBeGreaterThan(0);
  });
  it("denies fresh context canary and new operations after historical connector is revoked", async () => {
    await revoke(connector);
    await pool.query("insert into project_brand_dictionary_entries (project_id,kind,term,created_by_user_id,updated_by_user_id) values ($1,'allowed',$2,$3,$3)", [project,`S03_CANARY_${randomUUID()}`,author]);
    expect(await channelAiContextFor(connector, channel, 10, pool)).toBeNull();
    const op = await operation(connector);
    await expect(beginGenerationOperation(op.input, pool)).rejects.toMatchObject({ code: "generation_channel_forbidden" });
  });
  it("rechecks membership after context assembly when a concurrent revoke adds new data", async () => {
    let revoked = false;
    const db = { query: async (sql: string, values?: unknown[]) => {
      if (!revoked && sql.includes("from project_brand_dictionary_entries")) {
        revoked = true;
        await revoke(connector);
      }
      return pool.query(sql, values);
    } };
    expect(await channelAiContextFor(connector, channel, 10, db as never)).toBeNull();
    expect(revoked).toBe(true);
  });
  it("permits shared source drafts in the same project and rejects a foreign source", async () => {
    const ownSource = Number((await pool.query("insert into drafts (user_id,project_id,client_key,purpose) values ($1,$2,$3,'source_context') returning id", [connector,project,randomUUID()])).rows[0].id);
    const op = await operation(author);
    expect(await beginGenerationOperation({ ...op.input, sourceContextId: ownSource, sourceContextVersion: 1 }, pool)).toBeGreaterThan(0);
    const foreignProject = Number((await pool.query("insert into projects (name,created_by_user_id) values ('foreign',$1) returning id", [connector])).rows[0].id);
    const foreignSource = Number((await pool.query("insert into drafts (user_id,project_id,client_key,purpose) values ($1,$2,$3,'source_context') returning id", [author,foreignProject,randomUUID()])).rows[0].id);
    const bad = await operation(author);
    await expect(beginGenerationOperation({ ...bad.input, sourceContextId: foreignSource, sourceContextVersion: 1 }, pool)).rejects.toMatchObject({ code: "generation_source_conflict" });
  });
  it("API replay and ACK cannot bypass revoked project membership", async () => {
    const op = await prepared(connector);
    await revoke(connector);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("external fetch forbidden in S03"));
    try {
      const response = await generate(new NextRequest("http://localhost/api/ai/generate", {
        method: "POST", headers: { origin: "http://localhost", "idempotency-key": op.key.slice(4), "content-type": "application/json" },
        body: JSON.stringify({ channelId: channel, command: "write", input: "S03", surface: "studio" }),
      }));
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("S03_RESULT");
      const ackResponse = await ack(new NextRequest("http://localhost/api/ai/generate/ack", { method: "POST", headers: { origin: "http://localhost", "idempotency-key": op.key.slice(4) } }));
      expect(ackResponse.status).not.toBe(200);
      expect(await ackResponse.text()).not.toContain("S03_RESULT");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });
  it("serializes generation admission with revocation on membership rows", async () => {
    const op = await operation(connector);
    let releaseLock!: () => void; let locked!: () => void;
    const hold = new Promise<void>(resolve => { releaseLock = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const lockedPool = { query: pool.query.bind(pool), connect: async () => {
      const tx = await pool.connect();
      return { release: () => tx.release(), query: async (sql:string,values?:unknown[]) => {
        const result=await tx.query(sql,values);
        if(sql.includes("for share of channel")) { locked(); await hold; }
        return result;
      }};
    }};
    const start=beginGenerationOperation(op.input,lockedPool as never);
    await acquired;
    let revoked=false;
    const revocation=revoke(connector).then(()=>{revoked=true;});
    try {
      await new Promise(resolve=>setTimeout(resolve,40));
      expect(revoked).toBe(false);
      const waiting=await pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'update project_members%'");
      expect(waiting.rows[0].n).toBeGreaterThan(0);
    } finally { releaseLock(); }
    expect(await start).toBeGreaterThan(0);await revocation;
    await expect(beginGenerationOperation((await operation(connector)).input,pool)).rejects.toMatchObject({code:"generation_channel_forbidden"});
  });
  it("denies publisher context and generation because publishing is not content.create", async () => {
    await pool.query("update project_members set role = 'publisher' where project_id = $1 and user_id = $2", [project, connector]);
    expect(await channelAiContextFor(connector, channel, 10, pool)).toBeNull();
    await expect(beginGenerationOperation((await operation(connector)).input, pool)).rejects.toMatchObject({ code: "generation_channel_forbidden" });
  });
  it("denies archived project context and generation", async () => {
    await pool.query("update projects set is_archived = true where id = $1", [project]);
    expect(await channelAiContextFor(connector, channel, 10, pool)).toBeNull();
    await expect(beginGenerationOperation((await operation(connector)).input, pool)).rejects.toMatchObject({ code: "generation_channel_forbidden" });
  });
  it("never replays or ACKs durable output after revocation", async () => {
    const op = await prepared(connector);
    await revoke(connector);
    expect((await lookupAiUsageRequest(connector, op.key, op.fingerprint, pool)).result).toBeNull();
    expect((await acknowledgeAiUsageResult(connector, op.key, pool)).result).toBeNull();
    expect(await acknowledgeGenerationArtifact(connector, op.key, pool)).toBeNull();
    expect((await pool.query("select status from ai_usage where id = $1", [op.usage.reservationId])).rows[0].status).toBe("reserved");
  });
  it("author can ACK and read their generated result; revocation then denies reading", async () => {
    const op = await prepared(author);
    expect((await acknowledgeAiUsageResult(author, op.key, pool)).status).toBe("committed");
    expect(await acknowledgeGenerationArtifact(author, op.key, pool)).toBe(op.artifact.id);
    expect(await resolveGenerationDraft(author, op.artifact.id, pool)).toMatchObject({ text: "S03_RESULT", channelId: channel });
    await revoke(author);
    await expect(resolveGenerationDraft(author, op.artifact.id, pool)).rejects.toMatchObject({ code: "generation_result_forbidden" });
  });
  it("withholds output of an admitted operation when revoke commits before result staging", async () => {
    const op = await operation(connector);
    await beginGenerationOperation(op.input, pool);
    await revoke(connector);
    await expect(stageGenerationArtifact({ userId: connector, serverRequestId: op.serverRequestId, text: "S03_FRESH_AFTER_REVOKE", validation, providerResult: {} }, pool)).rejects.toMatchObject({ code: "generation_operation_not_running" });
  });
});


describe("N48 durable cancellation and interruption", () => {
  it("closes a late cancellation after normal failure persistence for the same owner and request", async () => {
    const op = await operation(connector);
    await beginGenerationOperation(op.input, pool);
    await failGenerationOperation(connector, op.serverRequestId, "provider_unavailable", true, pool);
    await failGenerationOperation(author, op.serverRequestId, "ai_generation_cancelled", false, pool);
    expect((await pool.query("select status from generation_operations where ai_usage_id=$1", [op.usage.reservationId])).rows[0].status).toBe("retryable_failed");
    await failGenerationOperation(connector, op.serverRequestId, "ai_generation_cancelled", false, pool);
    expect(await lookupTerminalGenerationFailure(connector, op.key, op.fingerprint, pool))
      .toEqual({ code: "ai_generation_cancelled", retryable: false });
    expect((await pool.query("select status,retryable from generation_operations where ai_usage_id=$1", [op.usage.reservationId])).rows[0])
      .toEqual({ status: "failed", retryable: false });
  });

  it("preserves both pending ACK and acknowledged results when cancellation arrives late", async () => {
    const op = await prepared(connector);
    await failGenerationOperation(connector, op.serverRequestId, "ai_generation_cancelled", false, pool);
    expect(await lookupTerminalGenerationFailure(connector, op.key, op.fingerprint, pool)).toBeNull();
    expect((await lookupAiUsageRequest(connector, op.key, op.fingerprint, pool)).result?.text).toBe("S03_RESULT");
    await acknowledgeAiUsageResult(connector, op.key, pool);
    await acknowledgeGenerationArtifact(connector, op.key, pool);
    await failGenerationOperation(connector, op.serverRequestId, "ai_generation_cancelled", false, pool);
    expect((await pool.query("select status from generation_operations where ai_usage_id=$1", [op.usage.reservationId])).rows[0].status).toBe("acknowledged");
    expect((await lookupAiUsageRequest(connector, op.key, op.fingerprint, pool)).result?.text).toBe("S03_RESULT");
  });

  it("closes an expired or mismatched running lease while preserving the current permission boundary", async () => {
    const op = await operation(connector);
    await beginGenerationOperation(op.input, pool);
    expect(await lookupTerminalGenerationFailure(connector, op.key, op.fingerprint, pool)).toBeNull();
    await pool.query("update ai_usage set expires_at=now()-interval '1 second' where id=$1", [op.usage.reservationId]);
    expect(await lookupTerminalGenerationFailure(connector, op.key, op.fingerprint, pool))
      .toEqual({ code: "ai_generation_interrupted", retryable: false });
    await pool.query("update ai_usage set expires_at=now()+interval '1 minute',operation_id=$2 where id=$1", [op.usage.reservationId, randomUUID()]);
    expect(await lookupTerminalGenerationFailure(connector, op.key, op.fingerprint, pool))
      .toEqual({ code: "ai_generation_interrupted", retryable: false });
    await revoke(connector);
    expect(await lookupTerminalGenerationFailure(connector, op.key, op.fingerprint, pool)).toBeNull();
  });
});

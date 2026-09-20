import { telegramUpdateContext, TELEGRAM_MESSAGE_METHODS, deliverTelegramUpdateCall } from "../worker/telegram-update-delivery.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import pg from "pg";
import { migrate } from "./migrate.mjs";
import { readTelegramResponse } from "../src/lib/telegram-response.mjs";
import { telegramPartDefinitions, deliverTelegramParts } from "../worker/telegram-multipart.mjs";
import { telegramCarouselPartDefinitions, deliverTelegramCarousel } from "../worker/telegram-carousel.mjs";
import { claimPublicationLease, beginProviderCall, claimPublicationPart } from "../worker/publication-lease.mjs";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const target = new URL(databaseUrl || "postgres://invalid/invalid");
assert(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) && target.pathname === "/aurora_s02_test", "explicit isolated aurora_s02_test database required");
assert(!process.env.DATABASE_URL, "do not inherit the application's DATABASE_URL");
const source = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");
const transport = source.slice(source.indexOf("async function tg(method,"), source.indexOf("const sleep =", source.indexOf("async function tg(method,")));
const publish = source.slice(source.indexOf("async function publishTg("), source.indexOf("/** VK: расшифровываем", source.indexOf("async function publishTg(")));
const reclaim = source.slice(source.indexOf("async function reclaimStuckPosts()"), source.indexOf("// PostgreSQL — источник правды", source.indexOf("async function reclaimStuckPosts()")));
let pool = new pg.Pool({ connectionString: databaseUrl });
try {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { DATABASE_URL: databaseUrl } });
  const userId = Number((await pool.query("insert into users (email, name) values ($1, 'S02 fixture') returning id", [`s02-${Date.now()}@example.invalid`])).rows[0].id);
  const projectId = Number((await pool.query("insert into projects (name, timezone, created_by_user_id) values ('S02 fixture', 'UTC', $1) returning id", [userId])).rows[0].id);
  await pool.query("insert into project_members(project_id,user_id,role,status) values($1,$2,'owner','active')",[projectId,userId]);
  const channel = (await pool.query("insert into channels (user_id, project_id, network, tg_chat_id, title, is_active, status) values ($1, $2, 'tg', $3, 'S02 fixture', true, 'active') returning *", [userId, projectId, -Date.now()])).rows[0];
  async function newPost(text = "safe fixture", media = null) {
    return Number((await pool.query("insert into posts (user_id, project_id, channel_id, text, media, status, scheduled_at) values ($1,$2,$3,$4,$5::jsonb,'scheduled',now()) returning id", [userId, projectId, channel.id, text, JSON.stringify(media)])).rows[0].id);
  }
  const image = { kind: "image", mime_type: "image/png", file_name: "fixture.png", data: Buffer.from("synthetic") };
  image.sha256 = createHash("sha256").update(image.data).digest("hex");
  function runtime(fetchImpl, fault = false) {
    const queryPool = { query: (sql, params) => {
      if (fault && sql.includes("set send_status = 'sent'")) throw new Error("synthetic DB receipt write failure");
      if (sql.includes("bot_delivery_events")) return Promise.resolve({ rows: [], rowCount: 1 });
      return pool.query(sql, params);
    } };
    const functions = vm.runInNewContext(`${transport}\n${publish}\n${reclaim}\n({publishTg,reclaimStuckPosts,tg});`, {
      pool: queryPool, fetch: fetchImpl, AbortSignal, FormData, Blob, TOKEN: "123456:synthetic", TELEGRAM_API_URL: "https://telegram.invalid",
      telegramSafeErrorDescription: String, telegramUpdateContext, TELEGRAM_MESSAGE_METHODS, deliverTelegramUpdateCall, readTelegramResponse, telegramPartDefinitions, deliverTelegramParts,
      telegramCarouselPartDefinitions, deliverTelegramCarousel, claimPublicationPart, createHash, MEDIA_VIDEO_MAX_BYTES: 1024 * 1024,
      loadMediaAssetBuffer: async () => image, classifyTelegramChannelFailure: () => null,
      notifyOwner: async () => {}, console,
    });
    const deliver = functions.publishTg;
    functions.publishTg = async (destination, postId, text, media) => {
      const input = {postId,projectId,scheduleRevision:1,leaseToken:`s02-direct-${postId}`,overdueCutoff:new Date(0)};
      const post = (await pool.query('select status from posts where id=$1',[postId])).rows[0];
      if(post.status === 'scheduled') {assert(await claimPublicationLease(pool,input));assert(await beginProviderCall(pool,input));}
      return deliver(destination,postId,text,media,input);
    };
    return functions;
  }
  let scenarios = 0;
  for (const format of ["text", "photo", "album"]) {
    let sends = 0;
    const fetchImpl = async () => { sends++; return { status: 200, json: async () => { throw new SyntaxError("synthetic response lost"); } }; };
    const media = format === "text" ? null : format === "photo" ? { assetId: 1 } : { kind: "carousel", items: [1,2,3].map((assetId) => ({ assetId, mimeType: image.mime_type })) };
    const postId = await newPost("safe fixture", media);
    assert.equal((await runtime(fetchImpl).publishTg(channel, postId, "safe fixture", media)).deliveryUnknown, true);
    assert((await pool.query("select send_status from publication_parts where post_id=$1", [postId])).rows.every((row) => row.send_status === "unknown"));
    await pool.end(); pool = new pg.Pool({ connectionString: databaseUrl });
    assert.equal((await runtime(fetchImpl).publishTg(channel, postId, "safe fixture", media)).deliveryUnknown, true);
    assert.equal(sends, 1); scenarios++;
  }
  {
    let sends = 0;
    const fetchImpl = async () => { sends++; return { status: 200, json: async () => ({ok:true,result:{message_id:88}}) }; };
    const postId = await newPost();
    assert.equal((await runtime(fetchImpl, true).publishTg(channel, postId, "safe fixture", null)).deliveryUnknown, true);
    await pool.end(); pool = new pg.Pool({ connectionString: databaseUrl });
    assert.equal((await runtime(fetchImpl).publishTg(channel, postId, "safe fixture", null)).deliveryUnknown, true);
    assert.equal(sends, 1); scenarios++;
  }
  {
    const postId = await newPost("x".repeat(4100));
    let sends = 0;
    const fetchImpl = async () => ({ status: ++sends === 2 ? 429 : 200, json: async () => sends === 2 ? { ok: false, error_code: 429, parameters: { retry_after: 37 } } : { ok: true, result: { message_id: 200 + sends } } });
    const first = await runtime(fetchImpl).publishTg(channel, postId, "x".repeat(4100), null);
    assert.equal(first.retryAfterSeconds, 37); assert.equal(first.deliveryUnknown, false);
    await pool.end(); pool = new pg.Pool({ connectionString: databaseUrl });
    assert.equal((await runtime(fetchImpl).publishTg(channel, postId, "x".repeat(4100), null)).ok, true);
    assert.equal(sends, 3); // first successful part is never resent.
    const parts = (await pool.query("select external_message_id from publication_parts where post_id=$1 order by part_index", [postId])).rows;
    assert.deepEqual(parts.map((part) => part.external_message_id), ["201", "203"]); scenarios++;
  }
  {
    const postId = await newPost();
    const leaseToken = "s02-lease";
    const input = { postId, projectId, scheduleRevision: 1, leaseToken, overdueCutoff: new Date(Date.now()-60000) };
    assert(await claimPublicationLease(pool, input));
    assert.equal(await beginProviderCall(pool, {...input, scheduleRevision: 2}), false);
    assert.equal(await beginProviderCall(pool, {...input, leaseToken: "stale"}), false);
    assert.equal(await beginProviderCall(pool, input), true);
    await pool.query("update posts set publish_started_at=now()-interval '20 minutes' where id=$1", [postId]);
    await runtime(async () => { throw new Error("restart must not send"); }).reclaimStuckPosts();
    const row = (await pool.query("select status, verification_error_code from posts where id=$1", [postId])).rows[0];
    assert.equal(row.status, "published_unverified");
    assert.equal(row.verification_error_code, "worker_restart_delivery_unknown");
    assert.equal(await claimPublicationLease(pool, input), null); scenarios++;
  }
  for (const fault of ["accepted", "lost_response", "429"]) {
    const updateId = Date.now() + scenarios;
    let sends = 0;
    const fetchImpl = async () => {
      sends++;
      return { status: fault === "429" && sends === 1 ? 429 : 200, json: async () => {
        if (fault === "lost_response") throw new SyntaxError("lost reply acknowledgement");
        return fault === "429" && sends === 1 ? { ok: false, error_code: 429, parameters: { retry_after: 37 } } : { ok: true, result: { message_id: 777 } };
      } };
    };
    const run = () => telegramUpdateContext.run({ updateId, next: 0 }, () => runtime(fetchImpl).tg("sendMessage", { chat_id: 888, text: "safe fixture" }));
    if (fault === "lost_response") await assert.rejects(run, { deliveryUnknown: true }); else await run();
    await pool.end(); pool = new pg.Pool({ connectionString: databaseUrl });
    if (fault === "lost_response") await assert.rejects(run, { deliveryUnknown: true }); else await run();
    assert.equal(sends, 1);
    if (fault === "429") {
      const record = (await pool.query("select retry_not_before-created_at as delay from telegram_update_deliveries where update_id=$1", [updateId])).rows[0];
      assert(record.delay.seconds >= 37);
      await pool.query("update telegram_update_deliveries set retry_not_before=now()-interval '1 second' where update_id=$1", [updateId]);
      assert.equal((await run()).ok, true); assert.equal(sends, 2);
    }
    scenarios++;
  }
  console.log(JSON.stringify({ ok: true, scenarios, provider: "in-process fake only", receipts: "real PostgreSQL", restart: "pool + transport runtime recreated", staleLeaseAndRevision: true }));
} finally { await pool.end(); }

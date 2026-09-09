import {selectProjectWithSettledReads} from "./e2e-project-selection.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { draftRevisionContentHash } from "../src/lib/editorial-revision.mjs";

const TAB_PROJECT_KEY = "aurora:request-project-id";
const TIMEOUT = 60_000;

async function fixture(pool, userId, projectId, channelId) {
  const key = `e2e-calendar-${randomUUID()}`;
  const text = `QA future calendar ${key}`;
  const scheduled = new Date(Date.now() + 60 * 86_400_000);
  scheduled.setUTCHours(12, 0, 0, 0);
  const at = scheduled.toISOString();
  const date = at.slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const draftId = Number((await client.query(
      `insert into drafts (project_id,user_id,text,client_key,origin,purpose,version,
        human_reviewed_version,human_reviewed_at,scheduled_at,scheduled_timezone,
        scheduled_local_date,scheduled_local_time,scheduled_offset,scheduled_disambiguation)
       values ($1,$2,$3,$4,'manual','publishable',1,1,now(),$5,'UTC',$6,'12:00','+00:00','reject') returning id`,
      [projectId, userId, text, key, at, date],
    )).rows[0].id);
    await client.query("insert into draft_destinations(draft_id,channel_id) values ($1,$2)", [draftId, channelId]);
    const snapshot = {
      schemaVersion: 4, text, formatting: [], media: null, tracking: {}, origin: "manual", purpose: "publishable", sourceRef: null,
      schedule: { scheduledAt: at, timezone: "UTC", localDate: date, localTime: "12:00", offset: "+00:00", disambiguation: "reject" },
      channelIds: [channelId],
      publicationPreferences: { version: 0, selectedBlocks: [], firstCommentFallback: "skip", commentsMode: "provider_default", pinAfterPublish: false, reviewAt: null, reviewResponsibleUserId: null },
    };
    const hash = draftRevisionContentHash(snapshot);
    const revisionId = Number((await client.query(
      `insert into draft_revisions(project_id,draft_id,draft_version,author_user_id,content_hash,snapshot)
       values($1,$2,1,$3,$4,$5::jsonb) returning id`, [projectId, draftId, userId, hash, JSON.stringify(snapshot)],
    )).rows[0].id);
    await client.query(
      `insert into draft_editorial_workflows(draft_id,project_id,state,current_revision_id,approved_revision_id,approved_content_hash)
       values($1,$2,'approved',$3,$3,$4)`, [draftId, projectId, revisionId, hash],
    );
    const operationId = Number((await client.query(
      `insert into publication_operations(project_id,user_id,draft_id,draft_version,idempotency_key,fingerprint,text,
        scheduled_at,timezone,schedule_offset,schedule_disambiguation,destination_ids,status,
        approved_revision_id,approved_draft_version,approved_content_hash)
       values($1,$2,$3,1,$4,$5::text,$6,$7,'UTC','+00:00','reject',$8::jsonb,'queued',$9,1,$5::text) returning id`,
      [projectId, userId, draftId, key, hash, text, at, JSON.stringify([channelId]), revisionId],
    )).rows[0].id);
    // Insert future before history: it would fall outside the old newest-ID LIMIT.
    const postId = Number((await client.query(
      `insert into posts(project_id,user_id,channel_id,text,status,scheduled_at,scheduled_timezone,
        scheduled_offset,scheduled_disambiguation,publication_origin,publication_operation_id,publication_draft_version)
       values($1,$2,$3,$4,'scheduled',$5,'UTC','+00:00','reject','manual',$6,1) returning id`,
      [projectId, userId, channelId, text, at, operationId],
    )).rows[0].id);
    await client.query(
      "insert into publication_outbox(operation_id,post_id,status,enqueued_at) values($1,$2,'enqueued',now())",
      [operationId, postId],
    );
    await client.query(
      `insert into posts(project_id,user_id,channel_id,text,status,scheduled_at,published_at,publication_origin,verification_state)
       select $1,$2,$3,$4 || ' history ' || n,'published',
          now()-interval '365 days'+n*interval '1 second',now()-interval '365 days'+n*interval '1 second','manual','verified'
         from generate_series(1,1205) n`, [projectId, userId, channelId, key],
    );
    await client.query("commit");
    return { key, text, scheduledAt: at, draftId, revisionId, operationId, postId, historyCount: 1205 };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function tabProject(page) {
  return page.evaluate((key) => Number(sessionStorage.getItem(key)), TAB_PROJECT_KEY);
}


function observeProjectTraffic(page, tab) {
  const reads = []; const mutations = []; const pending = new Set();
  const onResponse = (response) => {
    const request = response.request(); const url = new URL(response.url());
    if (url.pathname !== "/api/posts" && !/^\/api\/publication-operations\/\d+$/u.test(url.pathname)) return;
    const task = (async () => {
      const body = await response.json().catch(() => null);
      const record = { tab, method: request.method(), path: url.pathname + url.search, projectHeader: request.headers()["x-aurora-project-id"] ?? null, responseProjectId: body?.projectId ?? null, status: response.status(), ids: Array.isArray(body?.posts) ? body.posts.map((post) => Number(post.id)) : [] };
      (request.method() === "GET" ? reads : mutations).push(record);
    })();
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  page.on("response", onResponse);
  return { reads, mutations, settle: () => Promise.all([...pending]), stop: () => page.off("response", onResponse) };
}

/** Called only by the isolated real-E2E runner. Every mutation below is performed by UI. */
export async function runProjectCalendarCoverage({ page, context, pool, userId, sharedProjectId, legacyProjectId, sharedChannelId, waitFor, artifactDir, settleReads, closeCompletedPage = (page) => page.close(), navigate = (target, url, options) => target.goto(url, options), reload = (target) => target.reload() }) {
  const database = new URL(String(pool.options.connectionString || process.env.E2E_DATABASE_URL || ""));
  assert(["localhost", "127.0.0.1"].includes(database.hostname) && database.pathname === "/aurora_e2e_real", "project/calendar gate requires isolated aurora_e2e_real");
  assert(sharedProjectId !== legacyProjectId, "two distinct projects required");
  const seeded = await fixture(pool, userId, sharedProjectId, sharedChannelId);
  const first = observeProjectTraffic(page, "shared-tab");
  const other = await context.newPage();
  const second = observeProjectTraffic(other, "legacy-tab");
  let success = false;
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await other.setViewportSize({ width: 1280, height: 900 });
    await navigate(page, "/app/calendar");
    await selectProjectWithSettledReads(page, sharedProjectId, {waitFor, settleReads, timeoutMs:TIMEOUT});
    await navigate(other, "/app/calendar");
    await selectProjectWithSettledReads(other, legacyProjectId, {waitFor, settleReads, timeoutMs:TIMEOUT});
    await waitFor(async () => Number((await pool.query("select selected_project_id from user_project_preferences where user_id=$1", [userId])).rows[0]?.selected_project_id) === legacyProjectId,
      "second tab did not change shared server preference", TIMEOUT);
    // New first-tab requests and a reload must remain in the first tab's selected scope.
    await navigate(page, `/app/calendar#calendar-real-${seeded.postId}`);
    const handle = page.getByRole("button", { name: `Перетащить или выбрать другой день: ${seeded.text.slice(0, 60)}`, exact: true });
    await handle.waitFor({ state: "visible", timeout: TIMEOUT });
    assert.equal(await tabProject(page), sharedProjectId, "first tab adopted second tab's preference on reload");
    assert.equal(await tabProject(other), legacyProjectId, "second tab lost its local project");
    const history = Number((await pool.query("select count(*) as count from posts where project_id=$1 and text like $2", [sharedProjectId, `${seeded.key} history %`])).rows[0].count);
    assert.equal(history, seeded.historyCount, "large historical fixture incomplete");
    await waitFor(async () => {
      await first.settle(); await second.settle();
      return first.reads.some((entry) => entry.ids.includes(seeded.postId) && entry.projectHeader === String(sharedProjectId) && Number(entry.responseProjectId) === sharedProjectId)
        && second.reads.some((entry) => entry.projectHeader === String(legacyProjectId) && Number(entry.responseProjectId) === legacyProjectId);
    }, "real UI reads did not preserve per-tab request/response project identity", TIMEOUT);
    for (const [target, traffic, projectId] of [[page, first, sharedProjectId], [other, second, legacyProjectId]]) {
      const before = traffic.reads.length;
      await target.bringToFront();
      await waitFor(async () => {
        await traffic.settle();
        return traffic.reads.slice(before).filter((entry) => entry.path.startsWith("/api/posts?")
          && entry.projectHeader === String(projectId) && Number(entry.responseProjectId) === projectId).length >= 2;
      }, `visible tab polling lost project ${projectId}`, TIMEOUT);
    }
    await page.bringToFront();
    await handle.click();
    const picker = page.getByRole("dialog", { name: "Перенести публикацию", exact: true });
    await picker.waitFor({ state: "visible", timeout: TIMEOUT });
    await picker.getByRole("button", { name: /Перенести сюда/u }).first().click();
    const moved = await waitFor(async () => {
      const row = (await pool.query("select status,scheduled_at,schedule_revision,project_id from posts where id=$1", [seeded.postId])).rows[0];
      return Number(row?.schedule_revision) === 2 && new Date(row.scheduled_at).toISOString() !== seeded.scheduledAt ? row : null;
    }, "calendar UI did not persist schedule revision2", TIMEOUT);
    assert.equal(Number(moved.project_id), sharedProjectId);
    assert.equal(moved.status, "scheduled");
    assert(new Date(moved.scheduled_at).getTime() > Date.now() + 30 * 86_400_000, "fixture must remain far future");
    await page.getByRole("button", { name: `Открыть публикацию в редакторе: ${seeded.text.slice(0, 60)}`, exact: true }).first().click();
    await page.waitForURL((url) => url.pathname === "/app/composer" && url.searchParams.get("publication") === String(seeded.operationId), { timeout: TIMEOUT });
    await page.getByRole("button", { name: "Отменить публикацию", exact: true }).click();
    const cancelDialog = page.getByRole("dialog", { name: "Отменить запланированную публикацию?", exact: true });
    await cancelDialog.getByRole("button", { name: "Отменить публикацию", exact: true }).click();
    const cancelled = await waitFor(async () => {
      const row = (await pool.query("select operation.status,operation.schedule_revision,post.status as post_status,post.provider_started_at,post.published_at from publication_operations operation join posts post on post.publication_operation_id=operation.id where operation.id=$1", [seeded.operationId])).rows[0];
      return row?.status === "cancelled" && row.post_status === "cancelled" ? row : null;
    }, "composer UI cancellation did not reach DB", TIMEOUT);
    assert.equal(Number(cancelled.schedule_revision), 3);
    assert.equal(cancelled.provider_started_at, null); assert.equal(cancelled.published_at, null);
    // The transaction can commit before the browser emits its response event.
    // Wait for the exact HTTP evidence; settling currently observed bodies alone
    // does not wait for a response that has not arrived yet.
    await waitFor(async () => {
      await first.settle();
      return ["PATCH", "DELETE"].every((method) => first.mutations.some((entry) =>
        entry.path === `/api/publication-operations/${seeded.operationId}` && entry.method === method
        && entry.status === 200 && entry.projectHeader === String(sharedProjectId)));
    }, "UI mutation responses did not preserve captured project identity", TIMEOUT);
    const writes = first.mutations.filter((entry) => entry.path === `/api/publication-operations/${seeded.operationId}`);
    for (const method of ["PATCH", "DELETE"]) assert(writes.some((entry) => entry.method === method && entry.status === 200 && entry.projectHeader === String(sharedProjectId)), `UI ${method} failed captured project identity`);
    // Restore the shared server preference through UI, then reload the other tab.
    await navigate(page, "/app/calendar");
    await selectProjectWithSettledReads(page, legacyProjectId, {waitFor, settleReads, timeoutMs:TIMEOUT});
    await selectProjectWithSettledReads(page, sharedProjectId, {waitFor, settleReads, timeoutMs:TIMEOUT});
    await waitFor(async () => Number((await pool.query("select selected_project_id from user_project_preferences where user_id=$1", [userId])).rows[0]?.selected_project_id) === sharedProjectId,
      "first tab did not restore shared server preference", TIMEOUT);
    await reload(other);
    assert.equal(await tabProject(other), legacyProjectId, "first-tab mutations polluted second-tab selection");
    await waitFor(async () => Number(await other.getByRole("combobox", { name: "Текущий проект", exact: true }).first().inputValue()) === legacyProjectId,
      "second tab UI adopted shared server preference after reload", TIMEOUT);
    await second.settle();
    assert(!second.reads.some((entry) => entry.projectHeader === String(legacyProjectId) && entry.ids.includes(seeded.postId)), "other project's calendar leaked the future post");
    success = true;
    return { ...seeded, movedAt: new Date(moved.scheduled_at).toISOString(), finalRevision: Number(cancelled.schedule_revision), historyRows: history, firstTabProject: sharedProjectId, secondTabProject: legacyProjectId, providerStartedAt: cancelled.provider_started_at, publishedAt: cancelled.published_at };
  } finally {
    await first.settle(); await second.settle(); first.stop(); second.stop();
    await writeFile(join(artifactDir, "project-calendar-coverage.json"), JSON.stringify({ success, fixture: seeded, sharedProjectId, legacyProjectId, reads: [...first.reads, ...second.reads], mutations: [...first.mutations, ...second.mutations] }, null, 2));
    await closeCompletedPage(other);
  }
}

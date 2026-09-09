import { createE2eBrowserErrorCollector } from "./e2e-browser-error-collector.mjs";
import { createMainRequestEvidence } from "./e2e-main-request-evidence.mjs";
import { selectProjectWithSettledReads } from "./e2e-project-selection.mjs";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyEditorCancellation } from "./e2e-editor-safety-coverage.mjs";
import { installE2eBrowserBoundary } from "./e2e-browser-boundary.mjs";
import { createE2eBrowserContext } from "./e2e-browser-context.mjs";
import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";
import { classifyCompletedChannelNotificationRead } from "./e2e-channel-native-body-observer.mjs";

/** Only response acknowledgements and exact native EOF evidenced in this journey. */
export function classifyChannelOnboardingCancellation(record, { nativeBody = null } = {}) {
  if (record?.firstParty !== true || record.type !== "fetch") return null;
  const completedRead = classifyCompletedChannelNotificationRead(record, nativeBody);
  if (completedRead) return completedRead;
  const reason = classifyEditorCancellation(record);
  if (reason === "completed_rsc_prefetch" && record.isRscQuery === true
    && (/^\/app(?:\/[a-z0-9-]+)+$/u.test(record.path) || /^\/admin(?:\/[a-z0-9-]+)*$/u.test(record.path))) return reason;
  if (reason === "acknowledged_keepalive" && record.contentType?.startsWith("application/json")) return reason;
  return null;
}

/** Keep only safe metadata: no URL query values, response bodies, cookies or credentials. */
export function createChannelOnboardingNetworkTracker({ page, baseUrl, waitFor, bodyObserver = null, readEvidence = null }) {
  const origin = new URL(baseUrl).origin;
  const requests = new Map(); const network = []; const errors = []; const navigations = [];
  let currentNavigation = null;
  const requestStarted = (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;
    const headers = request.headers();
    const row = { id: network.length + 1, firstParty: true, method: request.method(), path: url.pathname,
      type: request.resourceType(), isNavigation: request.isNavigationRequest(), isRscQuery: url.searchParams.has("_rsc"),
      rsc: headers.rsc === "1" ? "1" : null, prefetch: headers["next-router-prefetch"] === "1" ? "1" : null,
      segmentPrefetch: Boolean(headers["next-router-segment-prefetch"]), startedAt: Date.now() };
    if (bodyObserver) row.documentId = bodyObserver.documentFor(page);
    if (readEvidence) row.nativeRequestId = readEvidence.observeRequest(request, "channel-onboarding", page)?.id ?? null;
    else bodyObserver?.trackRequest(request, row, page);
    requests.set(request, row); network.push(row);
  };
  const responseReceived = (response) => {
    readEvidence?.observeResponse(response);
    const row = requests.get(response.request());
    if (!row) return;
    row.status = response.status(); row.contentType = response.headers()["content-type"]?.split(";")[0] ?? null; row.responseAt = Date.now();
    if (row.status >= 400) errors.push({ kind: "http", requestId: row.id, method: row.method, path: row.path, status: row.status });
  };
  const requestFinished = (request) => { readEvidence?.observeFinished(request); const row = requests.get(request); if (row) row.finishedAt = Date.now(); };
  const requestFailed = (request) => {
    readEvidence?.observeFailure(request);
    const row = requests.get(request); if (!row) return;
    row.failedAt = Date.now(); row.failure = request.failure()?.errorText ?? "request_failed";
    row.navigationId = currentNavigation?.id ?? null;
  };
  const pageError = (error) => errors.push({ kind: "pageerror", name: error.name });
  const handlers = { request: requestStarted, response: responseReceived, requestfinished: requestFinished, requestfailed: requestFailed, pageerror: pageError };
  for (const [event, handler] of Object.entries(handlers)) page.on(event, handler);
  return {
    async navigate(label, action) {
      await readEvidence?.settleReads(page);
      const navigation = { id: navigations.length + 1, label, startedAt: Date.now(), complete: false };
      navigations.push(navigation); currentNavigation = navigation;
      try { const result = await action(); navigation.complete = true; navigation.destination = new URL(page.url()).pathname; return result; }
      finally { navigation.finishedAt = Date.now(); currentNavigation = null; }
    },
    async waitForIdle(label) {
      let idleSince = null;
      await waitFor(() => {
        const callerCompleted = new Set([...requests]
          .filter(([request, row]) => !row.finishedAt && !row.failedAt
            && readEvidence?.reason(request) === "native_caller_abort_without_transport_terminal")
          .map(([, row]) => row));
        const busy = network.some((row) => !row.finishedAt && !row.failedAt
          && !callerCompleted.has(row)
          && !(row.method === "POST" && row.path === "/api/product-events" && row.status >= 200 && row.status < 300));
        if (busy) idleSince = null; else idleSince ??= Date.now();
        return idleSince != null && Date.now() - idleSince >= 750;
      }, `${label} did not settle`, 60_000);
    },
    snapshot() {
      const knownCancellations = []; const unexpected = [...errors];
      for (const [request, row] of requests) {
        if (!row.failure) continue;
        const nativeBody = readEvidence ? null : bodyObserver?.match(row) ?? null;
        // Runtime admission uses the exact captured Request. Legacy metadata is
        // retained only for standalone compatibility, never as a fallback waiver.
        const reason = readEvidence ? readEvidence.reason(request) : classifyChannelOnboardingCancellation(row, { nativeBody });
        if (reason) knownCancellations.push({ ...row, reason, ...(reason === "completed_native_notifications_read" ? { nativeBody } : {}) });
        else unexpected.push({ kind: "requestfailed", ...row });
      }
      return { network: network.map((row) => ({ ...row })), navigations: navigations.map((row) => ({ ...row })), knownCancellations, unexpected, requestEvidence: readEvidence?.snapshot() ?? [] };
    },
    stop() { for (const [event, handler] of Object.entries(handlers)) page.off(event, handler); },
  };
}


const ACTOR = 910000001;
const BOT = 9000000000;
const CHAT = -100900000777;
const TITLE = "R02 local onboarding";
const updates = [];
const state = { privateReplies: 0, permissionChecks: [], deliveredUpdates: 0 };

export function takeChannelOnboardingUpdates() {
  const batch = updates.splice(0);
  state.deliveredUpdates += batch.length;
  return batch;
}

/** Dedicated synthetic account methods; publication retry counters stay independent. */
export function handleFakeChannelOnboardingRequest(req, res, raw) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!url.pathname.startsWith(`/bot${BOT}:e2e-fake-token-not-live/`)) return false;
  const method = url.pathname.split("/").at(-1);
  if (!["sendMessage", "getChat", "getChatMember", "getChatMemberCount"].includes(method)) return false;
  const body = req.method === "GET" ? Object.fromEntries(url.searchParams) : JSON.parse(raw || "{}");
  const chatId = Number(body.chat_id);
  let result;
  if (method === "sendMessage" && chatId === ACTOR) {
    state.privateReplies += 1;
    result = { message_id: 9200 + state.privateReplies, chat: { id: ACTOR, type: "private" }, date: Math.floor(Date.now() / 1000) };
  } else if (chatId === CHAT && method === "getChat") {
    result = { id: CHAT, type: "channel", title: TITLE };
  } else if (chatId === CHAT && method === "getChatMember") {
    const userId = Number(body.user_id);
    assert([ACTOR, BOT].includes(userId), "onboarding checked an unexpected Telegram actor");
    state.permissionChecks.push(userId);
    result = userId === BOT
      ? { user: { id: BOT, is_bot: true }, status: "administrator", can_post_messages: true }
      : { user: { id: ACTOR, is_bot: false }, status: "creator" };
  } else if (chatId === CHAT && method === "getChatMemberCount") {
    result = 1;
  } else return false;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, result }));
  return true;
}

/** Real Settings → one-time link → worker polling/proof → provider permissions → DB → Settings.
 * The Telegram client itself is a fake boundary, not a claimed native-device test. */
export async function runChannelOnboardingCoverage({ browser, cookies, baseUrl, pool, userId, projectId, waitFor, artifactDir = null }) {
  assert(["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname));
  assert.equal(new URL(pool.options.connectionString).pathname, "/aurora_e2e_real");
  const { context, transport } = await createE2eBrowserContext(browser, {
    baseUrl, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 },
  });
  const readEvidence = createMainRequestEvidence({ baseUrl });
  let boundary; let bodyObserver; let tracker; let primaryError; let result;
  const browserErrors = createE2eBrowserErrorCollector({ baseUrl });
  try {
  browserErrors.observeContext(context);
    boundary = await installE2eBrowserBoundary(context, { baseUrl });
    // Reuse the installed specialized observer; do not double-wrap native fetch.
    bodyObserver = await readEvidence.install(context);
    // The one-time Telegram credential remains in memory only, outside portable traces.
    await context.addCookies(cookies);
    let clientBoundaryCount = 0; let clientPayload = null;
    await context.route("https://t.me/**", async (route) => {
      const target = new URL(route.request().url());
      if (target.pathname !== "/aurora_e2e_bot" || !/^[a-f0-9]{32}_channel$/u.test(target.searchParams.get("start") || "")) {
        await route.fallback();
        return;
      }
      clientBoundaryCount += 1;
      clientPayload = target.searchParams.get("start");
      await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Isolated Telegram client boundary</title>" });
    });
    const page = await context.newPage();
    browserErrors.attach(page);
    tracker = createChannelOnboardingNetworkTracker({ page, baseUrl, waitFor, bodyObserver, readEvidence });
    const waitForFirstPartyNetworkIdle = (_page, label) => tracker.waitForIdle(label);
    await tracker.navigate("open Settings channels", () => page.goto("/app/settings?section=channels"));
    await selectProjectWithSettledReads(page, projectId, { waitFor,
      settleReads: target => readEvidence.settleReads(target) });
    await waitForFirstPartyNetworkIdle(page, "channel onboarding hydration");
    const payload = await transport.withExpectedDeniedConnect({ origin: "https://t.me" }, async () => {
      const statusPromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/bot/link" && response.request().method() === "GET");
      const launchPromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/bot/link" && response.request().method() === "POST");
      const popupPromise = page.waitForEvent("popup");
      void statusPromise.catch(() => undefined); void launchPromise.catch(() => undefined); void popupPromise.catch(() => undefined);
      await page.getByRole("button", { name: "Подключить ещё канал", exact: true }).click();
      const status = await statusPromise;
      assert.equal(status.status(), 200);
      assert.equal((await status.json()).botStatus, "up");
      const launch = await launchPromise;
      assert.equal(launch.status(), 200);
      assert.deepEqual(launch.request().postDataJSON(), { intent: "channel" });
      const body = await launch.json();
      const intent = new URL(body.url).searchParams.get("start");
      assert(/^[a-f0-9]{32}_channel$/u.test(intent || ""));
      const link = (await pool.query("select user_id,channel_project_id,used_at from bot_links where code=$1", [intent.slice(0, 32)])).rows[0];
      assert.equal(Number(link.user_id), userId); assert.equal(Number(link.channel_project_id), projectId); assert.equal(link.used_at, null);
      await waitFor(() => clientBoundaryCount === 1, "Settings did not open the isolated Telegram client boundary");
      assert(clientPayload === intent, "Telegram client did not receive the same one-time intent");
      const popup = await popupPromise;
      browserErrors.attach(popup);
      await waitFor(async () => await popup.title() === "Isolated Telegram client boundary", "the fake Telegram client did not finish loading");
      return intent;
    });
    // Main's discussion update99001 has completed before this helper. Higher IDs
    // preserve the actual worker's durable polling offset and replay behavior.
    updates.push({ update_id: 99101, message: { message_id: 9911, date: Math.floor(Date.now() / 1000),
      chat: { id: ACTOR, type: "private" }, from: { id: ACTOR, is_bot: false, first_name: "Isolated actor" }, text: `/start ${payload}` } });
    const proof = await waitFor(async () => (await pool.query(
      "select id,user_id,project_id,actor_id from telegram_channel_connection_proofs where user_id=$1 and project_id=$2 and actor_id=$3 and used_at is null and expires_at>now()",
      [userId, projectId, ACTOR])).rows[0], "actual worker did not create the project-bound Telegram proof", 45_000);
    const membership = { chat: { id: CHAT, type: "channel", title: TITLE }, from: { id: ACTOR, is_bot: false }, date: Math.floor(Date.now() / 1000),
      old_chat_member: { status: "left", user: { id: BOT, is_bot: true } },
      new_chat_member: { status: "administrator", can_post_messages: true, user: { id: BOT, is_bot: true } } };
    updates.push({ update_id: 99102, my_chat_member: membership });
    const channel = await waitFor(async () => (await pool.query("select id,user_id,project_id,status,is_active from channels where network='tg' and tg_chat_id=$1", [CHAT])).rows[0],
      "actual Telegram membership did not connect the channel", 45_000);
    assert.equal(Number(channel.user_id), userId); assert.equal(Number(channel.project_id), projectId);
    assert.equal(channel.status, "active"); assert.equal(channel.is_active, true);
    assert.deepEqual(state.permissionChecks, [BOT, ACTOR]);
    const consumed = (await pool.query("select used_at,event_id,chat_id from telegram_channel_connection_proofs where id=$1", [proof.id])).rows[0];
    assert(consumed.used_at); assert.equal(Number(consumed.event_id), 99102); assert.equal(Number(consumed.chat_id), CHAT);
    assert((await pool.query("select used_at from bot_links where code=$1", [payload.slice(0, 32)])).rows[0].used_at);
    await page.getByText(`Канал «${TITLE}» подключён и готов к публикациям.`, { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
    assert.equal(await page.evaluate(() => sessionStorage.getItem("aurora:telegram-channel-connection")), null);
    // A later membership notification cannot reuse the consumed intent.
    const repliesBeforeReplay = state.privateReplies;
    updates.push({ update_id: 99103, my_chat_member: membership });
    await waitFor(() => state.privateReplies > repliesBeforeReplay, "replayed Telegram membership was not handled", 30_000);
    await waitFor(async () => Number((await pool.query("select last_update from bot_state where id=1")).rows[0]?.last_update) >= 99103,
      "worker did not durably complete the replayed Telegram update", 30_000);
    assert.equal(Number((await pool.query("select count(*)::int as n from channels where network='tg' and tg_chat_id=$1", [CHAT])).rows[0].n), 1);
    assert.deepEqual(state.permissionChecks, [BOT, ACTOR], "consumed proof repeated provider permission/connect work");
    assert.equal(Number((await pool.query("select event_id from telegram_channel_connection_proofs where id=$1", [proof.id])).rows[0].event_id), 99102);
    await waitForFirstPartyNetworkIdle(page, "channel success before reload");
    await tracker.navigate("reload connected channel", () => page.reload());
    await page.getByText(TITLE, { exact: true }).waitFor({ state: "visible" });
    await waitForFirstPartyNetworkIdle(page, "persisted channel after reload");
    await readEvidence.settleReads(page);
    await bodyObserver.flush(page);
    const browserNetwork = tracker.snapshot();
    assert.deepEqual(browserNetwork.unexpected, [], "channel onboarding has unexpected browser/runtime failures");
    boundary.assertClean();
    transport.assertClean();
    result = { channelId: Number(channel.id), projectId, settingsLaunch: true, projectBoundOneTimeLink: true, actualWorkerProof: true,
      currentHumanAndBotPermissions: true, consumedProof: true, replayCreatesNoChannel: true, successUi: true, reload: true,
      fakeClientNavigations: clientBoundaryCount, realTelegramClient: false, realPublications: 0,
      browserBoundary: boundary.snapshot(),
      browserTransport: transport.snapshot(),
      expectedDeniedConnect: transport.expectedDeniedSnapshot(),
      nativeBodyObservations: bodyObserver.snapshot(),
      browserNetwork: { requests: browserNetwork.network.length, knownCancellations: browserNetwork.knownCancellations, unexpected: browserNetwork.unexpected } };
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await finalizeE2eBrowserLifecycle({ context, transport, boundary, error: primaryError,
      cleanup: [() => tracker?.stop(), () => browserErrors.stop()],
      assertDiagnostics: () => {
        browserErrors.assertClean();
        if (tracker) assert.deepEqual(tracker.snapshot().unexpected, [], "channel onboarding has unexpected browser/runtime failures after cleanup");
      },
      writeEvidence: async ({ error, externalAttempts, transportAttempts }) => {
        const browserNetwork = tracker?.snapshot();
        const final = { browserErrors: browserErrors.snapshot(), browserBoundary: externalAttempts, browserTransport: transportAttempts,
          browserNetwork: browserNetwork ? { requests: browserNetwork.network.length,
            knownCancellations: browserNetwork.knownCancellations, unexpected: browserNetwork.unexpected } : null,
          expectedDeniedConnect: transport.expectedDeniedSnapshot(), nativeBodyObservations: bodyObserver?.snapshot() ?? null,
          lifecycleFailure: Boolean(error) };
        if (result) Object.assign(result, final);
        if (artifactDir) await writeFile(join(artifactDir, "channel-onboarding-network.json"), JSON.stringify({
          ...(browserNetwork ?? { unexpected: [{ kind: "onboarding_setup_incomplete" }] }), ...final,
        }, null, 2) + "\n");
      },
    });
  }
}

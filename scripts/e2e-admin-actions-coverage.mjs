import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";
import { createE2eBrowserContext } from "./e2e-browser-context.mjs";
import { installE2eBrowserBoundary } from "./e2e-browser-boundary.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

// Only synthetic accounts in the explicitly disposable journey database are changed.
export async function runAdminActionsCoverage({ page, browser, baseUrl, pool, actorUserId, waitFor, captureScreenshot, artifactDir }) {
  const targetEmail = `admin-action-target-${randomBytes(8).toString("hex")}@aurora.test`;
  const targetUserId = Number((await pool.query(
    "insert into users(email,name,verified_email,onboarding_completed_at) values($1,'Проверка действий QA',$1,now()) returning id", [targetEmail],
  )).rows[0].id);
  const { context: targetContext, transport } = await createE2eBrowserContext(browser, { baseUrl, ignoreHTTPSErrors: true });
  let boundary; let failure; let result;
  try {
  boundary = await installE2eBrowserBoundary(targetContext, { baseUrl });
  const issueSession = async () => {
    const token = randomBytes(32).toString("base64url");
    const verifier = createHash("sha256").update(token).digest("hex");
    await pool.query(
      "insert into sessions(token_hash,user_id,expires_at,credential_epoch) select $1,id,now()+interval '1 hour',credential_epoch from users where id=$2", [verifier, targetUserId],
    );
    await targetContext.addCookies([{ name: "sid", value: token, url: baseUrl, httpOnly: true, secure: true, sameSite: "Lax" }]);
    return { verifier, token };
  };
  const actionUrl = `${baseUrl}/api/admin/users/${targetUserId}/actions`;
  const journal = async () => (await pool.query(
    "select actor_user_id,action,reason,request_id from admin_account_actions where target_user_id=$1 order by id", [targetUserId],
  )).rows;
  const confirm = async (action, button) => {
    const response = page.waitForResponse((r) => r.url() === actionUrl && r.request().method() === "POST");
    await button.click();
    const received = await response;
    assert.equal(received.status(), 200);
    const receipt = await received.json();
    assert.deepEqual({ status: receipt.status, action: receipt.action, targetUserId: receipt.targetUserId }, { status: "ok", action, targetUserId });
    assert.equal(receipt.requestId, received.headers()["x-request-id"]);
    return receipt;
  };
    const firstSession = await issueSession();
    assert.equal((await targetContext.request.get("/api/auth/me")).status(), 200);
    const ordinaryMutation = await targetContext.request.post(actionUrl, { headers: { origin: baseUrl }, data: { action: "block", reason: "must be rejected" } });
    assert.equal(ordinaryMutation.status(), 403, "ordinary account gained admin mutation authority");
    assert.equal((await journal()).length, 0);
    const projectId = Number((await pool.query("insert into projects(name,created_by_user_id) values('Admin action preservation QA',$1) returning id", [targetUserId])).rows[0].id);
    await pool.query("insert into project_members(project_id,user_id,role,status) values($1,$2,'owner','active')", [projectId, targetUserId]);
    const draftId = Number((await pool.query("insert into drafts(user_id,project_id,text,origin,client_key) values($1,$2,'Сохранённые данные администратора QA','manual','admin-action-preserved-draft') returning id", [targetUserId, projectId])).rows[0].id);
    const epochBefore = Number((await pool.query("select credential_epoch from users where id=$1", [targetUserId])).rows[0].credential_epoch);
    await page.goto(`/admin?user=${targetUserId}#users`);
    const controls = page.getByRole("region", { name: "Действия администратора", exact: true });
    await controls.waitFor();
    const block = controls.getByRole("button", { name: "Заблокировать", exact: true });
    await block.click();
    let dialog = page.getByRole("dialog", { name: "Заблокировать «Проверка действий QA»?", exact: true });
    await dialog.waitFor();
    await waitFor(() => dialog.getByRole("button", { name: "Отмена", exact: true }).evaluate((el) => el === document.activeElement), "block dialog must focus safe cancellation");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await journal()).length, 0, "cancelling confirmation caused an administrative effect");
    await block.click();
    dialog = page.getByRole("dialog", { name: "Заблокировать «Проверка действий QA»?", exact: true });
    await dialog.getByRole("textbox").fill("Изолированная проверка отзыва доступа");
    let blocked;
    let blockRequests = 0;
    await page.route(actionUrl, async (route) => {
      blockRequests += 1;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      blocked = await response.json();
      assert.deepEqual({ status: blocked.status, action: blocked.action, targetUserId: blocked.targetUserId }, { status: "ok", action: "account.blocked", targetUserId });
      // The actual Next transaction commits; only its browser receipt is lost.
      await route.fulfill({ response, body: '{"status":' });
    });
    try {
      await dialog.getByRole("button", { name: "Заблокировать", exact: true }).click();
      await dialog.getByRole("alert").filter({ hasText: "Не удалось подтвердить результат" }).waitFor();
      assert.equal(await dialog.getByRole("textbox").inputValue(), "Изолированная проверка отзыва доступа");
      assert.equal(blockRequests, 1, "uncertain administrative action was retried automatically");
    } finally { await page.unroute(actionUrl); }
    assert(blocked, "fault injection must observe the real committed receipt");
    const blockedRow = (await pool.query("select blocked_at,credential_epoch from users where id=$1", [targetUserId])).rows[0];
    assert(blockedRow.blocked_at);
    assert.equal(Number(blockedRow.credential_epoch), epochBefore + 1);
    assert.equal((await targetContext.request.get("/api/auth/me")).status(), 401);
    assert.equal(Number((await pool.query("select count(*) as n from sessions where token_hash=$1 and expires_at>now()", [firstSession.verifier])).rows[0].n), 0);
    let events = await journal();
    assert.equal(events.length, 1);
    assert.equal(Number(events[0].actor_user_id), actorUserId);
    assert.equal(events[0].request_id, blocked.requestId);
    assert.equal(events[0].reason, "Изолированная проверка отзыва доступа");
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    // Reload performs a new authorized read, resolving the unconfirmed UI state.
    await page.reload();
    await controls.getByRole("button", { name: "Разблокировать", exact: true }).waitFor();
    assert.equal((await journal()).length, 1, "read-based recovery repeated the administrative effect");
    await confirm("account.unblocked", controls.getByRole("button", { name: "Разблокировать", exact: true }));
    await controls.getByRole("button", { name: "Заблокировать", exact: true }).waitFor();
    assert.equal((await pool.query("select blocked_at from users where id=$1", [targetUserId])).rows[0].blocked_at, null);
    // The earlier 401 cleared the context cookie. Explicitly replay the original
    // credential; anonymous 200 {user:null} cannot prove old-session invalidation.
    assert.equal((await targetContext.request.get("/api/auth/me", { headers: { cookie: `sid=${firstSession.token}` } })).status(), 401, "unblock resurrected an old session");
    await issueSession();
    assert.equal((await targetContext.request.get("/api/auth/me")).status(), 200);
    await controls.getByRole("button", { name: "Завершить все сессии", exact: true }).click();
    const revoke = page.getByRole("dialog", { name: "Завершить все сессии?", exact: true });
    await confirm("account.sessions_revoked", revoke.getByRole("button", { name: "Завершить сессии", exact: true }));
    await revoke.waitFor({ state: "hidden" });
    assert.equal((await targetContext.request.get("/api/auth/me")).status(), 401);
    assert.equal(Number((await pool.query("select count(*) as n from sessions where user_id=$1 and expires_at>now()", [targetUserId])).rows[0].n), 0);
    assert.equal((await pool.query("select text from drafts where id=$1 and project_id=$2 and user_id=$3", [draftId, projectId, targetUserId])).rows[0].text, "Сохранённые данные администратора QA");
    events = await journal();
    assert.deepEqual(events.map((event) => event.action), ["account.blocked", "account.unblocked", "account.sessions_revoked"]);
    assert(events.every((event) => Number(event.actor_user_id) === actorUserId));
    await captureScreenshot(page, { path: `${artifactDir}/interface-admin-actions.png`, fullPage: true });
    return result = { target: "synthetic-only", ordinaryMutation: 403, confirmationCancelEffects: 0, lostBlockReceipt: { serverCommitted: true, uiUnconfirmed: true, effects: 1, automaticRetry: false, recoveredByAuthorizedRead: true }, blockRevokesCurrentSession: true, unblockDoesNotReviveSession: true, revokeNewSession: true, contentPreserved: true, journalActions: events.map((event) => event.action), exactActorAndReceipt: true, realAccountsChanged: false };
  } catch (error) { failure = error; throw error; }
  finally {
    await finalizeE2eBrowserLifecycle({ context: targetContext, transport, boundary, error: failure,
      writeEvidence: ({ externalAttempts, transportAttempts }) => { if (result) Object.assign(result, { externalAttempts, transportAttempts }); } });
  }
}

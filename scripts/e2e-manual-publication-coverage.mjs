import {selectProjectWithSettledReads} from "./e2e-project-selection.mjs";
import assert from "node:assert/strict";

export const E2E_MANUAL_PUBLICATION_TEXT = "E2E_MANUAL_IMMEDIATE\nРучная редакционная заметка: сохраняем выбранный текст без новых фактических утверждений.";

export async function prepareManualPublicationCoverage({ page, pool, baseUrl, userId, channelId, readEditableText, waitFor, waitForFirstPartyNetworkIdle }) {
  assert(["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "manual publication coverage requires the isolated fake-provider runtime");
  const projectId = Number((await pool.query("select project_id from channels where id=$1 and user_id=$2", [channelId, userId])).rows[0]?.project_id);
  assert(Number.isSafeInteger(projectId) && projectId > 0);
  const operationRequests = [];
  const observe = (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/publication-operations") operationRequests.push(request.postDataJSON());
  };
  page.on("request", observe);
  try {
    await waitForFirstPartyNetworkIdle(page, "before new manual editor");
    await page.goto(`/app/composer?channel=${channelId}`);
    const editor = page.locator("#composer-text");
    await editor.waitFor();
    await waitForFirstPartyNetworkIdle(page, "new manual editor hydration");
    assert.equal(await readEditableText(editor), "", "new manual editor must start with a blank draft");
    const otherActions = page.locator("summary").filter({ hasText: /^Другие действия$/u });
    if (await otherActions.isVisible()) await otherActions.click();
    const publish = page.getByRole("button", { name: "Опубликовать сейчас", exact: true });
    await publish.click();
    await page.getByText("Пост пустой. Напиши что-нибудь или попроси ИИ.", { exact: true }).waitFor();
    assert.equal(operationRequests.length, 0, "empty editor submitted a publication");
    await waitFor(() => editor.evaluate((el) => el === document.activeElement), "empty manual publication did not focus its error");
    await editor.fill(E2E_MANUAL_PUBLICATION_TEXT);
    await waitForFirstPartyNetworkIdle(page, "new manual draft autosave");
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/publication-operations" && response.request().method() === "POST");
    void responsePromise.catch(() => undefined);
    const before = Date.now();
    await publish.click();
    const response = await responsePromise;
    const body = await response.json();
    assert([200, 201].includes(response.status()), `manual immediate publication rejected: ${response.status()}/${body.error}`);
    const operationId = Number(body.operationId);
    assert(Number.isSafeInteger(operationId) && operationId > 0);
    await page.waitForURL((url) => url.pathname === "/app/calendar");
    await waitForFirstPartyNetworkIdle(page, "manual publication Calendar acknowledgement");
    assert.equal(operationRequests.length, 1, "one manual click created repeated operation requests");
    const rows = (await pool.query(`select p.id as post_id,p.text,p.channel_id,p.status,p.scheduled_at,
      d.id as draft_id,d.origin,d.version,o.project_id,o.draft_version,
      o.approved_revision_id as operation_revision_id,o.approved_content_hash as operation_content_hash,
      o.approved_draft_version,w.state,w.approved_revision_id,w.approved_content_hash,
      r.id as revision_id,r.content_hash,count(x.id) over()::int as outbox_count
      from publication_operations o join drafts d on d.id=o.draft_id
      join posts p on p.publication_operation_id=o.id
      join draft_editorial_workflows w on w.draft_id=d.id and w.project_id=o.project_id
      join draft_revisions r on r.id=w.approved_revision_id
      join publication_outbox x on x.operation_id=o.id and x.post_id=p.id
      where o.id=$1`, [operationId])).rows;
    assert.equal(rows.length, 1, "manual publication must have exactly one destination and outbox row");
    const row = rows[0];
    assert.equal(row.text, E2E_MANUAL_PUBLICATION_TEXT);
    assert.equal(Number(row.channel_id), channelId);
    assert.equal(Number(row.project_id), projectId);
    assert.equal(row.origin, "manual");
    assert.equal(row.state, "approved", "personal owner click did not approve the exact saved revision");
    assert.equal(row.approved_content_hash, row.content_hash);
    assert.equal(row.operation_content_hash, row.content_hash, "operation did not consume the approved content hash");
    assert.equal(Number(row.operation_revision_id), Number(row.revision_id));
    assert.equal(Number(row.approved_revision_id), Number(row.revision_id));
    assert.equal(Number(row.approved_draft_version), Number(row.version));
    assert.equal(Number(row.draft_version), Number(row.version));
    assert.equal(row.outbox_count, 1);
    const due = new Date(row.scheduled_at).getTime();
    assert(due >= before && due <= Date.now() + 120_000, "immediate UI did not use its bounded next dispatch slot");
    await page.locator(`#calendar-open-real-${row.post_id}`).waitFor({ state: "visible" });
    return { draftId: Number(row.draft_id), operationId, postId: Number(row.post_id), projectId, channelId, scheduledAt: new Date(row.scheduled_at).toISOString(), emptyPrevented: true, errorFocused: true, createdThroughUi: true, exactPersonalApproval: true, outboxCount: 1 };
  } finally { page.off("request", observe); }
}

export async function verifyManualPublicationDelivery({ evidence, page, pool, fakeRequests, waitFor, waitForFirstPartyNetworkIdle, settleReads }) {
  await waitFor(async () => (await pool.query("select status from posts where id=$1", [evidence.postId])).rows[0]?.status === "published", "manual UI publication did not reach the fake provider", 15_000);
  const parts = (await pool.query("select send_status,external_message_id from publication_parts where post_id=$1 order by part_index", [evidence.postId])).rows;
  assert.equal(parts.length, 1);
  assert.equal(parts[0].send_status, "sent");
  assert.equal(String(parts[0].external_message_id), "1201");
  assert.equal(fakeRequests.length, 1, "manual UI publication produced duplicate provider effects");
  assert.equal(fakeRequests[0].text, E2E_MANUAL_PUBLICATION_TEXT, "provider received text different from the approved editor");
  assert.equal(Number(fakeRequests[0].chat_id), -100900000002);
  await waitForFirstPartyNetworkIdle(page, "before manual publication delivery UI");
  const priorViewport = page.viewportSize();
  const priorProject = await page.evaluate(() => Number(sessionStorage.getItem("aurora:request-project-id")));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/calendar");
  await selectProjectWithSettledReads(page, evidence.projectId, {waitFor, settleReads});
  await waitForFirstPartyNetworkIdle(page, "manual delivery project selection");
  await page.goto(`/app/calendar#calendar-real-${evidence.postId}`);
  await page.locator(`#calendar-real-${evidence.postId}`).getByText("Опубликовано", { exact: true }).waitFor({ state: "visible" });
  await waitForFirstPartyNetworkIdle(page, "manual delivery state rendered");
  if (priorProject !== evidence.projectId) {
    await selectProjectWithSettledReads(page, priorProject, {waitFor, settleReads});
    await waitForFirstPartyNetworkIdle(page, "manual delivery prior project restored");
  }
  if (priorViewport) await page.setViewportSize(priorViewport);
  return { ...evidence, delivered: true, publishedUi: true, providerEffects: 1, durableReceipt: "1201", exactProviderText: true, realPublications: 0 };
}

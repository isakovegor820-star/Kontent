import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, firefox, webkit } from "playwright-core";

// Real CalendarPage, pointer events, range hook and CSS. HTTP is synthetic: no
// database, worker or external publication is started by this regression test.
const artifactDir = resolve(process.env.E2E_ARTIFACT_DIR || "test-results/calendar-return");
const browsers = { chromium, firefox, webkit };
const selectedBrowser = process.env.E2E_BROWSER;
assert(!selectedBrowser || Object.hasOwn(browsers, selectedBrowser), "E2E_BROWSER must be chromium, firefox or webkit");
await mkdir(artifactDir, { recursive: true });
const fixture = spawn(process.execPath, ["scripts/preview-calendar-autopilot-drag.mjs"], {
  env: { ...process.env, CALENDAR_PREVIEW_PORT: "0", E2E_ARTIFACT_DIR: artifactDir },
  stdio: ["ignore", "pipe", "pipe"],
});
const results = [];
try {
  const baseUrl = await new Promise((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Fixture did not start: ${output}`)), 30_000);
    fixture.on("error", error => { clearTimeout(timer); reject(error); });
    fixture.on("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${output}`)); });
    fixture.stderr.on("data", chunk => { output += chunk; });
    fixture.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/Calendar fixture: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); done(match[1]); }
    });
  });
  for (const [engine, browserType] of Object.entries(browsers)) {
    if (selectedBrowser && selectedBrowser !== engine) continue;
    const browser = await browserType.launch({ headless: true });
    try {
      for (const kind of ["autopilot", "publication", "draft"]) {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 }, timezoneId: "America/New_York",
          reducedMotion: kind === "draft" ? "reduce" : "no-preference",
        });
        const page = await context.newPage();
        page.setDefaultTimeout(8_000);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        let scheduled = "2030-04-10T10:00:00.000Z", revision = 1;
        let rejectNext = false, holdReads = false;
        const pendingReads = new Set();
        const requests = [];
        const post = () => ({
          id: 12001, author_user_id: 1, author_name: "Тестовый автор", text: "Проверка возврата поста",
          scheduled_at: scheduled, status: "scheduled", publication_origin: kind === "autopilot" ? "autopilot" : "manual",
          autopilot_can_reschedule: true, schedule_revision: revision, created_at: "2030-01-01T00:00:00Z",
          channel_id: 8, channel_title: "Тестовый канал", network: "tg", attempts: 0, publication_parts: [],
          publication_draft_id: kind === "publication" ? 41 : null,
          publication_operation_id: kind === "publication" ? 81 : null,
          publication_operation_status: kind === "publication" ? "queued" : null,
          operation_schedule_revision: kind === "publication" ? revision : null,
          scheduled_timezone: "Europe/Amsterdam", scheduled_offset: "+02:00", scheduled_disambiguation: "reject",
        });
        const draft = () => ({
          id: 41, author_user_id: 1, author_name: "Тестовый автор", text: "Проверка возврата поста",
          scheduled_at: scheduled, scheduled_timezone: "Europe/Amsterdam", scheduled_offset: "+02:00",
          scheduled_disambiguation: "reject", version: revision, editorial_state: "draft", origin: "manual",
          purpose: "publishable", client_key: "calendar-return", media: null, source_ref: null,
          created_at: "2030-01-01T00:00:00Z", updated_at: "2030-01-01T00:00:00Z",
          destinations: [{ channel_id: 8, network: "tg", title: "Тестовый канал", is_active: true }],
        });
        await context.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== baseUrl) return route.abort();
          if (!url.pathname.startsWith("/api/")) return route.continue();
          assert.equal(request.headers()["x-aurora-project-id"], "7");
          const json = (body, code = 200) => route.fulfill({ status: code, contentType: "application/json", headers: { "x-aurora-project-id": "7" }, body: JSON.stringify(body) });
          if (request.method() === "PATCH") {
            const input = request.postDataJSON();
            requests.push({ path: url.pathname, input });
            if (rejectNext) { rejectNext = false; return json({ ok: false, error: "version_conflict" }, 409); }
            const expected = kind === "autopilot" ? input.scheduleRevision : kind === "publication" ? input.expectedScheduleRevision : input.version;
            if (expected !== revision) return json({ ok: false, error: "schedule_revision_conflict" }, 409);
            assert.equal(input.schedule?.localTime ?? input.localTime, "12:00", "project-local time is preserved");
            scheduled = input.scheduledAt; revision++;
            if (kind === "draft") return json({ ok: true, draft: draft() });
            if (kind === "publication") return json({ ok: true, operationId: 81, status: "scheduled", operationStatus: "queued", scheduledAt: scheduled, scheduleRevision: revision });
            return json({ ok: true, ...input, scheduleRevision: revision, queuePending: false });
          }
          if (url.pathname === "/api/posts" || url.pathname === "/api/drafts") {
            const key = url.pathname.endsWith("posts") ? "posts" : "drafts";
            const inRange = Date.parse(scheduled) >= Date.parse(url.searchParams.get("from") + "T00:00:00Z") && Date.parse(scheduled) < Date.parse(url.searchParams.get("to") + "T00:00:00Z");
            const records = key === "posts" ? kind === "draft" ? [] : [post()] : kind === "draft" ? [draft()] : [];
            const body = { [key]: url.searchParams.has("id") ? [post()] : inRange ? records : [], hasMore: false, nextCursor: null };
            if (holdReads && !url.searchParams.has("id")) await new Promise(done => pendingReads.add(done));
            return json(body);
          }
          return json({ ok: true, items: [], members: [], campaigns: [] });
        });
        const id = kind === "draft" ? "draft-41" : "real-12001";
        const card = page.locator(`#calendar-${id}`);
        const open = page.locator(`#calendar-open-${id}`);
        const isOn = async day => {
          await page.waitForFunction(({ id, day }) => {
            const el = document.getElementById(`calendar-${id}`);
            return el?.closest("[data-calendar-day]")?.dataset.calendarDay === day && !el.hasAttribute("aria-busy") && getComputedStyle(el).pointerEvents !== "none";
          }, { id, day });
        };
        const begin = async () => {
          await open.scrollIntoViewIfNeeded();
          // Finish the existing shared-layout animation before taking coordinates.
          await page.waitForFunction(id => {
            const el = document.getElementById(`calendar-${id}`);
            return el && getComputedStyle(el).transform === "none";
          }, id);
          const box = await open.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + 32);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width / 2 + 18, box.y + 32, { steps: 3 });
          await page.locator('[data-calendar-dragging="true"]').waitFor();
          return box.y + 32;
        };
        const drop = async (day, y) => {
          const box = await page.locator(`[data-calendar-day="${day}"]`).boundingBox();
          await page.mouse.move(box.x + box.width / 2, y, { steps: 12 });
          await page.mouse.up();
        };
        const move = async (day, refreshDuringDrag = false) => {
          const y = await begin();
          if (refreshDuringDrag) {
            const response = page.waitForResponse(response => response.url().includes("/api/posts?view=range"));
            await page.evaluate(() => window.dispatchEvent(new Event("fixture-refresh")));
            await response;
            await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
            assert.equal(await page.locator('[data-calendar-dragging="true"]').count(), 1, "range refresh must not cancel an active return drag");
          }
          await drop(day, y);
          await isOn(day);
        };
        try {
          await page.goto(baseUrl + "/#calendar-real-12001");
          await isOn("2030-04-10");
          await move("2030-04-11");
          await move("2030-04-10", true);
          assert.equal(revision, 3);
          assert.equal(requests.length, 2);
          assert.equal(scheduled, "2030-04-10T10:00:00.000Z");
          assert.match(await page.locator("#qa-status").innerText(), /^Публикация перенесена/);

          // A successful save must stay usable even while its follow-up read is slow.
          holdReads = true;
          await move("2030-04-12");
          await move("2030-04-10");
          assert.equal(revision, 5, "return uses the acknowledged revision before refresh finishes");
          holdReads = false; pendingReads.forEach(done => done()); pendingReads.clear();
          await page.reload(); await isOn("2030-04-10");

          // Same-day and Escape are cancellation, never a save or an editor click.
          const beforeCancel = requests.length;
          let y = await begin(); await drop("2030-04-10", y);
          y = await begin(); await page.keyboard.press("Escape"); await page.mouse.up();
          assert.equal(requests.length, beforeCancel);
          assert.equal(await page.getByRole("dialog").count(), 0);
          assert.doesNotMatch(await page.locator("#qa-status").innerText(), /Открыт редактор/);

          // Keyboard alternative and reload persistence remain intact.
          await page.waitForTimeout(750); // Pointer click-suppression window.
          const handle = card.getByRole("button", { name: /Перетащить или выбрать другой день/ });
          await handle.focus(); await page.keyboard.press("Enter");
          await page.getByRole("dialog", { name: "Перенести публикацию" }).getByRole("button", { name: /четверг/i }).click();
          await isOn("2030-04-11");
          await move("2030-04-10");

          rejectNext = true;
          y = await begin(); await drop("2030-04-11", y);
          await page.waitForFunction(() => /не перенесена|не выполнено|не подтверждён|Черновик уже изменён/.test(document.getElementById("qa-status").textContent));
          await isOn("2030-04-10");
          await move("2030-04-11"); await move("2030-04-10");
          await page.reload(); await isOn("2030-04-10");
          assert.equal(scheduled, "2030-04-10T10:00:00.000Z");
          assert.deepEqual(errors, []);
          await page.screenshot({ path: resolve(artifactDir, `${engine}-${kind}.png`), fullPage: true });
          if (kind === "draft") {
            await page.setViewportSize({ width: 390, height: 844 });
            await open.scrollIntoViewIfNeeded();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            await page.screenshot({ path: resolve(artifactDir, `${engine}-mobile.png`), fullPage: true });
          }
          results.push({ engine, kind, ok: true, requests, revision, scheduled });
          console.log(`${engine}/${kind}: return drag, refresh mid-gesture, slow reads, keyboard, cancel, failed save/retry, reload PASS`);
        } catch (error) {
          await page.screenshot({ path: resolve(artifactDir, `${engine}-${kind}-failure.png`), fullPage: true });
          throw error;
        } finally {
          pendingReads.forEach(done => done());
          await context.close();
        }
      }
    } finally { await browser.close(); }
  }
  await writeFile(resolve(artifactDir, "browser-result.json"), JSON.stringify({ ok: true, results }, null, 2));
} finally { fixture.kill(); }

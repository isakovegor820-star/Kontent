import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { selectProjectWithSettledReads } from "./e2e-project-selection.mjs";

// Execute the complete exported journey with bounded dependency fixtures. Its
// navigation statements, awaits, project guards and finalizer are not replaced.
const source = readFileSync(new URL("./e2e-project-calendar-coverage.mjs", import.meta.url), "utf8");
const exported = source.slice(source.indexOf("export async function runProjectCalendarCoverage"))
  .replace("export async function", "async function");

function harness({ delayedMethod } = {}) {
  const calls = []; let preference = 1; let cancellationCommitted = false;
  let firstTraffic;
  const seeded = { key: "synthetic-calendar", text: "QA calendar", scheduledAt: new Date(Date.now() + 60 * 86_400_000).toISOString(), postId: 40, operationId: 30, historyCount: 1205 };
  const moved = new Date(Date.now() + 61 * 86_400_000).toISOString();
  function page(name) {
    const locator = { first: () => locator, getByRole: () => locator, waitFor: async () => {}, click: async () => {}, inputValue: async () => String(target.project),
      isDisabled: async () => false, selectOption: async id => { target.project = Number(id); preference = Number(id); } };
    const target = { name, project: name === "first" ? 2 : 1, setViewportSize: async () => {}, bringToFront: async () => {},
      goto: vi.fn(async url => { calls.push({ type: "goto", page: name, url }); }),
      reload: vi.fn(async () => { calls.push({ type: "reload", page: name }); }),
      getByRole: () => locator, evaluate: async () => target.project, waitForURL: async () => {}, close: vi.fn(async () => {}) };
    return target;
  }
  const first = page("first"); const other = page("other");
  const pool = { options: { connectionString: "postgresql://localhost/aurora_e2e_real" }, query: async sql => {
    if (sql.includes("selected_project_id")) return { rows: [{ selected_project_id: preference }] };
    if (sql.includes("count(*)")) return { rows: [{ count: 1205 }] };
    if (sql.includes("publication_operations operation")) {
      cancellationCommitted = true;
      return { rows: [{ status: "cancelled", post_status: "cancelled", schedule_revision: 3, provider_started_at: null, published_at: null }] };
    }
    if (sql.includes("from posts where id=")) return { rows: [{ status: "scheduled", schedule_revision: 2, scheduled_at: moved, project_id: 2 }] };
    throw new Error("Unrecognized fixture SQL");
  } };
  const observeProjectTraffic = target => {
    const reads = [];
    const mutations = ["PATCH", "DELETE"].filter(method => method !== delayedMethod).map(method => ({ path: "/api/publication-operations/30", method, status: 200, projectHeader: "2" }));
    if (target === first) firstTraffic = { mutations };
    return { reads, mutations, stop() {}, async settle() {
      for (let i = 0; i < 2; i++) reads.push({ path: "/api/posts?limit=200", projectHeader: String(target.project), responseProjectId: target.project, ids: target.project === 2 ? [40] : [] });
    } };
  };
  const create = new Function("assert", "fixture", "observeProjectTraffic", "selectProjectWithSettledReads", "tabProject", "TIMEOUT", "writeFile", "join", `return (${exported});`);
  const run = create(assert, async () => seeded, observeProjectTraffic,
    selectProjectWithSettledReads, async target => target.project,
    60_000, async () => {}, (...parts) => parts.join("/"));
  return { first, other, calls, cancellationCommitted: () => cancellationCommitted,
    response: record => firstTraffic.mutations.push({ path: "/api/publication-operations/30", method: delayedMethod, status: 200, projectHeader: "2", ...record }),
    input: { page: first, context: { newPage: async () => other }, pool, userId: 1, sharedProjectId: 2, legacyProjectId: 1, sharedChannelId: 3, artifactDir: "/synthetic-evidence",
    settleReads: vi.fn(async () => {}), waitFor: async (check, label) => {
      const deadline = Date.now() + 250;
      do { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 2)); } while (Date.now() < deadline);
      throw new Error(label);
    } }, run };
}

describe("Project/calendar journey navigation ownership", () => {
  const transitions = [
    ["goto", "first", "/app/calendar"],
    ["goto", "other", "/app/calendar"],
    ["goto", "first", "/app/calendar#calendar-real-40"],
    ["goto", "first", "/app/calendar"],
    ["reload", "other", undefined],
  ];

  it.each(transitions.map((value, index) => [index, ...value]))("awaits boundary %i for %s on %s", async (index) => {
    const h = harness(); let release;
    const held = new Promise(resolve => { release = resolve; });
    const boundaries = [];
    const visit = async (type, target, url, options) => {
      const position = boundaries.push([type, target.name, url]) - 1;
      if (position === index) await held;
      return type === "reload" ? target.reload() : target.goto(url, options);
    };
    const outcome = h.run({ ...h.input, navigate: (target, url, options) => visit("goto", target, url, options), reload: target => visit("reload", target) });
    await vi.waitFor(() => expect(boundaries).toHaveLength(index + 1));
    expect(h.calls).toHaveLength(index);
    release();
    expect((await outcome).finalRevision).toBe(3);
    expect(boundaries).toEqual(transitions);
    expect(h.calls).toHaveLength(5);
    expect(h.other.close).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2, 3, 4])("propagates failed read boundary %i before its navigation", async index => {
    const h = harness(); const failure = new Error("Captured GET failed before navigation"); let count = 0;
    const visit = async (type, target, url) => {
      if (count++ === index) throw failure;
      return type === "reload" ? target.reload() : target.goto(url);
    };
    await expect(h.run({ ...h.input, navigate: (target, url) => visit("goto", target, url), reload: target => visit("reload", target) })).rejects.toBe(failure);
    expect(h.calls).toHaveLength(index);
    expect(h.other.close).toHaveBeenCalledOnce();
  });

  it("keeps standalone native defaults and the two distinct tab identities", async () => {
    const h = harness(); const result = await h.run(h.input);
    expect(h.calls.map(({ type, page, url }) => [type, page, url])).toEqual(transitions);
    expect(result.firstTabProject).toBe(2); expect(result.secondTabProject).toBe(1);
    expect(result.finalRevision).toBe(3); expect(result.providerStartedAt).toBeNull();
    expect(h.input.settleReads).toHaveBeenCalledTimes(8);
  });

  it("rejects a non-isolated database before any navigation", async () => {
    const h = harness(); h.input.pool.options.connectionString = "postgresql://localhost/user_database";
    await expect(h.run(h.input)).rejects.toThrow("isolated aurora_e2e_real");
    expect(h.calls).toEqual([]);
  });

  it.each(["PATCH", "DELETE"])("waits for the %s response after the database has committed", async delayedMethod => {
    const h = harness({ delayedMethod }); let settled = false;
    const outcome = h.run(h.input).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    await vi.waitFor(() => expect(h.cancellationCommitted()).toBe(true));
    expect(settled, "A database commit is not HTTP response evidence").toBe(false);
    h.response({});
    const result = await outcome;
    expect(result.error).toBeUndefined(); expect(result.value.finalRevision).toBe(3);
    expect(h.other.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["wrong project", { projectHeader: "1" }],
    ["missing project", { projectHeader: null }],
    ["failed response", { status: 503 }],
    ["another operation", { path: "/api/publication-operations/31" }],
    ["another method", { method: "POST" }],
  ])("rejects %s even though cancellation is committed", async (_label, response) => {
    const h = harness({ delayedMethod: "DELETE" });
    const outcome = h.run(h.input).then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(h.cancellationCommitted()).toBe(true));
    h.response(response);
    expect((await outcome).error?.message).toMatch(/captured project identity/u);
    expect(h.other.close).toHaveBeenCalledOnce();
  });
});

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("./test-e2e-real.mjs", import.meta.url), "utf8");
const start = source.indexOf('  const done = targetPage.getByRole("button", { name: "Готово", exact: true });');
const end = source.indexOf("  await reviewHeading.waitFor", start);
if (start < 0 || end <= start) throw new Error("Actual Today action sequence is missing");

function fixture(failedPhase) {
  const events = [];
  const controls = new Map(["Готово", "Вернуть"].map(name => [name, {
    name,
    waitFor: async () => { events.push(`${name}:rendered`); },
    isEnabled: async () => { events.push(`${name}:enabled`); return true; },
  }]));
  const page = {
    getByRole: (role, options) => {
      if (role === "heading") return { evaluate: async () => true };
      expect(options.exact).toBe(true);
      const control = controls.get(options.name);
      expect(control).toBeDefined();
      return control;
    },
    evaluate: async () => true,
    keyboard: { press: async key => { expect(key).toBe("Enter"); events.push("Enter"); } },
  };
  const runTodayFocusCoverage = vi.fn(async options => {
    expect(options.page).toBe(page);
    expect(options.engine).toBe("webkit");
    expect(options.captureScreenshot).toBe(state.captureE2eScreenshot);
    expect(options.artifactDir).toBe("/tmp/isolated-today-focus");
    expect(options.locator).toBe(controls.get(options.controlName));
    events.push(`focus:${options.phase}`);
    if (options.phase === failedPhase) throw new Error("Native control is covered");
    return { ok: true, rows: [{ pass: true }] };
  });
  const state = { targetPage: page, browserEngine: "webkit", artifactDir: "/tmp/isolated-today-focus",
    UI_WAIT_TIMEOUT_MS: 30000, captureE2eScreenshot: vi.fn(), runTodayFocusCoverage,
    tabTo: async (_page, control) => { events.push(`tab:${control.name}`); return 1; },
    waitFor: async check => { expect(await check()).toBe(true); },
  };
  vm.createContext(state);
  return { events, runTodayFocusCoverage, run: () => vm.runInContext(`(async () => { ${source.slice(start, end)} })()`, state) };
}

it("actual Today flow verifies focus before Done and after confirmed Undo becomes available", async () => {
  const { events, run, runTodayFocusCoverage } = fixture();
  await run();
  expect(runTodayFocusCoverage).toHaveBeenCalledTimes(2);
  expect(events).toEqual(["focus:before-done", "tab:Готово", "Enter", "Вернуть:rendered", "Вернуть:enabled",
    "focus:confirmed-undo", "tab:Вернуть", "Enter"]);
});

it.each([
  { phase: "before-done", allowedActions: 0 },
  { phase: "confirmed-undo", allowedActions: 1 },
])("a failed native $phase focus check stops the corresponding action", async ({ phase, allowedActions }) => {
  const { events, run } = fixture(phase);
  await expect(run()).rejects.toThrow("Native control is covered");
  expect(events.filter(event => event === "Enter")).toHaveLength(allowedActions);
});

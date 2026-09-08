import { afterEach, describe, expect, it, vi } from "vitest";
import { saveE2eComposerDraft } from "./e2e-composer-save.mjs";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function composer({ saved = false } = {}) {
  let summary = saved ? "Сохранено в 12:00" : "Есть изменения";
  const click = vi.fn(() => { summary = "Сохранено в 12:01"; });
  const button = {
    waitFor: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn().mockResolvedValue("false"),
    textContent: vi.fn().mockResolvedValue(saved ? "Сохранено" : "Сохранить сейчас"),
    isEnabled: vi.fn().mockResolvedValue(true),
    evaluate: vi.fn(async (callback) => callback({ click })),
  };
  const summaryText = vi.fn(async () => summary);
  const readVisibleText = vi.fn().mockResolvedValue("Точный текущий текст");
  const readStoredText = vi.fn().mockResolvedValue("Точный текущий текст");
  return {
    button, click, summaryText, readStoredText, readVisibleText,
    input: {
      protection: { getByRole: () => button, locator: () => ({ textContent: summaryText }) },
      readVisibleText, readStoredText, timeoutMs: 1000,
    },
  };
}

describe("E2E Composer save acknowledgement", () => {
  it("accepts completed autosave after the disclosure closes without accessing its missing button", async () => {
    const state = composer();
    state.summaryText.mockResolvedValue("Сохранено в 12:01");
    state.button.textContent.mockReset()
      .mockResolvedValueOnce("Сохранить сейчас")
      .mockRejectedValue(new Error("button disappeared"));
    await saveE2eComposerDraft(state.input);
    expect(state.button.textContent).toHaveBeenCalledTimes(1);
    expect(state.button.isEnabled).not.toHaveBeenCalled();
    expect(state.click).not.toHaveBeenCalled();
    expect(state.readStoredText).toHaveBeenCalledTimes(1);
    expect(state.readVisibleText).toHaveBeenCalledTimes(1);
  });

  it("waits for an enabled button, saves once, and then verifies durable text", async () => {
    vi.useFakeTimers();
    const state = composer();
    state.button.isEnabled.mockResolvedValueOnce(false).mockResolvedValue(true);
    const outcome = saveE2eComposerDraft(state.input);
    await vi.advanceTimersByTimeAsync(151);
    await outcome;
    expect(state.button.isEnabled).toHaveBeenCalledTimes(2);
    expect(state.click).toHaveBeenCalledTimes(1);
    expect(state.readStoredText).toHaveBeenCalledTimes(1);
    expect(state.readStoredText.mock.invocationCallOrder[0]).toBeGreaterThan(state.click.mock.invocationCallOrder[0]);
  });

  it("rejects a saved UI acknowledgement when the database contains a different text", async () => {
    vi.useFakeTimers();
    const state = composer({ saved: true });
    state.readStoredText.mockResolvedValue("Старая версия");
    const outcome = saveE2eComposerDraft(state.input).catch(error => error.message);
    await vi.advanceTimersByTimeAsync(12_001);
    expect(await outcome).toBe("Composer save button did not acknowledge the visible text");
    expect(state.click).not.toHaveBeenCalled();
  });

  it("does not accept matching database text without the UI acknowledgement after a click", async () => {
    vi.useFakeTimers();
    const state = composer();
    state.click.mockImplementation(() => undefined);
    const outcome = saveE2eComposerDraft(state.input).catch(error => error.message);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await outcome).toBe("Composer save state did not acknowledge the visible text");
    expect(state.click).toHaveBeenCalledTimes(1);
    expect(state.readStoredText).not.toHaveBeenCalled();
  });

  it("bounds a stalled readiness call instead of polling indefinitely", async () => {
    vi.useFakeTimers();
    const state = composer();
    state.button.isEnabled.mockImplementation(() => new Promise(() => {}));
    const outcome = saveE2eComposerDraft(state.input).catch(error => error.message);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await outcome).toBe("Composer save button did not become enabled");
    expect(state.button.isEnabled).toHaveBeenCalledTimes(1);
    expect(state.click).not.toHaveBeenCalled();
    expect(state.readStoredText).not.toHaveBeenCalled();
  });
});

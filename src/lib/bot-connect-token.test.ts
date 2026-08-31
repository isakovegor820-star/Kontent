import { describe, expect, it, vi } from "vitest";

import { clearBotConnectionToken, consumeBotConnectionToken } from "./bot-connect-token";

const STORAGE_KEY = "aurora:bot-connection-token:v1";
const TOKEN = "a".repeat(43);

function storage(initial?: string) {
  const values = new Map<string, string>(initial ? [[STORAGE_KEY, initial]] : []);
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  };
}

describe("bot connection token URL hygiene", () => {
  it("reads a valid fragment, removes it immediately and preserves the query string", () => {
    const sessionStorage = storage();
    const replaceState = vi.fn();

    const token = consumeBotConnectionToken({
      location: { hash: `#token=${TOKEN}`, pathname: "/bot/connect", search: "?source=telegram" },
      history: { replaceState },
      storage: sessionStorage,
    });

    expect(token).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/bot/connect?source=telegram");
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain(TOKEN);
    expect(sessionStorage.setItem).toHaveBeenCalledWith(STORAGE_KEY, TOKEN);
  });

  it("rejects malformed fragments and clears both URL and stale storage", () => {
    const sessionStorage = storage(TOKEN);
    const replaceState = vi.fn();

    const token = consumeBotConnectionToken({
      location: { hash: "#token=malformed", pathname: "/bot/connect", search: "" },
      history: { replaceState },
      storage: sessionStorage,
    });

    expect(token).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/bot/connect");
    expect(sessionStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it("restores the same-tab token after login, back or refresh without rewriting the URL", () => {
    const sessionStorage = storage(TOKEN);
    const replaceState = vi.fn();

    expect(consumeBotConnectionToken({
      location: { hash: "", pathname: "/bot/connect", search: "" },
      history: { replaceState },
      storage: sessionStorage,
    })).toBe(TOKEN);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("clears the saved token after a successful confirmation", () => {
    const sessionStorage = storage(TOKEN);
    clearBotConnectionToken(sessionStorage);
    expect(sessionStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
  });
});

const BOT_CONNECTION_STORAGE_KEY = "aurora:bot-connection-token:v1";
const BOT_CONNECTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type BotConnectionLocation = Pick<Location, "hash" | "pathname" | "search">;
type BotConnectionHistory = Pick<History, "replaceState">;
type BotConnectionStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function consumeBotConnectionToken(input: {
  location: BotConnectionLocation;
  history: BotConnectionHistory;
  storage: BotConnectionStorage;
}): string | null {
  const fragmentToken = new URLSearchParams(input.location.hash.replace(/^#/u, "")).get("token");
  const candidate = fragmentToken || input.storage.getItem(BOT_CONNECTION_STORAGE_KEY) || "";

  if (input.location.hash) {
    input.history.replaceState(null, "", `${input.location.pathname}${input.location.search}`);
  }
  if (!BOT_CONNECTION_TOKEN_PATTERN.test(candidate)) {
    input.storage.removeItem(BOT_CONNECTION_STORAGE_KEY);
    return null;
  }
  input.storage.setItem(BOT_CONNECTION_STORAGE_KEY, candidate);
  return candidate;
}

export function clearBotConnectionToken(storage: BotConnectionStorage): void {
  storage.removeItem(BOT_CONNECTION_STORAGE_KEY);
}

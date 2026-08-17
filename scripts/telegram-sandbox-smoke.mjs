import { pathToFileURL } from "node:url";

const SEND_CONFIRMATION = "I_UNDERSTAND_THIS_SENDS_A_REAL_TELEGRAM_MESSAGE";
const TELEGRAM_API_ORIGIN = "https://api.telegram.org";

export class TelegramSandboxSmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = "TelegramSandboxSmokeError";
    this.code = code;
  }
}

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new TelegramSandboxSmokeError(`missing_${name.toLowerCase()}`);
  return value;
}

function sandboxConfiguration(env) {
  if (String(env.AURORA_ALLOW_TELEGRAM_SANDBOX_SEND || "").trim() !== SEND_CONFIRMATION) {
    throw new TelegramSandboxSmokeError("telegram_sandbox_send_not_confirmed");
  }
  const token = required(env, "TG_SANDBOX_BOT_TOKEN");
  const ordinaryToken = String(env.TG_BOT_TOKEN || "").trim();
  if (ordinaryToken && ordinaryToken === token) {
    throw new TelegramSandboxSmokeError("sandbox_token_must_be_distinct");
  }
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,100}$/u.test(token)) {
    throw new TelegramSandboxSmokeError("invalid_sandbox_bot_token");
  }
  const chatId = required(env, "TG_SANDBOX_CHAT_ID");
  if (!/^-?\d{1,20}$/u.test(chatId)) {
    throw new TelegramSandboxSmokeError("invalid_sandbox_chat_id");
  }
  const ordinaryChatId = String(env.TG_CHAT_ID || "").trim();
  if (ordinaryChatId && ordinaryChatId === chatId) {
    throw new TelegramSandboxSmokeError("sandbox_chat_must_be_distinct");
  }
  const expectedUsername = required(env, "TG_SANDBOX_EXPECTED_BOT_USERNAME")
    .replace(/^@/u, "");
  if (!/^[A-Za-z0-9_]{5,32}$/u.test(expectedUsername)) {
    throw new TelegramSandboxSmokeError("invalid_sandbox_bot_username");
  }
  const businessConnectionId = String(env.TG_SANDBOX_BUSINESS_CONNECTION_ID || "").trim();
  if (businessConnectionId && !/^[A-Za-z0-9_-]{8,256}$/u.test(businessConnectionId)) {
    throw new TelegramSandboxSmokeError("invalid_sandbox_business_connection_id");
  }
  const expectedBusinessUserId = String(env.TG_SANDBOX_EXPECTED_BUSINESS_USER_ID || "").trim();
  if (businessConnectionId && !expectedBusinessUserId) {
    throw new TelegramSandboxSmokeError("missing_tg_sandbox_expected_business_user_id");
  }
  if (expectedBusinessUserId && !/^\d{1,20}$/u.test(expectedBusinessUserId)) {
    throw new TelegramSandboxSmokeError("invalid_sandbox_business_user_id");
  }
  if (expectedBusinessUserId && !businessConnectionId) {
    throw new TelegramSandboxSmokeError("business_user_requires_connection");
  }
  return {
    token,
    chatId,
    expectedUsername,
    businessConnectionId,
    expectedBusinessUserId,
  };
}

function classifyTelegramResponse(payload) {
  if (payload?.ok === false) return "rejected";
  if (payload?.ok !== true) return "ambiguous";
  return "accepted";
}

async function telegramRequest(fetchImpl, token, method, body) {
  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_API_ORIGIN}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new TelegramSandboxSmokeError("telegram_network_ambiguous");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new TelegramSandboxSmokeError("telegram_response_ambiguous");
  }
  const outcome = classifyTelegramResponse(payload);
  if (outcome === "rejected") throw new TelegramSandboxSmokeError("telegram_rejected");
  if (outcome === "ambiguous") throw new TelegramSandboxSmokeError("telegram_response_ambiguous");
  return payload;
}

export async function runTelegramSandboxSmoke({
  env = process.env,
  fetchImpl = fetch,
  logger = console,
  now = new Date(),
} = {}) {
  const config = sandboxConfiguration(env);
  const identity = await telegramRequest(fetchImpl, config.token, "getMe", {});
  const actualUsername = String(identity?.result?.username || "").replace(/^@/u, "");
  if (actualUsername.toLowerCase() !== config.expectedUsername.toLowerCase()) {
    throw new TelegramSandboxSmokeError("sandbox_bot_identity_mismatch");
  }
  if (config.businessConnectionId) {
    const connection = await telegramRequest(fetchImpl, config.token, "getBusinessConnection", {
      business_connection_id: config.businessConnectionId,
    });
    const actualBusinessUserId = String(connection?.result?.user?.id || "");
    if (actualBusinessUserId !== config.expectedBusinessUserId) {
      throw new TelegramSandboxSmokeError("sandbox_business_owner_mismatch");
    }
  }
  const marker = now.toISOString().replace(/\.\d{3}Z$/u, "Z");
  const sent = await telegramRequest(fetchImpl, config.token, "sendMessage", {
    chat_id: config.chatId,
    ...(config.businessConnectionId
      ? { business_connection_id: config.businessConnectionId }
      : {}),
    text: `[AURORA SANDBOX] delivery smoke ${marker}`,
    disable_notification: true,
  });
  const messageId = Number(sent?.result?.message_id);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new TelegramSandboxSmokeError("telegram_response_ambiguous");
  }
  const report = {
    ok: true,
    botUsername: actualUsername,
    businessConnectionChecked: Boolean(config.businessConnectionId),
    messageId,
    checkedAt: now.toISOString(),
  };
  logger.log(JSON.stringify(report));
  return report;
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  runTelegramSandboxSmoke().catch((error) => {
    const code = error instanceof TelegramSandboxSmokeError
      ? error.code
      : "telegram_sandbox_smoke_failed";
    console.error(JSON.stringify({ ok: false, code }));
    process.exitCode = 1;
  });
}

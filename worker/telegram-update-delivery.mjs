import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { classifyTelegramDelivery } from "../src/lib/telegram-response.mjs";

export const telegramUpdateContext = new AsyncLocalStorage();
export const TELEGRAM_MESSAGE_METHODS = new Set(["sendMessage", "sendPhoto", "sendVideo", "sendDocument", "sendMediaGroup"]);
function unknown(code = "telegram_update_delivery_unknown") {
  return Object.assign(new Error(code), { code, deliveryUnknown: true, retryable: false });
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

/** Existing successful calls replay their minimal receipt; uncertainty is terminal. */
export async function deliverTelegramUpdateCall({ pool, botId, updateId, partIndex, method, body, send }) {
  if (![botId, updateId, partIndex].every((id) => Number.isSafeInteger(Number(id)) && Number(id) >= 0)) throw new Error("telegram_update_identity_invalid");
  const payloadHash = createHash("sha256").update(JSON.stringify(stableValue({ method, body }))).digest("hex");
  const identity = [botId, updateId, partIndex, payloadHash];
  const claimed = await pool.query(
    `insert into telegram_update_deliveries (bot_id, update_id, part_index, payload_hash, send_status)
     values ($1,$2,$3,$4,'sending')
     on conflict (bot_id, update_id, part_index) do update
       set send_status = 'sending', updated_at = now()
     where telegram_update_deliveries.payload_hash = excluded.payload_hash
       and telegram_update_deliveries.send_status = 'rejected'
       and telegram_update_deliveries.retry_not_before <= now()
     returning bot_id`, identity,
  );
  if (claimed.rowCount !== 1) {
    const row = (await pool.query(
      "select payload_hash, send_status, receipt from telegram_update_deliveries where bot_id=$1 and update_id=$2 and part_index=$3", identity.slice(0,3),
    )).rows[0];
    if (!row || String(row.payload_hash).trim() !== payloadHash) throw unknown("telegram_update_payload_changed");
    if (["sent", "rejected"].includes(row.send_status) && row.receipt) return row.receipt;
    throw unknown();
  }
  let response;
  try { response = await send(); }
  catch {
    await pool.query("update telegram_update_deliveries set send_status='unknown', updated_at=now() where bot_id=$1 and update_id=$2 and part_index=$3 and send_status='sending'", identity.slice(0,3)).catch(() => {});
    throw unknown();
  }
  const group = method === "sendMediaGroup";
  const outcome = classifyTelegramDelivery(response, { group, messageCount: group ? body.media?.length : 1 });
  const receipt = outcome.kind === "accepted"
    ? { ok: true, result: group ? outcome.messageIds.map((message_id) => ({ message_id })) : { message_id: outcome.messageIds[0] } }
    : outcome.kind === "rejected" ? { ok: false, error_code: outcome.providerErrorCode, parameters: { retry_after: outcome.retryAfterSeconds }, description: "telegram_rejected" } : null;
  const retrySeconds = outcome.kind === "rejected" && (outcome.providerErrorCode === 429 || outcome.providerErrorCode >= 500)
    ? outcome.retryAfterSeconds || 2 : null;
  try {
    const stored = await pool.query(
      `update telegram_update_deliveries
          set send_status=$5, receipt=$6::jsonb,
              retry_not_before=case when $7::integer is null then null else now()+($7::text || ' seconds')::interval end, updated_at=now()
        where bot_id=$1 and update_id=$2 and part_index=$3 and payload_hash=$4 and send_status='sending'`,
      [...identity, outcome.kind === "accepted" ? "sent" : outcome.kind === "rejected" ? "rejected" : "unknown", receipt ? JSON.stringify(receipt) : null, retrySeconds],
    );
    if (stored.rowCount !== 1) throw unknown();
  } catch { throw unknown(); }
  if (outcome.kind === "unknown") throw unknown();
  return receipt;
}

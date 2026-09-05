import { createHash } from "node:crypto";
import { classifyTelegramDelivery } from "../src/lib/telegram-response.mjs";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
const unknown = (reason = "telegram_background_delivery_unknown") => ({ kind: "unknown", reason });

/** A durable event identity is independent of Telegram update IDs and Redis job retries.
 * Each part is claimed before dispatch. An abandoned sending claim remains unknown forever
 * until an operator has independent evidence; missing receipts never authorize replay.
 */
export async function deliverTelegramBackgroundCall({ pool, userId, projectId, eventKey, botId, chatId, partIndex = 0, method = "sendMessage", body, send, beforeSend = undefined }) {
  if (![userId, projectId, botId].every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)
    || !Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0
    || !Number.isSafeInteger(partIndex) || partIndex < 0
    || typeof eventKey !== "string" || !/^[a-zA-Z0-9:_-]{1,200}$/.test(eventKey)) {
    throw new Error("telegram_background_identity_invalid");
  }
  const payloadHash = createHash("sha256").update(JSON.stringify(stableValue({ method, body }))).digest("hex");
  const key = [projectId, userId, eventKey, partIndex];
  const identity = [...key, botId, chatId, payloadHash];
  const claimed = await pool.query(
    `insert into telegram_background_deliveries
       (project_id,user_id,event_key,part_index,bot_id,chat_id,payload_hash,send_status)
     values ($1,$2,$3,$4,$5,$6,$7,'sending')
     on conflict (project_id,user_id,event_key,part_index) do update
       set send_status='sending', updated_at=now()
     where telegram_background_deliveries.payload_hash=excluded.payload_hash
       and telegram_background_deliveries.bot_id=excluded.bot_id
       and telegram_background_deliveries.chat_id=excluded.chat_id
       and telegram_background_deliveries.send_status='rejected'
       and telegram_background_deliveries.retry_not_before <= now()
     returning project_id`, identity,
  );
  if (claimed.rowCount !== 1) {
    const row = (await pool.query(
      "select bot_id,chat_id,payload_hash,send_status,receipt from telegram_background_deliveries where project_id=$1 and user_id=$2 and event_key=$3 and part_index=$4", key,
    )).rows[0];
    if (!row || String(row.payload_hash).trim() !== payloadHash || Number(row.bot_id) !== Number(botId) || Number(row.chat_id) !== Number(chatId)) return unknown("telegram_background_identity_changed");
    if (row.send_status === "sent" && classifyTelegramDelivery(row.receipt, { group: method === "sendMediaGroup", messageCount: method === "sendMediaGroup" ? body.media?.length : 1 }).kind === "accepted") return { kind: "accepted", receipt: row.receipt };
    if (row.send_status === "rejected" && classifyTelegramDelivery(row.receipt).kind === "rejected") return { kind: "rejected", receipt: row.receipt };
    if (row.send_status === "cancelled") return { kind: "denied" };
    return unknown();
  }
  if (beforeSend && !await beforeSend()) {
    await pool.query("update telegram_background_deliveries set send_status='cancelled',updated_at=now() where project_id=$1 and user_id=$2 and event_key=$3 and part_index=$4 and send_status='sending'", key);
    return { kind: "denied" };
  }
  let response;
  try { response = await send(); }
  catch {
    await pool.query("update telegram_background_deliveries set send_status='unknown',updated_at=now() where project_id=$1 and user_id=$2 and event_key=$3 and part_index=$4 and send_status='sending'", key).catch(() => {});
    return unknown();
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
      `update telegram_background_deliveries
          set send_status=$8,receipt=$9::jsonb,
              retry_not_before=case when $10::integer is null then null else now()+($10::text || ' seconds')::interval end,
              updated_at=now()
        where project_id=$1 and user_id=$2 and event_key=$3 and part_index=$4
          and bot_id=$5 and chat_id=$6 and payload_hash=$7 and send_status='sending'`,
      [...identity, outcome.kind === "accepted" ? "sent" : outcome.kind === "rejected" ? "rejected" : "unknown", receipt ? JSON.stringify(receipt) : null, retrySeconds],
    );
    if (stored.rowCount !== 1) return unknown("telegram_background_receipt_not_saved");
  } catch { return unknown("telegram_background_receipt_not_saved"); }
  return outcome.kind === "unknown" ? unknown() : { kind: outcome.kind, receipt };
}

import { createHash } from "node:crypto";

const RETRY_QUEUE_ERROR = "Не удалось поставить повтор в очередь — попробуй ещё раз";

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Telegram may redeliver the same callback query. Hash its opaque id into a DB-safe key. */
export function telegramRetryKey(callbackQueryId) {
  const raw = String(callbackQueryId ?? "").trim();
  if (!raw) return null;
  return `telegram-retry-${createHash("sha256").update(raw).digest("hex")}`;
}

/** BullMQ custom ids must not contain colons. */
export function botRetryJobId(postId, retryKey) {
  const suffix = createHash("sha256").update(retryKey).digest("hex").slice(0, 20);
  return `post-${postId}-bot-${suffix}`;
}

/**
 * Retry only a confirmed failure. Unknown publication outcomes (`publishing` and
 * `published_unverified`) must go through reconciliation instead of another send.
 */
export async function retryFailedPostFromBot({
  pool,
  queue,
  userId: rawUserId,
  postId: rawPostId,
  callbackQueryId,
}) {
  const userId = positiveInteger(rawUserId);
  const postId = positiveInteger(rawPostId);
  const retryKey = telegramRetryKey(callbackQueryId);
  if (!userId || !postId || !retryKey) return { kind: "not_retryable" };

  const claimed = await pool.query(
    `update posts
        set status = 'scheduled', last_error = null,
            last_retry_key = $3, retry_requested_at = now()
      where id = $1 and user_id = $2 and status = 'failed'
      returning id`,
    [postId, userId, retryKey],
  );

  if (!claimed.rowCount) {
    const current = (
      await pool.query(
        `select status, last_retry_key
           from posts
          where id = $1 and user_id = $2`,
        [postId, userId],
      )
    ).rows[0];
    if (current?.last_retry_key === retryKey) return { kind: "replayed" };
    return { kind: "not_retryable" };
  }

  const jobId = botRetryJobId(postId, retryKey);
  try {
    await queue.add(
      "publish",
      { postId },
      { jobId, removeOnComplete: true, removeOnFail: false },
    );
    return { kind: "queued", jobId };
  } catch (queueError) {
    let compensated = false;
    let compensationError = null;
    try {
      const compensation = await pool.query(
        `update posts
            set status = 'failed', last_error = $4, last_retry_key = null
          where id = $1 and user_id = $2
            and status = 'scheduled' and last_retry_key = $3`,
        [postId, userId, retryKey, RETRY_QUEUE_ERROR],
      );
      compensated = compensation.rowCount === 1;
    } catch (error) {
      compensationError = error;
    }
    return { kind: "queue_unavailable", compensated, queueError, compensationError };
  }
}

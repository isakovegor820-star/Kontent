// Идемпотентное добавление задачи публикации (общий для web-роутов и worker.mjs).
// Модуль намеренно без TS-импортов: воркер исполняется plain Node и не тянет queue.ts.

/**
 * Детерминированный revision-bound id задачи (дубль jobIdForPostRevision из queue.ts).
 * Без двоеточий — BullMQ их запрещает в custom id.
 */
export function publishJobId(postId, scheduleRevision) {
  const id = Number(postId);
  const revision = Number(scheduleRevision);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("post_id_invalid");
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new TypeError("schedule_revision_invalid");
  return `post-${id}-r${revision}`;
}

async function within(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("publish_queue_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Add с восстановлением после ambiguous-ACK: если add бросил (включая «jobId уже
 * существует» при повторном replay outbox), getJob доказывает, что задача жива в
 * Redis — это recovered, не ошибка. Если Redis не подтвердил ни add, ни getJob —
 * пробрасываем PUBLISH_QUEUE_UNAVAILABLE: durable outbox оставит строку в failed
 * и повторит dispatch позже. Повторный add с тем же jobId не создаёт дубля.
 */
export async function enqueuePublishJob(
  queue,
  data,
  scheduledAt,
  { timeoutMs = 2_000, jobId = null } = {},
) {
  const resolvedJobId = jobId || publishJobId(data.postId, data.scheduleRevision);
  const delay = Math.max(0, new Date(scheduledAt).getTime() - Date.now());
  try {
    await within(queue.add(
      "publish",
      {
        postId: Number(data.postId),
        projectId: Number(data.projectId),
        scheduleRevision: Number(data.scheduleRevision),
      },
      { delay, jobId: resolvedJobId, removeOnComplete: true, removeOnFail: 200 },
    ), timeoutMs);
    return { recovered: false, jobId: resolvedJobId };
  } catch {
    try {
      const existing = await within(queue.getJob(resolvedJobId), timeoutMs);
      if (existing) return { recovered: true, jobId: resolvedJobId };
    } catch {
      // Redis не подтвердил исход — владение строкой остаётся у outbox.
    }
    const error = new Error("publish_queue_unavailable");
    error.code = "PUBLISH_QUEUE_UNAVAILABLE";
    throw error;
  }
}

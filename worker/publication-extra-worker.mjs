import { createHash, randomUUID } from "node:crypto";
import { UnrecoverableError, Worker } from "bullmq";

import { activateNextPublicationExtra } from "../src/lib/publication-extra-operations.mjs";
import { PUBLICATION_EXTRA_QUEUE } from "../src/lib/publication-extra-queue.mjs";

export class PublicationExtraOperationError extends Error {
  constructor(code, message, { retryable = false, deliveryUnknown = false } = {}) {
    super(message || code);
    this.name = "PublicationExtraOperationError";
    this.code = code;
    this.retryable = retryable;
    this.deliveryUnknown = deliveryUnknown;
  }
}

function positiveId(value, code = "invalid_publication_extra_job") {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new PublicationExtraOperationError(code, code);
  return id;
}

function validJobData(value) {
  const operationId = positiveId(value?.operationId);
  const projectId = positiveId(value?.projectId);
  const fingerprint = String(value?.fingerprint || "");
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
    throw new PublicationExtraOperationError("invalid_publication_extra_job", "invalid fingerprint");
  }
  return { operationId, projectId, fingerprint };
}

function safeProviderError(provider, response) {
  const errorCode = Number(response?.error_code ?? response?.error?.error_code);
  if (errorCode === 429 || errorCode >= 500) {
    return new PublicationExtraOperationError(
      `${provider}_temporary_failure`,
      "Площадка временно не выполнила дополнительное действие.",
      { retryable: true },
    );
  }
  if ([5, 7, 15, 27, 28].includes(errorCode)) {
    return new PublicationExtraOperationError(
      `${provider}_permission_denied`,
      "Площадка не разрешила дополнительное действие.",
    );
  }
  return new PublicationExtraOperationError(
    `${provider}_request_failed`,
    "Площадка не выполнила дополнительное действие.",
  );
}

function vkGuid(fingerprint) {
  return Number.parseInt(String(fingerprint).slice(0, 8), 16) % 2_147_483_647 || 1;
}

async function resolveTelegramDiscussion(pool, operation) {
  const originMessageId = Number(operation.external_message_id || operation.tg_message_id);
  if (!Number.isSafeInteger(originMessageId) || originMessageId <= 0) {
    throw new PublicationExtraOperationError(
      "main_message_id_missing",
      "Telegram не вернул идентификатор основной публикации.",
    );
  }
  const mapping = (await pool.query(
    `select discussion_chat_id, discussion_message_id
       from telegram_discussion_messages
      where project_id = $1 and channel_id = $2 and origin_message_id = $3
      order by observed_at desc limit 1`,
    [operation.project_id, operation.channel_id, originMessageId],
  )).rows[0];
  if (!mapping) {
    throw new PublicationExtraOperationError(
      "discussion_message_pending",
      "Первый комментарий ждёт связанное обсуждение Telegram.",
      { retryable: true },
    );
  }
  return {
    discussionChatId: Number(mapping.discussion_chat_id),
    discussionMessageId: Number(mapping.discussion_message_id),
  };
}

async function executeProviderOperation({
  pool,
  operation,
  telegramRequest,
  vkRequest,
  decryptToken,
}) {
  const snapshot = operation.request_snapshot || {};
  const providerId = String(snapshot.providerId || operation.network || "");
  const postMessageId = Number(operation.external_message_id || operation.tg_message_id);
  const vkPostId = Number(operation.vk_post_id || operation.external_message_id);
  if (providerId === "tg") {
    if (operation.kind === "first_comment") {
      const mapping = await resolveTelegramDiscussion(pool, operation);
      const response = await telegramRequest("sendMessage", {
        chat_id: mapping.discussionChatId,
        text: String(snapshot.text || ""),
        disable_web_page_preview: true,
        reply_parameters: { message_id: mapping.discussionMessageId },
      });
      if (!response?.ok || !Number.isSafeInteger(Number(response.result?.message_id))) {
        const error = safeProviderError("telegram", response);
        if (error.retryable) {
          error.retryable = false;
          error.deliveryUnknown = true;
          error.code = "telegram_comment_delivery_unknown";
          error.message = "Telegram не подтвердил первый комментарий. Проверьте обсуждение перед повтором.";
        }
        throw error;
      }
      return { externalId: String(response.result.message_id), externalUrl: null };
    }
    if (!Number.isSafeInteger(postMessageId) || postMessageId <= 0) {
      throw new PublicationExtraOperationError("main_message_id_missing", "Нет идентификатора публикации Telegram.");
    }
    const method = operation.kind === "pin"
      ? "pinChatMessage"
      : operation.kind === "unpin"
        ? "unpinChatMessage"
        : null;
    if (!method) throw new PublicationExtraOperationError("unsupported_operation", "Операция недоступна для Telegram.");
    const response = await telegramRequest(method, {
      chat_id: operation.tg_chat_id,
      message_id: postMessageId,
      disable_notification: true,
    });
    if (!response?.ok) throw safeProviderError("telegram", response);
    return { externalId: String(postMessageId), externalUrl: null };
  }

  if (providerId === "vk") {
    if (!Number.isSafeInteger(vkPostId) || vkPostId <= 0) {
      throw new PublicationExtraOperationError("main_message_id_missing", "Нет идентификатора публикации VK.");
    }
    let token;
    try {
      token = decryptToken(operation.vk_token, { userId: operation.channel_user_id, provider: "vk" });
    } catch {
      throw new PublicationExtraOperationError("vk_token_unreadable", "Подключение VK нужно обновить.");
    }
    const ownerId = -Math.abs(Number(operation.vk_group_id));
    if (!Number.isSafeInteger(ownerId) || ownerId >= 0) {
      throw new PublicationExtraOperationError("vk_group_missing", "Не найдено сообщество VK.");
    }
    if (operation.kind === "first_comment") {
      const response = await vkRequest("wall.createComment", {
        owner_id: ownerId,
        post_id: vkPostId,
        message: String(snapshot.text || ""),
        guid: vkGuid(operation.fingerprint),
      }, token);
      const commentId = Number(response?.response?.comment_id ?? response?.response);
      if (response?.error || !Number.isSafeInteger(commentId) || commentId <= 0) {
        throw safeProviderError("vk", response);
      }
      return {
        externalId: String(commentId),
        externalUrl: `https://vk.com/wall${ownerId}_${vkPostId}?reply=${commentId}`,
      };
    }
    if (operation.kind === "configure_comments") {
      const method = snapshot.commentsEnabled === true ? "wall.openComments" : "wall.closeComments";
      const response = await vkRequest(method, { owner_id: ownerId, post_id: vkPostId }, token);
      if (response?.error || Number(response?.response) !== 1) throw safeProviderError("vk", response);
      return { externalId: String(vkPostId), externalUrl: null };
    }
    throw new PublicationExtraOperationError("unsupported_operation", "Операция недоступна для VK.");
  }
  throw new PublicationExtraOperationError("unsupported_provider", "Площадка не поддерживает это действие.");
}

async function markTerminalAndContinue(pool, operation, status, error = null) {
  const terminal = await pool.query(
    `with terminal as (
       update publication_extra_operations
          set status = $4, attempts = attempts + 1,
              last_error_code = $5, last_error_message = $6,
              lease_token = null, lease_expires_at = null,
              completed_at = case when $4 in ('succeeded','failed','skipped','unsupported','cancelled') then now() else completed_at end,
              updated_at = now()
        where id = $1 and project_id = $2 and fingerprint = $3
          and status = 'running' and lease_token = $8
      returning id
     )
     update publication_extra_attempts attempt
        set status = $4, safe_error_code = $5, completed_at = now()
      where attempt.operation_id = $1 and attempt.project_id = $2
        and attempt.attempt_number = $7 and attempt.status = 'running'
        and exists (select 1 from terminal)`,
    [
      operation.id,
      operation.project_id,
      operation.fingerprint,
      status,
      error?.code || null,
      error?.message || null,
      operation.attempt_number,
      operation.lease_token,
    ],
  );
  if (terminal.rowCount !== 1) return false;
  if (status === "failed_retry") return true;
  await pool.query(
    `update publication_extra_outbox
        set status = 'completed', lease_token = null, lease_expires_at = null,
            last_error_code = $3, updated_at = now()
      where project_id = $1 and operation_id = $2`,
    [operation.project_id, operation.id, error?.code || null],
  );
  await activateNextPublicationExtra(pool, {
    projectId: Number(operation.project_id),
    postId: Number(operation.post_id),
  });
  return true;
}

export async function processPublicationExtraOperation({
  pool,
  operationId,
  projectId,
  fingerprint,
  telegramRequest,
  vkRequest,
  decryptToken,
  finalAttempt = false,
}) {
  const data = validJobData({ operationId, projectId, fingerprint });
  const leaseToken = createHash("sha256")
    .update(`${data.operationId}:${randomUUID()}`)
    .digest("hex");
  const claimed = await pool.query(
    `with claimed as (
       update publication_extra_operations extra
          set status = 'running', lease_token = $4,
              lease_expires_at = now() + interval '2 minutes', updated_at = now()
         from posts post, channels channel
        where extra.id = $1 and extra.project_id = $2 and extra.fingerprint = $3
          and extra.status in ('pending','queued','failed_retry')
          and post.id = extra.post_id and post.project_id = extra.project_id and post.status = 'published'
          and channel.id = extra.channel_id and channel.project_id = extra.project_id
      returning extra.id, extra.project_id, extra.publication_operation_id,
                extra.post_id, extra.channel_id, extra.kind,
                extra.fingerprint, extra.request_snapshot, extra.provider_started_at,
                extra.requested_by_user_id,
                extra.lease_token,
                extra.attempts + 1 as attempt_number,
                post.external_message_id, post.tg_message_id, post.vk_post_id,
                channel.network, channel.user_id as channel_user_id, channel.tg_chat_id,
                channel.vk_group_id, channel.vk_token
     ), journal as (
       insert into publication_extra_attempts
         (project_id, operation_id, attempt_number, status)
       select project_id, id, attempt_number, 'running' from claimed
       on conflict (operation_id, attempt_number) do nothing
       returning operation_id, attempt_number
     )
     select claimed.*
       from claimed
       join journal on journal.operation_id = claimed.id
                   and journal.attempt_number = claimed.attempt_number`,
    [data.operationId, data.projectId, data.fingerprint, leaseToken],
  );
  const operation = claimed.rows[0];
  if (!operation) {
    const existing = (await pool.query(
      `select status, external_id from publication_extra_operations
        where id = $1 and project_id = $2 and fingerprint = $3`,
      [data.operationId, data.projectId, data.fingerprint],
    )).rows[0];
    if (existing?.status === "succeeded") {
      return { ok: true, replayed: true, externalId: existing.external_id };
    }
    if (["failed", "skipped", "unsupported", "cancelled"].includes(existing?.status)) {
      return { ok: false, replayed: true, status: existing.status };
    }
    throw new PublicationExtraOperationError(
      "operation_not_ready",
      "Основная публикация ещё не подтверждена.",
      { retryable: true },
    );
  }
  try {
    // A previous ambiguous Telegram comment request must never be repeated blindly.
    if (
      operation.kind === "first_comment"
      && operation.request_snapshot?.providerId === "tg"
      && operation.provider_started_at
    ) {
      throw new PublicationExtraOperationError(
        "telegram_comment_delivery_unknown",
        "Telegram не подтвердил первый комментарий. Проверьте обсуждение перед повтором.",
        { deliveryUnknown: true },
      );
    }
    // Dependency checks (notably Telegram discussion mapping) run before this marker.
    if (operation.kind === "first_comment" && operation.request_snapshot?.providerId === "tg") {
      await resolveTelegramDiscussion(pool, operation);
    }
    const marked = await pool.query(
      `update publication_extra_operations
          set provider_started_at = coalesce(provider_started_at, now()), updated_at = now()
        where id = $1 and project_id = $2 and fingerprint = $3
          and status = 'running' and lease_token = $4`,
      [operation.id, operation.project_id, operation.fingerprint, leaseToken],
    );
    if (marked.rowCount !== 1) {
      throw new PublicationExtraOperationError("operation_lease_lost", "Действие будет повторено.", { retryable: true });
    }
    const result = await executeProviderOperation({ pool, operation, telegramRequest, vkRequest, decryptToken });
    const saved = await pool.query(
      `with terminal as (
       update publication_extra_operations
          set status = 'succeeded', external_id = $5, external_url = $6,
              attempts = attempts + 1, last_error_code = null, last_error_message = null,
              lease_token = null, lease_expires_at = null,
              completed_at = now(), updated_at = now()
        where id = $1 and project_id = $2 and fingerprint = $3
          and status = 'running' and lease_token = $4
      returning id
     )
     update publication_extra_attempts attempt
        set status = 'succeeded', safe_error_code = null, completed_at = now()
      where attempt.operation_id = $1 and attempt.project_id = $2
        and attempt.attempt_number = $7 and attempt.status = 'running'
        and exists (select 1 from terminal)`,
      [
        operation.id,
        operation.project_id,
        operation.fingerprint,
        leaseToken,
        result.externalId,
        result.externalUrl,
        operation.attempt_number,
      ],
    );
    if (saved.rowCount !== 1) {
      throw new PublicationExtraOperationError(
        "provider_result_not_persisted",
        "Площадка выполнила действие, но результат требует сверки.",
        { deliveryUnknown: true },
      );
    }
    await pool.query(
      `update publication_extra_outbox set status = 'completed', last_error_code = null, updated_at = now()
        where project_id = $1 and operation_id = $2`,
      [operation.project_id, operation.id],
    );
    await pool.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id, after_version, safe_data, idempotency_key)
       select $1, coalesce(extra.requested_by_user_id, publication.user_id),
              'publication.extra.succeeded', 'publication_extra_operation', $2,
              1, jsonb_build_object('kind', $3::text), 'audit:publication-extra:succeeded:' || $2
         from publication_operations publication
         join publication_extra_operations extra
           on extra.id = $2::bigint and extra.project_id = publication.project_id
        where publication.id = $4 and publication.project_id = $1
       on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
      [operation.project_id, String(operation.id), operation.kind, operation.publication_operation_id],
    );
    await activateNextPublicationExtra(pool, {
      projectId: Number(operation.project_id),
      postId: Number(operation.post_id),
    });
    return { ok: true, replayed: false, externalId: result.externalId };
  } catch (rawError) {
    const error = rawError instanceof PublicationExtraOperationError
      ? rawError
      : new PublicationExtraOperationError("provider_unavailable", "Площадка временно недоступна.", { retryable: true });
    const retryable = error.retryable && !error.deliveryUnknown && !finalAttempt;
    await markTerminalAndContinue(pool, operation, retryable ? "failed_retry" : "failed", error);
    throw error;
  }
}

export async function observeTelegramDiscussionUpdate(pool, update) {
  const message = update?.message;
  const origin = message?.forward_origin;
  const originChatId = Number(origin?.chat?.id);
  const originMessageId = Number(origin?.message_id);
  const discussionChatId = Number(message?.chat?.id);
  const discussionMessageId = Number(message?.message_id);
  if (
    message?.is_automatic_forward !== true
    || origin?.type !== "channel"
    || ![originChatId, originMessageId, discussionChatId, discussionMessageId]
      .every((value) => Number.isSafeInteger(value) && value !== 0)
  ) return { observed: false };
  const channel = (await pool.query(
    `select id, project_id
       from channels
      where network = 'tg' and tg_chat_id = $1 and is_active = true
      order by id limit 1`,
    [originChatId],
  )).rows[0];
  if (!channel) return { observed: false };
  const post = (await pool.query(
    `select post.id
       from posts post
       left join publication_parts part on part.post_id = post.id
      where post.project_id = $1 and post.channel_id = $2
        and (post.tg_message_id::text = $3::text
          or post.external_message_id = $3::text
          or part.external_message_id = $3::text)
      order by post.id desc limit 1`,
    [channel.project_id, channel.id, originMessageId],
  )).rows[0];
  await pool.query(
    `insert into telegram_discussion_messages
       (project_id, channel_id, post_id, origin_chat_id, origin_message_id,
        discussion_chat_id, discussion_message_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (channel_id, origin_message_id) do update
       set post_id = coalesce(telegram_discussion_messages.post_id, excluded.post_id),
           discussion_chat_id = excluded.discussion_chat_id,
           discussion_message_id = excluded.discussion_message_id,
           observed_at = now()`,
    [
      channel.project_id,
      channel.id,
      post?.id || null,
      originChatId,
      originMessageId,
      discussionChatId,
      discussionMessageId,
    ],
  );
  await pool.query(
    `update publication_extra_operations extra
        set next_attempt_at = now(), updated_at = now()
      where extra.project_id = $1 and extra.channel_id = $2 and extra.kind = 'first_comment'
        and extra.status in ('waiting_dependency','failed_retry')
        and extra.request_snapshot->>'providerId' = 'tg'`,
    [channel.project_id, channel.id],
  );
  return { observed: true, postId: post?.id == null ? null : Number(post.id) };
}

export function createPublicationExtraWorker({
  connection,
  pool,
  telegramRequest,
  vkRequest,
  decryptToken,
  concurrency = 2,
  WorkerClass = Worker,
}) {
  const worker = new WorkerClass(
    PUBLICATION_EXTRA_QUEUE,
    async (job) => {
      const data = validJobData(job?.data);
      const attempts = Math.max(1, Number(job?.opts?.attempts) || 1);
      const finalAttempt = Number(job?.attemptsMade || 0) + 1 >= attempts;
      try {
        return await processPublicationExtraOperation({
          pool,
          ...data,
          telegramRequest,
          vkRequest,
          decryptToken,
          finalAttempt,
        });
      } catch (error) {
        if (error instanceof PublicationExtraOperationError && !error.retryable) {
          throw new UnrecoverableError(error.code);
        }
        throw error;
      }
    },
    { connection, concurrency: Math.max(1, Math.min(4, Number(concurrency) || 2)) },
  );
  worker.on?.("failed", (job, error) => {
    console.error("[publication-extra-worker] failed", {
      operationId: Number(job?.data?.operationId) || null,
      projectId: Number(job?.data?.projectId) || null,
      errorName: error instanceof Error ? error.name : "Error",
      errorCode: error instanceof Error ? error.message : "unknown_error",
    });
  });
  return worker;
}

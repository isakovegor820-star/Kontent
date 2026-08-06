const TERMINAL_DELIVERY_STATUSES = new Set([
  "published",
  "published_unverified",
  "missing",
  "deleted_external",
]);

const mutationFailure = (error, httpStatus, details = {}) => ({
  ok: false,
  error,
  httpStatus,
  ...details,
});

function validPositiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

async function rollback(client) {
  await client.query("rollback").catch(() => {});
}

async function lockedOperation(client, userId, operationId) {
  return (await client.query(
    `select id, user_id, draft_id, draft_version, text, media, scheduled_at, timezone,
            destination_ids, status, schedule_revision
       from publication_operations
      where id = $1 and user_id = $2
      for update`,
    [operationId, userId],
  )).rows[0] ?? null;
}

async function replayedEvent(client, operationId, idempotencyKey, action) {
  const event = (await client.query(
    `select action, result
       from publication_operation_events
      where operation_id = $1 and idempotency_key = $2`,
    [operationId, idempotencyKey],
  )).rows[0];
  if (!event) return null;
  if (event.action !== action) return mutationFailure("idempotency_action_conflict", 409);
  return { ...event.result, replayed: true };
}

function concurrencyFailure(operation, expectedRevision, expectedStatus) {
  if (Number(operation.schedule_revision) !== Number(expectedRevision)) {
    return mutationFailure("schedule_revision_conflict", 409, {
      currentRevision: Number(operation.schedule_revision),
      currentStatus: operation.status,
    });
  }
  if (expectedStatus && operation.status !== expectedStatus) {
    return mutationFailure("publication_status_conflict", 409, {
      currentRevision: Number(operation.schedule_revision),
      currentStatus: operation.status,
    });
  }
  return null;
}

async function lockedPosts(client, operationId) {
  return (await client.query(
    `select id, status, schedule_revision, provider_started_at
       from posts
      where publication_operation_id = $1
      order by id
      for update`,
    [operationId],
  )).rows;
}

function deliveryFenceFailure(posts) {
  const providerStarted = posts.find(
    (post) => post.status === "publishing" && post.provider_started_at != null,
  );
  if (providerStarted) {
    return mutationFailure("publication_in_progress", 409, { postId: Number(providerStarted.id) });
  }
  const terminal = posts.find((post) => TERMINAL_DELIVERY_STATUSES.has(post.status));
  if (terminal) {
    return mutationFailure("publication_already_delivered", 409, { postId: Number(terminal.id) });
  }
  return null;
}

async function recordEvent(client, input, result) {
  await client.query(
    `insert into publication_operation_events
       (operation_id, actor_user_id, action, idempotency_key, expected_revision,
        resulting_revision, from_status, to_status, request_id, result)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      input.operationId,
      input.userId,
      input.action,
      input.idempotencyKey,
      input.expectedRevision,
      result.scheduleRevision,
      input.fromStatus,
      result.status,
      input.requestId || null,
      JSON.stringify(result),
    ],
  );
}

function validateMutationInput(input) {
  if (!validPositiveInteger(input.userId) || !validPositiveInteger(input.operationId)) {
    return mutationFailure("bad_operation", 422);
  }
  if (!validPositiveInteger(input.expectedRevision)) {
    return mutationFailure("bad_schedule_revision", 422);
  }
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim()) {
    return mutationFailure("idempotency_key_required", 400);
  }
  return null;
}

export async function cancelPublicationOperation(input) {
  const invalid = validateMutationInput(input);
  if (invalid) return invalid;
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    const operation = await lockedOperation(client, input.userId, input.operationId);
    if (!operation) {
      await rollback(client);
      return mutationFailure("publication_operation_not_found", 404);
    }
    const replay = await replayedEvent(client, input.operationId, input.idempotencyKey, "cancel");
    if (replay) {
      await client.query("commit");
      return replay;
    }
    const conflict = concurrencyFailure(operation, input.expectedRevision, input.expectedStatus);
    if (conflict) {
      await rollback(client);
      return conflict;
    }
    const posts = await lockedPosts(client, input.operationId);
    if (!posts.length) {
      await rollback(client);
      return mutationFailure("publication_destinations_missing", 409);
    }
    const fenced = deliveryFenceFailure(posts);
    if (fenced) {
      await rollback(client);
      return fenced;
    }
    const scheduleRevision = Number(operation.schedule_revision) + 1;
    const postIds = posts.map((post) => Number(post.id));
    await client.query(
      `update publication_operations
          set status = 'cancelled', schedule_revision = $2, cancelled_at = now(), updated_at = now()
        where id = $1`,
      [input.operationId, scheduleRevision],
    );
    await client.query(
      `update posts
          set status = 'cancelled', schedule_revision = $2, cancelled_at = now(),
              publish_lease_token = null, publish_started_at = null,
              provider_started_at = null, next_attempt_at = null
        where publication_operation_id = $1`,
      [input.operationId, scheduleRevision],
    );
    await client.query(
      `update publication_outbox
          set status = 'cancelled', lease_token = null, lease_expires_at = null,
              last_error_code = 'publication_cancelled', updated_at = now()
        where operation_id = $1`,
      [input.operationId],
    );
    const result = {
      ok: true,
      operationId: Number(input.operationId),
      status: "cancelled",
      scheduleRevision,
      previousRevision: Number(operation.schedule_revision),
      postIds,
      replayed: false,
    };
    await recordEvent(client, {
      ...input,
      action: "cancel",
      fromStatus: operation.status,
    }, result);
    await client.query("commit");
    return result;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function reschedulePublicationOperation(input) {
  const invalid = validateMutationInput(input);
  if (invalid) return invalid;
  const scheduledAt = new Date(input.scheduledAt);
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now() + 30_000) {
    return mutationFailure("invalid_schedule", 422);
  }
  const timezone = String(input.timezone || "").trim();
  if (!timezone || timezone.length > 80) return mutationFailure("invalid_timezone", 422);
  const offset = String(input.offset || "").trim();
  if (!/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/u.test(offset)) {
    return mutationFailure("invalid_schedule_offset", 422);
  }
  const disambiguation = String(input.disambiguation || "");
  if (!new Set(["reject", "earlier", "later"]).has(disambiguation)) {
    return mutationFailure("invalid_schedule_disambiguation", 422);
  }
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    const operation = await lockedOperation(client, input.userId, input.operationId);
    if (!operation) {
      await rollback(client);
      return mutationFailure("publication_operation_not_found", 404);
    }
    const replay = await replayedEvent(client, input.operationId, input.idempotencyKey, "reschedule");
    if (replay) {
      await client.query("commit");
      return replay;
    }
    const conflict = concurrencyFailure(operation, input.expectedRevision, input.expectedStatus);
    if (conflict) {
      await rollback(client);
      return conflict;
    }
    const posts = await lockedPosts(client, input.operationId);
    if (!posts.length) {
      await rollback(client);
      return mutationFailure("publication_destinations_missing", 409);
    }
    const fenced = deliveryFenceFailure(posts);
    if (fenced) {
      await rollback(client);
      return fenced;
    }
    const scheduleRevision = Number(operation.schedule_revision) + 1;
    const postIds = posts.map((post) => Number(post.id));
    await client.query(
      `update publication_operations
          set status = 'pending', scheduled_at = $2, timezone = $3,
              schedule_offset = $4, schedule_disambiguation = $5,
              schedule_revision = $6, cancelled_at = null, updated_at = now()
        where id = $1`,
      [input.operationId, scheduledAt, timezone, offset, disambiguation, scheduleRevision],
    );
    await client.query(
      `update posts
          set status = 'scheduled', scheduled_at = $2, schedule_revision = $3,
              scheduled_timezone = $4, scheduled_offset = $5, scheduled_disambiguation = $6,
              attempts = 0, last_error = null, next_attempt_at = null,
              quarantined_at = null, quarantine_reason = null, cancelled_at = null,
              publish_started_at = null, provider_started_at = null, publish_lease_token = null,
              provider_operation_id = null, provider_reconciliation_state = 'none',
              provider_reconciliation_requested_at = null
        where publication_operation_id = $1`,
      [input.operationId, scheduledAt, scheduleRevision, timezone, offset, disambiguation],
    );
    await client.query(
      `update publication_outbox
          set status = 'pending', attempts = 0, next_attempt_at = now(),
              last_error_code = null, lease_token = null, lease_expires_at = null,
              enqueued_at = null, updated_at = now()
        where operation_id = $1`,
      [input.operationId],
    );
    const result = {
      ok: true,
      operationId: Number(input.operationId),
      status: "scheduled",
      operationStatus: "pending",
      scheduledAt: scheduledAt.toISOString(),
      timezone,
      offset,
      disambiguation,
      scheduleRevision,
      previousRevision: Number(operation.schedule_revision),
      postIds,
      replayed: false,
    };
    await recordEvent(client, {
      ...input,
      action: "reschedule",
      fromStatus: operation.status,
    }, result);
    await client.query("commit");
    return result;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function restorePublicationDraft(input) {
  const invalid = validateMutationInput(input);
  if (invalid) return invalid;
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    const operation = await lockedOperation(client, input.userId, input.operationId);
    if (!operation) {
      await rollback(client);
      return mutationFailure("publication_operation_not_found", 404);
    }
    const replay = await replayedEvent(client, input.operationId, input.idempotencyKey, "restore_draft");
    if (replay) {
      await client.query("commit");
      return replay;
    }
    const conflict = concurrencyFailure(operation, input.expectedRevision, input.expectedStatus);
    if (conflict) {
      await rollback(client);
      return conflict;
    }
    const clientKey = `publication-restore:${input.operationId}:${input.idempotencyKey}`;
    const draft = (await client.query(
      `insert into drafts
         (user_id, text, media, scheduled_at, origin, purpose, client_key, version)
       values ($1, $2, $3::jsonb, null, 'manual', 'publishable', $4, 1)
       returning id, version`,
      [
        input.userId,
        operation.text,
        operation.media == null ? null : JSON.stringify(operation.media),
        clientKey,
      ],
    )).rows[0];
    const destinationIds = Array.isArray(operation.destination_ids)
      ? operation.destination_ids.map(Number).filter(validPositiveInteger)
      : [];
    if (destinationIds.length) {
      await client.query(
        `insert into draft_destinations (draft_id, channel_id)
         select $1, channel.id
           from channels channel
          where channel.user_id = $2 and channel.id = any($3::bigint[])
         on conflict do nothing`,
        [draft.id, input.userId, destinationIds],
      );
    }
    const result = {
      ok: true,
      operationId: Number(input.operationId),
      status: operation.status,
      scheduleRevision: Number(operation.schedule_revision),
      draftId: Number(draft.id),
      draftVersion: Number(draft.version),
      replayed: false,
    };
    await recordEvent(client, {
      ...input,
      action: "restore_draft",
      fromStatus: operation.status,
    }, result);
    await client.query("commit");
    return result;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

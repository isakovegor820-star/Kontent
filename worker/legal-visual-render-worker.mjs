import { createHash } from "node:crypto";

import { validateLegalVisualConfig } from "../src/lib/legal-visual-model.mjs";
import {
  LegalVisualRenderBlockedError,
  renderLegalVisualCarousel,
} from "../src/lib/legal-visual-render.mjs";
import { loadMediaAssetBuffer } from "../src/lib/media-storage.mjs";

const SOURCE_ASSET_MAX_BYTES = 20 * 1024 * 1024;

export class LegalVisualRenderAttemptError extends Error {
  constructor(code, message, terminal = false) {
    super(message);
    this.name = "LegalVisualRenderAttemptError";
    this.code = code;
    this.terminal = terminal;
  }
}

function safeCode(value, fallback = "render_failed") {
  const code = String(value || fallback).toLowerCase().replace(/[^a-z0-9_]/gu, "_").slice(0, 100);
  return code || fallback;
}

function safeMessage(error) {
  if (error instanceof LegalVisualRenderBlockedError) {
    return "Макет не прошёл проверку безопасной области. Исправьте отмеченные поля и повторите рендер.";
  }
  if (error?.code === "source_asset_unavailable") {
    return "Исходное изображение недоступно. Выберите его заново и повторите рендер.";
  }
  return "Не удалось подготовить изображения. Рендер будет повторён автоматически.";
}

async function claim(pool, data) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const row = (await db.query(
      `update legal_visual_render_operations
        set status = 'rendering', attempts = attempts + 1, started_at = coalesce(started_at, now()),
            error_code = null, error_message = null, updated_at = now()
      where id = $1 and project_id = $2 and config_hash = $3
        and status in ('pending','queued','retryable_failed')
      returning id, project_id, design_id, requested_by_user_id, design_revision,
                config_snapshot, config_hash, attempts`,
    [data.operationId, data.projectId, data.configHash],
    )).rows[0];
    if (row) {
      await db.query(
        `insert into legal_visual_render_attempts
           (project_id, operation_id, attempt_number, status)
         values ($1, $2, $3, 'running')`,
        [row.project_id, row.id, row.attempts],
      );
      await db.query("commit");
      return { ...row, attempt_number: Number(row.attempts) };
    }
    const current = (await db.query(
      `select id, project_id, config_hash, status
       from legal_visual_render_operations where id = $1 and project_id = $2`,
      [data.operationId, data.projectId],
    )).rows[0];
    await db.query("rollback");
    if (!current) throw new LegalVisualRenderAttemptError("render_not_found", "Задача рендера не найдена.", true);
    if (String(current.config_hash) !== data.configHash) {
      throw new LegalVisualRenderAttemptError("render_snapshot_mismatch", "Снимок макета не совпадает с задачей.", true);
    }
    if (current.status === "ready") return null;
    if (current.status === "failed") {
      throw new LegalVisualRenderAttemptError("render_terminal", "Рендер уже завершён ошибкой.", true);
    }
    throw new LegalVisualRenderAttemptError("render_busy", "Рендер уже выполняется.");
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function finalize(pool, operation, rendered) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const locked = (await db.query(
      `select status, config_hash from legal_visual_render_operations
        where id = $1 and project_id = $2 for update`,
      [operation.id, operation.project_id],
    )).rows[0];
    if (!locked || locked.status === "ready") {
      await db.query("rollback");
      return;
    }
    if (locked.status !== "rendering" || locked.config_hash !== operation.config_hash) {
      throw new LegalVisualRenderAttemptError("render_state_changed", "Состояние задачи изменилось.", true);
    }
    await db.query(
      "delete from legal_visual_render_cards where operation_id = $1 and project_id = $2",
      [operation.id, operation.project_id],
    );
    for (const card of rendered.cards) {
      const inserted = (await db.query(
        `insert into media_assets (
           user_id, project_id, kind, file_name, mime_type, bytes, data, sha256,
           storage_backend, origin, width_px, height_px, metadata
         ) values ($1,$2,'image',$3,'image/png',$4,$5,$6,'postgres','legal_visual_render',$7,$8,$9::jsonb)
         returning id`,
        [operation.requested_by_user_id, operation.project_id,
          `legal-carousel-${operation.design_id}-r${operation.design_revision}-${card.order}.png`,
          card.png.byteLength, card.png, card.sha256, card.width, card.height,
          JSON.stringify({
            legalVisual: {
              operationId: Number(operation.id),
              designId: Number(operation.design_id),
              designRevision: Number(operation.design_revision),
              cardId: card.cardId,
              cardOrder: card.order,
              configHash: operation.config_hash,
            },
          })],
      )).rows[0];
      await db.query(
        `insert into legal_visual_render_cards (
           operation_id, project_id, design_id, card_id, card_order,
           media_asset_id, sha256, width, height
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [operation.id, operation.project_id, operation.design_id, card.cardId, card.order,
          inserted.id, card.sha256, card.width, card.height],
      );
    }
    await db.query(
      `update legal_visual_render_operations
          set status = 'ready', completed_at = now(), error_code = null,
              error_message = null, updated_at = now()
        where id = $1 and project_id = $2`,
      [operation.id, operation.project_id],
    );
    await db.query(
      `update legal_visual_render_outbox
          set status = 'completed', lease_token = null, lease_expires_at = null,
              last_error_code = null, updated_at = now()
        where operation_id = $1 and project_id = $2`,
      [operation.id, operation.project_id],
    );
    await db.query(
      `update legal_visual_designs
          set status = 'ready', rendered_revision = $3, error_code = null,
              error_message = null, updated_at = now()
        where id = $1 and project_id = $2 and revision = $3 and config_hash = $4`,
      [operation.design_id, operation.project_id, operation.design_revision, operation.config_hash],
    );
    await db.query(
      `update legal_visual_render_attempts
          set status = 'succeeded', safe_error_code = null, completed_at = now()
        where operation_id = $1 and project_id = $2 and attempt_number = $3 and status = 'running'`,
      [operation.id, operation.project_id, operation.attempt_number],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function markFailure(pool, operation, error, workerAttempt) {
  const terminal = error?.terminal === true
    || error instanceof LegalVisualRenderBlockedError
    || Number(operation.attempt_number || workerAttempt) >= 3;
  const code = safeCode(error?.code || (error instanceof LegalVisualRenderBlockedError ? "unsafe_layout" : "render_failed"));
  const message = safeMessage(error);
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(
      `update legal_visual_render_operations
        set status = $3, error_code = $4, error_message = $5,
            completed_at = case when $3 = 'failed' then now() else null end,
            updated_at = now()
      where id = $1 and project_id = $2 and status = 'rendering'`,
    [operation.id, operation.project_id, terminal ? "failed" : "retryable_failed", code, message],
    );
    await db.query(
      `update legal_visual_render_attempts
          set status = $4, safe_error_code = $5, completed_at = now()
        where operation_id = $1 and project_id = $2 and attempt_number = $3 and status = 'running'`,
      [operation.id, operation.project_id, operation.attempt_number, terminal ? "failed" : "failed_retry", code],
    );
    if (terminal) {
      await db.query(
      `update legal_visual_render_outbox
          set status = 'failed', lease_token = null, lease_expires_at = null,
              last_error_code = $3, updated_at = now()
        where operation_id = $1 and project_id = $2 and status <> 'completed'`,
      [operation.id, operation.project_id, code],
    );
      await db.query(
      `update legal_visual_designs
          set status = 'render_failed', error_code = $3, error_message = $4, updated_at = now()
        where id = $1 and project_id = $2 and revision = $5`,
      [operation.design_id, operation.project_id, code, message, operation.design_revision],
    );
    }
    await db.query("commit");
    return { terminal, code, message };
  } catch (failureError) {
    await db.query("rollback").catch(() => {});
    throw failureError;
  } finally {
    db.release();
  }
}

export async function processLegalVisualRender({ pool, data, workerAttempt = 1 }) {
  const operationId = Number(data?.operationId);
  const projectId = Number(data?.projectId);
  const configHash = String(data?.configHash ?? "");
  if (!Number.isSafeInteger(operationId) || operationId < 1
    || !Number.isSafeInteger(projectId) || projectId < 1
    || !/^[0-9a-f]{64}$/u.test(configHash)) {
    throw new LegalVisualRenderAttemptError("invalid_render_job", "Некорректная задача рендера.", true);
  }
  const operation = await claim(pool, { operationId, projectId, configHash });
  if (!operation) return { duplicate: true };
  try {
    const config = validateLegalVisualConfig(operation.config_snapshot);
    if (String(config.projectId) !== String(projectId)) {
      throw new LegalVisualRenderAttemptError("render_project_mismatch", "Проект снимка не совпадает с задачей.", true);
    }
    const rendered = await renderLegalVisualCarousel(config, {
      assetResolver: async (reference) => {
        const assetId = Number(reference.assetId);
        if (!Number.isSafeInteger(assetId) || assetId < 1) {
          throw new LegalVisualRenderAttemptError("source_asset_unavailable", "Исходное изображение не найдено.", true);
        }
        const asset = await loadMediaAssetBuffer({
          pool,
          assetId,
          projectId,
          maxBytes: SOURCE_ASSET_MAX_BYTES,
        });
        if (!asset || asset.kind !== "image" || asset.mime_type !== reference.mimeType) {
          throw new LegalVisualRenderAttemptError("source_asset_unavailable", "Исходное изображение не найдено.", true);
        }
        if (createHash("sha256").update(asset.data).digest("hex") !== reference.sha256) {
          throw new LegalVisualRenderAttemptError("source_asset_unavailable", "Исходное изображение изменилось.", true);
        }
        return { data: asset.data, mimeType: asset.mime_type };
      },
    });
    if (rendered.warnings.some((warning) => warning.code === "asset_unresolved")) {
      throw new LegalVisualRenderAttemptError("source_asset_unavailable", "Исходное изображение недоступно.", true);
    }
    await finalize(pool, operation, rendered);
    return { duplicate: false, cards: rendered.cards.length, configHash: rendered.configSha256 };
  } catch (error) {
    const failure = await markFailure(pool, operation, error, workerAttempt);
    if (!failure.terminal) throw error;
    return { failed: true, errorCode: failure.code };
  }
}

import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  LEGAL_VISUAL_TEMPLATES,
  serializeLegalVisualConfig,
  validateLegalVisualConfig,
  type LegalVisualAssetReference,
  type LegalVisualBrandKit,
  type LegalVisualConfig,
  type LegalVisualFormat,
  type LegalVisualTemplateKey,
} from "./legal-visual-model.mjs";
import { inspectLegalVisualConfig } from "./legal-visual-render.mjs";
import {
  EditorialValidationError,
  recordDraftRevisionInTransaction,
  requireExactDraftApproval,
} from "./editorial-approval";
import { normalizeIdempotencyKey } from "./publication-idempotency";
import {
  requireProjectPermission,
  requireSelectedProjectPermission,
} from "./project-permissions";

type Queryable = Pick<Pool, "query">;
type TransactionPool = Pick<Pool, "connect">;

export type LegalVisualDesignRecord = {
  id: number;
  projectId: number;
  name: string;
  format: LegalVisualFormat;
  status: "draft" | "render_queued" | "rendering" | "ready" | "render_failed";
  revision: number;
  renderedRevision: number | null;
  sourceDraftId: number | null;
  sourceDraftRevisionId: number | null;
  sourceDraftVersion: number | null;
  sourceContentHash: string | null;
  configHash: string;
  config: LegalVisualConfig;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LegalVisualRenderRecord = {
  id: number;
  designId: number;
  projectId: number;
  designRevision: number;
  configHash: string;
  status: "pending" | "queued" | "rendering" | "ready" | "retryable_failed" | "failed";
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cards: Array<{
    id: string;
    order: number;
    assetId: number;
    url: string;
    sha256: string;
    width: number;
    height: number;
  }>;
};

export class LegalVisualServiceError extends Error {
  readonly code:
    | "invalid_request"
    | "invalid_config"
    | "invalid_brand_kit"
    | "invalid_idempotency_key"
    | "asset_not_found"
    | "asset_mismatch"
    | "draft_not_found"
    | "approval_required"
    | "not_found"
    | "version_conflict"
    | "idempotency_conflict"
    | "unsafe_layout";

  readonly details?: unknown;

  constructor(code: LegalVisualServiceError["code"], details?: unknown) {
    super(code);
    this.name = "LegalVisualServiceError";
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_COLORS = {
  background: "#f7f8fc",
  surface: "#ffffff",
  text: "#12182a",
  mutedText: "#56627a",
  accent: "#5637ee",
  critical: "#c42f3b",
} as const;

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function positiveId(value: unknown, code: LegalVisualServiceError["code"] = "not_found"): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new LegalVisualServiceError(code);
  return id;
}

function cleanText(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  return normalized.slice(0, max) || fallback;
}

function configHash(config: LegalVisualConfig): string {
  return createHash("sha256").update(serializeLegalVisualConfig(config)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function createRequestHash(intent: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJson(intent), "utf8")
    .digest("hex");
}

async function withTransaction<T>(pool: TransactionPool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const result = await work(db);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

function defaultBrand(name = "Аврора"): LegalVisualBrandKit {
  return {
    name: cleanText(name, 100, "Аврора"),
    logo: null,
    colors: { ...DEFAULT_COLORS },
    allowedFonts: ["aurora-sans", "legal-serif", "technical-mono"],
    font: "aurora-sans",
    signature: "Информационный материал · проверьте применимость к вашей ситуации",
  };
}

function validateBrand(value: unknown): LegalVisualBrandKit {
  try {
    return validateLegalVisualConfig({
      schemaVersion: 1,
      id: "brand-preview",
      projectId: "1",
      revision: 1,
      name: "Проверка бренда",
      format: "1:1",
      brand: value,
      cards: [
        { id: "one", order: 1, role: "hook", template: "question_answer", eyebrow: "", title: "Заголовок", theses: ["Тезис"], emphasis: "", image: null, cta: null, sourceNote: "" },
        { id: "two", order: 2, role: "context", template: "question_answer", eyebrow: "", title: "Контекст", theses: ["Тезис"], emphasis: "", image: null, cta: null, sourceNote: "" },
        { id: "three", order: 3, role: "cta", template: "question_answer", eyebrow: "", title: "Что делать", theses: ["Тезис"], emphasis: "", image: null, cta: { label: "Сохранить", url: null }, sourceNote: "" },
      ],
    }).brand;
  } catch (error) {
    throw new LegalVisualServiceError("invalid_brand_kit", error);
  }
}

function splitSource(text: string): string[] {
  return text
    .replace(/\r\n?/gu, "\n")
    .split(/(?<=[.!?])\s+|\n+/gu)
    .map((part) => cleanText(part, 220))
    .filter(Boolean)
    .slice(0, 12);
}

function buildDefaultConfig(input: {
  id: string;
  projectId: number;
  name: string;
  format: LegalVisualFormat;
  template: LegalVisualTemplateKey;
  brand: LegalVisualBrandKit;
  sourceText?: string;
}): LegalVisualConfig {
  const sentences = splitSource(input.sourceText ?? "");
  const first = sentences[0] ?? input.name;
  const second = sentences[1] ?? "Разберите правило и проверьте исходные документы.";
  const third = sentences[2] ?? "Сохраните материал и обсудите детали со специалистом.";
  return validateLegalVisualConfig({
    schemaVersion: 1,
    id: input.id,
    projectId: String(input.projectId),
    revision: 1,
    name: input.name,
    format: input.format,
    brand: input.brand,
    cards: [
      {
        id: "card-1", order: 1, role: "hook", template: input.template,
        eyebrow: "Главное", title: first.slice(0, 110), theses: [second.slice(0, 160)],
        emphasis: "", image: null, cta: null, sourceNote: "Источник: исходный черновик",
      },
      {
        id: "card-2", order: 2, role: "actions", template: "three_actions",
        eyebrow: "Практика", title: "Что проверить", theses: [
          second.slice(0, 150),
          (sentences[3] ?? "Сверьте сроки и документы.").slice(0, 150),
          (sentences[4] ?? "Зафиксируйте следующий безопасный шаг.").slice(0, 150),
        ], emphasis: "", image: null, cta: null, sourceNote: "Источник: исходный черновик",
      },
      {
        id: "card-3", order: 3, role: "cta", template: "question_answer",
        eyebrow: "Итог", title: "Что делать дальше", theses: [third.slice(0, 180)],
        emphasis: "", image: null, cta: { label: "Сохранить и вернуться к материалу", url: null },
        sourceNote: "Материал носит информационный характер",
      },
    ],
  });
}

async function getBrandInProject(db: Pick<PoolClient, "query">, projectId: number): Promise<LegalVisualBrandKit> {
  const row = (await db.query<Record<string, unknown>>(
    `select kit.name, kit.colors, kit.allowed_fonts, kit.active_font, kit.signature,
            asset.id as logo_id, asset.mime_type as logo_mime_type,
            asset.sha256 as logo_sha256, asset.width_px as logo_width, asset.height_px as logo_height
       from projects project
       left join project_brand_kits kit on kit.project_id = project.id
       left join media_assets asset on asset.id = kit.logo_asset_id and asset.project_id = kit.project_id
      where project.id = $1 and project.is_archived = false limit 1`,
    [projectId],
  )).rows[0];
  if (!row) throw new LegalVisualServiceError("not_found");
  if (row.colors == null) return defaultBrand(String(row.name || "Аврора"));
  return validateBrand({
    name: row.name,
    logo: row.logo_id == null ? null : {
      assetId: String(row.logo_id),
      alt: "Логотип проекта",
      mimeType: row.logo_mime_type,
      width: Number(row.logo_width || 1),
      height: Number(row.logo_height || 1),
      sha256: row.logo_sha256,
    },
    colors: row.colors,
    allowedFonts: row.allowed_fonts,
    font: row.active_font,
    signature: row.signature,
  });
}

async function canonicalizeAssets(
  db: Pick<PoolClient, "query">,
  projectId: number,
  config: LegalVisualConfig,
): Promise<LegalVisualConfig> {
  const references = [
    ...(config.brand.logo ? [config.brand.logo] : []),
    ...config.cards.flatMap((card) => card.image ? [card.image] : []),
  ];
  if (references.length === 0) return config;
  const ids = [...new Set(references.map((reference) => positiveId(reference.assetId, "asset_not_found")))];
  const rows = (await db.query<Record<string, unknown>>(
    `select id, mime_type, sha256, width_px, height_px
       from media_assets
      where project_id = $1 and kind = 'image' and id = any($2::bigint[])`,
    [projectId, ids],
  )).rows;
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const canonical = (reference: LegalVisualAssetReference): LegalVisualAssetReference => {
    const row = byId.get(positiveId(reference.assetId, "asset_not_found"));
    if (!row) throw new LegalVisualServiceError("asset_not_found");
    const mimeType = String(row.mime_type);
    if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(mimeType)) {
      throw new LegalVisualServiceError("asset_mismatch");
    }
    return {
      ...reference,
      assetId: String(row.id),
      mimeType: mimeType as LegalVisualAssetReference["mimeType"],
      sha256: String(row.sha256).toLowerCase(),
      width: row.width_px == null ? reference.width : Number(row.width_px),
      height: row.height_px == null ? reference.height : Number(row.height_px),
    };
  };
  return validateLegalVisualConfig({
    ...config,
    brand: { ...config.brand, logo: config.brand.logo ? canonical(config.brand.logo) : null },
    cards: config.cards.map((card) => ({ ...card, image: card.image ? canonical(card.image) : null })),
  });
}

async function replaceSourceAssets(
  db: Pick<PoolClient, "query">,
  projectId: number,
  designId: number,
  config: LegalVisualConfig,
): Promise<void> {
  await db.query("delete from legal_visual_source_assets where project_id = $1 and design_id = $2", [projectId, designId]);
  for (const card of config.cards) {
    if (!card.image) continue;
    await db.query(
      `insert into legal_visual_source_assets (design_id, project_id, card_id, media_asset_id)
       values ($1,$2,$3,$4)`,
      [designId, projectId, card.id, positiveId(card.image.assetId, "asset_not_found")],
    );
  }
}

function designFromRow(row: Record<string, unknown>): LegalVisualDesignRecord {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    name: String(row.name),
    format: String(row.format) as LegalVisualFormat,
    status: String(row.status) as LegalVisualDesignRecord["status"],
    revision: Number(row.revision),
    renderedRevision: row.rendered_revision == null ? null : Number(row.rendered_revision),
    sourceDraftId: row.source_draft_id == null ? null : Number(row.source_draft_id),
    sourceDraftRevisionId: row.source_draft_revision_id == null ? null : Number(row.source_draft_revision_id),
    sourceDraftVersion: row.source_draft_version == null ? null : Number(row.source_draft_version),
    sourceContentHash: row.source_content_hash == null ? null : String(row.source_content_hash),
    configHash: String(row.config_hash),
    config: validateLegalVisualConfig(row.config),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const DESIGN_COLUMNS = `id, project_id, name, format, status, revision, rendered_revision,
  source_draft_id, source_draft_revision_id, source_draft_version, source_content_hash,
  config_hash, config, request_hash, error_code, error_message, created_at, updated_at`;

export async function getLegalVisualBrandKit(input: { pool: Queryable; actorUserId: number }) {
  const membership = await requireSelectedProjectPermission(input.pool, input.actorUserId, "project.read");
  const version = (await input.pool.query<{ version: number | string }>(
    "select version from project_brand_kits where project_id = $1",
    [membership.projectId],
  )).rows[0];
  return {
    projectId: membership.projectId,
    version: version ? Number(version.version) : 0,
    brand: await getBrandInProject(input.pool as Pick<PoolClient, "query">, membership.projectId),
  };
}

export async function updateLegalVisualBrandKit(input: {
  pool: TransactionPool;
  actorUserId: number;
  expectedVersion: number;
  brand: unknown;
}) {
  const brand = validateBrand(input.brand);
  return withTransaction(input.pool, async (db) => {
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "project.manage");
    if (brand.logo) await canonicalizeAssets(db, membership.projectId, buildDefaultConfig({ id: "brand-check", projectId: membership.projectId, name: "Проверка", format: "1:1", template: "question_answer", brand }));
    const existing = (await db.query<{ version: number | string }>(
      "select version from project_brand_kits where project_id = $1 for update",
      [membership.projectId],
    )).rows[0];
    const currentVersion = existing ? Number(existing.version) : 0;
    if (currentVersion !== input.expectedVersion) throw new LegalVisualServiceError("version_conflict");
    const nextVersion = currentVersion + 1;
    await db.query(
      `insert into project_brand_kits (
         project_id, name, logo_asset_id, colors, allowed_fonts, active_font,
         signature, version, created_by_user_id, updated_by_user_id
       ) values ($1,$2,$3,$4::jsonb,$5::text[],$6,$7,$8,$9,$9)
       on conflict (project_id) do update set
         name = excluded.name, logo_asset_id = excluded.logo_asset_id, colors = excluded.colors,
         allowed_fonts = excluded.allowed_fonts, active_font = excluded.active_font,
         signature = excluded.signature, version = excluded.version,
         updated_by_user_id = excluded.updated_by_user_id, updated_at = now()`,
      [membership.projectId, brand.name, brand.logo ? positiveId(brand.logo.assetId, "asset_not_found") : null,
        JSON.stringify(brand.colors), brand.allowedFonts, brand.font, brand.signature, nextVersion, input.actorUserId],
    );
    return { projectId: membership.projectId, version: nextVersion, brand };
  });
}

export async function listLegalVisualDesigns(input: { pool: Queryable; actorUserId: number; limit?: number }) {
  const membership = await requireSelectedProjectPermission(input.pool, input.actorUserId, "project.read");
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 30));
  const rows = (await input.pool.query<Record<string, unknown>>(
    `select ${DESIGN_COLUMNS} from legal_visual_designs
      where project_id = $1 order by updated_at desc, id desc limit $2`,
    [membership.projectId, limit],
  )).rows;
  return rows.map(designFromRow);
}

export async function getLegalVisualDesign(input: { pool: Queryable; actorUserId: number; designId: number }) {
  const membership = await requireSelectedProjectPermission(input.pool, input.actorUserId, "project.read");
  const row = (await input.pool.query<Record<string, unknown>>(
    `select ${DESIGN_COLUMNS} from legal_visual_designs where id = $1 and project_id = $2`,
    [positiveId(input.designId), membership.projectId],
  )).rows[0];
  if (!row) throw new LegalVisualServiceError("not_found");
  return designFromRow(row);
}

export async function createLegalVisualDesign(input: {
  pool: TransactionPool;
  actorUserId: number;
  requestKey: unknown;
  name?: unknown;
  format?: unknown;
  template?: unknown;
  sourceDraftId?: unknown;
  config?: unknown;
}) {
  const requestKey = normalizeIdempotencyKey(input.requestKey);
  if (!requestKey) throw new LegalVisualServiceError("invalid_idempotency_key");
  return withTransaction(input.pool, async (db) => {
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.create");
    const replay = (await db.query<Record<string, unknown>>(
      `select ${DESIGN_COLUMNS} from legal_visual_designs where project_id = $1 and request_key = $2`,
      [membership.projectId, requestKey],
    )).rows[0];
    const requestedSourceDraftId = input.sourceDraftId == null
      ? null
      : positiveId(input.sourceDraftId, "draft_not_found");
    const normalizedName = cleanText(input.name, 160, "");
    const normalizedFormat: LegalVisualFormat = input.format === "4:5" || input.format === "9:16" ? input.format : "1:1";
    const normalizedTemplate = LEGAL_VISUAL_TEMPLATES.some((item) => item.key === input.template)
      ? input.template as LegalVisualTemplateKey
      : "what_changed";
    const requestedConfig = input.config && typeof input.config === "object"
      ? input.config as Record<string, unknown>
      : null;
    const requestHash = createRequestHash({
      sourceDraftId: requestedSourceDraftId,
      name: normalizedName,
      format: normalizedFormat,
      template: normalizedTemplate,
      config: requestedConfig,
    });
    if (replay) {
      if (typeof replay.request_hash === "string") {
        if (replay.request_hash !== requestHash) throw new LegalVisualServiceError("idempotency_conflict");
      } else {
        const legacyConfig = replay.config as Record<string, unknown> | null;
        const legacyCards = Array.isArray(legacyConfig?.cards)
          ? legacyConfig.cards as Array<Record<string, unknown>>
          : [];
        const legacyIdentityMatches = requestedConfig == null
          && normalizedName.length > 0
          && Number(replay.source_draft_id ?? 0) === Number(requestedSourceDraftId ?? 0)
          && String(replay.format) === normalizedFormat
          && String(replay.name) === normalizedName
          && legacyCards.length === 3
          && legacyCards[0]?.template === normalizedTemplate
          && legacyCards[1]?.template === "three_actions"
          && legacyCards[2]?.template === "question_answer";
        if (!legacyIdentityMatches) throw new LegalVisualServiceError("idempotency_conflict");
      }
      return { design: designFromRow(replay), duplicate: true };
    }

    let sourceDraftId: number | null = null;
    let sourceRevisionId: number | null = null;
    let sourceDraftVersion: number | null = null;
    let sourceContentHash: string | null = null;
    let sourceText = "";
    if (input.sourceDraftId != null) {
      if (requestedSourceDraftId == null) throw new LegalVisualServiceError("draft_not_found");
      sourceDraftId = requestedSourceDraftId;
      await requireProjectPermission(db, input.actorUserId, membership.projectId, "content.edit");
      const revision = await recordDraftRevisionInTransaction(db, {
        draftId: sourceDraftId,
        actorUserId: input.actorUserId,
        projectId: membership.projectId,
      });
      let approval;
      try {
        approval = await requireExactDraftApproval(
          db,
          input.actorUserId,
          membership.projectId,
          sourceDraftId,
          "content.create",
        );
      } catch (error) {
        if (error instanceof EditorialValidationError && error.code === "approval_required") {
          throw new LegalVisualServiceError("approval_required", error);
        }
        throw error;
      }
      if (approval.revisionId !== revision.id || approval.contentHash !== revision.contentHash) {
        throw new LegalVisualServiceError("approval_required");
      }
      const revisionRow = (await db.query<Record<string, unknown>>(
        `select id, draft_version, content_hash, snapshot from draft_revisions
          where id = $1 and project_id = $2 and draft_id = $3`,
        [revision.id, membership.projectId, sourceDraftId],
      )).rows[0];
      if (!revisionRow) throw new LegalVisualServiceError("draft_not_found");
      sourceRevisionId = Number(revisionRow.id);
      sourceDraftVersion = Number(revisionRow.draft_version);
      sourceContentHash = String(revisionRow.content_hash);
      const snapshot = revisionRow.snapshot as Record<string, unknown>;
      sourceText = typeof snapshot?.text === "string" ? snapshot.text : "";
    }

    const brand = await getBrandInProject(db, membership.projectId);
    const name = normalizedName || cleanText(splitSource(sourceText)[0], 160, "Новая юридическая карусель");
    const format = normalizedFormat;
    const template = normalizedTemplate;
    const publicId = `visual-${randomUUID()}`;
    let config: LegalVisualConfig;
    try {
      const candidate = input.config && typeof input.config === "object"
        ? { ...(input.config as Record<string, unknown>), id: publicId, projectId: String(membership.projectId), revision: 1, name, format, brand }
        : buildDefaultConfig({ id: publicId, projectId: membership.projectId, name, format, template, brand, sourceText });
      config = await canonicalizeAssets(db, membership.projectId, validateLegalVisualConfig(candidate));
    } catch (error) {
      if (error instanceof LegalVisualServiceError) throw error;
      throw new LegalVisualServiceError("invalid_config", error);
    }
    const hash = configHash(config);
    const inserted = (await db.query<Record<string, unknown>>(
      `insert into legal_visual_designs (
         project_id, created_by_user_id, updated_by_user_id,
         source_draft_id, source_draft_revision_id, source_draft_version, source_content_hash,
         name, format, config, config_hash, request_key, request_hash
       ) values ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
       returning ${DESIGN_COLUMNS}`,
      [membership.projectId, input.actorUserId, sourceDraftId, sourceRevisionId, sourceDraftVersion,
        sourceContentHash, config.name, config.format, JSON.stringify(config), hash, requestKey, requestHash],
    )).rows[0];
    await replaceSourceAssets(db, membership.projectId, Number(inserted.id), config);
    return { design: designFromRow(inserted), duplicate: false };
  });
}

export async function updateLegalVisualDesign(input: {
  pool: TransactionPool;
  actorUserId: number;
  designId: number;
  expectedRevision: number;
  config: unknown;
}) {
  return withTransaction(input.pool, async (db) => {
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.edit");
    const current = (await db.query<Record<string, unknown>>(
      `select ${DESIGN_COLUMNS} from legal_visual_designs
        where id = $1 and project_id = $2 for update`,
      [positiveId(input.designId), membership.projectId],
    )).rows[0];
    if (!current) throw new LegalVisualServiceError("not_found");
    if (Number(current.revision) !== input.expectedRevision) throw new LegalVisualServiceError("version_conflict");
    const nextRevision = Number(current.revision) + 1;
    let config: LegalVisualConfig;
    try {
      config = await canonicalizeAssets(db, membership.projectId, validateLegalVisualConfig({
        ...(input.config as Record<string, unknown>),
        id: (current.config as Record<string, unknown>).id,
        projectId: String(membership.projectId),
        revision: nextRevision,
      }));
    } catch (error) {
      if (error instanceof LegalVisualServiceError) throw error;
      throw new LegalVisualServiceError("invalid_config", error);
    }
    const hash = configHash(config);
    const updated = (await db.query<Record<string, unknown>>(
      `update legal_visual_designs
          set name = $3, format = $4, revision = $5, config = $6::jsonb, config_hash = $7,
              status = 'draft', updated_by_user_id = $8, error_code = null,
              error_message = null, updated_at = now()
        where id = $1 and project_id = $2 and revision = $9
        returning ${DESIGN_COLUMNS}`,
      [input.designId, membership.projectId, config.name, config.format, nextRevision,
        JSON.stringify(config), hash, input.actorUserId, input.expectedRevision],
    )).rows[0];
    if (!updated) throw new LegalVisualServiceError("version_conflict");
    await replaceSourceAssets(db, membership.projectId, input.designId, config);
    return designFromRow(updated);
  });
}

export async function requestLegalVisualRender(input: {
  pool: TransactionPool;
  actorUserId: number;
  designId: number;
  expectedRevision: number;
  idempotencyKey: unknown;
}) {
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey) throw new LegalVisualServiceError("invalid_idempotency_key");
  return withTransaction(input.pool, async (db) => {
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.edit");
    const design = (await db.query<Record<string, unknown>>(
      `select ${DESIGN_COLUMNS} from legal_visual_designs
        where id = $1 and project_id = $2 for update`,
      [positiveId(input.designId), membership.projectId],
    )).rows[0];
    if (!design) throw new LegalVisualServiceError("not_found");
    if (Number(design.revision) !== input.expectedRevision) throw new LegalVisualServiceError("version_conflict");
    const config = await canonicalizeAssets(db, membership.projectId, validateLegalVisualConfig(design.config));
    const warnings = inspectLegalVisualConfig(config);
    if (warnings.some((item) => item.severity === "error")) {
      throw new LegalVisualServiceError("unsafe_layout", warnings);
    }
    const hash = configHash(config);
    if (hash !== design.config_hash) throw new LegalVisualServiceError("version_conflict");
    const existing = (await db.query<Record<string, unknown>>(
      `select id, design_id, project_id, design_revision, config_hash, status, attempts,
              error_code, error_message, created_at, updated_at, completed_at
         from legal_visual_render_operations
        where project_id = $1 and idempotency_key = $2`,
      [membership.projectId, idempotencyKey],
    )).rows[0];
    if (existing) {
      if (Number(existing.design_id) !== input.designId || String(existing.config_hash) !== hash) {
        throw new LegalVisualServiceError("idempotency_conflict");
      }
      return { operationId: Number(existing.id), projectId: membership.projectId, configHash: hash, duplicate: true };
    }
    const operation = (await db.query<{ id: number | string }>(
      `insert into legal_visual_render_operations (
         project_id, design_id, requested_by_user_id, design_revision,
         config_snapshot, config_hash, idempotency_key
       ) values ($1,$2,$3,$4,$5::jsonb,$6,$7) returning id`,
      [membership.projectId, input.designId, input.actorUserId, input.expectedRevision,
        JSON.stringify(config), hash, idempotencyKey],
    )).rows[0];
    await db.query(
      `insert into legal_visual_render_outbox (operation_id, project_id) values ($1,$2)`,
      [operation.id, membership.projectId],
    );
    await db.query(
      `update legal_visual_designs set status = 'render_queued', updated_at = now()
        where id = $1 and project_id = $2 and revision = $3`,
      [input.designId, membership.projectId, input.expectedRevision],
    );
    return { operationId: Number(operation.id), projectId: membership.projectId, configHash: hash, duplicate: false };
  });
}

export async function getLegalVisualRender(input: {
  pool: Queryable;
  actorUserId: number;
  designId: number;
  operationId: number;
}): Promise<LegalVisualRenderRecord> {
  const membership = await requireSelectedProjectPermission(input.pool, input.actorUserId, "project.read");
  const row = (await input.pool.query<Record<string, unknown>>(
    `select id, design_id, project_id, design_revision, config_hash, status, attempts,
            error_code, error_message, created_at, updated_at, completed_at
       from legal_visual_render_operations
      where id = $1 and design_id = $2 and project_id = $3`,
    [positiveId(input.operationId), positiveId(input.designId), membership.projectId],
  )).rows[0];
  if (!row) throw new LegalVisualServiceError("not_found");
  const cards = (await input.pool.query<Record<string, unknown>>(
    `select card_id, card_order, media_asset_id, sha256, width, height
       from legal_visual_render_cards
      where operation_id = $1 and design_id = $2 and project_id = $3
      order by card_order`,
    [input.operationId, input.designId, membership.projectId],
  )).rows;
  return {
    id: Number(row.id), designId: Number(row.design_id), projectId: Number(row.project_id),
    designRevision: Number(row.design_revision), configHash: String(row.config_hash),
    status: String(row.status) as LegalVisualRenderRecord["status"], attempts: Number(row.attempts),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    completedAt: row.completed_at == null ? null : iso(row.completed_at),
    cards: cards.map((card) => ({
      id: String(card.card_id), order: Number(card.card_order), assetId: Number(card.media_asset_id),
      url: `/api/media/assets/${card.media_asset_id}`, sha256: String(card.sha256),
      width: Number(card.width), height: Number(card.height),
    })),
  };
}

export { LEGAL_VISUAL_TEMPLATES };

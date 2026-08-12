import { providerSupportsOperation } from "./provider-capabilities.mjs";

export const PUBLICATION_BLOCK_KINDS = [
  "author_signature",
  "contacts",
  "disclaimer",
  "cta",
  "sources",
  "first_comment",
] as const;

export type PublicationBlockKind = (typeof PUBLICATION_BLOCK_KINDS)[number];

export type ClientPublicationBlock = {
  id: number;
  kind: PublicationBlockKind;
  name: string;
  text: string;
  version: number;
  enabled: boolean;
  updatedAt: string;
};

export type ClientPublicationPreferences = {
  draftId: number;
  selectedBlockIds: number[];
  firstCommentFallback: "append_to_post" | "skip";
  commentsMode: "provider_default" | "enabled" | "disabled";
  pinAfterPublish: boolean;
  reviewAt: string | null;
  reviewResponsibleUserId: number | null;
  version: number;
  draftVersion?: number;
};

export type PublicationSettingsPreview = {
  selectedBlocks: ClientPublicationBlock[];
  postBlocks: ClientPublicationBlock[];
  firstCommentBlock: ClientPublicationBlock | null;
  fallback: ClientPublicationPreferences["firstCommentFallback"];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveId(value: unknown) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function parsePublicationBlock(value: unknown): ClientPublicationBlock | null {
  const item = record(value);
  const id = positiveId(item?.id);
  const version = positiveId(item?.version);
  const kind = String(item?.kind || "") as PublicationBlockKind;
  if (
    id == null || version == null || !PUBLICATION_BLOCK_KINDS.includes(kind)
    || typeof item?.name !== "string" || !item.name.trim()
    || typeof item?.text !== "string" || !item.text.trim()
    || typeof item?.updatedAt !== "string"
  ) return null;
  return {
    id,
    kind,
    name: item.name.trim(),
    text: item.text.trim(),
    version,
    enabled: item.enabled === true,
    updatedAt: item.updatedAt,
  };
}

export function parsePublicationBlocksResponse(value: unknown) {
  const body = record(value);
  if (body?.ok !== true || !Array.isArray(body.blocks)) return null;
  const blocks = body.blocks.map(parsePublicationBlock);
  return blocks.every((block): block is ClientPublicationBlock => block !== null) ? blocks : null;
}

export function parsePublicationPreferencesResponse(value: unknown) {
  const body = record(value);
  const item = record(body?.preferences);
  const draftId = positiveId(item?.draftId);
  const version = Number(item?.version);
  if (
    body?.ok !== true || draftId == null
    || !Number.isSafeInteger(version) || version < 0
    || !Array.isArray(item?.selectedBlockIds)
  ) return null;
  const selectedBlockIds = item.selectedBlockIds.map(positiveId);
  if (selectedBlockIds.some((id) => id == null)) return null;
  const fallback = String(item.firstCommentFallback || "skip");
  const commentsMode = String(item.commentsMode || "provider_default");
  const responsible = item.reviewResponsibleUserId == null
    ? null
    : positiveId(item.reviewResponsibleUserId);
  const reviewAt = item.reviewAt == null ? null : String(item.reviewAt);
  const draftVersion = item.draftVersion == null ? undefined : positiveId(item.draftVersion);
  if (
    !(fallback === "append_to_post" || fallback === "skip")
    || !(commentsMode === "provider_default" || commentsMode === "enabled" || commentsMode === "disabled")
    || typeof item.pinAfterPublish !== "boolean"
    || (item.reviewResponsibleUserId != null && responsible == null)
    || (reviewAt != null && Number.isNaN(new Date(reviewAt).getTime()))
    || (item.draftVersion != null && draftVersion == null)
  ) return null;
  return {
    draftId,
    selectedBlockIds: selectedBlockIds as number[],
    firstCommentFallback: fallback,
    commentsMode,
    pinAfterPublish: item.pinAfterPublish,
    reviewAt,
    reviewResponsibleUserId: responsible,
    version,
    draftVersion: draftVersion ?? undefined,
  } satisfies ClientPublicationPreferences;
}

export function buildPublicationSettingsPreview(
  blocks: readonly ClientPublicationBlock[],
  preferences: ClientPublicationPreferences,
): PublicationSettingsPreview {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const selectedBlocks = preferences.selectedBlockIds
    .map((id) => byId.get(id))
    .filter((block): block is ClientPublicationBlock => Boolean(block?.enabled));
  return {
    selectedBlocks,
    postBlocks: selectedBlocks.filter((block) => block.kind !== "first_comment"),
    firstCommentBlock: selectedBlocks.find((block) => block.kind === "first_comment") ?? null,
    fallback: preferences.firstCommentFallback,
  };
}

function join(parts: readonly (string | null | undefined)[]) {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join("\n\n");
}

export function applyPublicationSettingsPreview(input: {
  body: string;
  firstCommentText: string | null;
  providerId: string;
  preview: PublicationSettingsPreview;
}) {
  const supportsFirstComment = providerSupportsOperation(input.providerId, "firstComment");
  let mainText = join([input.body, ...input.preview.postBlocks.map((block) => block.text)]);
  const firstCommentText = supportsFirstComment
    ? join([input.preview.firstCommentBlock?.text, input.firstCommentText]) || null
    : null;
  if (!supportsFirstComment && input.preview.fallback === "append_to_post") {
    mainText = join([mainText, input.preview.firstCommentBlock?.text, input.firstCommentText]);
  }
  return { mainText, firstCommentText, supportsFirstComment };
}

export function publicationSettingCapability(providerIds: readonly string[], operation: "firstComment" | "pin" | "commentToggle") {
  const unique = [...new Set(providerIds)];
  const supported = unique.filter((provider) => providerSupportsOperation(provider, operation));
  const unsupported = unique.filter((provider) => !providerSupportsOperation(provider, operation));
  return { supported, unsupported, available: supported.length > 0, partial: supported.length > 0 && unsupported.length > 0 };
}

export function publicationSettingsErrorMessage(value: unknown) {
  const body = record(value);
  const error = String(body?.error || "");
  if (error === "version_conflict") return "Настройки изменились в другой вкладке. Обновите данные и повторите.";
  if (error === "responsible_member_required") return "Выберите действующего участника проекта.";
  if (error === "invalid_review") return "Укажите корректные дату и ответственного за пересмотр.";
  if (error === "multiple_first_comments") return "Для публикации можно выбрать только один первый комментарий.";
  if (error === "permission_denied" || error === "access_denied") return "Недостаточно прав для изменения этих настроек.";
  if (error === "rate_limited") return "Слишком много изменений подряд. Подождите и повторите.";
  return "Настройки не сохранены. Введённые значения остались на экране — попробуйте ещё раз.";
}

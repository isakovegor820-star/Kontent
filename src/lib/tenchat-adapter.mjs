import { createHash } from "node:crypto";

import { createStoreZip } from "./library-export.mjs";
import { definiteFailure } from "./social-provider-contract.mjs";
import {
  TENCHAT_OFFICIAL_CONTACT_URL,
  TENCHAT_OFFICIAL_RULES_URL,
  TENCHAT_OFFICIAL_SOURCE_CHECKED_AT,
} from "./tenchat-integration.mjs";

function safeFileName(value, fallback) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return normalized || fallback;
}

function validateAsset(asset, index) {
  const data = Buffer.isBuffer(asset?.data) ? asset.data : Buffer.from(asset?.data ?? []);
  const expectedHash = String(asset?.sha256 || "").toLowerCase();
  const actualHash = createHash("sha256").update(data).digest("hex");
  if (!data.length || !/^[0-9a-f]{64}$/u.test(expectedHash) || expectedHash !== actualHash) {
    throw new Error(`tenchat_asset_${index}_hash_mismatch`);
  }
  const mimeType = String(asset?.mimeType || "");
  const extension = mimeType === "image/png"
    ? "png"
    : mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/webp"
        ? "webp"
        : mimeType === "video/mp4"
          ? "mp4"
          : null;
  if (!extension) throw new Error(`tenchat_asset_${index}_unsupported_type`);
  return {
    fileName: `${String(index + 1).padStart(2, "0")}-${safeFileName(asset.fileName, "media")}.${extension}`,
    mimeType,
    sha256: actualHash,
    bytes: data.length,
    data,
  };
}

export function createTenChatExportPackage(input) {
  const projectName = String(input?.projectName || "").trim();
  const text = String(input?.text || "").replace(/\u0000/gu, "").trim();
  const exportedAt = new Date(input?.exportedAt || "");
  if (!projectName || projectName.length > 160) throw new Error("tenchat_project_name_invalid");
  if (!text || text.length > 30_000) throw new Error("tenchat_text_invalid");
  if (!Number.isFinite(exportedAt.getTime())) throw new Error("tenchat_exported_at_invalid");
  const rawAssets = Array.isArray(input?.assets) ? input.assets : [];
  if (rawAssets.length > 10) throw new Error("tenchat_asset_count_invalid");
  const assets = rawAssets.map(validateAsset);
  let scheduledAt = null;
  if (input?.scheduledAt != null && input.scheduledAt !== "") {
    const candidate = new Date(input.scheduledAt);
    if (!Number.isFinite(candidate.getTime())) throw new Error("tenchat_scheduled_at_invalid");
    scheduledAt = candidate.toISOString();
  }

  const manifest = {
    schemaVersion: 1,
    provider: "tenchat",
    mode: "export_only",
    livePublishing: false,
    officialAccessRequired: true,
    manualPublishRequired: true,
    providerLimitsVerified: false,
    mediaCompatibilityVerified: false,
    officialContactUrl: TENCHAT_OFFICIAL_CONTACT_URL,
    officialRulesUrl: TENCHAT_OFFICIAL_RULES_URL,
    checkedAt: TENCHAT_OFFICIAL_SOURCE_CHECKED_AT,
    projectName,
    exportedAt: exportedAt.toISOString(),
    scheduledAt,
    textSha256: createHash("sha256").update(text).digest("hex"),
    assets: assets.map((asset) => ({
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      sha256: asset.sha256,
      bytes: asset.bytes,
    })),
  };
  const readme = [
    "Пакет публикации для TenChat",
    "",
    "Аврора не отправляла этот материал в TenChat.",
    "Автопубликация недоступна без подтверждённого официального доступа TenChat.",
    "Публичные лимиты publishing API и совместимость вложений не подтверждены.",
    `Официальный запрос партнёрского доступа: ${TENCHAT_OFFICIAL_CONTACT_URL}`,
    `Правила TenChat: ${TENCHAT_OFFICIAL_RULES_URL}`,
    "",
    "Проверьте текст и медиа, затем опубликуйте их вручную из официального приложения.",
  ].join("\n");
  const files = [
    ["README.txt", Buffer.from(`${readme}\n`, "utf8")],
    ["manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")],
    ["post.txt", Buffer.from(`${text}\n`, "utf8")],
    ...assets.map((asset) => [`media/${asset.fileName}`, asset.data]),
  ];
  const bytes = createStoreZip(files);
  return {
    bytes,
    contentType: "application/zip",
    extension: "zip",
    filename: `${safeFileName(projectName, "project")}-tenchat-package.zip`,
    manifest,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function officialAccessFailure() {
  return definiteFailure("official_access_required", {
    code: "tenchat_official_access_required",
    retryable: false,
  });
}

/**
 * Contract-ready and intentionally fail-closed. No undocumented endpoint is called.
 * The adapter can be opened only after official credentials and public/partner terms
 * have been verified and contract tests cover the authorized API.
 */
export const TENCHAT_ADAPTER = Object.freeze({
  id: "tenchat",
  label: "TenChat",
  composerSupported: false,
  retryPolicy: "reconcile_before_retry",
  publish: async () => officialAccessFailure(),
  reconcile: async () => officialAccessFailure(),
  exportPackage: createTenChatExportPackage,
  officialAccess: Object.freeze({
    verified: false,
    checkedAt: TENCHAT_OFFICIAL_SOURCE_CHECKED_AT,
    contactUrl: TENCHAT_OFFICIAL_CONTACT_URL,
    rulesUrl: TENCHAT_OFFICIAL_RULES_URL,
  }),
});

import { decryptToken, encryptToken } from "../token-crypto.mjs";
import { assertSiteDestinationAdapter } from "./contract.mjs";
import { createHostedAdapter } from "./hosted.mjs";
import { createWordPressAdapter } from "./wordpress-adapter.mjs";

export * from "./contract.mjs";
export * from "./hosted.mjs";
export { createWordPressAdapter, WordPressAdapterError, wpPostToRef } from "./wordpress-adapter.mjs";

const CREDENTIAL_PROVIDER = "site_destination";

export function encryptDestinationCredentials(credentials, { userId }) {
  return encryptToken(JSON.stringify(credentials), { userId, provider: CREDENTIAL_PROVIDER });
}

export function decryptDestinationCredentials(envelope, { userId }) {
  if (!envelope) return null;
  const parsed = JSON.parse(decryptToken(envelope, { userId, provider: CREDENTIAL_PROVIDER }));
  return parsed && typeof parsed === "object" ? parsed : null;
}

export function normalizeWordPressCredentials(input) {
  const username = String(input?.username || "").trim().slice(0, 120);
  const appPassword = String(input?.appPassword || "").replace(/\s+/gu, "").slice(0, 120);
  if (!username || appPassword.length < 8) return null;
  return { username, appPassword };
}

export function createSiteDestinationAdapters(options = {}) {
  const adapters = Object.freeze({
    wordpress: createWordPressAdapter(options.wordpress || {}),
    site_hosted: createHostedAdapter(options.hosted || {}),
  });
  for (const adapter of Object.values(adapters)) assertSiteDestinationAdapter(adapter);
  return adapters;
}

/**
 * Собирает объект назначения для адаптера из строки site_destinations: расшифровывает
 * учётные данные и подмешивает slug хостируемого раздела. Учётки не покидают этот объект.
 */
export function destinationRuntime(row, { userId, hostedSlug = null }) {
  return {
    id: Number(row.id),
    kind: row.kind,
    baseUrl: row.base_url,
    sectionPath: row.section_path || null,
    settings: { ...(row.settings || {}), hostedSlug: row.settings?.hostedSlug || hostedSlug || null },
    credentials: row.kind === "wordpress" ? decryptDestinationCredentials(row.credentials, { userId }) : null,
  };
}

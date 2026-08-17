import { createClientUuid } from "./client-uuid";

export type StableSiteAnalysisKey = {
  fingerprint: string;
  key: string;
  analysisId: number | null;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const SENSITIVE_QUERY_PARAM = /^(?:access[_-]?token|auth(?:orization)?|api[_-]?key|client[_-]?secret|code|cookie|credential|jwt|password|passwd|refresh[_-]?token|session(?:id)?|sid|signature|token|utm_.+|fbclid|gclid)$/iu;

export const createSiteAnalysisUuid = createClientUuid;

export function siteAnalysisIntentFingerprint(urlValue: string, confirmedDomain: string): string {
  try {
    const url = new URL(urlValue);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAM.test(key)) url.searchParams.delete(key);
    }
    return JSON.stringify({ url: url.toString(), confirmedDomain: confirmedDomain.trim().toLowerCase() });
  } catch {
    return JSON.stringify({ url: "invalid", confirmedDomain: confirmedDomain.trim().toLowerCase() });
  }
}

function parseRecord(value: string | null): StableSiteAnalysisKey | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StableSiteAnalysisKey>;
    if (
      typeof parsed.fingerprint !== "string"
      || typeof parsed.key !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{11,127}$/u.test(parsed.key)
    ) return null;
    const analysisId = Number(parsed.analysisId);
    return {
      fingerprint: parsed.fingerprint,
      key: parsed.key,
      analysisId: Number.isSafeInteger(analysisId) && analysisId > 0 ? analysisId : null,
    };
  } catch {
    return null;
  }
}

export function acquireStableSiteAnalysisKey(
  storage: StorageLike | null,
  slot: string,
  fingerprint: string,
  prefix: string,
  uuid: () => string,
  memoryRecord: StableSiteAnalysisKey | null = null,
): StableSiteAnalysisKey {
  const stored = memoryRecord?.fingerprint === fingerprint
    ? memoryRecord
    : (() => {
        try {
          return parseRecord(storage?.getItem(slot) || null);
        } catch {
          return null;
        }
      })();
  if (stored?.fingerprint === fingerprint) return stored;

  const record = { fingerprint, key: `${prefix}:${uuid()}`, analysisId: null };
  try {
    storage?.setItem(slot, JSON.stringify(record));
  } catch {
    // The in-memory record still keeps retries idempotent when sessionStorage is disabled.
  }
  return record;
}

export function bindStableSiteAnalysisKey(
  storage: StorageLike | null,
  slot: string,
  record: StableSiteAnalysisKey,
  analysisId: number,
): StableSiteAnalysisKey {
  const bound = { ...record, analysisId };
  try {
    storage?.setItem(slot, JSON.stringify(bound));
  } catch {
    // Keep the bound in-memory copy returned to the caller.
  }
  return bound;
}

export function releaseStableSiteAnalysisKey(
  storage: StorageLike | null,
  slot: string,
  analysisId: number,
): void {
  try {
    const record = parseRecord(storage?.getItem(slot) || null);
    if (record?.analysisId === analysisId) storage?.removeItem(slot);
  } catch {
    // Storage availability is not part of the analysis terminal state.
  }
}

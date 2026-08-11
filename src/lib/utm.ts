export const UTM_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export type UtmField = (typeof UTM_FIELDS)[number];
export type UtmValues = Partial<Record<UtmField, string>>;

const PRIVATE_V4 = [
  /^0\./u,
  /^10\./u,
  /^127\./u,
  /^169\.254\./u,
  /^172\.(?:1[6-9]|2\d|3[01])\./u,
  /^192\.168\./u,
  /^224\./u,
  /^2(?:2[5-9]|3\d|4\d|5[0-5])\./u,
];

const PERSONAL_DATA_PATTERN = /(?:[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}|(?:\+?7|8)[\s()-]*\d{3}[\s()-]*\d{3}[\s-]*\d{2}[\s-]*\d{2})/iu;

function isUnsafeHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "").replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }
  // Short links are for named public sites. Blocking every literal IP keeps the
  // browser preview and server redirect on one deterministic policy and closes
  // private, loopback, mapped and unusual numeric host forms without DNS lookup.
  if (normalized.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(normalized)) return true;
  return PRIVATE_V4.some((pattern) => pattern.test(normalized));
}

export function normalizeTrackingDestination(raw: string) {
  const value = raw.trim();
  if (!value || value.length > 2_048) throw new Error("invalid_destination");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_destination");
  }
  if (!(url.protocol === "http:" || url.protocol === "https:")) throw new Error("invalid_protocol");
  if (url.username || url.password) throw new Error("credentials_not_allowed");
  if (!url.hostname || isUnsafeHost(url.hostname)) throw new Error("private_destination_not_allowed");
  url.hash = url.hash.slice(0, 513);
  return url.toString();
}

export function normalizeUtmValues(input: UtmValues): UtmValues {
  const result: UtmValues = {};
  for (const field of UTM_FIELDS) {
    const value = input[field]?.normalize("NFC").trim().replace(/\s+/gu, " ") ?? "";
    if (!value) continue;
    if (value.length > 160) throw new Error(`${field}_too_long`);
    if (PERSONAL_DATA_PATTERN.test(value)) throw new Error(`${field}_contains_personal_data`);
    result[field] = value;
  }
  return result;
}

export function buildTrackedDestination(destination: string, utm: UtmValues) {
  const url = new URL(normalizeTrackingDestination(destination));
  for (const [field, value] of Object.entries(normalizeUtmValues(utm)) as [UtmField, string][]) {
    url.searchParams.set(field, value);
  }
  return url.toString();
}

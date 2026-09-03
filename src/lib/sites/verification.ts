import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";

import { fetchPublicText } from "../safe-http.mjs";

export const SITE_VERIFICATION_DNS_PREFIX = "_aurora-site";
export const SITE_VERIFICATION_META_NAME = "aurora-site-verification";
export const SITE_VERIFICATION_METHODS = ["dns_txt", "meta_tag"] as const;
export type SiteVerificationMethod = (typeof SITE_VERIFICATION_METHODS)[number];

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

export function generateSiteVerificationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isSiteVerificationToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function siteVerificationInstructions(domain: string, token: string) {
  return {
    dns: {
      recordName: `${SITE_VERIFICATION_DNS_PREFIX}.${domain}`,
      recordType: "TXT",
      recordValue: token,
    },
    meta: {
      name: SITE_VERIFICATION_META_NAME,
      content: token,
      tag: `<meta name="${SITE_VERIFICATION_META_NAME}" content="${token}">`,
    },
  };
}

/** TXT-записи приходят массивами фрагментов; сравнение идёт по склеенному значению. */
export function txtRecordsContainToken(records: unknown, token: string): boolean {
  if (!Array.isArray(records) || !isSiteVerificationToken(token)) return false;
  return records.some((record) => {
    const value = Array.isArray(record) ? record.join("") : String(record ?? "");
    return value.trim() === token;
  });
}

const META_TAG = /<meta\b[^>]*>/giu;
const ATTRIBUTE = /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu;

export function htmlContainsVerificationMeta(html: unknown, token: string): boolean {
  if (typeof html !== "string" || !isSiteVerificationToken(token)) return false;
  // Достаточно первых 256 КБ: подтверждающий тег должен стоять в <head>.
  const head = html.slice(0, 256 * 1024);
  for (const tag of head.match(META_TAG) || []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(ATTRIBUTE)) {
      attributes.set(match[1].toLowerCase(), (match[2] ?? match[3] ?? match[4] ?? "").trim());
    }
    if (attributes.get("name")?.toLowerCase() === SITE_VERIFICATION_META_NAME && attributes.get("content") === token) {
      return true;
    }
  }
  return false;
}

export type SiteVerificationCheck =
  | { ok: true; method: SiteVerificationMethod }
  | { ok: false; method: SiteVerificationMethod | null; reason: string };

export type SiteVerificationDeps = {
  resolveTxt?: (hostname: string) => Promise<string[][]>;
  fetchText?: (url: string) => Promise<string>;
};

async function checkDns(domain: string, token: string, resolveTxt: NonNullable<SiteVerificationDeps["resolveTxt"]>) {
  try {
    const records = await resolveTxt(`${SITE_VERIFICATION_DNS_PREFIX}.${domain}`);
    return txtRecordsContainToken(records, token) ? "matched" : "mismatch";
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "dns_error";
    return code === "ENODATA" || code === "ENOTFOUND" ? "missing" : "unavailable";
  }
}

async function checkMeta(canonicalUrl: string, token: string, fetchText: NonNullable<SiteVerificationDeps["fetchText"]>) {
  try {
    const html = await fetchText(canonicalUrl);
    return htmlContainsVerificationMeta(html, token) ? "matched" : "mismatch";
  } catch {
    return "unavailable";
  }
}

const defaultFetchText = async (url: string) => {
  const response = await fetchPublicText(url, { timeoutMs: 8_000, maxBytes: 512 * 1024, headers: { accept: "text/html" } });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.text();
};

/**
 * Проверяет владение доменом одним из двух способов. Никаких внешних сервисов:
 * TXT читается через системный DNS, meta-тег — через SSRF-безопасный fetch.
 */
export async function verifySiteOwnership(
  site: { confirmedDomain: string; canonicalUrl: string; verificationToken: string },
  method: SiteVerificationMethod | "auto" = "auto",
  deps: SiteVerificationDeps = {},
): Promise<SiteVerificationCheck> {
  if (!isSiteVerificationToken(site.verificationToken)) {
    return { ok: false, method: null, reason: "token_invalid" };
  }
  const resolveTxt = deps.resolveTxt ?? ((hostname: string) => dns.resolveTxt(hostname));
  const fetchText = deps.fetchText ?? defaultFetchText;
  const methods: SiteVerificationMethod[] = method === "auto" ? ["dns_txt", "meta_tag"] : [method];
  const outcomes: Array<{ method: SiteVerificationMethod; state: string }> = [];
  for (const candidate of methods) {
    const state = candidate === "dns_txt"
      ? await checkDns(site.confirmedDomain, site.verificationToken, resolveTxt)
      : await checkMeta(site.canonicalUrl, site.verificationToken, fetchText);
    if (state === "matched") return { ok: true, method: candidate };
    outcomes.push({ method: candidate, state });
  }
  const preferred = outcomes.find((item) => item.state === "mismatch") || outcomes[0];
  return {
    ok: false,
    method: preferred?.method ?? null,
    reason: preferred ? `${preferred.method}_${preferred.state}` : "not_checked",
  };
}

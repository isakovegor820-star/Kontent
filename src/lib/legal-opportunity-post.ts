import {
  applyPostPreset,
  patchPostSettings,
  targetForNetwork,
  type PostSettings,
} from "./post-settings";
import type { Network } from "./types";

export const LEGAL_OPPORTUNITY_POST_VARIANTS = [
  {
    id: "standard",
    label: "Новостной",
    description: "Событие, его значение и последствия — без лишней драматизации.",
  },
  {
    id: "short",
    label: "Короткий",
    description: "Сжатая версия с одной главной мыслью для быстрого чтения.",
  },
  {
    id: "expert",
    label: "Экспертный",
    description: "Практический смысл события и аккуратный профессиональный разбор.",
  },
  {
    id: "selling",
    label: "Продающий",
    description: "Связь события с услугой и понятный следующий шаг без ложной срочности.",
  },
] as const;

export type LegalOpportunityPostVariant = typeof LEGAL_OPPORTUNITY_POST_VARIANTS[number]["id"];

const SUPPORTED_NETWORKS = new Set<Network>(["tg", "vk", "instagram"]);

export function isLegalOpportunityPostNetwork(value: unknown): value is "tg" | "vk" | "instagram" {
  return typeof value === "string" && SUPPORTED_NETWORKS.has(value as Network);
}

export function parseLegalOpportunityPostVariant(value: unknown): LegalOpportunityPostVariant {
  return LEGAL_OPPORTUNITY_POST_VARIANTS.some((variant) => variant.id === value)
    ? value as LegalOpportunityPostVariant
    : "standard";
}

export function legalOpportunitySourceClientKey(
  itemId: number,
  channelId: number,
  variant: LegalOpportunityPostVariant,
): string {
  return `rss_item_source:${itemId}:channel:${channelId}:variant:${variant}`;
}

export function legalOpportunityVariantFromClientKey(value: unknown): LegalOpportunityPostVariant {
  if (typeof value !== "string") return "standard";
  const match = value.match(/:variant:(standard|short|expert|selling)$/u);
  return parseLegalOpportunityPostVariant(match?.[1]);
}

export function legalOpportunityPostSettings(
  base: unknown,
  variant: LegalOpportunityPostVariant,
  network: Network,
): PostSettings {
  const preset = variant === "expert"
    ? "expert"
    : variant === "selling"
      ? "selling"
      : "news";
  const withPreset = applyPostPreset(base, preset);
  return patchPostSettings(withPreset, {
    target: targetForNetwork(network),
    length: variant === "short" ? "short" : variant === "standard" ? "medium" : withPreset.length,
    cta: variant === "selling" ? "buy" : "save",
    ctaStrength: variant === "selling" ? "direct" : "soft",
    hashtags: "custom",
    hashtagCount: network === "instagram" ? 5 : 3,
    requireNewAngle: true,
    missingFactsMode: "omit",
    factStrictness: "verified_inference",
    blockAiCliches: true,
    blockGenericPhrases: true,
    outputParts: ["main"],
  });
}

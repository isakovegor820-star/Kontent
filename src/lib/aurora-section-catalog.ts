import { APP_NAV_GROUPS, APP_ROUTES, type AppNavRouteId } from "./app-routes";
import { AURORA_PRODUCT_FEATURES } from "./product-event-contract.mjs";

export type AuroraSectionId = AppNavRouteId;
export type AuroraSectionGroupId = (typeof APP_NAV_GROUPS)[number]["id"];
export type AuroraSloKind = "page" | "api" | "queue" | "worker" | "provider";

export type AuroraSectionSlo = Readonly<{
  kind: AuroraSloKind;
  operation: string;
  p95Ms: number;
}>;

type SectionOperationalDefinition = Readonly<{
  scenario: readonly string[];
  dependencies: readonly string[];
  slos: readonly AuroraSectionSlo[];
}>;

const PAGE_SLO = { kind: "page", operation: "page_load", p95Ms: 2_500 } as const;
const API_SLO = { kind: "api", operation: "interactive_api", p95Ms: 1_500 } as const;
const QUEUE_SLO = { kind: "queue", operation: "queue_wait", p95Ms: 10_000 } as const;
const WORKER_SLO = { kind: "worker", operation: "worker_execution", p95Ms: 60_000 } as const;
const AI_SLO = { kind: "provider", operation: "ai_generation", p95Ms: 120_000 } as const;

const OPERATIONAL: Record<AuroraSectionId, SectionOperationalDefinition> = {
  today: {
    scenario: ["loaded", "task_selected", "task_completed", "task_deferred"],
    dependencies: ["web_api", "postgresql", "stats_queue"],
    slos: [PAGE_SLO, API_SLO, QUEUE_SLO],
  },
  calendar: {
    scenario: ["created", "edited", "rescheduled", "scheduled"],
    dependencies: ["web_api", "postgresql", "redis", "publication_worker"],
    slos: [PAGE_SLO, API_SLO, QUEUE_SLO],
  },
  studio: {
    scenario: ["requested", "result_received", "saved", "used"],
    dependencies: ["web_api", "postgresql", "aurora_ai"],
    slos: [PAGE_SLO, API_SLO, AI_SLO],
  },
  autopilot: {
    scenario: ["planned", "generated", "approved", "scheduled"],
    dependencies: ["web_api", "postgresql", "redis", "autopilot_worker", "aurora_ai"],
    slos: [PAGE_SLO, API_SLO, QUEUE_SLO, WORKER_SLO, AI_SLO],
  },
  composer: {
    scenario: ["loaded", "edited", "saved", "published"],
    dependencies: ["web_api", "postgresql", "publication_worker"],
    slos: [PAGE_SLO, API_SLO, QUEUE_SLO],
  },
  library: {
    scenario: ["searched", "opened", "saved", "used"],
    dependencies: ["web_api", "postgresql"],
    slos: [PAGE_SLO, API_SLO],
  },
  rss: {
    scenario: ["refreshed", "opened", "saved", "hidden", "used"],
    dependencies: ["web_api", "postgresql", "stats_queue"],
    slos: [PAGE_SLO, API_SLO, QUEUE_SLO],
  },
  knowledge: {
    scenario: ["added", "processed", "searched", "used"],
    dependencies: ["web_api", "postgresql", "aurora_ai"],
    slos: [PAGE_SLO, API_SLO, AI_SLO],
  },
  recon: {
    scenario: ["added", "synchronized", "signal_opened", "used"],
    dependencies: ["web_api", "postgresql", "stats_queue"],
    slos: [PAGE_SLO, API_SLO, QUEUE_SLO],
  },
  opportunities: {
    scenario: ["built", "recommendation_opened", "applied"],
    dependencies: ["web_api", "postgresql", "aurora_ai"],
    slos: [PAGE_SLO, API_SLO, AI_SLO],
  },
  radar: {
    scenario: ["searched", "results_received", "saved", "used"],
    dependencies: ["web_api", "postgresql", "stats_queue"],
    slos: [PAGE_SLO, API_SLO, QUEUE_SLO],
  },
  siteAnalysis: {
    scenario: ["started", "crawled", "analyzed", "report_opened", "acted"],
    dependencies: ["web_api", "postgresql", "site_analysis_worker", "aurora_ai"],
    slos: [PAGE_SLO, API_SLO, QUEUE_SLO, WORKER_SLO, AI_SLO],
  },
  growth: {
    scenario: ["opened", "accepted", "completed", "result_confirmed"],
    dependencies: ["web_api", "postgresql", "stats_queue"],
    slos: [PAGE_SLO, API_SLO, QUEUE_SLO],
  },
  analytics: {
    scenario: ["loaded", "filtered", "analyzed", "acted"],
    dependencies: ["web_api", "postgresql", "stats_queue"],
    slos: [PAGE_SLO, API_SLO, QUEUE_SLO],
  },
  settings: {
    scenario: ["changed", "verified", "connected", "saved"],
    dependencies: ["web_api", "postgresql", "mail_delivery", "telegram_worker"],
    slos: [PAGE_SLO, API_SLO],
  },
};

export const AURORA_SECTION_CATALOG = Object.freeze(APP_NAV_GROUPS.flatMap((group) => (
  group.routeIds.map((sectionId) => {
    const route = APP_ROUTES[sectionId];
    const featureEntries = Object.entries(AURORA_PRODUCT_FEATURES[sectionId] ?? {});
    return Object.freeze({
      id: sectionId,
      groupId: group.id,
      groupTitle: group.title,
      label: route.label,
      href: route.href,
      features: Object.freeze(featureEntries.map(([id, actions]) => Object.freeze({ id, actions }))),
      ...OPERATIONAL[sectionId],
    });
  })
)));

export const AURORA_SECTION_BY_ID = Object.freeze(Object.fromEntries(
  AURORA_SECTION_CATALOG.map((section) => [section.id, section]),
)) as Readonly<Record<AuroraSectionId, (typeof AURORA_SECTION_CATALOG)[number]>>;

export function isAuroraSectionId(value: unknown): value is AuroraSectionId {
  return typeof value === "string" && Object.hasOwn(AURORA_SECTION_BY_ID, value);
}

export function auroraSloFor(
  sectionId: AuroraSectionId,
  kind: AuroraSloKind,
): AuroraSectionSlo | null {
  return AURORA_SECTION_BY_ID[sectionId].slos.find((slo) => slo.kind === kind) ?? null;
}

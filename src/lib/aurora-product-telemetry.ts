import {
  AURORA_PRODUCT_FEATURES,
  validateAuroraProductEventDraft,
  type AuroraProductEventDraft,
} from "./product-event-contract.mjs";
import type { AuroraSectionId } from "./aurora-section-catalog";

export type AuroraTelemetryInput = Omit<
  AuroraProductEventDraft,
  "eventId" | "occurredAt" | "sessionId" | "important"
> & { eventId?: string; occurredAt?: string; sessionId?: string | null };

type Sink = (event: AuroraProductEventDraft) => void;
let activeSink: Sink | null = null;

const ROUTES: Array<{ prefix: string; sectionId: AuroraSectionId }> = [
  { prefix: "/app/site-analysis", sectionId: "siteAnalysis" },
  { prefix: "/app/opportunities", sectionId: "opportunities" },
  { prefix: "/app/competitors", sectionId: "recon" },
  { prefix: "/app/trends", sectionId: "recon" },
  { prefix: "/app/recon", sectionId: "recon" },
  { prefix: "/app/autopilot", sectionId: "autopilot" },
  { prefix: "/app/calendar", sectionId: "calendar" },
  { prefix: "/app/composer", sectionId: "composer" },
  { prefix: "/app/knowledge", sectionId: "knowledge" },
  { prefix: "/app/library", sectionId: "library" },
  { prefix: "/app/studio", sectionId: "studio" },
  { prefix: "/app/today", sectionId: "today" },
  { prefix: "/app/radar", sectionId: "radar" },
  { prefix: "/app/growth", sectionId: "growth" },
  { prefix: "/app/analytics", sectionId: "analytics" },
  { prefix: "/app/settings", sectionId: "settings" },
  { prefix: "/app/rss", sectionId: "rss" },
];

export function auroraSectionForPath(pathname: string): AuroraSectionId | null {
  return ROUTES.find((route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`))?.sectionId ?? null;
}

export function primaryAuroraFeature(sectionId: AuroraSectionId): string {
  return Object.keys(AURORA_PRODUCT_FEATURES[sectionId])[0];
}

export function installAuroraTelemetrySink(sink: Sink | null): () => void {
  activeSink = sink;
  return () => {
    if (activeSink === sink) activeSink = null;
  };
}

export function auroraProductEventWireDraft(
  event: AuroraProductEventDraft,
): Omit<AuroraProductEventDraft, "important"> {
  const { important, ...draft } = event;
  void important;
  return draft;
}

export function emitAuroraProductEvent(input: AuroraTelemetryInput): boolean {
  const candidate = {
    ...input,
    eventId: input.eventId ?? crypto.randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    sessionId: input.sessionId ?? null,
  };
  const validated = validateAuroraProductEventDraft(candidate);
  if (!validated.ok || !activeSink) return false;
  activeSink(validated.event);
  return true;
}

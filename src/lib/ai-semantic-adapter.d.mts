import type { SemanticClaimAdapter } from "./semantic-claims.mjs";
import type { EngineId } from "./engines";

export function createConfiguredSemanticAdapter(options?: {
  env?: Record<string, string | undefined>;
  engine?: EngineId;
  fetchImpl?: typeof fetch;
  telemetry?: (event: Record<string, unknown>) => void;
}): SemanticClaimAdapter | null;

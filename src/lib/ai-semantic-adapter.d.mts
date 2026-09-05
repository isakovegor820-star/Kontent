import type { SemanticClaimAdapter } from "./semantic-claims.mjs";
import type { EngineId } from "./engines";
import type { TopicAlignmentAdapter } from "./reference-adaptation";

export function createConfiguredSemanticAdapter(options?: {
  env?: Record<string, string | undefined>;
  engine?: EngineId;
  providerRequestKey?: string;
  providerRequestId?: string;
  fetchImpl?: typeof fetch;
  telemetry?: (event: Record<string, unknown>) => void;
}): (SemanticClaimAdapter & TopicAlignmentAdapter) | null;

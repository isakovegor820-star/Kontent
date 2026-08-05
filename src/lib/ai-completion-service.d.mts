import type { EngineId } from "./engines";

export class AiCompletionError extends Error {
  readonly engine: EngineId;
  readonly code: string;
  readonly status: number | null;
}

export function completeAiText(
  request: {
    system?: string;
    user?: string;
    messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    engine?: EngineId | null;
    temperature?: number;
    maxTokens?: number;
  },
  options?: {
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    timeoutMs?: number;
    localTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    telemetry?: (event: Record<string, unknown>) => void;
  },
): Promise<{ text: string; engine: EngineId; fallbackUsed: boolean; attempts: number }>;

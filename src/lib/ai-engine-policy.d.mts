import type { EngineId } from "./engines";

export interface SharedAiEngineRuntime {
  id: EngineId;
  label: string;
  protocol: "ollama" | "openai" | "anthropic" | null;
  baseUrl: string;
  model: string;
  key: string;
  keyEnv: string | null;
  supported: boolean;
  configured: boolean;
}

export function isConfiguredEngineId(value: unknown): value is EngineId;
export function resolveAiEngineRuntime(engineId: EngineId, env?: Record<string, string | undefined>): SharedAiEngineRuntime;
export function configuredServiceEngine(requested?: unknown, env?: Record<string, string | undefined>): EngineId;
export function configuredAiConcurrency(
  primary: EngineId,
  env?: Record<string, string | undefined>,
  cloudConcurrency?: number,
): number;
export function configuredAiFallbacks(primary: EngineId, env?: Record<string, string | undefined>): EngineId[];

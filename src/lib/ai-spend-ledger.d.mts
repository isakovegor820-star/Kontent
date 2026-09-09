import type { Pool } from "pg";
export class AiSpendError extends Error { constructor(code: string, dimension?: string | null); readonly code: string; readonly dimension: string | null; }
export type AiSpendScope = { pool: Pick<Pool, "connect" | "query">; userId: number; projectId: number; permission?: import("./project-role-policy.mjs").ProjectPermission };
export type AiSpendUsage = { inputTokens: number; outputTokens: number };
export function withAiSpendScope<T>(scope: AiSpendScope, task: () => T): T;
export function resolveAiSpendPolicy(provider: string, model: string, env?: Record<string,string | undefined>): { userCap: number; projectCap: number; globalCap: number; userConcurrency: number; projectConcurrency: number; globalConcurrency: number; tariff: { inputMicrousdPerMillionTokens: number; outputMicrousdPerMillionTokens: number; unitMicrousd: number } };
export function aiSpendCost(tariff: ReturnType<typeof resolveAiSpendPolicy>["tariff"], inputTokens: number, outputTokens: number, units?: number): number;
export function beginAiSpendAttempt(input: { provider: string; model: string; inputTokens: number; outputTokens: number; units?: number }, options?: { scope?: AiSpendScope; env?: Record<string,string | undefined> }): Promise<{ id: string | null; finish(result?: { outcome?: "succeeded" | "failed" | "unknown"; usage?: AiSpendUsage | null }): Promise<void> }>;
export function withChannelAiSpendScope<T>(pool: AiSpendScope["pool"], userId: number, channelId: number, task: () => T): Promise<Awaited<T>>;
export function withSystemAiSpendScope<T>(pool: AiSpendScope["pool"], task: () => T, env?: Record<string,string | undefined>): T;

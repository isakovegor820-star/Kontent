import type { Pool, PoolClient } from "pg";
import type { ProjectPermission } from "./project-role-policy.mjs";
export class AiWorkAccessError extends Error { readonly code: string; constructor(code?: string); }
export function requireAiWorkAccess(db: Pick<Pool | PoolClient, "query">, scope: { userId: number; projectId: number; permission?: ProjectPermission }): Promise<void>;

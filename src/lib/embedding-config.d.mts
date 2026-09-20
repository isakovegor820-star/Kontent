export const EMBED_DIM: 1024;
export function resolveEmbeddingConfig(env?: Record<string, string | undefined>): { provider: string; key: string; url: string; model: string; dimensions: number; identity: string; configured: boolean };

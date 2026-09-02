import { assertWorkerAiCallPolicy } from "./ai-call-policy.mjs";

export const EMBED_DIM = 1024;

/**
 * Один код эмбеддинга для базы знаний каналов и сайтов. Облачный провайдер — при наличии
 * AI_API_KEY, иначе локальный Ollama (bge-m3). null означает «движок недоступен»:
 * вызывающий код обязан оставить объект непроиндексированным, а не записать мусор.
 */
export function createEmbedder(env = process.env, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const ollamaUrl = String(env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/u, "");
  const cloudKey = String(env.AI_API_KEY || "");
  const cloudUrl = String(env.AI_API_URL || "https://api.openai.com/v1").replace(/\/+$/u, "");
  const localModel = env.EMBED_MODEL || "bge-m3";
  const cloudModel = env.EMBED_CLOUD_MODEL || "text-embedding-3-small";

  return async function embed(text) {
    assertWorkerAiCallPolicy("knowledge-embedding");
    const input = String(text || "").trim();
    if (!input) return null;
    try {
      if (cloudKey) {
        const response = await fetchImpl(`${cloudUrl}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cloudKey}` },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ model: cloudModel, input }),
        });
        if (!response.ok) return null;
        const data = await response.json();
        const vector = data?.data?.[0]?.embedding ?? null;
        return Array.isArray(vector) && vector.length === EMBED_DIM ? vector : null;
      }
      const response = await fetchImpl(`${ollamaUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model: localModel, input }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      const vector = data?.embeddings?.[0] ?? data?.embedding ?? null;
      if (vector && vector.length !== EMBED_DIM) {
        console.error(`[база] ${localModel} даёт ${vector.length} измерений, схема ждёт ${EMBED_DIM}`);
        return null;
      }
      return vector;
    } catch {
      return null;
    }
  };
}

export const toVector = (vector) => `[${vector.join(",")}]`;

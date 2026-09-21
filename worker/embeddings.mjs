import { assertWorkerAiCallPolicy } from './ai-call-policy.mjs';
import { resolveEmbeddingConfig, EMBED_DIM } from '../src/lib/embedding-config.mjs';
export { EMBED_DIM };

const httpCode = status => status === 401 || status === 403 ? 'embedding_auth' : status === 404 ? 'embedding_model_unavailable' : status === 429 ? 'embedding_rate_limit' : status >= 500 ? 'embedding_provider_unavailable' : 'embedding_request_rejected';

/** A nullable compatibility wrapper for retrieval; indexing uses result() for typed errors. */
export function createEmbedder(env = process.env, { fetchImpl = fetch, timeoutMs = 30_000, onResult = event => console.info('[knowledge-embedding]', JSON.stringify(event)) } = {}) {
  const config = resolveEmbeddingConfig(env);
  async function result(text) {
    assertWorkerAiCallPolicy('knowledge-embedding');
    const input = String(text || '').trim();
    const started = Date.now();
    let output;
    try {
      if (!config.configured) output = { vector: null, code: 'embedding_not_configured', retryable: false };
      else if (!input) output = { vector: null, code: 'embedding_empty', retryable: false };
      else {
        const local = config.provider === 'ollama';
        const response = await fetchImpl(`${config.url}${local ? '/api/embed' : '/embeddings'}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(!local ? { authorization: `Bearer ${config.key}` } : {}) },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ model: config.model, input, ...(!local ? { dimensions: EMBED_DIM, encoding_format: 'float' } : {}) }),
        });
        if (!response.ok) output = { vector: null, code: httpCode(response.status), retryable: response.status === 429 || response.status >= 500, httpStatus: response.status };
        else {
          const data = await response.json();
          const vector = local ? data?.embeddings?.[0] ?? data?.embedding : data?.data?.[0]?.embedding;
          if (!Array.isArray(vector) || vector.length !== EMBED_DIM) output = { vector: null, code: 'embedding_dimension_mismatch', retryable: false };
          else if (!vector.every(Number.isFinite) || !vector.some(value => value !== 0)) output = { vector: null, code: 'embedding_invalid_vector', retryable: false };
          else output = { vector, code: null, retryable: false };
        }
      }
    } catch (error) {
      output = { vector: null, code: error?.name === 'SyntaxError' ? 'embedding_invalid_response' : /Timeout|Abort/.test(error?.name || '') ? 'embedding_timeout' : 'embedding_network', retryable: error?.name !== 'SyntaxError' };
    }
    // Only controlled fields: no source text, request URL, response body, key or exception message.
    onResult({ provider: config.provider, model: config.model, dimensions: EMBED_DIM, ok: Boolean(output.vector), code: output.code, httpStatus: output.httpStatus ?? null, latencyMs: Date.now() - started });
    return { ...output, model: config.identity };
  }
  const embed = async text => (await result(text)).vector;
  embed.result = result;
  embed.identity = config.identity;
  return embed;
}
export const toVector = vector => `[${vector.join(',')}]`;

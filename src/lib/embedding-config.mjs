import { createHash } from 'node:crypto';

export const EMBED_DIM = 1024;
export function resolveEmbeddingConfig(env = process.env) {
  const provider = env.EMBED_PROVIDER || (env.EMBED_API_KEY ? 'custom' : env.OPENAI_API_KEY || env.AI_API_KEY ? 'openai' : env.NAVYAI_API_KEY ? 'navy' : 'ollama');
  const supported = ['custom', 'openai', 'navy', 'ollama'].includes(provider);
  const key = String(env.EMBED_API_KEY || (provider === 'navy' ? env.NAVYAI_API_KEY : provider === 'openai' ? env.OPENAI_API_KEY || env.AI_API_KEY : '') || '').trim();
  const url = String(env.EMBED_API_URL || (provider === 'ollama' ? env.OLLAMA_URL || 'http://127.0.0.1:11434' : provider === 'navy' ? env.NAVYAI_API_URL || 'https://api.navy/v1' : provider === 'openai' ? env.OPENAI_API_URL || env.AI_API_URL || 'https://api.openai.com/v1' : '')).replace(/\/+$/u, '');
  const model = String((provider === 'ollama' ? env.EMBED_MODEL : env.EMBED_CLOUD_MODEL) || (provider === 'ollama' ? 'bge-m3' : 'text-embedding-3-small'));
  // A URL change can route to different weights under the same model name. Never mix it
  // with an existing index. Keys are deliberately excluded and never returned to clients.
  const identity = createHash('sha256').update(JSON.stringify([provider, url, model, EMBED_DIM, 'v1'])).digest('hex');
  let validUrl = false;
  try { validUrl = ['http:', 'https:'].includes(new URL(url).protocol); } catch {}
  return { provider, key, url, model, dimensions: EMBED_DIM, identity, configured: supported && validUrl && (provider === 'ollama' || Boolean(key)) };
}

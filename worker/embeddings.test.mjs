import { describe, it, expect, vi } from 'vitest';
import { createEmbedder } from './embeddings.mjs';
import { resolveEmbeddingConfig } from '../src/lib/embedding-config.mjs';
const vector = Array(1024).fill(0.01);
function provider(env, response) {
  const fetchImpl = vi.fn().mockResolvedValue(response);
  const onResult = vi.fn();
  return { embed: createEmbedder(env, { fetchImpl, onResult }), fetchImpl, onResult };
}
describe('knowledge embedding provider contract', () => {
  it.each([
    [{ NAVYAI_API_KEY: 'test-secret' }, 'https://api.navy/v1/embeddings'],
    [{ OPENAI_API_KEY: 'test-secret', OPENAI_API_URL: 'https://openai.example/v1' }, 'https://openai.example/v1/embeddings'],
    [{ AI_API_KEY: 'test-secret' }, 'https://api.openai.com/v1/embeddings'],
  ])('routes configured cloud keys and requests compatible dimensions', async (env, url) => {
    const p = provider(env, { ok: true, json: async () => ({ data: [{ embedding: vector }] }) });
    expect(await p.embed('private source')).toEqual(vector);
    expect(p.fetchImpl.mock.calls[0][0]).toBe(url);
    expect(JSON.parse(p.fetchImpl.mock.calls[0][1].body)).toMatchObject({ dimensions: 1024, model: 'text-embedding-3-small', encoding_format: 'float' });
    expect(JSON.stringify(p.onResult.mock.calls)).not.toMatch(/private source|test-secret/);
  });
  it('honors explicit local selection even with a cloud key', async () => {
    const p = provider({ EMBED_PROVIDER: 'ollama', NAVYAI_API_KEY: 'secret' }, { ok: true, json: async () => ({ embeddings: [vector] }) });
    expect(await p.embed('text')).toEqual(vector);
    expect(p.fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/embed');
  });
  it.each([[401, 'embedding_auth', false], [404, 'embedding_model_unavailable', false], [429, 'embedding_rate_limit', true], [500, 'embedding_provider_unavailable', true]])('preserves safe HTTP %s cause', async (status, code, retryable) => {
    const p = provider({ NAVYAI_API_KEY: 'secret' }, { ok: false, status });
    expect(await p.embed.result('text')).toMatchObject({ vector: null, code, retryable });
  });
  it.each([Array(1536).fill(.1), Array(1024).fill(NaN), Array(1024).fill(0)])('rejects malformed vectors without silently writing invalid data', async embedding => {
    const p = provider({ NAVYAI_API_KEY: 'secret' }, { ok: true, json: async () => ({ data: [{ embedding }] }) });
    expect((await p.embed.result('text')).vector).toBeNull();
  });
  it('classifies a network failure and retains nullable retrieval compatibility', async () => {
    const p = provider({ NAVYAI_API_KEY: 'secret' }, null);
    p.fetchImpl.mockRejectedValue(new Error('contains-secret-and-private-url'));
    expect(await p.embed.result('private')).toMatchObject({ code: 'embedding_network', retryable: true });
    expect(await p.embed('private')).toBeNull();
    expect(JSON.stringify(p.onResult.mock.calls)).not.toContain('contains-secret');
  });
  it('separates indexes across model/provider/endpoint changes, but not key rotation', () => {
    const config = resolveEmbeddingConfig({ NAVYAI_API_KEY: 'key1' });
    expect(resolveEmbeddingConfig({ NAVYAI_API_KEY: 'key2' }).identity).toBe(config.identity);
    expect(resolveEmbeddingConfig({ NAVYAI_API_KEY: 'key2', EMBED_CLOUD_MODEL: 'text-embedding-3-large' }).identity).not.toBe(config.identity);
    expect(resolveEmbeddingConfig({ NAVYAI_API_KEY: 'key2', NAVYAI_API_URL: 'https://other.example/v1' }).identity).not.toBe(config.identity);
  });
});

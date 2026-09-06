import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiProviderCircuitBreaker } from './ai-provider-health';
import { resetAiCompletionCircuits } from './ai-completion-service.mjs';
import { probeAiProviderReadiness } from './readiness-probes';

beforeEach(() => {
  vi.stubEnv('NAVYAI_API_KEY', 'synthetic-readiness-key');
  vi.stubEnv('NAVYAI_API_URL', 'https://navy.example/v1');
  vi.stubEnv('AI_SERVICE_ENGINE', 'navy-deepseek-flash');
  aiProviderCircuitBreaker.reset(); resetAiCompletionCircuits();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); aiProviderCircuitBreaker.reset(); resetAiCompletionCircuits(); });

describe('AI readiness requires a real completion', () => {
  it('does not turn a successful model catalogue into health when generation returns 410', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/models')
      ? Response.json({ data: [{ id: 'deepseek-v4-flash' }] })
      : new Response('', { status: 410 }));
    vi.stubGlobal('fetch', fetcher);
    expect((await probeAiProviderReadiness())[0]).toMatchObject({ lastOutcome: 'failure', lastFailureCode: 'readiness_probe_failed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toMatch(/\/chat\/completions$/);
  });
  it('confirms a terminal visible completion using only a fixed synthetic prompt', async () => {
    vi.stubEnv('AI_SERVICE_ENGINE', 'navy-qwen-3-6');
    const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { content: 'READY' }, finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetcher);
    expect((await probeAiProviderReadiness())[0]).toMatchObject({ engine: 'navy-qwen-3-6', lastOutcome: 'success' });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('qwen3.6-27b');
    expect(body.messages).toEqual([{ role: 'system', content: 'This is a synthetic availability check. Reply only READY.' }, { role: 'user', content: 'READY' }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['empty', 'truncated'])('rejects %s completion evidence', async kind => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: kind === 'empty' ? '' : 'REA' }, finish_reason: kind === 'truncated' ? 'length' : 'stop' }] })));
    expect((await probeAiProviderReadiness())[0]).toMatchObject({ lastOutcome: 'failure' });
  });
  it('bounds an unresponsive provider and does not retry the paid request', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const pending = probeAiProviderReadiness();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending)[0]).toMatchObject({ lastOutcome: 'failure' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('shares concurrent cold checks and reuses fresh successful evidence', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const first = probeAiProviderReadiness(); const second = probeAiProviderReadiness();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    finish(Response.json({ choices: [{ message: { content: 'READY' }, finish_reason: 'stop' }] }));
    const results = await Promise.all([first, second]);
    expect(results[0][0]).toMatchObject({ lastOutcome: 'success' });
    expect(results[1]).toEqual(results[0]);
    expect((await probeAiProviderReadiness())[0]).toMatchObject({ lastOutcome: 'success' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

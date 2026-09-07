import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { scrubTelemetry, telemetryScrubIntegration } from './telemetry-scrub.mjs';
describe('final telemetry boundary', () => {
  it('removes path, query, userinfo and credential fields while preserving diagnostic IDs', () => {
    const event = {request: {url:'https://user:credential@example.test/file/bot123:fake/getFile?access_token=query-value',headers:{Authorization:'Bearer bearer-value'}}, breadcrumbs:[{data:{url:'https://api.telegram.org/bot123:fake/sendMessage',status_code:429,method:'POST'}}],spans:[{description:'fetch /bot123%3Afake/sendPhoto'}],extra:{requestId:'req-7'}};
    scrubTelemetry(event);
    const payload=JSON.stringify(event);
    for(const value of ['123:fake','123%3Afake','query-value','bearer-value','credential'])expect(payload).not.toContain(value);
    expect(event.extra.requestId).toBe('req-7');
    expect(event.breadcrumbs[0].data.status_code).toBe(429);
  });
  it('scrubs enriched data when SDK sends the final envelope', () => {
    let hook;
    telemetryScrubIntegration().setup({on:(name,fn)=>{expect(name).toBe('beforeEnvelope');hook=fn}});
    const envelope=[{},[[{type:'span'},{description:'POST https://api.telegram.org/bot123:fake/sendPhoto'}]]];
    hook(envelope);
    expect(JSON.stringify(envelope)).not.toContain('123:fake');
  });
  it('covers every enabled runtime configuration', () => {
    for(const file of ['sentry.worker.config.mjs','sentry.server.config.ts','sentry.edge.config.ts','src/instrumentation-client.ts']){
      expect(readFileSync(new URL('../../'+file,import.meta.url),'utf8')).toContain('integrations: [telemetryScrubIntegration()]');
    }
  });
});

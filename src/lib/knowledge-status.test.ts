import { expect, it } from 'vitest';
import { knowledgeCanRetry, knowledgeNeedsPolling, knowledgeStatusMessage } from './knowledge-status';
it('reports text availability while semantic processing is unavailable', () => {
  const message = knowledgeStatusMessage({ status: 'ready', chunks: 2, semantic_ready: false, embedding_error_code: 'embedding_auth', embedding_attempts: 1, next_retry_at: null });
  expect(message).toContain('Текст доступен');
  expect(message).toContain('проверить подключение');
  expect(message).toContain('попытки остановлены');
  expect(message).not.toContain('embedding_auth');
});
it('distinguishes queued, retrying, and completed states', () => {
  expect(knowledgeStatusMessage({ status: 'pending', chunks: 0 })).toContain('ждёт обработки');
  expect(knowledgeStatusMessage({ status: 'ready', chunks: 1, semantic_ready: true })).toContain('текстового и семантического');
  expect(knowledgeStatusMessage({ status: 'ready', chunks: 1, embedding_error_code: 'embedding_rate_limit', next_retry_at: new Date().toISOString() })).toContain('Повтор запланирован');
});

it('keeps polling a legacy index and an active final attempt, but stops on quarantine', () => {
  expect(knowledgeNeedsPolling({ status: 'ready', chunks: 1, semantic_ready: false })).toBe(true);
  const active = { status: 'ready' as const, chunks: 1, embedding_error_code: 'embedding_processing', embedding_attempts: 5, next_retry_at: new Date(Date.now()+60_000).toISOString() };
  expect(knowledgeNeedsPolling(active)).toBe(true);
  expect(knowledgeCanRetry(active)).toBe(false);
  expect(knowledgeStatusMessage(active)).toContain('готовится');
  const paused = { ...active, next_retry_at: new Date(0).toISOString() };
  expect(knowledgeNeedsPolling(paused)).toBe(false);
  expect(knowledgeCanRetry(paused)).toBe(true);
});

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/use-project-transport', () => ({ useProjectFetch: () => mocks.fetch }));
vi.mock('@/components/app/shell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('@/lib/store', () => ({ useStore: () => ({ realChannels: [{ id: 22 }], toast: mocks.toast }) }));
vi.mock('@/components/app/channel-picker', () => ({ ChannelPicker: () => null, useChannelChoice: () => ({ tgChannels: [{ id: 22 }], channelId: 22 }) }));
import KnowledgePage from './page';
const failed = { id: 1, title: 'Услуги', kind: 'paste', status: 'ready', chunks: 2, semantic_ready: false, text_indexed_at: '2026-09-14T10:00:00Z', embedding_error_code: 'embedding_auth', embedding_attempts: 1, next_retry_at: null, added_at: '2026-09-14T10:00:00Z', last_attempt_at: '2026-09-14T10:00:00Z' };
const payload = (source = failed) => ({ ok: true, channelId: 22, facts: 2, voice: 0, effectiveProfile: {}, sources: [source] });
beforeEach(() => { mocks.fetch.mockReset(); mocks.toast.mockReset(); });
afterEach(cleanup);
describe('knowledge recovery interaction', () => {
  it('announces text availability and recovers the same source through a scoped retry', async () => {
    let ready = false;
    mocks.fetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'PUT') { ready = true; return { ok: true, json: async () => ({ ok: true, queued: true }) }; }
      return { ok: true, json: async () => payload(ready ? { ...failed, semantic_ready: true, embedding_error_code: null as unknown as string } : failed) };
    });
    render(<KnowledgePage />);
    const retry = await screen.findByRole('button', { name: 'Повторить обработку «Услуги»' });
    expect(screen.getByText(/Текст доступен для поиска и генерации/).getAttribute('role')).toBe('status');
    fireEvent.click(retry);
    await screen.findByText('Материал доступен для текстового и семантического поиска.');
    expect(screen.queryByRole('button', { name: 'Повторить обработку «Услуги»' })).toBeNull();
    expect(mocks.fetch.mock.calls.find(call => call[1]?.method === 'PUT')?.[1].body).toBe(JSON.stringify({ channelId: 22, sourceId: 1 }));
  });
  it('retains entered material and explains an unconfirmed network save', async () => {
    mocks.fetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') throw new Error('network');
      return { ok: true, json: async () => payload() };
    });
    render(<KnowledgePage />);
    await screen.findByRole('button', { name: 'Добавить в базу' });
    const title = document.getElementById('knowledge-source-title') as HTMLInputElement;
    const text = document.getElementById('knowledge-source-text') as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: 'Цены' } });
    fireEvent.change(text, { target: { value: 'Консультация стоит 1000 рублей.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить в базу' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Сохранение не подтверждено' })));
    expect(text.value).toBe('Консультация стоит 1000 рублей.');
  });
});

import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { indexKnowledgeSource } from '../../worker/knowledge-indexer.mjs';
import { createEmbedder, toVector } from '../../worker/embeddings.mjs';
import { reconcilePendingKnowledgeSources } from '../lib/knowledge-index-queue.mjs';
import { knowledgeStyleSamples } from '../lib/knowledge-style.mjs';
import { channelAiContextFor } from '../lib/ai-usage';
import { migrate } from '../../scripts/migrate.mjs';
const databaseUrl = String(process.env.DATABASE_URL || '');
const target = new URL(databaseUrl);
if (target.hostname !== '127.0.0.1' || target.pathname !== '/aurora_launch_test') throw new Error('Requires disposable local aurora_launch_test');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
let owner: number, project: number, channel: number;
const vector = Array(1024).fill(0.01);
const good = () => createEmbedder({ NAVYAI_API_KEY: 'synthetic', NODE_ENV: 'test' }, { fetchImpl: async () => Response.json({ data: [{ embedding: vector }] }), onResult() {} });
const broken = () => createEmbedder({ NAVYAI_API_KEY: 'synthetic', NODE_ENV: 'test' }, { fetchImpl: async () => new Response(null, { status: 503 }), onResult() {} });
async function source(kind = 'paste', raw = 'Стоимость консультации составляет 1000 рублей. Срок подготовки ответа — два рабочих дня.') {
  return Number((await pool.query("insert into knowledge_sources(user_id,channel_id,kind,title,raw_text) values($1,$2,$3,'Fixture',$4) returning id", [owner,channel,kind,raw])).rows[0].id);
}
beforeAll(async () => {
  await pool.query('drop schema public cascade; create schema public');
  await pool.query(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  await migrate({ env: { DATABASE_URL: databaseUrl }, logger: { log() {} } });
  owner = Number((await pool.query("insert into users(email,name) values('engine@knowledge.test','Engine tester') returning id")).rows[0].id);
  project = Number((await pool.query("insert into projects(name,created_by_user_id) values('Knowledge engine',$1) returning id", [owner])).rows[0].id);
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner')", [project,owner]);
  channel = Number((await pool.query("insert into channels(project_id,user_id,network,tg_chat_id,title) values($1,$2,'tg',-100555111,'Knowledge') returning id", [project,owner])).rows[0].id);
});
beforeEach(async () => { await pool.query('delete from knowledge_sources where channel_id=$1', [channel]); });
afterAll(async () => { await pool.end(); });

describe.sequential('knowledge text, embeddings, and durable recovery', () => {
  it('keeps new text searchable and available to generation when embeddings fail; restores without changing chunk IDs', async () => {
    const id = await source();
    expect(await indexKnowledgeSource(pool, broken(), id)).toMatchObject({ semanticReady: false, code: 'embedding_provider_unavailable' });
    const chunks = (await pool.query("select id from knowledge_chunks where source_id=$1 and tsv @@ plainto_tsquery('russian','консультация')", [id])).rows;
    expect(chunks).toHaveLength(1);
    const state = (await pool.query('select * from knowledge_sources where id=$1', [id])).rows[0];
    expect(state.status).toBe('ready'); expect(state.next_retry_at).not.toBeNull();
    const context = await channelAiContextFor(owner, channel, 10, pool);
    expect(context?.facts[0]).toContain('1000');
    await pool.query('update knowledge_chunks set used_count=7 where source_id=$1', [id]);
    expect(await indexKnowledgeSource(pool, good(), id)).toMatchObject({ semanticReady: true });
    const restored = (await pool.query('select id, used_count, embedding_model, vector_dims(embedding) as dims from knowledge_chunks where source_id=$1', [id])).rows;
    expect(restored[0]).toMatchObject({ id: chunks[0].id, used_count: 7, embedding_model: good().identity, dims: 1024 });
    const found = await pool.query('select id from knowledge_chunks where channel_id=$1 and embedding_model=$2 order by embedding <=> $3::vector limit 1', [channel,good().identity,toVector(vector)]);
    expect(found.rows[0].id).toBe(chunks[0].id);
  });
  it('bounds automatic retries but lets a changed model recover', async () => {
    const id = await source();
    for (let i=0; i<5; i++) await indexKnowledgeSource(pool, broken(), id);
    const state = (await pool.query('select embedding_attempts, next_retry_at from knowledge_sources where id=$1', [id])).rows[0];
    expect(state).toMatchObject({ embedding_attempts: 5, next_retry_at: null });
    const calls: number[] = [];
    const queue = { async add(_name: string, data: {sourceId: number}) { calls.push(Number(data.sourceId)); } };
    await reconcilePendingKnowledgeSources(pool, queue, { model: good().identity });
    expect(calls).toEqual([]);
    await reconcilePendingKnowledgeSources(pool, queue, { model: 'changed-model' });
    expect(calls).toEqual([id]);
  });
  it('recovers the 201st source despite a 200-source backlog and failed Redis enqueues', async () => {
    await pool.query("insert into knowledge_sources(user_id,channel_id,kind,title,raw_text) select $1,$2,'paste','Fixture','Тестовый факт' from generate_series(1,201)", [owner,channel]);
    const last = Number((await pool.query('select max(id) as id from knowledge_sources where channel_id=$1', [channel])).rows[0].id);
    const first = await reconcilePendingKnowledgeSources(pool, { async add() { throw new Error('redis unavailable'); } }, { model: good().identity });
    expect(first).toMatchObject({ scanned: 200, failed: 200 });
    const calls: number[] = [];
    await reconcilePendingKnowledgeSources(pool, { async add(_name: string, data: {sourceId: number}) { calls.push(Number(data.sourceId)); } }, { model: good().identity });
    expect(calls).toEqual([last]);
  });
  it('does not resurrect a source deleted while the provider is responding', async () => {
    const id = await source();
    const embed = good();
    const original = embed.result;
    embed.result = async (text: string) => { await pool.query('delete from knowledge_sources where id=$1', [id]); return original(text); };
    expect(await indexKnowledgeSource(pool, embed, id)).toMatchObject({ skipped: true });
    expect((await pool.query('select id from knowledge_chunks where source_id=$1', [id])).rowCount).toBe(0);
  });
  it('makes an explicit style import available to generation, never as a fact', async () => {
    const text = 'Пишем короткими предложениями, обращаемся к читателю на вы. Приводим понятные примеры из практики.';
    await source('channel', text);
    expect(await knowledgeStyleSamples(pool, channel)).toEqual([text]);
    expect(await knowledgeStyleSamples(pool, channel + 99999)).toEqual([]);
    const context = await channelAiContextFor(owner, channel, 10, pool);
    expect(context?.styleSamples).toContain(text);
    expect(context?.facts).toEqual([]);
  });
});

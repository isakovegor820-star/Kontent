// Live embedding smoke test against a disposable local database only.
import pg from 'pg';
import { createEmbedder, toVector } from '../worker/embeddings.mjs';
import { indexKnowledgeSource } from '../worker/knowledge-indexer.mjs';
const url = new URL(process.env.KNOWLEDGE_SMOKE_DATABASE_URL || '');
if (url.hostname !== '127.0.0.1' || url.pathname !== '/aurora_launch_test') throw new Error('Disposable local aurora_launch_test required');
const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
const embed = createEmbedder(process.env);
let userId;
try {
  userId = (await pool.query("insert into users(email,name) values($1,'Knowledge smoke fixture') returning id", [`knowledge-smoke-${Date.now()}@example.test`])).rows[0].id;
  const projectId = (await pool.query("insert into projects(name,created_by_user_id) values('Knowledge smoke fixture',$1) returning id", [userId])).rows[0].id;
  const channelId = (await pool.query("insert into channels(project_id,user_id,network,title,tg_chat_id) values($1,$2,'tg','Knowledge smoke fixture',$3) returning id", [projectId,userId,-Date.now()])).rows[0].id;
  const sourceId = (await pool.query("insert into knowledge_sources(user_id,channel_id,kind,title,raw_text) values($1,$2,'paste','Synthetic fact','Консультация стоит 1000 рублей. Письменный ответ готовится за два рабочих дня.') returning id", [userId,channelId])).rows[0].id;
  const indexed = await indexKnowledgeSource(pool, embed, sourceId);
  if (!indexed.semanticReady) throw new Error(indexed.code || 'index_incomplete');
  const query = await embed('Стоимость консультации и срок ответа');
  if (!query) throw new Error('query_embedding_failed');
  const found = await pool.query(`select source_id, vector_dims(embedding) as dimensions,
    1-(embedding <=> $2::vector) as similarity,
    tsv @@ plainto_tsquery('russian','консультация') as text_match
    from knowledge_chunks where channel_id=$1 and embedding_model=$3
    order by embedding <=> $2::vector limit 1`, [channelId,toVector(query),embed.identity]);
  const result = found.rows[0];
  if (result?.source_id !== sourceId || !result.text_match || result.dimensions !== 1024 || Number(result.similarity) < 0.45) throw new Error('retrieval_failed');
  console.log(JSON.stringify({ ok: true, semanticReady: true, textMatch: result.text_match, dimensions: result.dimensions, similarity: Number(result.similarity) }));
} finally {
  if (userId) {
    await pool.query('delete from channels where project_id in (select id from projects where created_by_user_id=$1)', [userId]);
    await pool.query('delete from projects where created_by_user_id=$1', [userId]);
    await pool.query('delete from users where id=$1', [userId]);
  }
  await pool.end();
}

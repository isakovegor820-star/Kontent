import { splitChunks } from './lib.mjs';
import { toVector } from './embeddings.mjs';

export const MAX_EMBEDDING_ATTEMPTS = 5;
/** Text is committed before the external call; retries preserve chunk IDs and usage metadata. */
export async function indexKnowledgeSource(pool, embedder, sourceId) {
  const tx = await pool.connect();
  let src;
  let chunks;
  let attempt;
  try {
    await tx.query('begin');
    const owner = (await tx.query('select channel_id, site_id from knowledge_sources where id=$1', [sourceId])).rows[0];
    if (owner?.channel_id) await tx.query('select id from channels where id=$1 for key share', [owner.channel_id]);
    else if (owner?.site_id) await tx.query('select id from sites where id=$1 for key share', [owner.site_id]);
    src = (await tx.query('select * from knowledge_sources where id = $1 for update', [sourceId])).rows[0];
    if (!src) { await tx.query('commit'); return { error: 'no_source' }; }
    if (src.text_indexed_at && src.embedding_model === embedder.identity && Number(src.embedding_attempts) >= MAX_EMBEDDING_ATTEMPTS) {
      await tx.query("update knowledge_sources set next_retry_at=null where id=$1", [sourceId]);
      await tx.query('commit'); return { semanticReady: false, code: src.embedding_error_code, exhausted: true };
    }
    const parts = splitChunks(src.raw_text);
    if (!parts.length) {
      await tx.query("update knowledge_sources set status='error', last_error='Материал пуст. Добавьте текст.', embedding_error_code='embedding_empty', next_retry_at=null where id=$1", [sourceId]);
      await tx.query('commit');
      return { error: 'empty' };
    }
    chunks = (await tx.query('select id, text from knowledge_chunks where source_id=$1 order by id', [sourceId])).rows;
    if (!chunks.length) {
      const kind = src.kind === 'channel' ? 'voice' : src.kind === 'form' ? 'service' : 'fact';
      for (const part of parts) {
        const row = (await tx.query(`insert into knowledge_chunks (user_id, channel_id, site_id, source_id, kind, text)
          values ($1,$2,$3,$4,$5,$6) returning id, text`, [src.user_id, src.channel_id, src.site_id, sourceId, kind, part])).rows[0];
        chunks.push(row);
      }
    }
    attempt = src.embedding_model === embedder.identity ? Number(src.embedding_attempts) + 1 : 1;
    await tx.query(`update knowledge_sources set status='ready', text_indexed_at=coalesce(text_indexed_at, now()),
      embedding_model=$2, embedding_attempts=$3, embedding_error_code='embedding_processing', last_error=null, last_attempt_at=now(), next_retry_at=now()+interval '5 minutes'
      where id=$1`, [sourceId, embedder.identity, attempt]);
    await tx.query('commit');
  } catch (error) {
    await tx.query('rollback').catch(() => {});
    throw error;
  } finally { tx.release(); }

  const vectors = [];
  let failure = null;
  for (const chunk of chunks) {
    const result = await embedder.result(chunk.text);
    if (!result.vector) { failure = result; break; }
    vectors.push([chunk.id, result.vector]);
  }
  const db = await pool.connect();
  try {
    await db.query('begin');
    const existing = (await db.query('select id, embedding_model, embedding_attempts from knowledge_sources where id=$1 for update', [sourceId])).rows[0];
    // Deleted/replaced sources never reappear. A later attempt owns the final state.
    if (!existing || existing.embedding_model !== embedder.identity || Number(existing.embedding_attempts) !== attempt) {
      await db.query('commit'); return { skipped: true };
    }
    if (failure) {
      const retrySeconds = failure.retryable && attempt < MAX_EMBEDDING_ATTEMPTS ? Math.min(3600, 60 * 2 ** (attempt - 1)) : null;
      await db.query(`update knowledge_sources set embedding_error_code=$2, last_error=$2,
        next_retry_at=case when $3::int is null then null else now()+make_interval(secs=>$3) end where id=$1`, [sourceId, failure.code, retrySeconds]);
    } else {
      for (const [id, vector] of vectors) {
        await db.query('update knowledge_chunks set embedding=$2::vector, embedding_model=$3 where id=$1 and source_id=$4', [id, toVector(vector), embedder.identity, sourceId]);
      }
      await db.query(`update knowledge_sources set indexed_at=now(), last_error=null, embedding_error_code=null,
        next_retry_at=null, embedding_attempts=0 where id=$1`, [sourceId]);
    }
    await db.query('commit');
  } catch (error) {
    await db.query('rollback').catch(() => {});
    throw error;
  } finally { db.release(); }
  return { chunks: chunks.length, semanticReady: !failure, code: failure?.code ?? null };
}

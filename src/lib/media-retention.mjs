const identifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const qualified = (table) => `public.${identifier(table)}`;

// Conservative discovery covers current and newly added JSON snapshots/text URLs,
// as well as every FK to an asset id (including composite project-scoped FKs).
async function referenceCatalog(client) {
  const textual = (await client.query(`select c.relname as table_name, a.attname as column_name
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid
    join pg_type t on t.oid=a.atttypid
    where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
      and c.relname<>'media_assets' and t.typname in ('json','jsonb','text','varchar')
    order by c.relname,a.attnum`)).rows;
  const foreignKeys = (await client.query(`select c.conrelid::regclass::text as table_name, a.attname as column_name
    from pg_constraint c
    join lateral unnest(c.conkey,c.confkey) as k(local_att,foreign_att) on true
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.local_att
    join pg_attribute f on f.attrelid=c.confrelid and f.attnum=k.foreign_att
    where c.contype='f' and c.confrelid='media_assets'::regclass and f.attname='id'
    order by c.conrelid,a.attname`)).rows;
  const tables = new Map();
  for (const row of textual) {
    const table = tables.get(row.table_name) || { text: new Set(), ids: new Set() };
    table.text.add(row.column_name); tables.set(row.table_name,table);
  }
  for (const row of foreignKeys) {
    const name = row.table_name.replace(/^public\./u,'').replaceAll('"','');
    const table = tables.get(name) || { text: new Set(), ids: new Set() };
    table.ids.add(row.column_name); tables.set(name,table);
  }
  return [...tables].sort(([a],[b]) => a.localeCompare(b));
}

export async function cleanupUnusedMedia({ pool, createdBefore, limit = 25, afterAssetId = 0, apply = false }) {
  const cutoff = new Date(createdBefore);
  if (!Number.isFinite(cutoff.getTime()) || cutoff.getTime() >= Date.now()) throw new Error('explicit_past_media_retention_cutoff_required');
  if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw new Error('invalid_media_cleanup_limit');
  if (!Number.isSafeInteger(afterAssetId) || afterAssetId<0) throw new Error('invalid_media_cleanup_cursor');
  const client = await pool.connect();
  try {
    await client.query(apply ? 'begin' : 'begin isolation level repeatable read read only');
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='30s'");
    const catalog=await referenceCatalog(client);
    if (apply) {
      // JSON references have no FK lock. A maintenance transaction must block
      // their writers until deletion commits, otherwise a new draft can race us.
      for (const [table] of catalog) await client.query(`lock table ${qualified(table)} in share mode`);
      await client.query('lock table media_assets in share row exclusive mode');
    }
    const candidates=(await client.query(`select id,storage_backend,bytes,greatest(bytes,coalesce(octet_length(data),0))::text as stored_bytes
      from media_assets where created_at<$1 and id>$3 order by id limit $2`,[cutoff,limit,afterAssetId])).rows;
    const protectedIds=[]; const unused=[];
    for (const asset of candidates) {
      const pattern=`("(assetId|mediaAssetId|outputAssetId|asset_id|media_asset_id|logoAssetId)"[[:space:]]*:[[:space:]]*"?${asset.id}("|[,}[:space:]]|$)|/api/media/assets/${asset.id}([^0-9]|$))`;
      let referenced=false;
      for (const [table, columns] of catalog) {
        const predicates=[...columns.ids].map(c=>`${identifier(c)}::text=$1`).concat([...columns.text].map(c=>`${identifier(c)}::text ~ $2`));
        const row=await client.query(`select 1 from ${qualified(table)} where (${predicates.join(' or ')}) and $1::text is not null and $2::text is not null limit 1`,[String(asset.id),pattern]);
        if(row.rowCount>0){referenced=true;break;}
      }
      if(referenced) protectedIds.push(String(asset.id));else unused.push(asset);
    }
    if(apply && unused.length) await client.query('delete from media_assets where id=any($1::bigint[])',[unused.map(a=>a.id)]);
    await client.query(apply ? 'commit':'rollback');
    return {mode:apply?'apply':'dry_run',createdBefore:cutoff.toISOString(),scanned:candidates.length,
      nextCursor:candidates.length===limit?String(candidates.at(-1).id):null,protectedIds,unusedIds:unused.map(a=>String(a.id)),deleted:apply?unused.length:0,
      releasableBytes:unused.reduce((total,a)=>total+Number(a.stored_bytes),0),
      objectDeletion:'journal_only',tablesChecked:catalog.length};
  } catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}
}

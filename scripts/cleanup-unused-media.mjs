import pg from 'pg';
import { cleanupUnusedMedia } from '../src/lib/media-retention.mjs';
const databaseUrl=process.env.MEDIA_RETENTION_DATABASE_URL;
if(!databaseUrl)throw Error('explicit_MEDIA_RETENTION_DATABASE_URL_required');
const url=new URL(databaseUrl);const apply=process.argv.includes('--apply');
if(process.argv.slice(2).some(arg=>arg!=='--apply'))throw Error('unknown_argument');
if(apply && (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^\/aurora_[a-z0-9_]+_test$/u.test(url.pathname)))throw Error('apply_requires_disposable_local_media_database');
const pool=new pg.Pool({connectionString:databaseUrl});
try{console.log(JSON.stringify(await cleanupUnusedMedia({pool,createdBefore:process.env.MEDIA_RETENTION_CREATED_BEFORE,limit:Number(process.env.MEDIA_RETENTION_BATCH_SIZE||25),afterAssetId:Number(process.env.MEDIA_RETENTION_AFTER_ASSET_ID||0),apply}),null,2));}finally{await pool.end();}

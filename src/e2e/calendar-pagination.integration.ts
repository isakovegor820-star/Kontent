import { readFile } from 'node:fs/promises';
import { NextRequest } from 'next/server';
import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from '../../scripts/migrate.mjs';
const mocks=vi.hoisted(()=>({pool:vi.fn(),user:vi.fn()}));
vi.mock('@/lib/db',()=>({getPool:mocks.pool}));
vi.mock('@/lib/session',()=>({getSessionUser:mocks.user}));
vi.mock('@/lib/rate-limit',()=>({checkRateLimit:async()=>({allowed:true}),rateLimitResponse:()=>{throw new Error('unexpected rate limit')}}));
import { GET } from '@/app/api/posts/route';
const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL || 'http://invalid');
if(!['127.0.0.1','localhost'].includes(url.hostname)||!['/aurora_calendar_gate_test','/aurora_calendar_race_test'].includes(url.pathname))throw new Error('Requires isolated aurora_calendar_gate_test');
const pool=new pg.Pool({connectionString:url.href,max:4});
let projectId=0;let futureId=0;const total=1205;
beforeAll(async()=>{
 await pool.query('drop schema public cascade');await pool.query('create schema public');
 await pool.query(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'));
 await migrate({env:{...process.env,DATABASE_URL:url.href},logger:{log(){}}});
 const userId=Number((await pool.query("insert into users(email) values ('calendar@example.test') returning id")).rows[0].id);
 projectId=Number((await pool.query("insert into projects(name,created_by_user_id) values ('calendar',$1) returning id",[userId])).rows[0].id);
 await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner')",[projectId,userId]);
 await pool.query('insert into user_project_preferences(user_id,selected_project_id) values($1,$2)',[userId,projectId]);
 const channelId=Number((await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title) values($1,$2,'tg',-100501,'calendar') returning id",[userId,projectId])).rows[0].id);
 await pool.query(`insert into posts(user_id,project_id,channel_id,text,status,scheduled_at)
 select $1,$2,$3,'past-'||i,'published','2026-01-01T00:00:00Z'::timestamptz+make_interval(secs=>floor(i/3))+((i%3)::text||' microseconds')::interval from generate_series(1,1200) i`,[userId,projectId,channelId]);
 const added=await pool.query(`insert into posts(user_id,project_id,channel_id,text,status,scheduled_at) values
 ($1,$2,$3,'future','scheduled','2026-10-25T01:30:00Z'),
 ($1,$2,$3,'dst-start','scheduled','2026-10-24T22:00:00Z'),
 ($1,$2,$3,'next-day','scheduled','2026-10-25T23:00:00Z'),
 ($1,$2,$3,'null-one','draft',null),($1,$2,$3,'null-two','draft',null) returning id`,[userId,projectId,channelId]);
 futureId=Number(added.rows[0].id);mocks.pool.mockReturnValue(pool);mocks.user.mockResolvedValue({id:userId});
});
afterAll(async()=>{await pool.end()});
it('selects the exact calendar range after 1200 historical posts including DST boundaries',async()=>{
 const response=await GET(new NextRequest('http://localhost/api/posts?from=2026-10-25T00:00:00%2B02:00&to=2026-10-26T00:00:00%2B01:00'));
 expect(response.status).toBe(200);const body=await response.json();
 expect(body.posts.map((p:{text:string})=>p.text)).toEqual(['dst-start','future']);
 expect(body.posts.some((p:{id:number})=>p.id===futureId)).toBe(true);
 expect(body.pageInfo).toMatchObject({hasMore:false,nextCursor:null});expect(body.projectId).toBe(projectId);
});
it('paginates every unchanged row once including equal/microsecond timestamps and null tail',async()=>{
 const ids:number[]=[];let cursor:string|null=null;let pageCount=0;
 do {
  const response=await GET(new NextRequest('http://localhost/api/posts?limit=199'+(cursor?'&cursor='+encodeURIComponent(cursor):'')));
  expect(response.status).toBe(200);const body=await response.json();
  expect(body.posts.length).toBeLessThanOrEqual(199);expect(body.pageInfo).toBeDefined();
  ids.push(...body.posts.map((p:{id:number})=>p.id));cursor=body.pageInfo.nextCursor;pageCount++;
  expect(pageCount).toBeLessThan(10);
 }while(cursor);
 expect(ids).toHaveLength(total);expect(new Set(ids).size).toBe(total);expect(ids).toContain(futureId);
});
it('rejects invalid dates and cursor reuse across date ranges',async()=>{
 expect((await GET(new NextRequest('http://localhost/api/posts?from=invalid'))).status).toBe(400);
 const body=await (await GET(new NextRequest('http://localhost/api/posts?limit=2'))).json();
 expect(body.pageInfo?.nextCursor).toBeTypeOf('string');
 expect((await GET(new NextRequest('http://localhost/api/posts?from=2026-01-01&cursor='+body.pageInfo.nextCursor))).status).toBe(400);
});

it('resolves a project-owned deep link outside the current week without scanning history',async()=>{
 const response=await GET(new NextRequest('http://localhost/api/posts?id='+futureId));
 const body=await response.json();expect(response.status).toBe(200);expect(body.posts.map((p:{id:number})=>p.id)).toEqual([futureId]);
 expect((await GET(new NextRequest('http://localhost/api/posts?id=-1'))).status).toBe(400);
 expect((await GET(new NextRequest('http://localhost/api/posts?id='+futureId+'&from=2026-01-01'))).status).toBe(400);
});

it('rejects a continuation when an unread active post moves behind its cursor',async()=>{
 const first=await GET(new NextRequest('http://localhost/api/posts?limit=199'));const page=await first.json();
 expect(page.pageInfo.hasMore).toBe(true);expect(page.posts.some((row:{id:number})=>row.id===futureId)).toBe(false);
 try{
  await pool.query("update posts set scheduled_at='2026-01-01T00:00:00Z' where id=$1",[futureId]);
  const continuation=await GET(new NextRequest('http://localhost/api/posts?limit=199&cursor='+encodeURIComponent(page.pageInfo.nextCursor)));
  expect(continuation.status).toBe(409);expect(await continuation.json()).toEqual({error:'posts_snapshot_changed'});
 }finally{await pool.query("update posts set scheduled_at='2026-10-25T01:30:00Z' where id=$1",[futureId]);}
});

it('restarts the actual client/route series after a move and returns every current row once',async()=>{
 const {loadAllPosts}=await import('@/lib/posts-client');let moved=false;let calls=0;
 try{
  const fetchImpl:typeof fetch=async(input)=>{
   calls++;const response=await GET(new NextRequest('http://localhost'+String(input)));
   if(!moved){moved=true;await pool.query("update posts set scheduled_at='2026-01-01T00:00:00Z' where id=$1",[futureId]);}
   return response;
  };
  const posts=await loadAllPosts({projectId,range:null,fetchImpl});
  expect(posts).toHaveLength(total);expect(new Set(posts.map(row=>row.id)).size).toBe(total);expect(posts[0].id).toBe(futureId);expect(calls).toBe(9);
 }finally{await pool.query("update posts set scheduled_at='2026-10-25T01:30:00Z' where id=$1",[futureId]);}
});
it('increments once per project per bulk statement, ignores no-row writes and rolls back with the mutation',async()=>{
 const version=async()=>BigInt((await pool.query('select calendar_version from projects where id=$1',[projectId])).rows[0].calendar_version);
 const before=await version();const client=await pool.connect();
 try{
  await client.query('begin');await client.query('update posts set text=text where project_id=$1',[projectId]);
  expect(BigInt((await client.query('select calendar_version from projects where id=$1',[projectId])).rows[0].calendar_version)).toBe(before+BigInt(1));
  await client.query('rollback');expect(await version()).toBe(before);
  await pool.query('update posts set text=text where id=-1');expect(await version()).toBe(before);
 }finally{await client.query('rollback');client.release();}
});
it('returns versioned empty ranges and invalidates deletion continuations',async()=>{
 const empty=await (await GET(new NextRequest('http://localhost/api/posts?from=2080-01-01&to=2080-02-01'))).json();
 expect(empty.posts).toEqual([]);expect(empty.pageInfo).toMatchObject({snapshotVersion:expect.any(String),hasMore:false,nextCursor:null});
 const first=await (await GET(new NextRequest('http://localhost/api/posts?limit=199'))).json();
 const client=await pool.connect();
 try{
  await client.query('begin');
  const before=BigInt((await client.query('select calendar_version from projects where id=$1',[projectId])).rows[0].calendar_version);
  await client.query('delete from posts where id=$1',[futureId]);
  expect(BigInt((await client.query('select calendar_version from projects where id=$1',[projectId])).rows[0].calendar_version)).toBe(before+BigInt(1));
  await client.query('rollback');
  // A rollback must preserve the earlier snapshot and all rows.
  expect((await GET(new NextRequest('http://localhost/api/posts?limit=199&cursor='+encodeURIComponent(first.pageInfo.nextCursor)))).status).toBe(200);
 }finally{await client.query('rollback');client.release();}
});
it('keeps unrelated projects independent and invalidates both sides of a project transfer once',async()=>{
 const client=await pool.connect();
 try{
  await client.query('begin');
  const actor=Number((await client.query('select created_by_user_id from projects where id=$1',[projectId])).rows[0].created_by_user_id);
  const other=Number((await client.query("insert into projects(name,created_by_user_id)values('Other calendar',$1)returning id",[actor])).rows[0].id);
  await client.query("insert into project_members(project_id,user_id,role)values($1,$2,'owner')",[other,actor]);
  const channel=Number((await client.query("insert into channels(user_id,project_id,network,tg_chat_id,title)values($1,$2,'tg',-100554411,'Other calendar')returning id",[actor,other])).rows[0].id);
  const version=async(id:number)=>BigInt((await client.query('select calendar_version from projects where id=$1',[id])).rows[0].calendar_version);
  const before=await version(projectId);
  await client.query("insert into posts(user_id,project_id,channel_id,text,status)select $1,$2,$3,'bulk','draft' from generate_series(1,1000)",[actor,other,channel]);
  expect(await version(other)).toBe(BigInt(2));expect(await version(projectId)).toBe(before);
  await client.query('update posts set project_id=$2,channel_id=$3 where id=$1',[futureId,other,channel]);
  expect(await version(projectId)).toBe(before+BigInt(1));expect(await version(other)).toBe(BigInt(3));
 }finally{await client.query('rollback');client.release();}
});
it('upgrades a legacy populated schema and can reapply the additive migration without resetting its version',async()=>{
 await pool.query('drop trigger posts_calendar_insert on posts');await pool.query('drop trigger posts_calendar_update on posts');await pool.query('drop trigger posts_calendar_delete on posts');
 await pool.query('alter table projects drop column calendar_version');
 const migration=await readFile(new URL('../../db/migrations/20261016_calendar_snapshot_version.sql',import.meta.url),'utf8');
 await pool.query(migration);
 expect(Number((await pool.query('select count(*) from posts where project_id=$1',[projectId])).rows[0].count)).toBe(total);
 expect((await pool.query('select calendar_version::text version from projects where id=$1',[projectId])).rows[0].version).toBe('1');
 await pool.query('update posts set text=text where project_id=$1',[projectId]);
 await pool.query(migration);
 expect((await pool.query('select calendar_version::text version from projects where id=$1',[projectId])).rows[0].version).toBe('2');
});

// Exercise the actual HTTP handlers with a real-PG barrier at their first current
// membership SELECT. The revocation commits before the content read/write resumes.
function pauseAfterMembership(action:()=>Promise<void>) {
 let used=false;
 const wrap=(db:Pick<pg.Pool,'query'>)=>async(sql:string,values?:unknown[])=>{
  const result=await db.query(sql,values);
  if(!used&&sql.includes('from user_project_preferences preference')){used=true;await action();}
  return result;
 };
 const query=wrap(pool);
 const connect=async()=>{const client=await pool.connect();return {query:wrap(client),release:()=>client.release()};};
 return {db:{query,connect},wasUsed:()=>used};
}
it('membership revoked and fresh canary committed before calendar read cannot reveal new data',async()=>{
 const owner=(await pool.query('select user_id,channel_id from posts where id=$1',[futureId])).rows[0];let canary=0;
 const barrier=pauseAfterMembership(async()=>{
  await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2",[projectId,owner.user_id]);
  canary=Number((await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at)values($1,$2,$3,'N26_FRESH_AFTER_REVOKE','scheduled','2025-01-01T00:00:00Z')returning id",[owner.user_id,projectId,owner.channel_id])).rows[0].id);
 });
 mocks.pool.mockReturnValue(barrier.db);
 try{const response=await GET(new NextRequest('http://localhost/api/posts'));const body=await response.json();expect(barrier.wasUsed()).toBe(true);expect(JSON.stringify(body)).not.toContain('N26_FRESH_AFTER_REVOKE');expect(response.status).toBe(403);}
 finally{mocks.pool.mockReturnValue(pool);if(canary)await pool.query('delete from posts where id=$1',[canary]);await pool.query("update project_members set status='active',revoked_at=null where project_id=$1 and user_id=$2",[projectId,owner.user_id]);}
});
it('project PATCH cannot mutate after manager revocation commits between guard and UPDATE',async()=>{
 const {PATCH}=await import('@/app/api/projects/current/route');const owner=(await pool.query('select created_by_user_id,name from projects where id=$1',[projectId])).rows[0];
 const barrier=pauseAfterMembership(async()=>{await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2",[projectId,owner.created_by_user_id]);});mocks.pool.mockReturnValue(barrier.db);
 try{const response=await PATCH(new NextRequest('http://localhost/api/projects/current',{method:'PATCH',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({name:'N26_UNAUTHORIZED_CHANGE',timezone:'UTC'})}));expect(barrier.wasUsed()).toBe(true);expect(response.status).toBe(403);expect((await pool.query('select name from projects where id=$1',[projectId])).rows[0].name).toBe(owner.name);}
 finally{mocks.pool.mockReturnValue(pool);await pool.query('update projects set name=$2 where id=$1',[projectId,owner.name]);await pool.query("update project_members set status='active',revoked_at=null where project_id=$1 and user_id=$2",[projectId,owner.created_by_user_id]);}
});

it('parallel manageable project PATCHes do not deadlock while upgrading their authority locks',async()=>{
 const {PATCH}=await import('@/app/api/projects/current/route');let actors=0;const pids:number[]=[];
 const db={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();const pid=Number((await client.query('select pg_backend_pid() pid')).rows[0].pid);pids.push(pid);return {release:()=>client.release(),query:async(sql:string,values?:unknown[])=>{
  const result=await client.query(sql,values);
  if(sql.startsWith('select id from users')){
   actors++;const deadline=Date.now()+5000;
   while(actors<2){const waiting=(await pool.query('select count(*)::int n from pg_locks where pid=any($1::int[]) and not granted',[pids])).rows[0].n;if(waiting>0)break;if(Date.now()>deadline)throw new Error('parallel authority barrier timed out');await new Promise(resolve=>setTimeout(resolve,5));}
  }
  return result;
 }};}};
 mocks.pool.mockReturnValue(db);const original=(await pool.query('select name from projects where id=$1',[projectId])).rows[0].name;
 try{const responses=await Promise.all(['N26_A','N26_B'].map(name=>PATCH(new NextRequest('http://localhost/api/projects/current',{method:'PATCH',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({name,timezone:'UTC'})}))));expect(actors).toBe(2);expect(responses.map(response=>response.status)).toEqual([200,200]);}
 finally{mocks.pool.mockReturnValue(pool);await pool.query('update projects set name=$2 where id=$1',[projectId,original]);}
});

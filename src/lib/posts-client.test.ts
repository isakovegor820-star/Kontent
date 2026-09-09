import {expect,it,vi} from 'vitest';
import {loadAllPosts} from './posts-client';
it('loads every page for the same range/project before exposing a complete list',async()=>{
 const fetchImpl=vi.fn().mockResolvedValueOnce(Response.json({projectId:7,posts:[{id:1}],pageInfo:{snapshotVersion:"1",hasMore:true,nextCursor:'next'}})).mockResolvedValueOnce(Response.json({projectId:7,posts:[{id:2}],pageInfo:{snapshotVersion:"1",hasMore:false,nextCursor:null}}));
 const range={from:'2026-10-25T00:00:00Z',to:'2026-10-26T00:00:00Z'};
 expect(await loadAllPosts({projectId:7,range,fetchImpl})).toEqual([{id:1},{id:2}]);
 expect(fetchImpl.mock.calls[1][0]).toContain('cursor=next');
 for(const [,options]of fetchImpl.mock.calls)expect(options.headers['X-Aurora-Project-Id']).toBe('7');
});
it('rejects missing completeness metadata, wrong project and interrupted continuation',async()=>{
 for(const body of [{projectId:7,posts:[]},{projectId:8,posts:[],pageInfo:{snapshotVersion:"1",hasMore:false,nextCursor:null}}])await expect(loadAllPosts({projectId:7,range:null,fetchImpl:vi.fn().mockResolvedValue(Response.json(body))})).rejects.toThrow();
 const fetchImpl=vi.fn().mockResolvedValueOnce(Response.json({projectId:7,posts:[{id:1}],pageInfo:{snapshotVersion:"1",hasMore:true,nextCursor:'next'}})).mockResolvedValueOnce(new Response('',{status:503}));
 await expect(loadAllPosts({projectId:7,range:null,fetchImpl})).rejects.toThrow('posts_unavailable');
});
it('restarts the entire series after a snapshot conflict and discards old partial rows',async()=>{
 const fetchImpl=vi.fn()
 .mockResolvedValueOnce(Response.json({projectId:7,posts:[{id:1}],pageInfo:{snapshotVersion:'1',hasMore:true,nextCursor:'old'}}))
 .mockResolvedValueOnce(Response.json({error:'posts_snapshot_changed'},{status:409}))
 .mockResolvedValueOnce(Response.json({projectId:7,posts:[{id:2},{id:3}],pageInfo:{snapshotVersion:'2',hasMore:false,nextCursor:null}}));
 expect(await loadAllPosts({projectId:7,range:null,fetchImpl})).toEqual([{id:2},{id:3}]);
 expect(fetchImpl.mock.calls[2][0]).not.toContain('cursor=');
});
it('bounds restarts during continuous mutations and never returns partial success',async()=>{
 const fetchImpl=vi.fn(async(url:RequestInfo|URL)=>String(url).includes('cursor=')
  ?Response.json({error:'posts_snapshot_changed'},{status:409})
  :Response.json({projectId:7,posts:[{id:1}],pageInfo:{snapshotVersion:'1',hasMore:true,nextCursor:'next'}}));
 await expect(loadAllPosts({projectId:7,range:null,fetchImpl})).rejects.toThrow('posts_changed_during_pagination');
 expect(fetchImpl).toHaveBeenCalledTimes(6);
});
it('does not retry a revoked permission or continue after cancellation',async()=>{
 const denied=vi.fn(async()=>new Response('',{status:403}));
 await expect(loadAllPosts({projectId:7,range:null,fetchImpl:denied})).rejects.toThrow('posts_unavailable');expect(denied).toHaveBeenCalledOnce();
 const aborted=vi.fn(async()=>Response.json({error:'posts_snapshot_changed'},{status:409}));
 await expect(loadAllPosts({projectId:7,range:null,fetchImpl:aborted,signal:AbortSignal.abort()})).rejects.toMatchObject({name:'AbortError'});expect(aborted).toHaveBeenCalledOnce();
});

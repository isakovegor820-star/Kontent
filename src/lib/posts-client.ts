import { projectFetch as fetch } from "./project-fetch";
import type { RealPost } from './types';
export type PostsRange = Readonly<{ from: string; to: string }>;
/** Publish a new client snapshot only after every page is complete for one project/range. */
export async function loadAllPosts({projectId, range, signal, fetchImpl=fetch}: {
  projectId:number;range:PostsRange|null;signal?:AbortSignal;fetchImpl?:typeof fetch;
}): Promise<RealPost[]> {
  // Retry a changed series from page one at most twice. A busy project must surface
  // an incomplete refresh, never spin forever or present a plausible partial calendar.
  for (let attempt=0; attempt<3; attempt++) {
    const posts=new Map<number,RealPost>();const seen=new Set<string>();let cursor:string|null=null;
    let snapshotVersion:string|null=null;let changed=false;
    do {
      const params=new URLSearchParams({limit:'200'});
      if(range){params.set('from',range.from);params.set('to',range.to);}
      if(cursor)params.set('cursor',cursor);
      const response=await fetchImpl('/api/posts?'+params,{cache:'no-store',signal,headers:{'X-Aurora-Project-Id':String(projectId)}});
      if(response.status===409){
        const error=await response.json().catch(()=>null);
        if(error?.error==='posts_snapshot_changed'){changed=true;break;}
      }
      if(!response.ok)throw new Error('posts_unavailable');
      const body=await response.json();
      if(body.projectId!==projectId||!Array.isArray(body.posts)||typeof body.pageInfo?.hasMore!=='boolean'
        ||typeof body.pageInfo.snapshotVersion!=='string'||!(/^[1-9]\d*$/.test(body.pageInfo.snapshotVersion)))throw new Error('posts_incomplete_contract');
      if(snapshotVersion!==null&&snapshotVersion!==body.pageInfo.snapshotVersion){changed=true;break;}
      snapshotVersion=body.pageInfo.snapshotVersion;
      for(const post of body.posts){if(!Number.isSafeInteger(post.id)||posts.has(post.id))throw new Error('posts_changed_during_pagination');posts.set(post.id,post);}
      cursor=body.pageInfo.nextCursor;
      if(body.pageInfo.hasMore!==Boolean(cursor)||cursor!==null&&(typeof cursor!=='string'||seen.has(cursor)))throw new Error('posts_invalid_cursor');
      if(cursor)seen.add(cursor);
    }while(cursor);
    if(!changed)return [...posts.values()];
    if(signal?.aborted)throw new DOMException('Calendar refresh aborted','AbortError');
  }
  throw new Error('posts_changed_during_pagination');
}

import { Temporal } from '@js-temporal/polyfill';

export class PostsQueryError extends Error {}
type Cursor = { snapshotVersion: string; projectId: number; from: string | null; to: string | null; at: string | null; id: number };
function instant(value: string | null): string | null {
  if(value===null)return null;
  try { return Temporal.Instant.from(/^\d{4}-\d{2}-\d{2}$/.test(value)?value+'T00:00:00Z':value).toString(); }
  catch {throw new PostsQueryError('invalid_date_range');}
}
export function parsePostsQuery(params: URLSearchParams, projectId: number) {
  const from=instant(params.get('from'));const to=instant(params.get('to'));
  if(from&&to&&Temporal.Instant.compare(from,to)>=0)throw new PostsQueryError('invalid_date_range');
  const limit=Number(params.get('limit')??200);
  if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new PostsQueryError('invalid_page_size');
  const id=params.has('id')?Number(params.get('id')):null;
  if(id!==null&&(!Number.isSafeInteger(id)||id<1||from!==null||to!==null||params.has('cursor')))throw new PostsQueryError('invalid_post_id');
  let cursor:Cursor|null=null;
  if(params.has('cursor')){
    try {
      cursor=JSON.parse(Buffer.from(params.get('cursor')!,'base64url').toString('utf8'));
      if(!cursor||typeof cursor.snapshotVersion!=='string'||!(/^[1-9]\d*$/.test(cursor.snapshotVersion))||cursor.projectId!==projectId||cursor.from!==from||cursor.to!==to||!Number.isSafeInteger(cursor.id)||cursor.id<=0
        ||(cursor.at!==null&&(typeof cursor.at!=='string'||!instant(cursor.at))))throw new Error();
    }catch{throw new PostsQueryError('invalid_cursor');}
  }
  return {from,to,limit,cursor,id};
}
export function postsCursor(value:Cursor) {return Buffer.from(JSON.stringify(value)).toString('base64url');}

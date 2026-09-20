import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { claimRadarSearchRun } from "../../worker/trend-search.mjs";
import { trendDatasetQuery, serializeTrendDataset, type TrendDatasetInput } from "@/lib/trend-dataset";
import { seedTrendQa } from "../../scripts/trends-qa-fixtures.mjs";
const url = new URL(String(process.env.DATABASE_URL));
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/aurora_trends_qa_')) throw new Error('Isolated disposable trends QA database required');
const pool = new pg.Pool({ connectionString: url.href, ssl: false, max: 2 });
let fixture: Awaited<ReturnType<typeof seedTrendQa>>;
beforeAll(async () => { fixture = await seedTrendQa(pool); });
afterAll(async () => { await pool.end(); });
async function dataset(overrides: Partial<TrendDatasetInput> = {}) {
  const input: TrendDatasetInput = { userId: fixture.user, projectId: fixture.project, channelId: fixture.channel,
    source:'own', period:'week', topic:'щука', runId:null, offset:0, sort:'recent', ...overrides };
  const query=trendDatasetQuery(input);
  const result=await pool.query(query.text,query.values);
  return serializeTrendDataset(result.rows[0].payload,input);
}

describe.sequential('query-specific trend datasets on PostgreSQL', () => {
  it('uses the identical publication set for feed, totals and chart', async () => {
    const data=await dataset();
    expect(data.summary).toMatchObject({posts:4,sources:1,views:1300,postsWithViews:3,avgViews:433});
    expect(data.items).toHaveLength(4);
    expect(data.series).toHaveLength(7);
    expect(data.series.reduce((n,p)=>n+p.posts,0)).toBe(data.summary.posts);
    expect(data.series.reduce((n,p)=>n+(p.views??0),0)).toBe(data.summary.views);
    expect(data.coverage).toMatchObject({undatedPosts:1,futurePosts:1,comparisonAvailable:false});
  });
  it('distinguishes a missing counter, a real zero, and a mature measured ratio', async () => {
    const data=await dataset();
    expect(data.items.find(p=>p.msgId===12)?.views).toBeNull();
    expect(data.items.find(p=>p.msgId===13)?.views).toBe(0);
    expect(data.items.find(p=>p.msgId===10)?.ratio).toBe(4);
    expect(data.items.find(p=>p.msgId===11)?.ratio).toBeNull();
  });
  it('keeps semantic search results and deduplicates their original URLs', async () => {
    const data=await dataset({source:'internet',topic:'рыбалка',runId:fixture.currentRun});
    expect(data.summary).toMatchObject({posts:2,views:300,postsWithViews:1});
    expect(data.items).toHaveLength(2);
    expect(data.items.find(p=>p.msgId===10)?.ratio).toBe(3);
    expect(data.items.find(p=>p.msgId===10)?.text).not.toContain('рыбалка');
    expect(data.coverage).toMatchObject({undatedPosts:1,futurePosts:1});
  });
  it('selects the latest matching query without mixing older runs or other topics', async () => {
    const data=await dataset({source:'internet',topic:'рыбалка'});
    expect(data.search?.id).toBe(fixture.currentRun);
    expect(data.summary.views).toBe(300);
  });
  it('never falls back to another query, channel, project, user, or inaccessible run', async () => {
    for(const runId of [fixture.otherTopic,fixture.otherChannelRun,fixture.otherProjectRun,fixture.otherUserRun,999999999]) {
      const data=await dataset({source:'internet',topic:'рыбалка',runId});
      expect(data.search).toBeNull(); expect(data.items).toEqual([]); expect(data.summary.posts).toBe(0);
    }
    const empty=await dataset({source:'internet',topic:''});
    expect(empty.items).toEqual([]);
  });
  it('calculates all totals before pagination and offers different sources in the leaders', async () => {
    const first=await dataset({source:'internet',topic:'ремонт квартиры',runId:fixture.paginatedRun,period:'month'});
    const second=await dataset({source:'internet',topic:'ремонт квартиры',runId:fixture.paginatedRun,period:'month',offset:24});
    expect(first.items).toHaveLength(24); expect(second.items).toHaveLength(6);
    expect(first.summary.posts).toBe(30); expect(second.summary).toEqual(first.summary);
    expect(new Set([...first.items,...second.items].map(p=>p.link)).size).toBe(30);
    expect(new Set(first.topItems.slice(0,5).map(p=>p.handle)).size).toBe(5);
  });
  it('returns unavailable totals when every view counter is missing', async () => {
    const data=await dataset({topic:'недоступен'});
    expect(data.summary).toMatchObject({posts:1,views:null,avgViews:null,postsWithViews:0});
  });
  it('applies the shared topic filter to the editorial collection', async () => {
    const data=await dataset({source:'collection',channelId:null});
    expect(data.items.every(p=>p.text?.includes('Щука'))).toBe(true);
    expect(data.summary.sources).toBe(1);
    expect(data.summary.views).toBe(20);
  });
  it('provides exact non-overlapping intervals for each period and does not include future posts', async () => {
    for (const period of ['day','week','month','quarter'] as const) {
      const data=await dataset({period});
      for(let i=1;i<data.series.length;i++) expect(data.series[i].bucket).toBe(data.series[i-1].until);
      expect(data.series.reduce((n,p)=>n+p.posts,0)).toBe(data.summary.posts);
      expect(data.items.some(p=>p.msgId===15)).toBe(false);
    }
  });
  it('adopts an old-web queued search using its authorized channel and claims it only once', async () => {
    const id=Number((await pool.query(`insert into radar_search_runs
      (user_id,channel_id,request_key,query,normalized_query)
      values ($1,$2,'legacy-window-claim','Проверка','проверка') returning id`,[fixture.user,fixture.channel])).rows[0].id);
    const results=await Promise.all([claimRadarSearchRun(pool,id,fixture.user),claimRadarSearchRun(pool,id,fixture.user)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(Number(results.find(Boolean)?.project_id)).toBe(fixture.project);
  });
  it('does not claim a legacy search when its user lacks access to the channel project', async () => {
    const id=Number((await pool.query(`insert into radar_search_runs
      (user_id,channel_id,request_key,query,normalized_query)
      values ($1,$2,'legacy-window-denied','Проверка','проверка') returning id`,[fixture.otherUser,fixture.channel])).rows[0].id);
    expect(await claimRadarSearchRun(pool,id,fixture.otherUser)).toBeNull();
    expect((await pool.query('select status from radar_search_runs where id=$1',[id])).rows[0].status).toBe('queued');
  });

});

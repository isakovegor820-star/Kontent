import { describe, expect, it, vi } from 'vitest';
import * as storage from './media-storage.mjs';

describe('journaled object media persistence', () => {
  const config={MEDIA_OBJECT_BUCKET:'fake',MEDIA_OBJECT_REGION:'fake'};
  function fixture() {
    const events=[]; const client={query:vi.fn(async(sql)=>{events.push(String(sql)); return {rows:[],rowCount:1};}),release:vi.fn()};
    return {events,client,pool:{connect:vi.fn(async()=>client)}};
  }
  it('journals the object before upload and retains cleanup intent on lost storage receipt',async()=>{
    const {pool,events,client}=fixture();const put=vi.fn(async()=>{events.push('PUT');throw Error('receipt_lost');});
    await expect(storage.withJournaledMediaObject({pool,projectId:1,sha256:'fake',extension:'mp4',body:Buffer.from('x'),mimeType:'video/mp4',env:config,put},vi.fn())).rejects.toThrow('receipt_lost');
    expect(events.findIndex(s=>s.includes('insert into media_object_orphans'))).toBeLessThan(events.indexOf('PUT'));
    expect(client.release).toHaveBeenCalled();
    expect(events.some(s=>s.includes('pg_advisory_unlock'))).toBe(true);
  });
  it('does not upload if durable cleanup intent cannot be written',async()=>{
    const {pool,client}=fixture();client.query.mockImplementation(async(sql)=>{if(String(sql).includes('insert into media_object_orphans'))throw Error('db_lost');return {rows:[]};});
    const put=vi.fn();await expect(storage.withJournaledMediaObject({pool,projectId:1,sha256:'fake',extension:'mp4',body:Buffer.from('x'),mimeType:'video/mp4',env:config,put},vi.fn())).rejects.toThrow('db_lost');expect(put).not.toHaveBeenCalled();
  });
  it('retains a journal through database persistence failure or no-op and uses the same planned key',async()=>{
    const {pool,events}=fixture();const put=vi.fn(async({key})=>{events.push('PUT');return {key,etag:'fixture'};});
    const persist=vi.fn(async(object)=>{expect(object.key).toMatch(/^projects\/1\/media\//);throw Error('quota');});
    await expect(storage.withJournaledMediaObject({pool,projectId:1,sha256:'fake',extension:'mp4',body:Buffer.from('x'),mimeType:'video/mp4',env:config,put},persist)).rejects.toThrow('quota');
    expect(events.some(s=>s.includes('deleted_at = now()'))).toBe(false);
  });
  it('passes the already locked connection to persistence so a one-slot pool does not deadlock',async()=>{
    const {pool,client}=fixture();const put=vi.fn(async({key})=>({key,etag:null}));
    const persist=vi.fn(async(_object,db)=>{expect(db).toBe(client);await db.query('begin');await db.query('commit');return 'saved';});
    expect(await storage.withJournaledMediaObject({pool,projectId:1,sha256:'fake',extension:'mp4',body:Buffer.from('x'),mimeType:'video/mp4',env:config,put},persist)).toBe('saved');
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

});

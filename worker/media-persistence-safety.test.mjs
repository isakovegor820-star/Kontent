import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { expect,it,vi } from 'vitest';
import { withJournaledMediaObject } from '../src/lib/media-storage.mjs';
it('does not upload a generated object when the database cannot journal it',async()=>{
  const source=await readFile(process.env.WORKER_MEDIA_SOURCE || new URL('../worker.mjs',import.meta.url),'utf8');
  const start=source.indexOf('async function persistMediaResult(');const end=source.indexOf('\nconst navyMedia',start);
  const put=vi.fn(async()=>({key:'fixture',etag:null}));
  const pool={query:vi.fn(async()=>({rowCount:1,rows:[]})),connect:vi.fn(async()=>{throw Error('synthetic_db_unavailable');})};
  const persist=vm.runInNewContext(source.slice(start,end)+'\npersistMediaResult',{
    pool,createHash,console,MediaGenerationAttemptError:Error,downloadMedia:async()=>({buffer:Buffer.from('fixture'),mime:'video/mp4'}),chooseMediaStorageBackend:()=> 'object',putMediaObject:put,
    withJournaledMediaObject:(input,fn)=>withJournaledMediaObject({...input,put},fn),
  });
  await expect(persist({id:1,project_id:1,user_id:1,kind:'video'},{},{assertActive:async()=>{}})).rejects.toThrow('synthetic_db_unavailable');
  expect(put).not.toHaveBeenCalled();
});

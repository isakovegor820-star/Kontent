import { EventEmitter } from "node:events";
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({profile:vi.fn(),context:vi.fn(),write:vi.fn()}));
vi.mock('./e2e-chromium-offline-profile.mjs',()=>({createE2eChromiumOfflineProfile:mocks.profile}));
vi.mock('./e2e-browser-context.mjs',()=>({createE2eBrowserContext:mocks.context}));
vi.mock('./e2e-browser-boundary.mjs',()=>({installE2eBrowserBoundary:async()=>({snapshot:()=>[],assertClean(){}})}));
vi.mock('node:fs/promises',()=>({writeFile:mocks.write}));
vi.mock('playwright-core',()=>({chromium:{executablePath:()=>'/synthetic/full-chromium'}}));
import {runTrueZoomCoverage} from './e2e-true-zoom-coverage.mjs';
beforeEach(()=>{vi.resetAllMocks();vi.useFakeTimers();mocks.write.mockResolvedValue(undefined);});
afterEach(()=>vi.useRealTimers());
async function fixture(lateError=false, lateRequest=null, nativeRead=null){
 const bindings=new Map();let documentId=null;let emitted=false;
 const frame={page:()=>page};
 const native=event=>bindings.get('__auroraMainReadLifetime')?.({page,frame},event);
 const page=Object.assign(new EventEmitter(),{goto:async()=>{
   documentId='zoom-document';await native({kind:'document',documentId});
   if(nativeRead&&!emitted){
    emitted=true;const identity='zoom-read-1';const at=Date.now();
    const request={url:()=> 'https://127.0.0.1:12345/api/drafts',method:()=> 'GET',
     headers:()=>({'x-aurora-e2e-read-id':identity}),frame:()=>frame,resourceType:()=> 'fetch',
     failure:()=>({errorText:nativeRead==='network'?'net::ERR_CONNECTION_RESET':'net::ERR_ABORTED'})};
    await native({kind:'start',id:1,identity,documentId,at,method:'GET',url:request.url()});
    context.emit('request',request);
    if(nativeRead!=='unproved'){
     await native({kind:'abort',id:1,identity:nativeRead==='other_identity'?'unrelated':identity,documentId,at});
     await native({kind:'failure',id:1,identity,documentId,at,callerAbort:nativeRead!=='late_abort'});
    }
    context.emit('requestfailed',request);
   }
  },url:()=> 'https://127.0.0.1:12345/admin',mainFrame:()=>frame,context:()=>context,
  getByRole:()=>({first:()=>({waitFor:async()=>{}})}),locator:()=>({waitFor:async()=>{}}),keyboard:{press:async()=>{}},
  evaluate:async fn=>{
   const source=String(fn);
   if(source.includes('Owned renderer settlement'))return documentId?{documentId}:{uninitialized:true};
   if(source.includes('const root='))return {outerWidth:1280,innerWidth:640,dpr:2,visualScale:1,cssZoom:'1',scrollWidth:640,contrast:[{fg:'--text',bg:'--bg',ratio:10}]};
   if(source.includes('document.activeElement'))return {visible:true,width:40,left:0,right:40,href:'#main',backgroundAlpha:255};
  },
 });
 const context=Object.assign(new EventEmitter(),{pages:()=>[page],newCDPSession:async()=>({send:async()=>({data:'c3ludGhldGlj'})}),
  addCookies:async()=>{},addInitScript:async()=>{},exposeBinding:async(name,fn)=>{bindings.set(name,fn);},close:vi.fn(async()=>{
    if(lateError){const message={type:()=> 'error',text:()=> 'synthetic late renderer error',page:()=>page,args:()=>['synthetic'],location:()=>({url:page.url(),lineNumber:1,columnNumber:1})};context.emit('console',message);page.emit('console',message);}
    if(lateRequest){const request={url:()=> 'https://127.0.0.1:12345'+lateRequest.path,method:()=>lateRequest.method,
      headers:()=>lateRequest.headers??{},frame:()=>frame,resourceType:()=> 'fetch',failure:()=>({errorText:lateRequest.failure??'net::ERR_ABORTED'})};
      context.emit('request',request);
      if(lateRequest.status)context.emit('response',{request:()=>request,url:()=>request.url(),status:()=>lateRequest.status,headers:()=>({'content-type':lateRequest.contentType})});
      context.emit('requestfailed',request);
    }
  })});
 const transport={stop:vi.fn(async()=>{}),snapshot:()=>[],assertClean(){}};
 mocks.profile.mockResolvedValue({profilePath:'/synthetic-profile',launchArgs:[],serviceFixture:{},stop:async()=>{},snapshot:()=>({stopped:true,requests:[]})});
 mocks.context.mockResolvedValue({context,transport});
 const pending=runTrueZoomCoverage({baseUrl:'https://127.0.0.1:12345',browserServiceTls:{},cookies:[],projectId:1,artifactDir:'/synthetic-evidence'})
  .then(value=>({value}),error=>({error}));
 await vi.runAllTimersAsync();
 return {result:await pending,context,transport};
}
it('retains a clean complete ten-screen zoom journey',async()=>{
 const {result,context,transport}=await fixture();expect(result.error).toBeUndefined();
 expect(result.value.screens).toHaveLength(10);expect(result.value.errors).toEqual([]);
 expect(context.close).toHaveBeenCalledOnce();expect(transport.stop).toHaveBeenCalledOnce();
});
it('cannot return successful evidence when a renderer error arrives during final close',async()=>{
 const {result,context,transport}=await fixture(true);
 expect.soft(result.error,'late collected diagnostic must fail the awaited helper').toBeDefined();
 expect.soft(result.value,'main must not receive a success-shaped trueZoom report').toBeUndefined();
 expect(context.close).toHaveBeenCalledOnce();expect(transport.stop).toHaveBeenCalledOnce();
 const call=mocks.write.mock.calls.find(([path])=>path.endsWith('true-zoom-coverage.json'));
 expect(JSON.parse(call[1]).errors).toContain('synthetic late renderer error');
});

it.each([{method:'PATCH',path:'/api/drafts/7'},{method:'GET',path:'/api/channels'},{method:'POST',path:'/api/product-events'},
 {method:'POST',path:'/api/product-events',status:200,contentType:'application/json',failure:'net::ERR_CONNECTION_RESET'}])('rejects an unconfirmed request during close: %j',async request=>{
 const {result}=await fixture(false,request);expect(result.error).toBeDefined();expect(result.value).toBeUndefined();
});
it.each([{method:'POST',path:'/api/product-events',status:200,contentType:'application/json'},
 {method:'GET',path:'/app/calendar',headers:{rsc:'1','next-router-prefetch':'1'},status:200,contentType:'text/x-component'}])('retains an evidenced completed cancellation: %j',async request=>{
 const {result}=await fixture(false,request);expect(result.error).toBeUndefined();expect(result.value.network).toHaveLength(1);expect(result.value.errors).toEqual([]);
});

it('uses the exact native caller signal to confirm a zoom read cancellation',async()=>{
 const {result}=await fixture(false,null,'caller');
 expect(result.error).toBeUndefined();expect(result.value?.screens).toHaveLength(10);
 expect(result.value?.knownCancellations).toEqual([{id:1,reason:'caller_abort_signal'}]);
 expect(result.value?.requestEvidence[0]).toMatchObject({callerMatched:true,callerFailure:true,reason:'caller_abort_signal'});
});
it.each(['unproved','network','other_identity','late_abort'])('keeps zoom read uncertainty for %s',async cause=>{
 const {result}=await fixture(false,null,cause);
 expect(result.error).toBeDefined();expect(result.value).toBeUndefined();
});

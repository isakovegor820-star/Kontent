import {it, expect, vi} from 'vitest';
import {runAiPreviewCoverage} from './e2e-ai-preview-coverage.mjs';

// Exercise the actual journey helper, including its held ACK and both decisions.
function fixture() {
  const baseUrl='https://127.0.0.1:58801'; let draft, key, generation=0, calls=0, acknowledged=false, visible=false, gate, observed, ackResolve;
  const requests=[]; const acknowledgements=[]; const decisions=[];
  const candidate=()=>`Complete candidate ${generation}`;
  const response=(status,body)=>({status:()=>status,json:async()=>body});
  const button=(name)=>({
    count:async()=>name==='Применить вариант'&&!acknowledged?0:1,
    waitFor:async()=>{expect(acknowledged).toBe(true);},
    click:async()=>{
      if(name==='Улучшить') {
        generation++; calls++; key=`preview-${generation}`; visible=true; acknowledged=false;
        const request={url:()=>baseUrl+'/api/ai/generate',method:()=>'POST',headers:()=>({'idempotency-key':key,'x-aurora-project-id':'2'}),
          postDataJSON:()=>({inputDraftId:draft.id,inputDraftVersion:1,command:'rewrite',surface:'composer',channelId:3})};
        requests.push(request); observed(request);
        const ackRequest={method:()=>'POST',headers:()=>({'idempotency-key':key})};
        const ack={...response(200,{ok:true,status:'committed',generationResultId:generation}),request:()=>ackRequest}; acknowledgements.push(ack);
        void gate({request:()=>ackRequest,continue:async()=>{acknowledged=true;ackResolve(ack);}});
      } else if(name==='Применить вариант') {
        decisions.push('apply'); visible=false; draft={...draft,text:candidate(),origin:'ai',version:2,generation_result_id:generation};
      } else {decisions.push('reject'); visible=false;}
    },
  });
  const preview={waitFor:async()=>{},getAttribute:async()=>acknowledged?'false':'true',getByRole:(_role,{name})=>button(name),
    locator:()=>({textContent:async()=>candidate()}),count:async()=>visible?1:0};
  const page={locator:()=>({waitFor:async()=>{}}),getByRole:(role,{name})=>role==='region'?preview:button(name),
    on:(_event,listener)=>{observed=listener;},off:vi.fn(),route:async(_pattern,handler)=>{gate=handler;},unroute:vi.fn(),
    goto:async()=>{},reload:async()=>{},waitForResponse:()=>new Promise(resolve=>{ackResolve=resolve;})};
  const pool={query:async(sql)=>({rows:sql.includes('current_database')?[{name:'aurora_preview_test'}]
    :sql.includes('from drafts')?[structuredClone(draft)]:sql.includes('from ai_usage')?[{status:'committed'}]
    :sql.includes('from generation_results')?[{text:candidate()}]:[{n:0}]})};
  const context={request:{post:async(_url,{data})=>{draft={id:4,project_id:2,text:data.text,origin:'manual',version:1,generation_result_id:null,ai_validation:null};return response(201,{draft:{id:4}});}}};
  return {requests,acknowledgements,decisions,page,options:{page,context,pool,baseUrl,userId:1,projectId:2,channelId:3,
    readEditableText:async()=>draft.text,waitForFirstPartyNetworkIdle:async()=>{},getProviderCallCount:()=>calls,fakeProviderConfigured:true}};
}
it('binds each original preview Request and its actual completed ACK before applying or rejecting',async()=>{
  const f=fixture();const seen=[];
  await runAiPreviewCoverage({...f.options,onAcknowledgedGeneration:async proof=>{
    expect(f.decisions).toHaveLength(seen.length); seen.push(proof);
  }});
  expect(seen).toHaveLength(2);
  for(let i=0;i<2;i++){expect(seen[i].request).toBe(f.requests[i]);expect(seen[i].ackResponse).toBe(f.acknowledgements[i]);}
  expect(f.decisions).toEqual(['reject','apply']);expect(f.page.unroute).toHaveBeenCalledOnce();
});
it('a rejected completion proof fails the journey before any preview decision and still removes the ACK gate',async()=>{
  const f=fixture();const error=new Error('Exact original ACK not proved');
  await expect(runAiPreviewCoverage({...f.options,onAcknowledgedGeneration:async()=>{throw error;}})).rejects.toBe(error);
  expect(f.decisions).toEqual([]);expect(f.page.off).toHaveBeenCalledOnce();expect(f.page.unroute).toHaveBeenCalledOnce();
});

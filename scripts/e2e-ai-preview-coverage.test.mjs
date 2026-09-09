import {it, expect, vi} from 'vitest';
import {runAiPreviewCoverage} from './e2e-ai-preview-coverage.mjs';

// Exercise the actual journey helper, including its held ACK and both decisions.
function fixture({invalidProjectHeader=false, continuationError=null, jsonUnavailable=false, strayAcks=false}={}) {
  const baseUrl='https://127.0.0.1:58801'; let draft, key, generation=0, calls=0, acknowledged=false, visible=false, gate, observed, ackResolve, ackPredicate;
  const requests=[]; const acknowledgements=[]; const decisions=[]; const routeEvents=[];
  const candidate=()=>`Complete candidate ${generation}`;
  const response=(status,body)=>({status:()=>status,json:async()=>body});
  const emitAck=ack=>{if(ackPredicate?.(ack)){ackPredicate=null;ackResolve(ack);}};
  const makeAck=(requestKey, project='2', status=200)=>{
    const receipt={ok:true,status:'committed',generationResultId:generation};
    return {...response(status,receipt),receipt,url:()=>baseUrl+'/api/ai/generate/ack',
      request:()=>({method:()=>'POST',headers:()=>({'idempotency-key':requestKey,'x-aurora-project-id':project})}),
      json:vi.fn(async()=>{if(jsonUnavailable)throw new Error('Network.getResponseBody: No data found');return receipt;}),
    };
  };
  const confirm=async({ackResponse})=>ackResponse.receipt;
  const button=(name)=>({
    count:async()=>name==='Применить вариант'&&!acknowledged?0:1,
    waitFor:async()=>{expect(acknowledged).toBe(true);},
    click:async()=>{
      if(name==='Улучшить') {
        if(strayAcks)emitAck(acknowledgements.at(-1)??makeAck('unrelated-operation','2',599));
        generation++; calls++; key=`preview-${generation}`; const requestKey=key; visible=true; acknowledged=false;
        const request={url:()=>baseUrl+'/api/ai/generate',method:()=>'POST',headers:()=>({'idempotency-key':requestKey,'x-aurora-project-id':invalidProjectHeader?'999':'2'}),
          postDataJSON:()=>({inputDraftId:draft.id,inputDraftVersion:1,command:'rewrite',surface:'composer',channelId:3})};
        requests.push(request); observed(request);
        if(strayAcks){emitAck(makeAck('unrelated-operation','2',599));emitAck(makeAck(key,'999',599));}
        const ack=makeAck(key);const ackRequest=ack.request();acknowledgements.push(ack);
        const pending=gate({request:()=>ackRequest,continue:async()=>{
          routeEvents.push('continue:start');await new Promise(resolve=>setTimeout(resolve,20));
          routeEvents.push('continue:end');if(continuationError)throw continuationError;
          acknowledged=true;emitAck(ack);
        }});
        void pending.catch(()=>undefined); // The fixture owns dispatcher failures too.
      } else if(name==='Применить вариант') {
        decisions.push('apply'); visible=false; draft={...draft,text:candidate(),origin:'ai',version:2,generation_result_id:generation};
      } else {decisions.push('reject'); visible=false;}
    },
  });
  const preview={waitFor:async()=>{},getAttribute:async()=>null,getByRole:(_role,{name})=>button(name),
    locator:()=>({textContent:async()=>candidate(),getAttribute:async()=>acknowledged?null:'true'}),count:async()=>visible?1:0};
  const page={locator:()=>({waitFor:async()=>{}}),getByRole:(role,{name})=>role==='region'?preview:button(name),
    on:(_event,listener)=>{observed=listener;},off:vi.fn(),route:async(_pattern,handler)=>{gate=handler;},unroute:vi.fn(()=>{routeEvents.push('unroute');}),
    goto:async()=>{},reload:async()=>{},waitForResponse:predicate=>new Promise(resolve=>{ackPredicate=predicate;ackResolve=resolve;})};
  const pool={query:async(sql)=>({rows:sql.includes('current_database')?[{name:'aurora_preview_test'}]
    :sql.includes('from drafts')?[structuredClone(draft)]:sql.includes('from ai_usage')?[{status:'committed'}]
    :sql.includes('from generation_results')?[{text:candidate()}]:[{n:0}]})};
  const context={request:{post:async(_url,{data})=>{draft={id:4,project_id:2,text:data.text,origin:'manual',version:1,generation_result_id:null,ai_validation:null};return response(201,{draft:{id:4}});}}};
  return {requests,acknowledgements,decisions,routeEvents,page,options:{page,context,pool,baseUrl,userId:1,projectId:2,channelId:3,
    readEditableText:async()=>draft.text,waitForFirstPartyNetworkIdle:async()=>{},getProviderCallCount:()=>calls,fakeProviderConfigured:true,onAcknowledgedGeneration:confirm}};
}
it('binds each original preview Request and its actual completed ACK before applying or rejecting',async()=>{
  const f=fixture();const seen=[];
  await runAiPreviewCoverage({...f.options,onAcknowledgedGeneration:async proof=>{
    expect(f.decisions).toHaveLength(seen.length); seen.push(proof);return proof.ackResponse.receipt;
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

it('drains a held ACK before unroute and preserves the original failed security assertion',async()=>{
  const f=fixture({invalidProjectHeader:true});
  await expect(runAiPreviewCoverage({...f.options,onAcknowledgedGeneration:async()=>{}})).rejects.toMatchObject({actual:'999',expected:'2'});
  expect(f.routeEvents).toEqual(['continue:start','continue:end','unroute']);
  expect(f.decisions).toEqual([]);
});
it('reports a route continuation failure together with the original journey failure',async()=>{
  const continuationError=new Error('native continuation failed');
  const f=fixture({invalidProjectHeader:true,continuationError});
  await expect(runAiPreviewCoverage({...f.options,onAcknowledgedGeneration:async()=>{}})).rejects.toMatchObject({
    name:'AggregateError',errors:[expect.objectContaining({actual:'999',expected:'2'}),continuationError],
  });
  expect(f.routeEvents).toEqual(['continue:start','continue:end','unroute']);
});

it('uses the verified original ingress receipt even when the CDP body is unavailable',async()=>{
  const f=fixture({jsonUnavailable:true});
  const result=await runAiPreviewCoverage(f.options);
  expect(result.decisions.map(row=>row.generationResultId)).toEqual([1,2]);
  expect(f.decisions).toEqual(['reject','apply']);
  for(const ack of f.acknowledgements)expect(ack.json).not.toHaveBeenCalled();
});
it('ignores previous, unrelated-key and foreign-project ACKs for each new preview',async()=>{
  const f=fixture({strayAcks:true});const seen=[];
  await runAiPreviewCoverage({...f.options,onAcknowledgedGeneration:async proof=>{
    seen.push(proof.ackResponse);return proof.ackResponse.receipt;
  }});
  expect(seen).toEqual(f.acknowledgements);
  expect(f.decisions).toEqual(['reject','apply']);
});
it.each([undefined,{ok:false,status:'committed',generationResultId:1},{ok:true,status:'pending',generationResultId:1},
  {ok:true,status:'committed',generationResultId:null}])('rejects missing or invalid verified receipt %j before any decision',async receipt=>{
  const f=fixture();
  await expect(runAiPreviewCoverage({...f.options,onAcknowledgedGeneration:async()=>receipt})).rejects.toBeTruthy();
  expect(f.decisions).toEqual([]);expect(f.page.unroute).toHaveBeenCalledOnce();
});

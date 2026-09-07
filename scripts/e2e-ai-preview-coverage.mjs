import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Current Composer variant preview, using the real stream/ACK/draft API and fake provider. */
export async function runAiPreviewCoverage({
  page, context, pool, baseUrl, userId, projectId, channelId, artifactDir,
  readEditableText, waitForFirstPartyNetworkIdle, getProviderCallCount, onAcknowledgedGeneration,
  fakeProviderConfigured = false,
}) {
  assert.equal(fakeProviderConfigured, true, 'AI preview coverage requires an explicitly configured fake provider');
  assert(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'AI preview coverage requires an isolated local application');
  const database = (await pool.query('select current_database() as name')).rows[0].name;
  assert(/^aurora_(?:.+_test|e2e_real)$/u.test(database), 'AI preview coverage requires a disposable Aurora database');
  for (const id of [userId, projectId, channelId]) assert(Number.isSafeInteger(id) && id > 0);
  assert.equal(typeof getProviderCallCount, 'function');
  assert.equal(typeof onAcknowledgedGeneration, 'function', 'each preview requires exact Request/ACK completion evidence');
  const originalText = 'Редакционный черновик: исходный текст остаётся моим.\nВторая строка, эмодзи ✨ и ссылка https://example.com/preview.';
  const evidence = {scenario:'current Composer AI preview apply/reject',database,userId,projectId,channelId,decisions:[]};
  const requestHeaders = {origin:baseUrl, 'x-aurora-project-id':String(projectId)};
  const create = await context.request.post(baseUrl+'/api/drafts', {
    headers:requestHeaders,
    data:{clientKey:'draft_e2e_ai_preview_'+randomUUID(),text:originalText,origin:'manual',channelIds:[channelId],scheduledAt:null,sourceRef:null,aiValidation:null},
  });
  assert.equal(create.status(),201,'preview fixture draft must be created through the real API');
  const draft = (await create.json()).draft;
  assert(Number.isSafeInteger(draft?.id)); evidence.draftId=draft.id;
  const readDraft = async () => (await pool.query(
    'select id,project_id,text,origin,version,generation_result_id,ai_validation from drafts where id=$1 and user_id=$2 and project_id=$3',
    [draft.id,userId,projectId],
  )).rows[0];
  const waitFor = async (predicate, message) => {
    const deadline=Date.now()+30_000;
    while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}
    throw new Error(message);
  };
  const text = page.locator('#composer-text');
  const preview = page.getByRole('region',{name:'Предварительный вариант от ИИ',exact:true});
  const ackPattern = baseUrl+'/api/ai/generate/ack';
  let activeKey=null;let releaseAck=null;let ackHeld=false;
  const requestLog=[];
  const observeRequest = request => {
    if(new URL(request.url()).pathname!=='/api/ai/generate'||request.method()!=='POST')return;
    const input=request.postDataJSON();
    if(Number(input.inputDraftId)!==draft.id)return;
    activeKey=request.headers()['idempotency-key'];
    requestLog.push({nativeRequest:request,key:activeKey,projectHeader:request.headers()['x-aurora-project-id'],input});
  };
  const gateAck = async route => {
    if(route.request().method()==='POST'&&route.request().headers()['idempotency-key']===activeKey&&releaseAck){
      ackHeld=true;await releaseAck.promise;
    }
    await route.continue();
  };
  page.on('request',observeRequest);
  await page.route(ackPattern,gateAck);
  try {
    await page.goto(baseUrl+`/app/composer?draft=${draft.id}`,{waitUntil:'domcontentloaded'});
    await text.waitFor();
    await waitForFirstPartyNetworkIdle(page,'AI preview fixture hydration');
    assert.equal(await readEditableText(text),originalText);
    const original=await readDraft();
    assert.equal(original.text,originalText);assert.equal(original.origin,'manual');assert.equal(original.generation_result_id,null);
    for(const decision of ['reject','apply']) {
      ackHeld=false;
      let resolveAck;const promise=new Promise(resolve=>{resolveAck=resolve;});releaseAck={promise,resolve:resolveAck};
      const beforeProvider=getProviderCallCount();
      const ackResponsePromise=page.waitForResponse(response=>response.url()===ackPattern&&response.request().method()==='POST');
      // If an earlier assertion fails, cleanup must not add an unhandled timeout.
      void ackResponsePromise.catch(()=>undefined);
      await page.getByRole('button',{name:'Улучшить',exact:true}).click();
      await preview.waitFor();
      await waitFor(()=>ackHeld,'completed provider response did not reach the held real ACK boundary');
      const request=requestLog.at(-1);
      assert(request?.key,'AI request omitted its idempotency key');
      assert.equal(request.input.command,'rewrite');assert.equal(request.input.surface,'composer');
      assert.equal(request.input.inputDraftId,draft.id);assert.equal(request.input.inputDraftVersion,Number(original.version));
      assert.equal(request.input.channelId,channelId);assert.equal(request.projectHeader,String(projectId));
      assert.equal(await preview.getAttribute('aria-busy'),null,'the live status must remain outside the busy content');
      assert.equal(await preview.locator('div.whitespace-pre-wrap').getAttribute('aria-busy'),'true','unacknowledged preview content must remain busy');
      assert.equal(await preview.getByRole('button',{name:'Применить вариант',exact:true}).count(),0,'unacknowledged output cannot be applied as complete');
      assert.equal(await readEditableText(text),originalText,'streaming preview replaced the editor before the decision');
      assert.deepEqual(await readDraft(),original,'streaming preview mutated the durable draft before the decision');
      releaseAck.resolve();
      const ack=await ackResponsePromise;assert.equal(ack.status(),200,'terminal ACK must succeed durably');
      const receipt=await ack.json();assert.equal(receipt.ok,true);assert.equal(receipt.status,'committed');assert(Number.isSafeInteger(receipt.generationResultId));
      const apply=preview.getByRole('button',{name:'Применить вариант',exact:true});await apply.waitFor();
      await waitForFirstPartyNetworkIdle(page,'AI preview ready');
      const candidate=await preview.locator('div.whitespace-pre-wrap').textContent();
      assert(candidate?.trim()&&candidate!==originalText,'fake provider must return a distinct complete candidate');
      assert.equal(await readEditableText(text),originalText,'ready preview replaced the editor before the decision');
      assert.deepEqual(await readDraft(),original,'ready preview mutated the durable draft before the decision');
      const usage=(await pool.query('select status from ai_usage where user_id=$1 and reservation_key=$2',[userId,'web:'+request.key])).rows[0];
      assert.equal(usage?.status,'committed','delivered preview must retain its accounted AI usage');
      const generated=(await pool.query('select text from generation_results where id=$1',[receipt.generationResultId])).rows[0];
      assert.equal(generated?.text,candidate,'visible preview diverged from its durable generation receipt');
      await onAcknowledgedGeneration({request:request.nativeRequest,ackResponse:ack});
      const callsAfterReady=getProviderCallCount();assert(callsAfterReady>beforeProvider,'preview never reached the configured fake provider');
      if(decision==='reject') {
        await preview.getByRole('button',{name:'Оставить текущий текст',exact:true}).click();
        await preview.waitFor({state:'hidden'});
        await waitForFirstPartyNetworkIdle(page,'AI preview rejected');
        assert.equal(await readEditableText(text),originalText);
        assert.deepEqual(await readDraft(),original,'reject changed the original draft/provenance/version');
      } else {
        await apply.click();await preview.waitFor({state:'hidden'});
        await waitFor(async()=>{const row=await readDraft();return row?.text===candidate&&Number(row.generation_result_id)===receipt.generationResultId;},'applied candidate did not persist with its exact generation receipt');
        await waitForFirstPartyNetworkIdle(page,'AI preview applied');
        const applied=await readDraft();assert.equal(applied.origin,'ai');assert.equal(Number(applied.version),Number(original.version)+1);
        assert.equal(await readEditableText(text),candidate);
      }
      await page.reload({waitUntil:'domcontentloaded'});await text.waitFor();
      await waitForFirstPartyNetworkIdle(page,'AI preview decision reload');
      assert.equal(await readEditableText(text),decision==='reject'?originalText:candidate,'reload lost the explicit preview decision');
      assert.equal(await preview.count(),0,'decided preview reappeared after reload');
      assert.equal(getProviderCallCount(),callsAfterReady,'decision/reload repeated a provider generation');
      evidence.decisions.push({decision,requestKey:request.key,generationResultId:receipt.generationResultId,providerCalls:callsAfterReady-beforeProvider,draftVersion:Number((await readDraft()).version),result:'PASS'});
    }
    assert.notEqual(evidence.decisions[0].requestKey,evidence.decisions[1].requestKey,'explicit new preview reused a completed operation');
    const publications=(await pool.query('select count(*)::int as n from publication_operations where draft_id=$1',[draft.id])).rows[0].n;
    assert.equal(publications,0,'preview decision unexpectedly scheduled a publication');
    evidence.result='PASS';return evidence;
  } catch(error) {evidence.result='FAIL';evidence.failure=String(error?.message||error);throw error;}
  finally {
    releaseAck?.resolve();page.off('request',observeRequest);await page.unroute(ackPattern,gateAck);
    if(artifactDir)await writeFile(join(artifactDir,'ai-preview-coverage.json'),JSON.stringify(evidence,null,2)+'\n');
  }
}

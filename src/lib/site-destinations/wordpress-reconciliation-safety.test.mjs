import {describe,it,expect,vi} from 'vitest';
import {createWordPressAdapter} from './wordpress-adapter.mjs';
const destination={baseUrl:'https://fixture.example',credentials:{username:'fixture',appPassword:'fixture-password'}};
const expectedPayload={slug:'fixture',title:'Expected title',bodyHtml:'<p>Expected body</p>',metaDescription:'Expected excerpt'};
const knownProviderRef={id:987,slug:'fixture'};
const lookupFn=async()=>[{address:'93.184.216.34',family:4}];
const knownPost={id:987,slug:'fixture',status:'publish',link:'https://fixture.example/fixture',title:{raw:expectedPayload.title},content:{raw:expectedPayload.bodyHtml},excerpt:{raw:expectedPayload.metaDescription}};
function fixture(post,status=200){const fetchImpl=vi.fn(async url=>({status,text:async()=>JSON.stringify(new URL(url).searchParams.has('slug')?[post]:post)}));return{fetchImpl,adapter:createWordPressAdapter({lookupFn,fetchImpl})};}
describe('WordPress action-aware reconciliation',()=>{
 it.each(['publish','draft'])('a matching %s slug never proves an unknown create operation succeeded',async status=>{
  const{adapter}=fixture({...knownPost,status});expect(await adapter.reconcile(destination,'fixture',{action:'publish',expectedPayload})).toMatchObject({ok:false,outcome:'delivery_unknown',retryable:false});
 });
 it('does not retire a post that is still public after a lost unpublish acknowledgement',async()=>{
  const{adapter}=fixture(knownPost);expect(await adapter.reconcile(destination,'fixture',{action:'unpublish',knownProviderRef})).toMatchObject({ok:false,outcome:'delivery_unknown'});
 });
 it('does not mark an update successful when the known post still has its old content',async()=>{
  const{adapter}=fixture({...knownPost,content:{raw:'<p>Old body</p>'}});expect(await adapter.reconcile(destination,'fixture',{action:'update',knownProviderRef,expectedPayload})).toMatchObject({ok:false,outcome:'delivery_unknown'});
 });
 it('accepts only the known id in the requested draft state after unpublish',async()=>{
  const{adapter,fetchImpl}=fixture({...knownPost,status:'draft'});expect(await adapter.reconcile(destination,'fixture',{action:'unpublish',knownProviderRef})).toMatchObject({ok:true,publishedUrl:null,providerRef:{id:987,status:'draft'}});
  expect(fetchImpl).toHaveBeenCalledWith('https://fixture.example/wp-json/wp/v2/posts/987?context=edit',expect.objectContaining({method:'GET'}));
 });
 it('accepts the exact known id, status and raw requested content after update',async()=>{
  const{adapter}=fixture(knownPost);expect(await adapter.reconcile(destination,'fixture',{action:'update',knownProviderRef,expectedPayload})).toMatchObject({ok:true,providerRef:{id:987}});
 });
 it('keeps absence or wrong post id unknown',async()=>{
  for(const[post,status]of[[{code:'rest_post_invalid_id'},404],[{...knownPost,id:988},200]]){
   const{adapter}=fixture(post,status);expect(await adapter.reconcile(destination,'fixture',{action:'unpublish',knownProviderRef})).toMatchObject({ok:false,outcome:'delivery_unknown'});
  }
 });
 it('rejects a successful update receipt for a different post id',async()=>{
  const{adapter}=fixture({...knownPost,id:988});expect(await adapter.update(destination,knownProviderRef,expectedPayload)).toMatchObject({ok:false,outcome:'delivery_unknown'});
 });
 it.each(['draft','pending','private'])('does not report a %s receipt as a published post',async status=>{
  const {adapter}=fixture({...knownPost,status});expect(await adapter.publish(destination,expectedPayload)).toMatchObject({ok:false,outcome:'delivery_unknown'});
 });
 it('does not treat a missing unpublish receipt as proof that the post is gone',async()=>{
  const{adapter}=fixture({code:'rest_post_invalid_id'},404);expect(await adapter.unpublish(destination,knownProviderRef)).toMatchObject({ok:false,outcome:'delivery_unknown'});
 });

});

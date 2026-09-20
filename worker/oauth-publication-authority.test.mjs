import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(process.env.OAUTH_WORKER_SOURCE||new URL('../worker.mjs',import.meta.url),'utf8');
const block=source.slice(source.indexOf('async function refreshOAuthToken('),source.indexOf('const RECON_CONCURRENCY',source.indexOf('async function refreshOAuthToken(')));
function runtime({expired=false,deny=false,revokeOnPublish=false,revokeOnRefresh=false,unknown=false}={}){
 let allowed=!deny;const calls={read:0,publish:0,refresh:0};
 const publish=vm.runInNewContext(`${block}\npublishOAuth`,{pool:{query:async()=>({rowCount:1})},getOAuthConfig:()=>({}),encryptToken:String,refreshAccessToken:async()=>{calls.refresh++;if(revokeOnRefresh)allowed=false;return{accessToken:'fixture-fresh',expiresIn:3600};},getAdapter:()=>({publish:async()=>{calls.publish++;if(revokeOnPublish)allowed=false;return calls.publish===1?{ok:false,reason:'401 synthetic token rejection',...(unknown?{deliveryUnknown:true,outcome:'delivery_unknown'}:{})}:{ok:true};}}),loadOAuthToken:async()=>{calls.read++;return{accessToken:'fixture',refreshToken:'fixture',expiresAt:expired?new Date(0):null};},PROVIDER_OUTCOMES:{AUTH_FAILED:'auth_failed',DEFINITE_FAILURE:'definite_failure'},console});
 return{calls,run:()=>publish({network:'youtube',user_id:1},{text:'fixture'},async()=>allowed)};
}
describe('OAuth dispatch current-authority boundary',()=>{
 it('denies token reads and writes when authority was revoked',async()=>{const r=runtime({deny:true});await r.run();expect(r.calls).toEqual({read:0,publish:0,refresh:0});});
 it('does not start refresh/retry after revocation during a rejected publish',async()=>{const r=runtime({revokeOnPublish:true});expect((await r.run()).authorityLost).toBe(true);expect(r.calls).toEqual({read:1,publish:1,refresh:0});});
 it('does not publish after revocation during proactive refresh',async()=>{const r=runtime({expired:true,revokeOnRefresh:true});await r.run();expect(r.calls).toEqual({read:1,publish:0,refresh:1});});
 it('does not turn an unknown result containing 401 into retry evidence',async()=>{const r=runtime({unknown:true});const result=await r.run();expect(result.deliveryUnknown).toBe(true);expect(r.calls).toEqual({read:1,publish:1,refresh:0});});
 it('retains one refresh and retry for an authorized explicit rejection',async()=>{const r=runtime();expect((await r.run()).ok).toBe(true);expect(r.calls).toEqual({read:1,publish:2,refresh:1});});
});

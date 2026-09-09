import { describe, expect, it } from "vitest";
import { classifyEditorCancellation } from "../../scripts/e2e-editor-safety-coverage.mjs";
const read = { method:"GET",path:"/api/drafts/42",url:"https://127.0.0.1/api/drafts/42",page:0,failedAt:200,failure:"net::ERR_ABORTED" };
const navigation = { page:0,startedAt:100,finishedAt:300,complete:true,destination:"/login" };
const callerAbort = {page:0,url:read.url,at:195,aborted:true};
const rsc = {...read,path:"/login",url:"https://127.0.0.1/login?_rsc=fixture",rsc:"1",status:200,contentType:"text/x-component"};
describe("editor diagnostics requires cancellation evidence",()=>{
 it("does not treat a navigation time window as request causality",()=>{
  expect(classifyEditorCancellation(read,{navigation})).toBeNull();
  for(const changed of [{page:1},{complete:false},{finishedAt:199},{startedAt:201}]) expect(classifyEditorCancellation(read,{navigation:{...navigation,...changed}})).toBeNull();
 });
 it("rejects raw caller timing without exact native Request identity",()=>{
  expect(classifyEditorCancellation(read,{callerAbort})).toBeNull();
  for(const changed of [{aborted:false},{page:1},{url:read.url+"/editorial"},{at:2201}]) expect(classifyEditorCancellation(read,{callerAbort:{...callerAbort,...changed}})).toBeNull();
 });
 it("requires successful RSC and a real prefetch header",()=>{
  expect(classifyEditorCancellation({...rsc,prefetch:"1"})).toBe("completed_rsc_prefetch");
  for(const changed of [{prefetch:undefined},{status:503},{contentType:"application/json"},{rsc:undefined},{path:"/api/drafts/42"}]) expect(classifyEditorCancellation({...rsc,prefetch:"1",...changed})).toBeNull();
 });
 it("does not use a rendered destination as proof of a completed RSC body",()=>{
  expect(classifyEditorCancellation(rsc,{navigation})).toBeNull();
  expect(classifyEditorCancellation(rsc,{navigation:{...navigation,destination:"/app/calendar"}})).toBeNull();
 });
 it("rejects transport resets, truncated bodies, arbitrary HTTP failures and all canceled writes",()=>{
  for(const failure of ["net::ERR_CONNECTION_RESET","net::ERR_CONTENT_LENGTH_MISMATCH","NS_ERROR_NET_PARTIAL_TRANSFER","unknown"]) expect(classifyEditorCancellation({...read,failure},{navigation,callerAbort})).toBeNull();
  for(const method of ["POST","PATCH","PUT","DELETE"]) expect(classifyEditorCancellation({...read,method,status:200},{navigation,callerAbort})).toBeNull();
  expect(classifyEditorCancellation({...rsc,status:409,prefetch:"1"})).toBeNull();
 });
 it("accepts only acknowledged product-event keepalive; missing ACK still fails",()=>{
  const beacon={...read,method:"POST",path:"/api/product-events",status:200};
  expect(classifyEditorCancellation(beacon)).toBe("acknowledged_keepalive");
  for(const changed of [{status:undefined},{status:500},{path:"/api/drafts/42"}]) expect(classifyEditorCancellation({...beacon,...changed})).toBeNull();
 });
});

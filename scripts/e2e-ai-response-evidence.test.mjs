import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createAiConflictResponseEvidence, createAiAcknowledgementEvidence, createSitesMutationResponseEvidence, readSitesMutationReceipt } from "./e2e-ai-response-evidence.mjs";

const response = (id = "first", statusCode = 409) => Object.assign(new EventEmitter(), {
  headers: { "x-ai-request-id": id }, statusCode, complete: true,
});
const request = { method: "POST", path: "/api/ai/generate" };
describe("exact upstream pending-AI response evidence", () => {
  it("keeps the original complete response and does not substitute another request's body", () => {
    const evidence = createAiConflictResponseEvidence(); const first = response(); const second = response("second");
    evidence.observe(first, request); evidence.observe(second, request);
    first.emit("data", Buffer.from('{"error":"request_in_progress"}')); first.emit("end");
    second.emit("data", Buffer.from('{"error":"idempotency_key_conflict"}')); second.emit("end");
    expect(evidence.read("first")).toMatchObject({ complete: true, body: { error: "request_in_progress" } });
    expect(evidence.read("second").body.error).toBe("idempotency_key_conflict");
    expect(evidence.read("unknown")).toBeNull();
  });
  it("retains an exact terminal cancellation response separately from pending conflict", () => {
    const evidence = createAiConflictResponseEvidence(); const terminal = response("cancelled", 422);
    evidence.observe(terminal, request);
    terminal.emit("data", Buffer.from('{"error":"ai_generation_cancelled","retryable":false}'));
    terminal.emit("end");
    expect(evidence.read("cancelled")).toMatchObject({ status: 422, complete: true, body: { error: "ai_generation_cancelled", retryable: false } });
  });
  it.each(["aborted", "error", "incomplete", "invalid", "oversized"])("rejects %s response evidence", (kind) => {
    const evidence = createAiConflictResponseEvidence(); const upstream = response(); evidence.observe(upstream, request);
    if (kind === "incomplete") upstream.complete = false;
    if (["aborted", "error"].includes(kind)) upstream.emit(kind, new Error("fixture"));
    upstream.emit("data", Buffer.from(kind === "invalid" ? "{" : kind === "oversized" ? "x".repeat(65_537) : '{"error":"request_in_progress"}'));
    upstream.emit("end");
    expect(evidence.read("first").complete).toBe(false);
    expect(evidence.read("first").error).toBeTruthy();
  });
  it("does not capture other paths/statuses or reuse duplicate correlation IDs", () => {
    const evidence = createAiConflictResponseEvidence();
    evidence.observe(response("wrong-status", 200), request);
    evidence.observe(response("wrong-path"), { ...request, path: "/api/auth/login" });
    expect(evidence.read("wrong-status")).toBeNull(); expect(evidence.read("wrong-path")).toBeNull();
    evidence.observe(response(), request); evidence.observe(response(), request);
    expect(evidence.read("first")).toEqual({ error: "duplicate_response_id" });
  });
});


describe("exact upstream AI acknowledgement evidence", () => {
  const ackRequest = { method: "POST", path: "/api/ai/generate/ack", headers: { "idempotency-key": "owned-ack-key" } };
  const ackResponse = () => Object.assign(response("ack", 200), { headers: { "x-ai-request-id": "ack", "x-ai-acknowledged": "true", "content-type": "application/json; charset=utf-8" } });
  it("records only the complete original keyed ACK receipt", () => {
    const evidence = createAiAcknowledgementEvidence(); const upstream = ackResponse(); evidence.observe(upstream, ackRequest);
    upstream.emit("data", Buffer.from('{"ok":true,"status":"committed","generationResultId":91}'));
    expect(evidence.read("ack").complete).toBe(false); upstream.emit("end");
    expect(evidence.read("ack")).toMatchObject({ complete: true, status: 200, requestId: "ack", requestKey: "owned-ack-key", body: { generationResultId: 91 } });
  });
  it.each(["aborted", "error", "incomplete", "invalid", "oversized", "duplicate"])("does not certify %s ACK body", kind => {
    const evidence = createAiAcknowledgementEvidence(); const upstream = ackResponse(); evidence.observe(upstream, ackRequest);
    if (kind === "incomplete") upstream.complete = false;
    if (["aborted", "error"].includes(kind)) upstream.emit(kind, new Error("fixture"));
    if (kind === "duplicate") evidence.observe(ackResponse(), ackRequest);
    upstream.emit("data", Buffer.from(kind === "invalid" ? "{" : kind === "oversized" ? "x".repeat(65537) : '{"ok":true}')); upstream.emit("end");
    expect(evidence.read("ack").complete).not.toBe(true); expect(evidence.read("ack").error).toBeTruthy();
  });
  it.each(["path", "status", "method", "header", "type", "key"])("ignores an unrelated ACK %s contract", kind => {
    const evidence = createAiAcknowledgementEvidence(); const upstream = ackResponse(); const req = { ...ackRequest, headers: { ...ackRequest.headers } };
    if (kind === "path") req.path = "/api/ai/generate";
    if (kind === "method") req.method = "GET";
    if (kind === "status") upstream.statusCode = 409;
    if (kind === "header") delete upstream.headers["x-ai-acknowledged"];
    if (kind === "type") upstream.headers["content-type"] = "text/plain";
    if (kind === "key") delete req.headers["idempotency-key"];
    evidence.observe(upstream, req); expect(evidence.read("ack")).toBeNull();
  });
});


describe("Sites original creation receipt", () => {
  function fixture(path="/api/sites", id="sites-request-1") {
    const baseUrl="https://127.0.0.1:58801", status=path==="/api/sites"?201:202;
    const headers={"x-aurora-project-id":"2",...(status===201?{"idempotency-key":"sites-create-key"}:{})};
    const responseHeaders={"x-request-id":id,"content-type":"application/json; charset=utf-8"};
    const upstream=Object.assign(new EventEmitter(),{statusCode:status,headers:responseHeaders,complete:true});
    const evidence=createSitesMutationResponseEvidence();
    evidence.observe(upstream,{method:"POST",path,headers});
    const nativeRequest={method:()=>"POST",headers:()=>({...headers})};
    const browserResponse={url:()=>baseUrl+path,status:()=>status,headers:()=>({...responseHeaders}),request:()=>nativeRequest};
    const body={requestId:id,ok:true,site:{id:9},article:{id:10}};
    const finish=(raw=JSON.stringify(body))=>{upstream.emit("data",Buffer.from(raw));upstream.emit("end");};
    const options={evidence,response:browserResponse,baseUrl,projectId:2,waitFor:async predicate=>{
      const row=predicate();if(!row)throw new Error("original response incomplete");return row;
    }};
    return {upstream,evidence,headers,responseHeaders,body,finish,options,path,nativeRequest,browserResponse};
  }
  it.each(["/api/sites","/api/sites/9/articles"])("reads the exact original %s body with no repeat request or CDP body call",async path=>{
    const f=fixture(path);f.finish();
    expect(await readSitesMutationReceipt(f.options)).toEqual(f.body);
  });
  it.each(["aborted","error","incomplete","invalid","oversized","duplicate"])("rejects %s original receipt",async kind=>{
    const f=fixture();
    if(kind==="incomplete")f.upstream.complete=false;
    if(["aborted","error"].includes(kind))f.upstream.emit(kind,new Error("fixture"));
    if(kind==="duplicate")f.evidence.observe(f.upstream,{method:"POST",path:f.path,headers:f.headers});
    f.finish(kind==="invalid"?"{":kind==="oversized"?"x".repeat(65537):JSON.stringify(f.body));
    await expect(readSitesMutationReceipt(f.options)).rejects.toThrow();
  });
  it.each(["origin","path","query","method","project","key","status","type","id","body-id"])("rejects another operation's %s",async kind=>{
    const f=fixture();
    if(kind==="body-id")f.body.requestId="foreign-response";
    f.finish();
    if(kind==="origin")f.browserResponse.url=()=>"https://foreign.invalid/api/sites";
    if(kind==="path")f.browserResponse.url=()=>f.options.baseUrl+"/api/sites/9/articles";
    if(kind==="query")f.browserResponse.url=()=>f.options.baseUrl+"/api/sites?extra=1";
    if(kind==="method")f.nativeRequest.method=()=>"GET";
    if(kind==="project")f.headers["x-aurora-project-id"]="3";
    if(kind==="key")f.headers["idempotency-key"]="foreign-create-key";
    if(kind==="status")f.browserResponse.status=()=>200;
    if(kind==="type")f.responseHeaders["content-type"]="text/plain";
    if(kind==="id")f.responseHeaders["x-request-id"]="unknown-id";
    await expect(readSitesMutationReceipt(f.options)).rejects.toThrow();
  });
  it("keeps concurrent creation response identities separate",async()=>{
    const a=fixture();const b=fixture("/api/sites/9/articles","sites-request-2");
    a.finish();b.finish();
    expect(await readSitesMutationReceipt(a.options)).toEqual(a.body);
    await expect(readSitesMutationReceipt({...b.options,evidence:a.evidence})).rejects.toThrow("incomplete");
  });
});

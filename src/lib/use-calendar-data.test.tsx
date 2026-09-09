// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProjectTransport } from "./project-transport";
import { useCalendarData } from "./use-calendar-data";
let failing = false;
let delayed: ((response: Response) => void) | null = null;
let shouldDelay = false;
function reply(input: RequestInfo | URL, init?: RequestInit) {
  const url=new URL(String(input),"http://localhost");
  const project=Number(new Headers(init?.headers).get("x-aurora-project-id"));
  const resource=url.pathname.endsWith("posts")?"posts":"drafts";
  const range=url.searchParams.get("view")==="range";
  const second=url.searchParams.has("cursor");
  if(failing && second) return new Response(null,{status:503});
  return new Response(JSON.stringify({[resource]:range?[{id:(project*100)+(second?1:2),text:url.searchParams.get("from")}]:[],hasMore:range&&!second,nextCursor:range&&!second?"next":null}),{headers:{"x-aurora-project-id":String(project)}});
}
beforeEach(()=>{ failing=false; delayed=null; shouldDelay=false; setProjectTransport(7,true,1); vi.stubGlobal("fetch",vi.fn((input,init)=>{
  if(shouldDelay && String(input).includes("/api/posts") && String(input).includes("cursor=")) return new Promise<Response>(resolve=>{delayed=resolve;});
  return Promise.resolve(reply(input,init));
})); });
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe("calendar complete-view state",()=>{
  it("keeps the previous full collection on a next-page error and recovers",async()=>{
    const {result}=renderHook(()=>useCalendarData(7,"UTC","2030-01-01","2030-02-01",0));
    await waitFor(()=>expect(result.current.ready).toBe(true));
    expect(result.current.posts.map(r=>r.id)).toEqual([702,701]);
    failing=true; await act(()=>result.current.refresh());
    expect(result.current.error).toBe(true);expect(result.current.posts).toHaveLength(2);
    failing=false;await act(()=>result.current.refresh());expect(result.current.error).toBe(false);
  });
  it("does not present a partial first load as a complete empty calendar",async()=>{
    failing=true;
    const {result}=renderHook(()=>useCalendarData(7,"UTC","2030-01-01","2030-02-01",0));
    await waitFor(()=>expect(result.current.error).toBe(true));
    expect(result.current.ready).toBe(true);expect(result.current.posts).toEqual([]);
  });
  it("clears a previous range immediately and refuses late earlier responses",async()=>{
    const {result,rerender}=renderHook(({from,to})=>useCalendarData(7,"UTC",from,to,0),{initialProps:{from:"2030-01-01",to:"2030-02-01"}});
    await waitFor(()=>expect(result.current.ready).toBe(true));
    shouldDelay=true;let pending!:Promise<void>;
    act(()=>{pending=result.current.refresh();});
    await waitFor(()=>expect(delayed).not.toBeNull());
    const release=delayed!;shouldDelay=false;
    rerender({from:"2030-02-01",to:"2030-03-01"});
    expect(result.current.posts).toEqual([]);
    await waitFor(()=>expect(result.current.ready).toBe(true));
    await act(async()=>{release(new Response(JSON.stringify({posts:[{id:999}],hasMore:false,nextCursor:null}),{headers:{"x-aurora-project-id":"7"}}));await pending;});
    expect(result.current.posts.every(r=>r.text==="2030-02-01")).toBe(true);
  });
  it("does not reuse account or project data after a context change",async()=>{
    const {result,rerender}=renderHook(({project})=>useCalendarData(project,"UTC","2030-01-01","2030-02-01",0),{initialProps:{project:7}});
    await waitFor(()=>expect(result.current.ready).toBe(true));
    act(()=>setProjectTransport(8,true,2));rerender({project:8});
    expect(result.current.posts).toEqual([]);
    await waitFor(()=>expect(result.current.posts.map(r=>r.id)).toEqual([802,801]));
  });
});

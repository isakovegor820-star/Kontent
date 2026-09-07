// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {StoreProvider,useStore} from './store';
import {setClientProjectId} from './project-fetch';
vi.mock('next/navigation',()=>({usePathname:()=>'/fixture'}));
let store:ReturnType<typeof useStore>;const fetcher=vi.fn<typeof fetch>();
const actor={id:17,name:'Owned',email:'owned@example.test',onboarding_completed_at:'2026-09-01T00:00:00Z'};
let selectedProject=44;let channels:()=>Promise<Response>;let posts:(signal?:AbortSignal|null)=>Promise<Response>;
const postsResponse=()=>Response.json({projectId:selectedProject,posts:[],pageInfo:{hasMore:false,nextCursor:null,snapshotVersion:'1'}});
function Probe(){const value=useStore();React.useEffect(()=>{store=value;},[value]);return <><output data-testid="ready">{String(value.realReady)}</output><output data-testid="error">{String(value.realError)}</output></>;}
const pending=new Set<Promise<unknown>>();
const track=(value:Promise<unknown>)=>{pending.add(value);void value.then(()=>pending.delete(value),()=>pending.delete(value));return value;};
async function mount(){render(<StoreProvider><Probe/></StoreProvider>);await waitFor(()=>expect(store.ready&&store.user?.id===17).toBe(true));}
beforeEach(()=>{vi.stubGlobal('React',React);selectedProject=44;setClientProjectId(44);channels=async()=>Response.json({channels:[]});posts=async()=>postsResponse();fetcher.mockReset().mockImplementation(async(input,init)=>{const url=String(input);if(url==='/api/auth/me')return Response.json({user:actor});if(url==='/api/projects/current')return Response.json({ok:true,project:{projectId:selectedProject}});if(url==='/api/channels')return channels();if(url.startsWith('/api/posts?'))return posts(init?.signal);throw new Error('Unexpected owned request '+url);});vi.stubGlobal('fetch',fetcher);});
afterEach(async()=>{cleanup();await Promise.allSettled([...pending]);pending.clear();window.localStorage.clear();window.sessionStorage.clear();setClientProjectId(null);vi.unstubAllGlobals();});
function holdPosts(){let release!:(response:Response)=>void;let observedSignal:AbortSignal|null|undefined;posts=signal=>{observedSignal=signal;return new Promise<Response>((resolve,reject)=>{release=resolve;signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});});};return {release:()=>release(postsResponse()),signal:()=>observedSignal};}

describe('actual Store known channel rejection is not hidden by independent posts latency',()=>{
 for(const status of [401,403,503])it(`channels ${status} makes existing error/ready state available while posts is still pending`,async()=>{
  await mount();const held=holdPosts();channels=async()=>Response.json({error:status===503?'unavailable':'denied'},{status});let settled=false;
  act(()=>{track(store.refreshReal().then(()=>{settled=true;}));});
  await waitFor(()=>expect(fetcher.mock.calls.some(([url])=>String(url).startsWith('/api/posts?'))).toBe(true));
  try{await waitFor(()=>{expect(store.realError).toBe(true);expect(store.realReady).toBe(true);expect(settled).toBe(true);},{timeout:250});expect(held.signal()?.aborted).toBe(false);}
  finally{await act(async()=>{held.release();await Promise.allSettled([...pending]);});}
 });
 it('successful channels alone does not publish partial data before posts completes',async()=>{
  await mount();const held=holdPosts();channels=async()=>Response.json({channels:[{id:88,title:'Owned'}]});act(()=>{track(store.refreshReal());});await waitFor(()=>expect(fetcher.mock.calls.some(([url])=>String(url).startsWith('/api/posts?'))).toBe(true));await act(async()=>{await Promise.resolve();});expect(store.realReady).toBe(false);expect(store.realChannels).toEqual([]);
  await act(async()=>{held.release();await Promise.allSettled([...pending]);});expect(store.realReady).toBe(true);expect(store.realError).toBe(false);expect(store.realChannels[0]?.id).toBe(88);
 });
 it('a newer refresh keeps its data when an older failed response arrives late',async()=>{
  await mount();let release!:(response:Response)=>void;channels=()=>new Promise<Response>(resolve=>{release=resolve;});act(()=>{track(store.refreshReal());});await waitFor(()=>expect(fetcher.mock.calls.some(([url])=>url==='/api/channels')).toBe(true));channels=async()=>Response.json({channels:[{id:99,title:'New'}]});await act(async()=>{await store.refreshReal();});await act(async()=>{release(Response.json({error:'unavailable'},{status:503}));await Promise.allSettled([...pending]);});expect(store.realChannels[0]?.id).toBe(99);expect(store.realError).toBe(false);expect(store.realReady).toBe(true);
 });

 it('a refusal from the old selected project cannot overwrite the new project',async()=>{
  await mount();let release!:(response:Response)=>void;channels=()=>new Promise<Response>(resolve=>{release=resolve;});act(()=>{track(store.refreshReal());});
  await waitFor(()=>expect(fetcher.mock.calls.some(([url])=>url==='/api/channels')).toBe(true));
  selectedProject=45;channels=async()=>Response.json({channels:[{id:145,title:'Project 45'}]});
  act(()=>{setClientProjectId(45);window.dispatchEvent(new Event('aurora:project-changed'));});
  await waitFor(()=>expect(store.ready).toBe(true));await act(async()=>{await store.refreshReal();});
  await act(async()=>{release(Response.json({error:'access_denied'},{status:403}));await Promise.allSettled([...pending]);});
  expect(store.realChannels.map(channel=>channel.id)).toEqual([145]);expect(store.realError).toBe(false);expect(store.realReady).toBe(true);
  const lastChannels=fetcher.mock.calls.filter(([url])=>url==='/api/channels').at(-1);expect(new Headers(lastChannels?.[1]?.headers).get('x-aurora-project-id')).toBe('45');
 });
 it('a current refusal preserves the prior complete snapshot without publishing a partial replacement',async()=>{
  await mount();channels=async()=>Response.json({channels:[{id:88,title:'Prior confirmed'}]});await act(async()=>{await store.refreshReal();});
  const held=holdPosts();channels=async()=>Response.json({error:'unavailable'},{status:503});act(()=>{track(store.refreshReal());});
  try{await waitFor(()=>expect(store.realError).toBe(true),{timeout:250});expect(store.realReady).toBe(true);expect(store.realChannels.map(channel=>channel.id)).toEqual([88]);}
  finally{await act(async()=>{held.release();await Promise.allSettled([...pending]);});}
  expect(store.realChannels.map(channel=>channel.id)).toEqual([88]);
 });
});


describe('invalid channel bodies preserve the last complete Store snapshot', () => {
  it.each(['malformed', 'missing-channels', 'wrong-channels-type'])('rejects %s instead of clearing confirmed channels', async (kind) => {
    await mount(); channels=async()=>Response.json({channels:[{id:88,title:'Prior confirmed'}]});
    await act(async()=>{await store.refreshReal();});
    channels=async()=>kind==='malformed' ? new Response('{', {headers:{'content-type':'application/json'}}) : Response.json(kind==='missing-channels' ? {} : {channels:null});
    await act(async()=>{await store.refreshReal();});
    expect(store.realError).toBe(true);
    expect(store.realChannels.map(channel=>channel.id)).toEqual([88]);
  });
  it('detects malformed channels without waiting for independent posts latency', async () => {
    await mount(); const held=holdPosts(); channels=async()=>new Response('{',{headers:{'content-type':'application/json'}});
    act(()=>{track(store.refreshReal());});
    try {await waitFor(()=>expect(store.realError).toBe(true),{timeout:250});}
    finally {await act(async()=>{held.release();await Promise.allSettled([...pending]);});}
  });
});

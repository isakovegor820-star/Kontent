// @vitest-environment jsdom
import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {AdminAuroraAnalyticsCenter} from './admin-aurora-analytics';
import {analyticsPayload} from './__fixtures__/admin-payloads';

const fetchMock=vi.fn<typeof fetch>();
const payload=(params:URLSearchParams)=>{
  const value=analyticsPayload(params);
  value.filters.range=params.get('range')==='30d'?'30d':'7d';
  return value;
};
beforeEach(()=>{
  vi.stubGlobal('fetch',fetchMock); fetchMock.mockReset();
  fetchMock.mockImplementation(async input=>Response.json(payload(new URL(String(input),'http://localhost').searchParams)));
  Element.prototype.scrollIntoView=vi.fn();
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it.each(['?range=7d&analyticsSection=studio&analyticsTab=errors',''])('starts only the URL-selected analytics request: %s',async query=>{
  window.history.replaceState({},'',`/admin${query}#aurora-analytics`);
  render(<AdminAuroraAnalyticsCenter/>);
  await screen.findByRole('button',{name:'7 дней'});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  expect(fetchMock.mock.calls.map(([input])=>String(input))).toEqual([`/api/admin/aurora-analytics${query}`]);
});

it('a superseded JSON completion cannot replace the newer URL-selected result',async()=>{
  window.history.replaceState({},'','/admin?range=7d#aurora-analytics');
  let finishOld!:()=>void; let oldSignal:AbortSignal|null|undefined;
  const oldBody=new Promise(resolve=>{finishOld=()=>resolve(payload(new URLSearchParams('range=7d')));});
  fetchMock.mockImplementation(async(input,init)=>{
    const params=new URL(String(input),'http://localhost').searchParams;
    if(params.get('range')==='7d') {oldSignal=init?.signal;return {ok:true,status:200,json:()=>oldBody} as Response;}
    return Response.json(payload(params));
  });
  render(<AdminAuroraAnalyticsCenter/>);
  await waitFor(()=>expect(oldSignal).toBeTruthy());
  await act(async()=>{window.history.pushState({},'','/admin?range=30d#aurora-analytics');window.dispatchEvent(new PopStateEvent('popstate'));});
  await waitFor(()=>expect(screen.getByRole('button',{name:'30 дней'}).getAttribute('aria-pressed')).toBe('true'));
  expect(oldSignal?.aborted).toBe(true);
  await act(async()=>{finishOld();await oldBody;});
  expect(window.location.search).toBe('?range=30d');
  expect(screen.getByRole('button',{name:'30 дней'}).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button',{name:'7 дней'}).getAttribute('aria-pressed')).toBe('false');
});

import {it,expect,vi} from 'vitest';
import {selectProjectWithSettledReads} from './e2e-project-selection.mjs';
function fixture(initial=2) {
  let selected=initial,tab=initial; const steps=[];
  const selector={first(){return this;},waitFor:async()=>{},isDisabled:async()=>false,inputValue:async()=>String(selected),
    selectOption:vi.fn(async id=>{steps.push('select');selected=Number(id);tab=selected;})};
  const page={getByRole:()=>selector,evaluate:async()=>tab};
  const waitFor=async predicate=>{expect(await predicate()).toBe(true);};
  return {page,selector,waitFor,steps};
}
it('settles existing and frame-enqueued reads before changing the project, then settles the new project',async()=>{
  const f=fixture();let release; const held=new Promise(resolve=>{release=resolve;});
  const settleReads=vi.fn(async page=>{expect(page).toBe(f.page);f.steps.push('settle');if(settleReads.mock.calls.length===1)await held;});
  const work=selectProjectWithSettledReads(f.page,1,{waitFor:f.waitFor,settleReads});
  await new Promise(resolve=>setTimeout(resolve,0));
  try {expect(f.selector.selectOption).not.toHaveBeenCalled();}
  finally {release();await work;}
  expect(f.steps).toEqual(['settle','select','settle']);
});
it('an unresolved old read fails setup before a project mutation',async()=>{
  const f=fixture();const error=new Error('original GET was not proved');
  await expect(selectProjectWithSettledReads(f.page,1,{waitFor:f.waitFor,settleReads:async()=>{throw error;}})).rejects.toBe(error);
  expect(f.selector.selectOption).not.toHaveBeenCalled();
});
it('a failure in the newly selected project propagates instead of authorizing the next navigation',async()=>{
  const f=fixture();const error=new Error('new project read failed');
  const settleReads=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
  await expect(selectProjectWithSettledReads(f.page,1,{waitFor:f.waitFor,settleReads})).rejects.toBe(error);
  expect(f.selector.selectOption).toHaveBeenCalledOnce();
});
it('already selected project retains identity while its reads are still checked',async()=>{
  const f=fixture(1);const settleReads=vi.fn();await selectProjectWithSettledReads(f.page,1,{waitFor:f.waitFor,settleReads});
  expect(f.selector.selectOption).not.toHaveBeenCalled();expect(settleReads).toHaveBeenCalledTimes(2);
});

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { assertTodayFocusGeometry } from './e2e-today-focus-coverage.mjs';
const visible = () => ({ found:true,focus:true,focusVisible:true,rect:{left:33,right:287,top:700,bottom:744,width:254,height:44},clientWidth:320,innerHeight:844,documentWidth:320,bodyWidth:320,hits:[true,true,true],bottomNav:{top:787,bottom:844,height:57},scrollingElement:'HTML',scrollPaddingEnd:'80px',nativeZoom:false });
test('visible native focus above reserved mobile navigation is accepted',()=>assert.doesNotThrow(()=>assertTodayFocusGeometry(visible())));
for(const [name,mutate] of [
 ['narrow touch target',r=>{r.rect.width=20;}],
 ['short touch target',r=>{r.rect.height=20;}],
 ['actual nav-covered focus',r=>{r.rect.top=782;r.rect.bottom=826;r.hits=[false,false,false];}],
 ['one covered sample',r=>{r.hits[2]=false;}],
 ['focus never reached',r=>{r.found=false;}],
 ['programmatic-only focus without visible keyboard focus',r=>{r.focusVisible=false;}],
 ['offscreen control',r=>{r.rect.top=900;r.rect.bottom=944;}],
 ['missing native hit sample',r=>{r.hits.pop();}],
 ['horizontal overflow',r=>{r.documentWidth=340;}],
 ['CSS zoom substituted for native200',r=>{r.nativeZoom=true;r.outerWidth=640;r.innerWidth=320;r.cssZoom='2';r.visualScale=1;}],
 ['pinch zoom substituted for native200',r=>{r.nativeZoom=true;r.outerWidth=640;r.innerWidth=320;r.cssZoom='1';r.visualScale=2;}],
 ['unconfirmed 200 percent',r=>{r.nativeZoom=true;r.outerWidth=320;r.innerWidth=320;r.cssZoom='1';r.visualScale=1;}],
]) test(name+' remains rejected',()=>{const r=visible();mutate(r);assert.throws(()=>assertTodayFocusGeometry(r));});
test('native200 exact ratio/control metrics accepted',()=>{const r=visible();Object.assign(r,{nativeZoom:true,outerWidth:640,innerWidth:320,cssZoom:'1',visualScale:1});assert.doesNotThrow(()=>assertTodayFocusGeometry(r));});
test('desktop without a rendered mobile nav does not require mobile padding',()=>{const r=visible();r.bottomNav=null;r.scrollPaddingEnd='auto';assert.doesNotThrow(()=>assertTodayFocusGeometry(r));});

const { runTodayFocusCoverage } = await import('./e2e-today-focus-coverage.mjs');
test('ambiguous exact locator fails before keyboard interaction',async()=>{
  let pressed=0;const page={url:()=> 'https://127.0.0.1:63387/app/today',keyboard:{press:async()=>pressed++}};
  await assert.rejects(runTodayFocusCoverage({page,engine:'chromium',locator:{count:async()=>2}}),/must be unique/);
  assert.equal(pressed,0);
});
test('disabled content action is not activated or certified',async()=>{
  let pressed=0;const page={url:()=> 'https://127.0.0.1:63387/app/today',keyboard:{press:async()=>pressed++}};
  await assert.rejects(runTodayFocusCoverage({page,engine:'chromium',locator:{count:async()=>1,isEnabled:async()=>false}}),/must be enabled/);
  assert.equal(pressed,0);
});
test('foreign origin never enters focus probe',async()=>{
  await assert.rejects(runTodayFocusCoverage({page:{url:()=> 'https://example.test/app/today'},engine:'chromium',controlName:'Готово'}),/caller-owned local/);
});

for (const widths of [[], [0], [-1], [NaN], [320.5], ['320'], null]) test('invalid viewport matrix '+String(widths)+' is rejected',async()=>{
 await assert.rejects(runTodayFocusCoverage({page:{url:()=> 'https://127.0.0.1:63387/app/today'},engine:'chromium',controlName:'Готово',viewportWidths:widths}),/viewport matrix/);
});

test('computed scrolling diagnostics do not replace actual native focus and hit behavior',()=>{const r=visible();r.scrollingElement='BODY';r.scrollPaddingEnd='auto';assert.doesNotThrow(()=>assertTodayFocusGeometry(r));});

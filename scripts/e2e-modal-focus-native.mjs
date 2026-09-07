import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(new URL('../package.json',import.meta.url));
const root=fileURLToPath(new URL('../',import.meta.url));
let bundlePromise;
async function fixtureBundle(){
  // Use the installed test toolchain; do not read project env/config or replace the component.
  const {build}=await import('vite');
  const fixture=`import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ConfirmDialog} from ${JSON.stringify(fileURLToPath(new URL('../src/components/ui/confirm-dialog.tsx',import.meta.url)))};
    function Fixture(){
      const [open,setOpen]=React.useState(false);
      const [result,setResult]=React.useState('idle');
      window.closeFixture=()=>setOpen(false);
      return React.createElement('main',null,
        React.createElement('button',{onClick:()=>setOpen(true)},'Open'),
        React.createElement('output',{id:'result'},result),
        React.createElement(ConfirmDialog,{open,title:'Owned copy',description:'Disposable fixture',
          confirmLabel:'Delete owned copy',onConfirm:()=>{setResult('confirmed');setOpen(false);},
          onCancel:()=>{setResult('cancelled');setOpen(false);}}));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
  const built=await build({root,configFile:false,envDir:false,logLevel:'silent',define:{'process.env.NODE_ENV':JSON.stringify('production')},
    resolve:{alias:[{find:'@',replacement:root+'src'},
      {find:/^react$/,replacement:require.resolve('react')},
      {find:/^react-dom\/client$/,replacement:require.resolve('react-dom/client')}]},
    plugins:[{name:'owned-modal-fixture',resolveId(id){if(id==='aurora-modal-fixture'||id===root+'aurora-modal-fixture')return '\0aurora-modal-fixture';},
      load(id){if(id==='\0aurora-modal-fixture')return fixture;}}],
    build:{write:false,minify:false,lib:{entry:'aurora-modal-fixture',formats:['iife'],name:'AuroraModalFixture'}}});
  const outputs=(Array.isArray(built)?built:[built]).flatMap(item=>item.output);
  assert.equal(outputs.filter(item=>item.type==='chunk').length,1);
  return outputs.find(item=>item.type==='chunk').code;
}

export async function verifyNativeModalFocus(browser){
  const code=await (bundlePromise??=fixtureBundle());
  const server=http.createServer((req,res)=>{
    if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript; charset=utf-8');res.end(code);}
    else if(req.url==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><title>Owned modal focus fixture</title><div id="root"></div><script src="/fixture.js"></script>');}
    else {res.statusCode=404;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const cases=[];
  try{for(const scenario of ['explicit-confirm','safe-default','explicit-cancel','close-before-frame']){
    const page=await browser.newPage();page.setDefaultTimeout(5000);const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    try{
      // Hold only the modal's initial frame to reproduce focus selection before that frame.
      await page.addInitScript(()=>{
        const nativeFrame=window.requestAnimationFrame.bind(window);
        const nativeCancel=window.cancelAnimationFrame.bind(window);let next=-1;
        window.heldModalFrames=new Map();window.holdModalFrame=false;
        window.requestAnimationFrame=callback=>{if(!window.holdModalFrame)return nativeFrame(callback);
          const id=next--;window.heldModalFrames.set(id,callback);return id;};
        window.cancelAnimationFrame=id=>{if(id<0)window.heldModalFrames.delete(id);else nativeCancel(id);};
        window.flushModalFrames=()=>{window.holdModalFrame=false;const callbacks=[...window.heldModalFrames.values()];
          window.heldModalFrames.clear();for(const callback of callbacks)callback(performance.now());};
      });
      await page.goto(origin);
      const trigger=page.getByRole('button',{name:'Open',exact:true});
      await trigger.focus();await page.evaluate(()=>{window.holdModalFrame=true;});
      await page.keyboard.press('Enter');await page.getByRole('dialog').waitFor();
      await page.waitForFunction(()=>window.heldModalFrames.size===1);
      const confirm=page.getByRole('button',{name:'Delete owned copy',exact:true});
      const cancel=page.getByRole('button',{name:'Отмена',exact:true});
      if(scenario==='explicit-confirm')await confirm.focus();
      if(scenario==='explicit-cancel')await cancel.focus();
      if(scenario==='close-before-frame'){
        await page.evaluate(()=>window.closeFixture());
        await page.getByRole('dialog').waitFor({state:'hidden'});
        assert.equal(await page.evaluate(()=>window.heldModalFrames.size),0,'unmount cancels deferred focus');
        await page.evaluate(()=>window.flushModalFrames());
      }else{
        await page.evaluate(()=>window.flushModalFrames());
        if(scenario==='safe-default'){
          assert.equal(await cancel.evaluate(node=>node===document.activeElement),true,'safe initial focus');
          await page.keyboard.press('Shift+Tab');
          assert.equal(await confirm.evaluate(node=>node===document.activeElement),true,'backward focus trap');
          await page.keyboard.press('Tab');
          assert.equal(await cancel.evaluate(node=>node===document.activeElement),true,'forward focus trap');
          await page.keyboard.press('Escape');
        }else await page.keyboard.press('Enter');
        await page.getByRole('dialog').waitFor({state:'hidden'});
      }
      const outcome=await page.locator('#result').textContent();
      assert.equal(outcome,scenario==='explicit-confirm'?'confirmed':scenario==='close-before-frame'?'idle':'cancelled',
        'deferred focus must preserve the chosen native keyboard action');
      assert.equal(await trigger.evaluate(node=>node===document.activeElement&&!node.inert),true,'return focus and background restoration');
      assert.deepEqual(errors,[]);cases.push({scenario,ok:true,outcome});
    }catch(error){cases.push({scenario,ok:false,error:error.message,runtimeErrors:errors});}finally{await page.close();}
  }}finally{await new Promise(resolve=>server.close(resolve));}
  assert.equal(cases.filter(row=>!row.ok).length,0,JSON.stringify(cases));
  return cases;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const engines=require('playwright-core');const report=[];
  for(const engine of ['chromium','firefox','webkit']){
    const browser=await engines[engine].launch({headless:true});
    try{report.push({engine,ok:true,cases:await verifyNativeModalFocus(browser)});}
    catch(error){report.push({engine,ok:false,error:error.message});}finally{await browser.close();}
  }
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.every(row=>row.ok)?0:1;
}

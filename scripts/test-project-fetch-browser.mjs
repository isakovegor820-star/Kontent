import http from 'node:http';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {verifyNativeFirefoxFaviconEvidence} from './e2e-firefox-favicon-native.mjs';
import {verifyNativeWorkspacePolling} from './e2e-workspace-polling-native.mjs';
import {verifyNativeModalFocus} from './e2e-modal-focus-native.mjs';
import {verifyNativeBrowserBoundary} from './e2e-native-browser-boundary.mjs';
import {verifyNativeExportReads} from './e2e-native-export-read.mjs';
import {verifyNativeReadTerminalEvidence} from './e2e-native-read-terminal.mjs';
const require=createRequire(new URL('../package.json',import.meta.url));
const {chromium,firefox,webkit}=await import('./e2e-playwright.mjs');
const ts=require('typescript');
const source=ts.transpileModule(readFileSync(new URL('../src/lib/project-fetch.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^export /gm,'');
const server=http.createServer((req,res)=>{
 if(req.url==='/'){res.end('<!doctype html><title>Local stream probe</title>');return;}
 res.setHeader('content-type','application/json');res.write('{"ok":');
 if(req.url==='/api/reset')setTimeout(()=>res.destroy(),40);
 else {const timer=setTimeout(()=>res.end('true}'),1000);res.on('close',()=>clearTimeout(timer));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await firefox.launch({headless:true});
const report=[];
const fixtureFailures=[];
async function runFixture(name,check){
  try{console.log(JSON.stringify({fixture:name,result:await check()}));}
  catch(error){const failure={fixture:name,error:String(error?.stack||error)};fixtureFailures.push(failure);console.error(JSON.stringify(failure));}
}
try{for(const wrap of [false,true])for(const fault of ['abort','reset']){
 const page=await browser.newPage();const errors=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('pageerror',e=>errors.push('pageerror:'+e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.addScriptTag({content:source+';window.fixtureProjectFetch=projectFetch;window.fixtureSetProject=setClientProjectId;setClientProjectId(1);'});
 const result=await page.evaluate(async({wrap,fault})=>{
  const abort=new AbortController();const response=await (wrap?window.fixtureProjectFetch:fetch)('/api/'+fault,{signal:abort.signal});
  if(fault==='abort')setTimeout(()=>abort.abort(),40);
  try{await response.json();return 'unexpected-success';}catch(error){return error.name;}
 },{wrap,fault});
 await new Promise(r=>setTimeout(r,80));report.push({wrap,fault,result,errors});await page.close();
}
await runFixture('firefox/nativeFavicon',()=>verifyNativeFirefoxFaviconEvidence(browser));
await runFixture('firefox/nativeReadTerminal',()=>verifyNativeReadTerminalEvidence(browser));
await runFixture('firefox/workspacePolling',()=>verifyNativeWorkspacePolling(browser));
await runFixture('firefox/modalFocus',()=>verifyNativeModalFocus(browser));
await runFixture('firefox/exportReads',()=>verifyNativeExportReads(browser));
await runFixture('firefox/browserBoundary',()=>verifyNativeBrowserBoundary(browser));
for(const [engine,launcher] of Object.entries({chromium,webkit})){
 const owned=await launcher.launch({headless:true});
 try{await runFixture(`${engine}/workspacePolling`,()=>verifyNativeWorkspacePolling(owned));
   await runFixture(`${engine}/modalFocus`,()=>verifyNativeModalFocus(owned));
   await runFixture(`${engine}/exportReads`,()=>verifyNativeExportReads(owned));
   await runFixture(`${engine}/browserBoundary`,()=>verifyNativeBrowserBoundary(owned));}finally{await owned.close();}
}
}finally{await browser.close();await new Promise(r=>server.close(r));}
console.log(JSON.stringify(report,null,2));
for(const row of report){assert.deepEqual(row.errors,[], 'caught body failures must not become browser runtime errors');assert.equal(row.result,row.fault==='reset'?'TypeError':'AbortError','preserve actual failure classification');}
assert.equal(fixtureFailures.length,0,`Native fixture failures: ${JSON.stringify(fixtureFailures)}`);

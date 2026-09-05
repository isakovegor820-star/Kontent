import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright-core';
import {sanitizeE2eNetworkUrl} from './e2e-browser-config.mjs';

/** Actual Chromium browser zoom, using only a fresh owned profile, never CSS zoom. */
export async function runTrueZoomCoverage({baseUrl, cookies, projectId, artifactDir}) {
  assert(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'zoom QA must use an isolated local application');
  const profile = await mkdtemp(join(tmpdir(), 'aurora-e2e-zoom-'));
  await mkdir(join(profile, 'Default'));
  // Chromium stores a base-1.2 zoom level for the default storage partition (key x).
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({partition:{default_zoom_level:{x:Math.log(2)/Math.log(1.2)}}}));
  const context = await chromium.launchPersistentContext(profile, {
    headless:true, executablePath:chromium.executablePath(), viewport:null,
    ignoreHTTPSErrors:true, reducedMotion:'reduce', args:['--window-size=1280,1000'],
  });
  const report={zoom:200,mechanism:'native Chromium preference in ephemeral profile',screens:[],errors:[],network:[]};
  const requests=new Map();let sequence=0;let teardown=false;
  context.on('request',request=>{
    const entry={id:++sequence,url:sanitizeE2eNetworkUrl(request.url(),baseUrl),method:request.method(),resourceType:request.resourceType(),startedAt:new Date().toISOString()};
    requests.set(request,entry);report.network.push(entry);
  });
  context.on('response',response=>{const entry=requests.get(response.request());if(entry){entry.status=response.status();entry.responseAt=new Date().toISOString();}});
  context.on('requestfinished',request=>{const entry=requests.get(request);if(entry)entry.finishedAt=new Date().toISOString();});
  context.on('requestfailed',request=>{const entry=requests.get(request);if(entry){entry.failedAt=new Date().toISOString();entry.failure=request.failure();
    // Next prefetch and superseded project reads intentionally cancel. Preserve
    // those observations; transport resets/truncated bodies remain hard failures.
    if(!teardown&&entry.failure?.errorText!=='net::ERR_ABORTED')report.errors.push('Request failed: '+entry.method+' '+entry.url+' '+String(entry.failure?.errorText||'unknown'));
  }});
  try {
    const page=context.pages()[0];
    page.on('pageerror', e => report.errors.push(String(e.message)));
    page.on('console', m => {if(m.type()==='error')report.errors.push(m.text());});
    const cdp=await context.newCDPSession(page);
    async function waitForContentIdle(label) {
      // The existing full E2E contract treats product-events as keepalive beacons.
      // Full Chromium can emit their HTTP response without requestfinished. Require
      // a successful acknowledgement before treating those background requests as
      // settled; every other request must actually finish or fail.
      const deadline=Date.now()+30_000;let idleSince=null;
      while(Date.now()<deadline) {
        const blocking=report.network.filter(entry=>!entry.finishedAt&&!entry.failedAt
          &&!(entry.url==='/api/product-events'&&entry.status>=200&&entry.status<300));
        if(blocking.length===0){idleSince??=Date.now();if(Date.now()-idleSince>=750)return;}
        else idleSince=null;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error(label+' requests did not settle: '+JSON.stringify(report.network.filter(entry=>!entry.finishedAt&&!entry.failedAt)));
    }
    async function inspect(label, heading, theme) {
      await page.getByRole('heading',{name:heading,exact:true}).first().waitFor();
      if(theme)await page.locator(`.app-v3[data-theme="${theme}"]`).waitFor();
      await waitForContentIdle(label);
      const state=await page.evaluate(() => {
        const root=document.querySelector('.app-v3')||document.documentElement;
        const style=getComputedStyle(root);const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
        function rgb(token){ctx.clearRect(0,0,1,1);ctx.fillStyle=style.getPropertyValue(token).trim();ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];}
        function luminance(c){return c.slice(0,3).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);}
        const pairs=[['--text','--bg'],['--text-2','--surface'],['--text-3','--surface'],['--danger-text','--danger-soft'],['--success-text','--success-soft'],['--fire-text','--fire-soft'],['--info-text','--info-soft']];
        const contrast=pairs.map(([fg,bg])=>{const a=rgb(fg),b=rgb(bg),x=luminance(a),y=luminance(b);return {fg,bg,rgba:[a,b],ratio:(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};});
        return {outerWidth,innerWidth,dpr:devicePixelRatio,visualScale:visualViewport.scale,cssZoom:getComputedStyle(document.documentElement).zoom,scrollWidth:document.documentElement.scrollWidth,theme:root.getAttribute('data-theme'),contrast};
      });
      assert(Math.abs(state.outerWidth/state.innerWidth-2)<.02,'native page zoom did not reach 200%');
      assert(state.cssZoom==='1' && state.visualScale===1,'CSS or pinch zoom must not substitute for browser zoom');
      assert(state.scrollWidth<=state.innerWidth+1,label+' overflows horizontally at actual zoom200');
      for(const pair of state.contrast)assert(pair.ratio>=4.5,label+' token text contrast below4.5: '+pair.fg+'/'+pair.bg+'='+pair.ratio);
      await page.keyboard.press('Tab');
      // Full Chromium at native zoom exposes the new focused element before its
      // focus styles have reached a rendered frame. Inspect the painted state.
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const focus=await page.evaluate(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),s=getComputedStyle(e),ctx=document.createElement('canvas').getContext('2d');ctx.fillStyle=s.backgroundColor;ctx.fillRect(0,0,1,1);return {tag:e.tagName,visible:e.matches(':focus-visible'),left:r.left,right:r.right,width:r.width,href:e.getAttribute('href'),background:s.backgroundColor,backgroundAlpha:ctx.getImageData(0,0,1,1).data[3],color:s.color,padding:s.padding};});
      assert(focus.visible&&focus.width>0&&focus.left>=-1&&focus.right<=state.innerWidth+1,label+' keyboard focus unavailable at actual zoom200');
      if(focus.href==='#main')assert.equal(focus.backgroundAlpha,255,label+' focused skip link must have an opaque background');
      // Playwright fullPage captures CSS-sized clips at native zoom. CDP captures the
      // actual browser viewport in device pixels without changing page metrics.
      const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      const screenshot='interface-true-zoom200-'+label+'.png';
      await writeFile(join(artifactDir,screenshot),Buffer.from(shot.data,'base64'));
      report.screens.push({label,...state,focus,screenshot});
    }
    await page.goto(baseUrl+'/login',{waitUntil:'load'});
    await inspect('login','С возвращением');
    await context.addCookies(cookies);
    await context.addInitScript(id=>sessionStorage.setItem('aurora:request-project-id',String(id)),projectId);
    for(const theme of ['light','dark']) {
      await context.addCookies([{name:'aurora_app_theme',value:theme,url:baseUrl}]);
      for(const [path,heading] of [['calendar','Календарь'],['studio','Студия контента'],['sites','Мои сайты'],['settings','Настройки']]) {
        await page.goto(baseUrl+'/app/'+path,{waitUntil:'load'});
        await inspect(path+'-'+theme,heading,theme);
      }
    }
    await page.goto(baseUrl+'/admin#system',{waitUntil:'load'});
    await inspect('admin-system','Состояние системы');
    assert.deepEqual(report.errors,[],'zoom QA contains unexpected browser errors');
    await writeFile(join(artifactDir,'true-zoom-coverage.json'),JSON.stringify(report,null,2)+'\n');
    return report;
  } catch(error) {
    report.failure=error instanceof Error?error.message:String(error);
    report.currentUrl=sanitizeE2eNetworkUrl(context.pages()[0]?.url()||baseUrl,baseUrl);
    await writeFile(join(artifactDir,'true-zoom-coverage.json'),JSON.stringify(report,null,2)+'\n');
    const page=context.pages()[0];
    if(page){const cdp=await context.newCDPSession(page);const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).catch(()=>null);if(shot)await writeFile(join(artifactDir,'true-zoom-failure.png'),Buffer.from(shot.data,'base64'));}
    throw error;
  } finally {teardown=true;await context.close();await rm(profile,{recursive:true,force:true});}
}

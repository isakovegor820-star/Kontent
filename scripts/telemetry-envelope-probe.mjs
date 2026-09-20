// Runs the actual worker SDK configuration with an in-memory transport only.
import { readFile, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.argv[2] ? pathToFileURL(process.argv[2].replace(/\/$/,'')+'/') : new URL('../', import.meta.url);
const folder = await mkdtemp(join(tmpdir(), 'aurora-telemetry-'));
try {
  await symlink(fileURLToPath(new URL('node_modules', root)), join(folder, 'node_modules'));
  const original = await readFile(new URL('sentry.worker.config.mjs', root), 'utf8');
  const config = original
    .replace(/from ["'](\.\/?[^"']+)["']/g, (_, path) => `from ${JSON.stringify(new URL(path, root).href)}`)
    .replace(/dsn: ["'][^"']+["']/, 'dsn: "https://public@example.invalid/1"')
    .replace('Sentry.init({', 'Sentry.init({ transport: () => globalThis.__testTransport,');
  await writeFile(join(folder, 'config.mjs'), config);
  await writeFile(join(folder, 'probe.mjs'), `
    const captured = [];
    globalThis.__testTransport = {send: async envelope => {captured.push(envelope);return {statusCode:200}},flush:async()=>true};
    await import('./config.mjs');
    const Sentry = await import('@sentry/node');
    const {createServer} = await import('node:http');
    const server = createServer((req,res)=>{res.end('{"ok":true}')});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const {randomUUID} = await import('node:crypto');
    const secret = '9172345:'+randomUUID().replaceAll('-','');
    const querySecret=randomUUID(); const authSecret=randomUUID();
    const url = 'http://127.0.0.1:'+server.address().port+'/bot'+secret+'/sendMessage?api_key='+querySecret;
    await Sentry.startSpan({name:'provider test',op:'test'},async()=>{await fetch(url)});
    Sentry.captureException(new Error('controlled failure at '+url), {extra:{requestId:'safe-request-42',authorization:'Bearer '+authSecret}});
    await Sentry.flush(3000);
    const encoded=JSON.stringify(captured);
    const failed=[secret,querySecret,authSecret].filter(s=>encoded.includes(s)).length;
    const locations=[];function scan(v,p='envelope'){if(typeof v==='string'){[secret,querySecret,authSecret].forEach((s,i)=>{if(v.includes(s))locations.push(p+':canary-'+i)})}else if(v&&typeof v==='object')for(const[k,val]of Object.entries(v))scan(val,p+'.'+k)}scan(captured);
    const result={locations,tracing:process.env.SENTRY_TRACES_SAMPLE_RATE,envelopes:captured.length,secretCount:failed,requestIdPreserved:encoded.includes('safe-request-42'),externalTransport:false};
    console.log(JSON.stringify(result));
    await new Promise(r=>server.close(r));await Sentry.close(1000);
    if(failed||!result.requestIdPreserved||!captured.length)process.exitCode=1;
  `);
  let failure = false;
  for (const rate of ['0', '1']) {
    const result = spawnSync(process.execPath, [join(folder, 'probe.mjs')], {
      cwd: folder, encoding:'utf8', timeout:20000,
      env: {PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',SENTRY_TRACES_SAMPLE_RATE:rate,AURORA_SENTRY_DISABLED:'0'},
    });
    process.stdout.write(result.stdout || '');
    // SDK diagnostics contain no real data; never emit the envelopes themselves.
    if(result.status!==0){failure=true;process.stderr.write(result.stderr||String(result.error||''));}
  }
  if(failure)process.exitCode=1;
} finally { await rm(folder,{recursive:true,force:true}); }

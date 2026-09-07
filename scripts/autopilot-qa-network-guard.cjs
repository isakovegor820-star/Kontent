// Test runtime only: no HTTP provider call can leave loopback, including worker children.
const http = require('node:http');
const https = require('node:https');
const { syncBuiltinESMExports } = require('node:module');
const local = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function assertLocal(input, options) {
  let hostname;
  if (typeof input === 'string' || input instanceof URL) hostname = new URL(String(input)).hostname;
  else hostname = input?.hostname || input?.host || 'localhost';
  if (options?.hostname || options?.host) hostname = options.hostname || options.host;
  if (!local.has(hostname)) throw new Error('QA runtime blocks non-loopback provider requests');
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function(input, options) {
  assertLocal(typeof input === 'string' || input instanceof URL ? input : input.url);
  return originalFetch(input, options);
};
for (const mod of [http, https]) {
  const request = mod.request;
  mod.request = function(input, ...args) { assertLocal(input, typeof args[0] === 'object' ? args[0] : null); return request.call(this, input, ...args); };
  mod.get = function(input, ...args) { const req = mod.request(input, ...args); req.end(); return req; };
}
syncBuiltinESMExports();

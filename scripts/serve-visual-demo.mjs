import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createStaticServer } from '../server.mjs';

const directory = process.env.NEVERHOOD_DEMO_DIR;
assert(directory && directory === resolve(directory), 'Set NEVERHOOD_DEMO_DIR to the new private release');
const port = Number(process.env.PORT ?? 4204);
assert(Number.isInteger(port) && port > 1024 && port <= 65535);
const origin = `http://127.0.0.1:${port}`;
const manifestURL = process.env.NEVERHOOD_DEMO_MANIFEST_URL ?? `${origin}/__private-demo/manifest.json`;
assert.equal(manifestURL, `${origin}/__private-demo/manifest.json`, 'Local release URL only');
const server = createStaticServer({ privateDemoDir: directory });
const [staticRequest] = server.listeners('request');
server.removeAllListeners('request');
server.on('request', (request, response) => {
  // Local launcher opt-in only; server.mjs and the published config stay untouched.
  if (request.url === '/hd-demo/config.json' && ['GET', 'HEAD'].includes(request.method)) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, manifestURL }) + '\n');
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': bytes.length });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } else staticRequest(request, response);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Local visual demo: ${origin}/hd-demo/`));

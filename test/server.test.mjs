import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStaticServer } from '../server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'neverhood-server-'));
  const web = join(root, 'web');
  await mkdir(join(web, 'public/runtime'), { recursive: true });
  await mkdir(join(web, 'public/extractor'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<title>Neverhood</title>');
  await writeFile(join(web, 'public/runtime/scummvm.wasm'), '0123456789');
  await writeFile(join(web, 'public/extractor/innoextract.wasm'), 'extractor');
  await writeFile(join(root, 'private.txt'), 'PRIVATE');
  await writeFile(join(web, 'a.blb'), 'PRIVATE GAME DATA');
  await symlink(join(root, 'private.txt'), join(web, 'leak.txt'));
  const server = createStaticServer({ webRoot: web });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('serves app and runtime with correct MIME and isolation headers', async t => {
  const base = await fixture(t);
  const app = await fetch(base);
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type'), /text\/html/);
  assert.equal(app.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(app.headers.get('cross-origin-embedder-policy'), 'require-corp');
  const wasm = await fetch(`${base}/runtime/scummvm.wasm`);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.equal(await wasm.text(), '0123456789');
  const extractor = await fetch(`${base}/extractor/innoextract.wasm`);
  assert.equal(extractor.status, 200);
  assert.equal(extractor.headers.get('content-type'), 'application/wasm');
  assert.equal(await extractor.text(), 'extractor');
});

test('does not expose private files, symlinks, game archives or directory listings', async t => {
  const base = await fixture(t);
  for (const path of ['/private.txt', '/%2e%2e%2fprivate.txt', '/original%20game/setup.exe', '/leak.txt', '/a.blb', '/public/']) {
    const response = await fetch(base + path);
    assert.ok([403, 404].includes(response.status), `${path}: ${response.status}`);
    assert.doesNotMatch(await response.text(), /PRIVATE/);
  }
});

test('supports HEAD and byte ranges for runtime files', async t => {
  const base = await fixture(t);
  const head = await fetch(`${base}/runtime/scummvm.wasm`, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  const partial = await fetch(`${base}/runtime/scummvm.wasm`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');
  const suffix = await fetch(`${base}/runtime/scummvm.wasm`, { headers: { Range: 'bytes=-3' } });
  assert.equal(await suffix.text(), '789');
  for (const range of ['bytes=100-', 'bytes=4-1', 'bytes=-', 'bytes=-0', 'bytes=1-2,4-5']) {
    assert.equal((await fetch(`${base}/runtime/scummvm.wasm`, { headers: { Range: range } })).status, 416);
  }
});

test('rejects uploads and malformed paths', async t => {
  const base = await fixture(t);
  assert.equal((await fetch(base, { method: 'POST', body: 'do not store' })).status, 405);
  for (const path of ['/%ZZ', '/%00', '/%5cprivate.txt']) {
    assert.equal((await fetch(base + path)).status, 400);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticServer } from '../server.mjs';

const prefix = '/__private-room-pack/';
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neverhood-private-pack-'));
  const web = join(root, 'web'), pack = join(root, 'private-pack'), pack2 = join(root, 'private-pack2');
  await mkdir(web); await mkdir(join(pack, 'sprites'), { recursive: true });
  await mkdir(join(pack2, 'sprites'), { recursive: true });
  await writeFile(join(web, 'index.html'), 'public app');
  const png = Buffer.alloc(33);
  [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, 4, 4].forEach((value, index) => png.writeUInt32BE(value, index * 4));
  const manifest = { version: 1, private: true, room: 'Scene1001', scale: 4, runtimeSHA256: 'a'.repeat(64),
    sourceBinding: 'test catalog', backgrounds: [], entries: [{ key: '1x1-1-12345678-p12345678-0',
      file: 'sprites/one.png', sha256: createHash('sha256').update(png).digest('hex'), width: 4, height: 4,
      scale: 4, kind: 'sprite', sourceSHA256: 'b'.repeat(64), resource: 'test', frameId: 0 }] };
  await writeFile(join(pack, 'room-pack.json'), JSON.stringify(manifest));
  await writeFile(join(pack, 'sprites/one.png'), png);
  for (const name of ['unlisted.png', 'source.blb', 'database.json', 'source.dat']) await writeFile(join(pack, name), 'PRIVATE');
  const manifest2 = structuredClone(manifest);
  manifest2.room = 'Scene1002'; manifest2.entries[0].file = 'sprites/two.png';
  await writeFile(join(pack2, 'room-pack.json'), JSON.stringify(manifest2));
  await writeFile(join(pack2, 'sprites/two.png'), png);
  if (options.prepare) await options.prepare({ root, web, pack, pack2, manifest, manifest2 });
  const server = createStaticServer({ webRoot: web, privateRoomPackDir: options.useEnvironment ? undefined : options.enabled === false ? '' :
    options.directory ? options.directory({ root, web, pack }) : pack,
    privateRoom2PackDir: options.room2Environment ? undefined : options.room2Directory ? options.room2Directory({ root, web, pack2 }) : options.room2 ? pack2 : '',
    bundlesInPublic: options.bundlesInPublic ?? true });
  server.listen(0, options.host || '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true }); });
  return { root, web, pack, pack2, manifest, manifest2, server, base: `http://127.0.0.1:${server.address().port}` };
}
function raw(base, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(base + '/', { path, headers, method }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }); req.on('error', reject); req.end();
  });
}

test('private route is absent without opt-in and in dist preview', async t => {
  const old = process.env.NEVERHOOD_ROOM_PACK_DIR;
  delete process.env.NEVERHOOD_ROOM_PACK_DIR;
  t.after(() => { if (old === undefined) delete process.env.NEVERHOOD_ROOM_PACK_DIR; else process.env.NEVERHOOD_ROOM_PACK_DIR = old; });
  for (const options of [{ useEnvironment: true }, { enabled: false }, { bundlesInPublic: false }]) {
    const { base } = await fixture(t, options);
    assert.equal((await fetch(base + prefix + 'room-pack.json')).status, 404);
    assert.equal((await fetch(base + prefix + 'sprites/one.png')).status, 404);
  }
});

test('private route rejects a nonloopback remote peer even with loopback Host', async t => {
  const remote = Object.values(networkInterfaces()).flat().find(value => value.family === 'IPv4' && !value.internal)?.address;
  if (!remote) { t.skip('No nonloopback interface available'); return; }
  const { server } = await fixture(t, { host: '0.0.0.0' });
  const port = server.address().port;
  const response = await raw(`http://${remote}:${port}`, prefix + 'room-pack.json', { Host: `127.0.0.1:${port}` });
  assert.equal(response.status, 403);
});

test('private route serves only validated manifest PNG references with no CORS or caching', async t => {
  const { base, manifest } = await fixture(t);
  const response = await fetch(base + prefix + 'room-pack.json');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), manifest);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const image = await fetch(base + prefix + 'sprites/one.png');
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal((await image.arrayBuffer()).byteLength, 33);
  const head = await fetch(base + prefix + 'sprites/one.png', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const path of ['unlisted.png', 'source.blb', 'database.json', 'source.dat', '', 'sprites/', '../private-pack/room-pack.json']) {
    assert.notEqual((await raw(base, prefix + path)).status, 200, path);
  }
  for (const path of ['/private-pack/room-pack.json', '/sprites/one.png', '/room-pack.json']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal(await (await fetch(base)).text(), 'public app');
  assert.equal((await raw(base, prefix + 'room-pack.json', {}, 'POST')).status, 405);
});

test('private v2 WebP resources retain whitelist, header, origin and no-store defenses', async t => {
  let image;
  const { base } = await fixture(t, { prepare: async ({ pack, manifest }) => {
    const bytes = Buffer.alloc(30);
    bytes.write('RIFF'); bytes.writeUInt32LE(22, 4); bytes.write('WEBPVP8X', 8); bytes.writeUInt32LE(10, 16);
    bytes[24] = bytes[27] = 1;
    image = { id: 'd'.repeat(64), file: 'shared.webp', format: 'webp', width: 2, height: 2,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    const { file, sha256, ...entry } = manifest.entries[0];
    manifest.version = 2; manifest.images = [image];
    manifest.entries = [{ ...entry, image: image.id, crop: { x: 1, y: 1, width: 2, height: 2 }, flipX: true }];
    await writeFile(join(pack, 'room-pack.json'), JSON.stringify(manifest));
    await writeFile(join(pack, image.file), bytes);
  } });
  const response = await fetch(base + prefix + image.file);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await fetch(base + prefix + 'sprites/one.png')).status, 404);
  assert.equal((await raw(base, prefix + image.file, { Origin: 'https://foreign.example' })).status, 403);
});

test('private route blocks DNS rebinding, foreign origins, encoded separators and traversal', async t => {
  const { base } = await fixture(t), host = new URL(base).host;
  for (const headers of [{ Host: 'attacker.example' }, { Host: '127.0.0.1.attacker.example' },
    { Host: '[::1]' }, { Origin: 'https://attacker.example' }, { Origin: 'null' },
    { Origin: 'http://localhost:1234' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await raw(base, prefix + 'room-pack.json', headers)).status, 403);
  }
  assert.equal((await raw(base, prefix + 'room-pack.json', { Origin: `http://${host}` })).status, 200);
  for (const path of ['sprites%2fone.png', 'sprites%5cone.png', 'sprites/%2e%2e/room-pack.json',
    'sprites/../room-pack.json', 'sprites//one.png', 'sprites/one.png?x', '%252e%252e/source.blb']) {
    assert.equal((await raw(base, prefix + path)).status, 403, path);
  }
});

test('private route refuses invalid manifests, public roots, symlink roots and symlink components', async t => {
  const cases = [
    { prepare: async ({ pack, manifest }) => { manifest.entries[0].file = '../source.blb';
      await writeFile(join(pack, 'room-pack.json'), JSON.stringify(manifest)); } },
    { directory: ({ web }) => web },
    { prepare: async ({ root, pack }) => symlink(pack, join(root, 'alias')), directory: ({ root }) => join(root, 'alias') },
    { prepare: async ({ root, pack }) => symlink(pack, join(root, 'alias')), directory: ({ root }) => `${root}/alias/../private-pack` },
    { prepare: async ({ pack }) => { await rm(join(pack, 'sprites/one.png')); await symlink('../unlisted.png', join(pack, 'sprites/one.png')); } },
    { prepare: async ({ root, pack }) => { await mkdir(join(root, 'images')); await rm(join(pack, 'sprites'), { recursive: true });
      await symlink(join(root, 'images'), join(pack, 'sprites')); } },
    { prepare: async ({ pack }) => { await rm(join(pack, 'room-pack.json')); await symlink('database.json', join(pack, 'room-pack.json')); } },
    { prepare: async ({ pack }) => writeFile(join(pack, 'sprites/one.png'), 'not PNG') }
  ];
  for (const options of cases) {
    const { base } = await fixture(t, options);
    const response = await fetch(base + prefix + 'sprites/one.png');
    assert.notEqual(response.status, 200); assert.doesNotMatch(await response.text(), /PRIVATE/);
  }
});

test('private whitelist follows manifest replacement and in-place changes without restarting', async t => {
  const { base, pack, manifest } = await fixture(t);
  const get = file => fetch(base + prefix + file);
  assert.equal((await get('sprites/one.png')).status, 200);
  assert.equal((await get('sprites/two.png')).status, 404);
  await copyFile(join(pack, 'sprites/one.png'), join(pack, 'sprites/two.png'));
  manifest.entries[0].file = 'sprites/two.png';
  await writeFile(join(pack, 'replacement.json'), JSON.stringify(manifest));
  await rename(join(pack, 'replacement.json'), join(pack, 'room-pack.json'));
  assert.equal((await get('sprites/one.png')).status, 404, 'old referenced file must not remain allowed');
  assert.equal((await get('sprites/two.png')).status, 200);
  assert.equal((await (await get('room-pack.json')).json()).entries[0].file, 'sprites/two.png');
  await writeFile(join(pack, 'room-pack.json'), '{invalid');
  assert.notEqual((await get('sprites/two.png')).status, 200, 'invalid new manifest must not reuse old whitelist');
  manifest.entries = [];
  await writeFile(join(pack, 'room-pack.json'), JSON.stringify(manifest));
  assert.equal((await get('sprites/two.png')).status, 404);
  assert.deepEqual((await (await get('room-pack.json')).json()).entries, []);
  await rm(join(pack, 'room-pack.json'));
  await symlink('database.json', join(pack, 'room-pack.json'));
  assert.notEqual((await get('room-pack.json')).status, 200, 'cached manifest does not bypass symlink guards');
});

test('second prefix has an isolated catalog and whitelist, including independent invalidation', async t => {
  const { base, pack2, manifest2 } = await fixture(t, { room2: true });
  const second = prefix + 'room2/';
  assert.equal((await (await fetch(base + prefix + 'room-pack.json')).json()).room, 'Scene1001');
  assert.deepEqual(await (await fetch(base + second + 'room-pack.json')).json(), manifest2);
  assert.equal((await fetch(base + second + 'sprites/two.png')).status, 200);
  assert.equal((await fetch(base + prefix + 'sprites/one.png')).status, 200);
  for (const path of [prefix + 'sprites/two.png', second + 'sprites/one.png', prefix + 'private-pack2/sprites/two.png']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  for (const path of ['../sprites/one.png', '%2e%2e/sprites/one.png', 'sprites%2ftwo.png', 'sprites/two.png?x']) {
    assert.equal((await raw(base, second + path)).status, 403, path);
  }
  for (const headers of [{ Host: 'attacker.example' }, { Origin: 'http://localhost:9999' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await raw(base, second + 'room-pack.json', headers)).status, 403);
  }
  await writeFile(join(pack2, 'room-pack.json'), '{invalid');
  assert.notEqual((await fetch(base + second + 'sprites/two.png')).status, 200);
  assert.equal((await fetch(base + prefix + 'sprites/one.png')).status, 200);
  manifest2.entries = [];
  await writeFile(join(pack2, 'room-pack.json'), JSON.stringify(manifest2));
  assert.equal((await fetch(base + second + 'sprites/two.png')).status, 404);
});

test('second prefix independently fails closed without configuration, in dist, or on wrong-room manifests', async t => {
  const old = process.env.NEVERHOOD_ROOM2_PACK_DIR;
  delete process.env.NEVERHOOD_ROOM2_PACK_DIR;
  t.after(() => { if (old === undefined) delete process.env.NEVERHOOD_ROOM2_PACK_DIR; else process.env.NEVERHOOD_ROOM2_PACK_DIR = old; });
  for (const options of [{}, { room2Environment: true }, { room2: true, bundlesInPublic: false },
    { room2: true, prepare: async ({ pack2, manifest2 }) => {
      manifest2.room = 'Scene1001'; await writeFile(join(pack2, 'room-pack.json'), JSON.stringify(manifest2));
    } }]) {
    const { base } = await fixture(t, options);
    assert.notEqual((await fetch(base + prefix + 'room2/room-pack.json')).status, 200);
    assert.notEqual((await fetch(base + prefix + 'room2/sprites/two.png')).status, 200);
  }
});

test('second root uses the same public-tree, root, manifest and image symlink guards', async t => {
  const cases = [
    { room2Directory: ({ web }) => web },
    { prepare: async ({ root, pack2 }) => symlink(pack2, join(root, 'alias2')), room2Directory: ({ root }) => join(root, 'alias2') },
    { prepare: async ({ pack2 }) => { await rename(join(pack2, 'room-pack.json'), join(pack2, 'manifest.json'));
      await symlink('manifest.json', join(pack2, 'room-pack.json')); } },
    { prepare: async ({ pack2 }) => { await rename(join(pack2, 'sprites/two.png'), join(pack2, 'image.png'));
      await symlink('../image.png', join(pack2, 'sprites/two.png')); } },
    { prepare: async ({ root, pack2 }) => { await rename(join(pack2, 'sprites'), join(root, 'images2'));
      await symlink(join(root, 'images2'), join(pack2, 'sprites')); } }
  ];
  for (const options of cases) {
    const { base } = await fixture(t, { room2: true, ...options });
    assert.notEqual((await fetch(base + prefix + 'room2/sprites/two.png')).status, 200);
    assert.equal((await fetch(base + prefix + 'sprites/one.png')).status, 200);
  }
});

test('second private route rejects nonloopback remote peers', async t => {
  const remote = Object.values(networkInterfaces()).flat().find(value => value.family === 'IPv4' && !value.internal)?.address;
  if (!remote) { t.skip('No nonloopback interface available'); return; }
  const { server } = await fixture(t, { room2: true, host: '0.0.0.0' });
  const port = server.address().port;
  assert.equal((await raw(`http://${remote}:${port}`, prefix + 'room2/room-pack.json', { Host: `127.0.0.1:${port}` })).status, 403);
});

test('second directory can be configured by environment without enabling the legacy directory', async t => {
  const old = process.env.NEVERHOOD_ROOM2_PACK_DIR;
  t.after(() => { if (old === undefined) delete process.env.NEVERHOOD_ROOM2_PACK_DIR; else process.env.NEVERHOOD_ROOM2_PACK_DIR = old; });
  const { base } = await fixture(t, { enabled: false, room2Environment: true,
    prepare: async ({ pack2 }) => { process.env.NEVERHOOD_ROOM2_PACK_DIR = pack2; } });
  assert.equal((await fetch(base + prefix + 'room2/room-pack.json')).status, 200);
  assert.equal((await fetch(base + prefix + 'room2/sprites/two.png')).status, 200);
  assert.equal((await fetch(base + prefix + 'room-pack.json')).status, 404);
  assert.equal((await fetch(base + prefix + 'sprites/two.png')).status, 404);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildSite, RUNTIME_LICENSES } from '../scripts/build-site.mjs';
import { createStaticServer } from '../server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'neverhood-build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = async (name, data = 'fixture') => {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), data);
  };
  for (const name of ['app.js', 'styles.css', 'player.html', 'player.js', 'lib/app.js', 'data/index.json', 'vendor/fflate-0.8.2.js', 'vendor/fflate-LICENSE', 'vendor/fflate-provenance.json', 'assets/fonts/Mansalva-Regular.ttf', 'assets/fonts/OFL.txt', 'assets/fonts/provenance.json']) await file(`web/${name}`);
  await file('web/index.html', '<html><aside><a data-source-link href="https://github.com/mihmosh/neverhood_online">Source &amp; licenses</a></aside><footer>Local game client</footer></html>');
  await file('web/public/runtime/runtime.json', JSON.stringify({ available: true, api: 'emscripten-global-module', engine: 'neverhood', module: 'scummvm.js', wasm: 'scummvm.wasm', engineData: ['neverhood.dat'], sourceRevision: 'a'.repeat(40) }));
  for (const name of ['scummvm.js', 'neverhood.dat', 'COPYING', 'COPYRIGHT', 'AUTHORS', ...RUNTIME_LICENSES.map(name => `LICENSES/${name}`)]) await file(`web/public/runtime/${name}`);
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  await file('web/public/runtime/scummvm.wasm', wasm);
  await file('web/public/extractor/extractor.json', JSON.stringify({ available: true, api: 'emscripten-modularize', factory: 'createInnoextract', module: 'innoextract.js', wasm: 'innoextract.wasm', version: '1.9', licenses: ['LICENSE.txt'] }));
  await file('web/public/extractor/innoextract.js');
  await file('web/public/extractor/innoextract.wasm', wasm);
  await file('web/public/extractor/LICENSE.txt');
  const source = Buffer.from('Source and rebuild instructions fixture');
  await file('web/public/sources/README.txt', source);
  const binaries = [];
  for (const name of ['runtime/scummvm.js', 'runtime/scummvm.wasm', 'runtime/neverhood.dat', 'extractor/innoextract.js', 'extractor/innoextract.wasm']) {
    const data = await readFile(join(root, 'web/public', name));
    binaries.push({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  await file('web/public/sources/manifest.json', JSON.stringify({ version: 1, runtimeRevision: 'a'.repeat(40), extractorVersion: '1.9', files: [{ name: 'README.txt', bytes: source.length, sha256: createHash('sha256').update(source).digest('hex') }], binaries }));
  for (const name of ['original game/setup.exe', 'extracted/a.blb', 'server.mjs', 'web/test/private.js', 'web/package.json', 'web/public/runtime/a.blb', 'web/public/extractor/setup.exe', 'web/public/runtime/LICENSES/.env', 'web/lib/.env']) await file(name, 'PRIVATE');
  return { root, file };
}

test('static packaging flattens artifact URLs and excludes private and development files', async t => {
  const { root } = await fixture(t);
  const out = await buildSite({ root });
  const names = [];
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${prefix}${entry.name}/`);
      else names.push(prefix + entry.name);
    }
  }
  await walk(out);
  assert.ok(names.includes('runtime/scummvm.wasm'));
  assert.ok(names.includes('extractor/innoextract.wasm'));
  assert.ok(names.includes('runtime/LICENSES/SDL.txt'));
  assert.ok(names.includes('lib/app.js'));
  assert.ok(names.includes('assets/fonts/Mansalva-Regular.ttf'));
  assert.ok(names.includes('assets/fonts/OFL.txt'));
  assert.ok(!names.some(name => /(^|\/)(public|test|original game|extracted)\/|server\.mjs|\.env|\.exe$|\.blb$|package\.json/.test(name)));
  assert.equal(JSON.parse(await readFile(join(out, 'sources.json'), 'utf8')).sourceDistributionConfigured, true);
  assert.equal(JSON.parse(await readFile(join(out, 'sources.json'), 'utf8')).correspondingSource, '/sources/manifest.json');
  assert.ok(names.includes('sources/README.txt'));
  assert.ok(names.includes('sources/index.html'));
  assert.match(await readFile(join(out, 'index.html'), 'utf8'), /href="\/sources\/index.html"/);
  assert.equal((await readFile(join(out, 'index.html'), 'utf8')).match(/data-source-link/g).length, 1);
});

test('missing or invalid artifacts fail before replacing an existing static build', async t => {
  const { root, file } = await fixture(t);
  await buildSite({ root });
  const previous = await readFile(join(root, 'dist/index.html'), 'utf8');
  await file('web/public/runtime/scummvm.wasm', 'invalid wasm');
  await assert.rejects(buildSite({ root }), /Invalid runtime WebAssembly/);
  assert.equal(await readFile(join(root, 'dist/index.html'), 'utf8'), previous);
  await rm(join(root, 'web/public/extractor/innoextract.wasm'));
  await file('web/public/runtime/scummvm.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await assert.rejects(buildSite({ root }), /npm run build:extractor/);
});

test('bundled sources must match artifact revisions, sizes and SHA-256 without environment setup', async t => {
  const { root, file } = await fixture(t);
  const original = JSON.parse(await readFile(join(root, 'web/public/sources/manifest.json'), 'utf8'));
  for (const [manifest, error] of [
    [{ ...original, runtimeRevision: 'b'.repeat(40) }, /does not match/],
    [{ ...original, files: [{ ...original.files[0], bytes: original.files[0].bytes + 1 }] }, /size mismatch/],
    [{ ...original, files: [{ ...original.files[0], sha256: '0'.repeat(64) }] }, /checksum mismatch/],
    [{ ...original, files: [{ ...original.files[0], name: '../private.txt' }] }, /Invalid corresponding-source/],
    [{ ...original, files: [original.files[0], original.files[0]] }, /Invalid corresponding-source/],
  ]) {
    await file('web/public/sources/manifest.json', JSON.stringify(manifest));
    await assert.rejects(buildSite({ root }), error);
  }
  await rm(join(root, 'web/public/sources/manifest.json'));
  await assert.rejects(buildSite({ root }), /manifest.json/);
});

test('static packaging rejects source symlinks', async t => {
  const { root, file } = await fixture(t);
  await file('private.txt', 'PRIVATE');
  await rm(join(root, 'web/app.js'));
  await symlink(join(root, 'private.txt'), join(root, 'web/app.js'));
  await assert.rejects(buildSite({ root }), /regular public file/);
});

test('changed compiled artifacts require regenerating their corresponding-source bindings', async t => {
  const { root, file } = await fixture(t);
  await file('web/public/runtime/scummvm.js', 'changed');
  await assert.rejects(buildSite({ root }), /Compiled artifact does not match/);
});

test('packaged output serves as static files without exposing the Node server or catch-all HTML', async t => {
  const { root } = await fixture(t);
  const webRoot = await buildSite({ root });
  const server = createStaticServer({ webRoot, bundlesInPublic: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin)).status, 200);
  for (const name of ['runtime/scummvm.wasm', 'extractor/innoextract.wasm']) {
    const response = await fetch(`${origin}/${name}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/wasm');
  }
  assert.equal((await fetch(`${origin}/assets/fonts/Mansalva-Regular.ttf`)).headers.get('content-type'), 'font/ttf');
  for (const name of ['server.mjs', 'api', 'missing.wasm', 'original%20game/setup.exe']) assert.equal((await fetch(`${origin}/${name}`)).status, 404);
  const sourceMetadata = await (await fetch(`${origin}/sources/manifest.json`)).json();
  assert.equal(sourceMetadata.files[0].name, 'README.txt');
  assert.equal((await fetch(`${origin}/sources/README.txt`)).status, 200);
});

test('Vercel uses the static output directory and sets worker isolation headers', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.framework, null);
  assert.equal(config.buildCommand, 'npm run build');
  assert.equal(config.outputDirectory, 'dist');
  assert.equal(config.functions, undefined);
  assert.equal(config.rewrites, undefined);
  const headers = config.headers.find(rule => rule.source === '/(.*)').headers;
  assert.ok(headers.some(header => header.key === 'Cross-Origin-Opener-Policy' && header.value === 'same-origin'));
  assert.ok(headers.some(header => header.key === 'Cross-Origin-Embedder-Policy' && header.value === 'require-corp'));
});

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { demoAddress } from '../web/lib/demo-data.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = ['index.html', 'app.js', 'styles.css', 'player.html', 'player.js', 'data/index.json',
  'hd-demo/index.html', 'hd-demo/demo.css', 'hd-demo/demo.js', 'hd-demo/config.json'];
const prototype = ['compositor.js', 'read-frame.js', 'room1.js', 'replacement-pack.js', 'render-abi.json', 'demo-cursor.js', 'room-archive.js', 'room-archive-cache.js'];
const bundles = {
  runtime: ['runtime.json', 'scummvm.js', 'scummvm.wasm', 'neverhood.dat', 'COPYING', 'COPYRIGHT', 'AUTHORS'],
  extractor: ['extractor.json', 'innoextract.js', 'innoextract.wasm'],
};
export const RUNTIME_LICENSES = Object.freeze(['CatharonLicense.txt', 'SDL.txt', ...['Apache', 'BSD', 'BSL', 'GLAD', 'ISC', 'LGPL', 'LUA', 'MIT', 'MKV', 'MPL', 'OFL', 'TINYGL'].map(name => `COPYING.${name}`)]);

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular public file: ${path}`);
}

async function readDescriptor(root, bundle) {
  const directory = join(root, 'web/public', bundle);
  try {
    for (const file of bundles[bundle]) await regularFile(join(directory, file));
    const descriptor = JSON.parse(await readFile(join(directory, bundles[bundle][0]), 'utf8'));
    if (!descriptor.available || (bundle === 'runtime'
      ? descriptor.api !== 'emscripten-global-module' || descriptor.engine !== 'neverhood' || descriptor.module !== 'scummvm.js' || descriptor.wasm !== 'scummvm.wasm' || JSON.stringify(descriptor.engineData) !== '["neverhood.dat"]'
      : descriptor.api !== 'emscripten-modularize' || descriptor.factory !== 'createInnoextract' || descriptor.module !== 'innoextract.js' || descriptor.wasm !== 'innoextract.wasm')) {
      throw new Error(`Incompatible ${bundle} descriptor`);
    }
    if (!WebAssembly.validate(await readFile(join(directory, descriptor.wasm)))) throw new Error(`Invalid ${bundle} WebAssembly`);
    return descriptor;
  } catch (error) {
    throw new Error(`Cannot package ${bundle}. Run npm run build:${bundle === 'runtime' ? 'runtime' : 'extractor'} or supply the verified build artifacts first. ${error.message}`, { cause: error });
  }
}

async function verifySources(root, runtime, extractor, demo) {
  const directory = join(root, 'web/public/sources');
  const manifestPath = join(directory, 'manifest.json');
  await regularFile(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || manifest.runtimeRevision !== runtime.sourceRevision || manifest.extractorVersion !== extractor.version || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100) {
    throw new Error('The bundled source manifest does not match these runtime/extractor artifacts. Run npm run package:sources.');
  }
  const names = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(entry.name) || entry.name === 'manifest.json' || names.has(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 32 * 1024 ** 2 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid corresponding-source file entry.');
    names.add(entry.name);
    const path = join(directory, entry.name);
    await regularFile(path);
    const info = await lstat(path);
    if (info.size !== entry.bytes) throw new Error(`Corresponding-source size mismatch: ${entry.name}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== entry.sha256) throw new Error(`Corresponding-source checksum mismatch: ${entry.name}`);
  }
  const binaries = new Set(['runtime/scummvm.js', 'runtime/scummvm.wasm', 'runtime/neverhood.dat', 'extractor/innoextract.js', 'extractor/innoextract.wasm']);
  if (demo) for (const name of ['scummvm.js', 'scummvm.wasm', 'neverhood.dat']) binaries.add(`demo-runtime/${name}`);
  if (!Array.isArray(manifest.binaries) || manifest.binaries.length !== binaries.size) throw new Error('Missing exact source-to-binary bindings. Run npm run package:sources.');
  for (const entry of manifest.binaries) {
    if (!binaries.delete(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid source-to-binary binding.');
    const path = join(root, 'web/public', entry.name);
    await regularFile(path);
    const data = await readFile(path);
    if (data.length !== entry.bytes || createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error(`Compiled artifact does not match the supplied source bundle: ${entry.name}`);
  }
  return manifest;
}

export async function buildSite({ root = project, demoManifestURL = process.env.NEVERHOOD_DEMO_MANIFEST_URL } = {}) {
  const runtime = await readDescriptor(root, 'runtime');
  const extractor = await readDescriptor(root, 'extractor');
  let demo;
  try { demo = JSON.parse(await readFile(join(root, 'web/public/demo-runtime/runtime.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (demo) {
    const wasm = await readFile(join(root, 'web/public/demo-runtime/scummvm.wasm'));
    const sourceWasm = await readFile(join(root, 'web/public/runtime/scummvm.wasm'));
    const abi = JSON.parse(await readFile(join(root, 'web/public/demo-runtime/render-abi.json'), 'utf8'));
    if (!demo.demo || demo.sourceRevision !== runtime.sourceRevision || demo.module !== 'scummvm.js' || demo.wasm !== 'scummvm.wasm' ||
        demo.abi !== 'render-abi.json' || JSON.stringify(demo.engineData) !== '["neverhood.dat"]' || !WebAssembly.validate(wasm) ||
        demo.sourceRuntimeSHA256 !== createHash('sha256').update(sourceWasm).digest('hex') ||
        createHash('sha256').update(wasm).digest('hex') !== demo.wasmSHA256 || abi.wasmSHA256 !== demo.wasmSHA256) throw new Error('Invalid bounded demo runtime artifacts.');
  }
  const sources = await verifySources(root, runtime, extractor, demo);
  if (demoManifestURL && (!demo || demoAddress(demoManifestURL, undefined).protocol !== 'https:')) throw new Error('Published demo requires HTTPS assets and a verified demo runtime.');
  if (!Array.isArray(extractor.licenses) || !extractor.licenses.length || extractor.licenses.some(name => !/^[A-Za-z0-9_.-]+\.txt$/.test(name))) throw new Error('Invalid extractor license list');
  const stage = join(root, `.site-build-${randomUUID()}`);
  const web = join(root, 'web');
  const copy = async (source, relative) => {
    await regularFile(source);
    const destination = join(stage, relative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  };
  try {
    await mkdir(stage);
    for (const file of frontend) await copy(join(web, file), file);
    if (demoManifestURL) await writeFile(join(stage, 'hd-demo/config.json'), JSON.stringify({ version: 1, manifestURL: demoManifestURL }) + '\n');
    for (const file of prototype) await copy(join(web, 'prototype', file), `prototype/${file}`);
    for (const entry of await readdir(join(web, 'lib'), { withFileTypes: true })) {
      if (entry.name.endsWith('.js')) await copy(join(web, 'lib', entry.name), `lib/${entry.name}`);
    }
    for (const file of ['fflate-0.8.2.js', 'fflate-LICENSE', 'fflate-provenance.json']) await copy(join(web, 'vendor', file), `vendor/${file}`);
    for (const file of ['Mansalva-Regular.ttf', 'OFL.txt', 'provenance.json']) await copy(join(web, 'assets/fonts', file), `assets/fonts/${file}`);
    for (const [bundle, files] of Object.entries(bundles)) {
      for (const file of files) await copy(join(web, 'public', bundle, file), `${bundle}/${file}`);
    }
    if (demo) {
      for (const file of [...bundles.runtime, 'render-abi.json']) await copy(join(web, 'public/demo-runtime', file), `demo-runtime/${file}`);
      for (const name of RUNTIME_LICENSES) await copy(join(web, 'public/runtime/LICENSES', name), `demo-runtime/LICENSES/${name}`);
    }
    for (const name of RUNTIME_LICENSES) await copy(join(web, 'public/runtime/LICENSES', name), `runtime/LICENSES/${name}`);
    for (const file of extractor.licenses) await copy(join(web, 'public/extractor', file), `extractor/${file}`);
    for (const file of ['manifest.json', ...sources.files.map(entry => entry.name)]) await copy(join(web, 'public/sources', file), `sources/${file}`);
    await writeFile(join(stage, 'sources/index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Source Code and Licenses</title><body><main><h1>Source Code and Licenses</h1><p>These downloads contain the matching open-source engine, extractor, dependencies and build materials. They contain no original game archives or installers.</p><p>Start with the README download for unpacking and rebuilding instructions. The manifest records versions, archive groups and checksums.</p><ul>${sources.files.map(file => `<li><a href="${file.name}">${file.name}</a> (${file.bytes} bytes)<br><code>SHA-256: ${file.sha256}</code></li>`).join('')}</ul><p><a href="https://github.com/mihmosh/neverhood_online">Project on GitHub</a> | <a href="manifest.json">Source manifest</a> | <a href="/runtime/COPYING">ScummVM license</a> | <a href="/vendor/fflate-LICENSE">ZIP decoder license</a> | <a href="/assets/fonts/OFL.txt">Menu typeface license</a> | <a href="/">Back to the game client</a></p></main></body></html>`);
    await writeFile(join(stage, 'sources.json'), JSON.stringify({
      correspondingSource: '/sources/manifest.json',
      sourceDistributionConfigured: true,
      runtimeRevision: runtime.sourceRevision,
      extractorVersion: extractor.version,
      note: 'Matching source archives, versions, hashes and rebuild instructions are served by this site without requiring repository access.',
    }, null, 2) + '\n');
    const index = await readFile(join(stage, 'index.html'), 'utf8');
    const sourceLink = 'data-source-link href="https://github.com/mihmosh/neverhood_online"';
    if (!index.includes(sourceLink)) throw new Error('The launcher is missing its single source-link location.');
    await writeFile(join(stage, 'index.html'), index.replace(sourceLink, 'data-source-link href="/sources/index.html"'));
    await rm(join(root, 'dist'), { recursive: true, force: true });
    await rename(stage, join(root, 'dist'));
    return join(root, 'dist');
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildSite().then(directory => console.log(`Packaged static site: ${directory}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

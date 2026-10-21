import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile, open } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARCHIVES, parseArchive } from '../tools/assets/catalog.mjs';
import { resolveResources } from './build-demo-data.mjs';
import { demoAddress, demoAssetURL, validateDemoManifest, DEMO_LIMITS } from '../web/lib/demo-data.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeSHA256 = '31bdb5fa1afcdf80a6895e2fe5c87a5a999a245af85de7326df20f0756e0d83c';

export async function verifyDemoVideos({ originals, release, fetcher = fetch }) {
  const url = demoAddress(release);
  assert.equal(url.protocol, 'https:', 'Use the public HTTPS release');
  const inventory = JSON.parse(await readFile(originals, 'utf8'));
  const releaseResponse = await fetcher(url, { signal: AbortSignal.timeout(120000) });
  assert(releaseResponse.ok && releaseResponse.body, 'Release manifest download failed');
  const chunks = []; let manifestBytes = 0;
  for await (const chunk of releaseResponse.body) {
    manifestBytes += chunk.byteLength;
    assert(manifestBytes <= DEMO_LIMITS.manifest, 'Oversized release manifest');
    chunks.push(chunk);
  }
  const manifest = validateDemoManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')), runtimeSHA256);
  assert.equal(manifest.fullGame, true, 'A bounded/nonvideo demo is not a complete video source');
  const archives = [], verified = [];
  let videoBytes = 0, physicalVideos = 0;
  const signatures = {};
  for (const name of ARCHIVES) {
    const source = inventory.files.find(file => file.relativePath === `DATA/${name}`);
    assert(source?.localPath, `Missing original archive: ${name}`);
    const archive = parseArchive(source.localPath);
    assert.equal(archive.sha256, source.sha256, `Original source hash mismatch: ${name}`);
    assert.equal(archive.size, source.bytes, `Original source length mismatch: ${name}`);
    archives.push(archive);
    const videos = archive.entries.filter(entry => entry.type === 10 && entry.compression !== 0x65);
    const handle = await open(source.localPath, 'r');
    try {
      for (const entry of videos) {
        assert(entry.diskSize >= 16 && entry.compression === 1, `Unexpected original video encoding: ${name}/${entry.index}`);
        const header = Buffer.alloc(16);
        assert.equal((await handle.read(header, 0, 16, entry.offset)).bytesRead, 16);
        const signature = header.toString('ascii', 0, 4);
        assert(/^SMK[24]$/.test(signature), `Invalid original Smacker header: ${name}/${entry.index}`);
        assert(header.readUInt32LE(4) > 0 && header.readUInt32LE(8) > 0 && header.readUInt32LE(12) > 0, 'Invalid original video dimensions/frames');
        signatures[signature] = (signatures[signature] ?? 0) + 1;
        videoBytes += entry.diskSize; physicalVideos++;
      }
    } finally { await handle.close(); }
    const entry = manifest.files.find(file => file.name === name);
    assert.equal(entry.sha256, source.sha256, `Release omits or changes original video data: ${name}`);
    assert.equal(entry.bytes, source.bytes, `Release has a stub/repacked archive: ${name}`);
    const response = await fetcher(demoAssetURL(entry.file, url), { signal: AbortSignal.timeout(300000) });
    assert.equal(response.status, 200, `Original archive download failed: ${name}`);
    assert(response.body, `Missing original archive body: ${name}`);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      assert(bytes <= entry.bytes, `Oversized original archive response: ${name}`);
      hash.update(chunk);
    }
    assert.equal(bytes, entry.bytes, `Truncated original archive response: ${name}`);
    assert.equal(hash.digest('hex'), entry.sha256, `Public archive hash mismatch: ${name}`);
    verified.push({ name, bytes, sha256: entry.sha256, physicalVideos: videos.length });
  }
  assert(physicalVideos > 0, 'No original Smacker videos found');
  const { winners } = resolveResources(archives);
  return { version: 1, release: url.href, verified: true, originalArchives: verified,
    originalBytes: verified.reduce((n, entry) => n + entry.bytes, 0), physicalVideoResources: physicalVideos,
    winningVideoResources: [...winners.values()].filter(entry => entry.type === 10).length,
    originalVideoPayloadBytes: videoBytes, signatures, transcoded: false, upscaled: false,
    scope: 'Every byte of all seven original BLBs verified over HTTPS. Original cutscene and navigation resources are retained together; this is not a full playthrough.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i++) {
      const name = { '--originals': 'originals', '--release': 'release', '--output': 'output' }[process.argv[i]];
      assert(name && process.argv[i + 1], 'Usage: verify-demo-videos.mjs --originals JSON --release HTTPS_URL [--output NEW_PRIVATE_JSON]');
      options[name] = process.argv[++i];
    }
    const report = await verifyDemoVideos(options);
    if (options.output) {
      const output = resolve(options.output), parent = await realpath(dirname(output));
      const within = relative(resolve(root, 'private-assets'), output);
      assert(within && !within.startsWith('..') && parent === dirname(output), 'Audit output must remain in an existing private directory');
      await lstat(parent);
      await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

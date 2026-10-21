import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStaticServer } from '../server.mjs';
import { REQUIRED_FILES } from '../web/lib/validation.js';
import { noSymlinks, RUNTIME_SHA256, sha256, BLOCK_SIZE, INDEX_LIMIT_BYTES } from './prepare-streaming-demo.mjs';

export const MAX_RANGE_BYTES = 1024 ** 2;
export const MAX_HD_RANGE_BYTES = 32 * 1024 ** 2;
export function permittedPeer(request) {
  const host = request.headers.host;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
    && typeof host === 'string' && /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)
    && (request.headers.origin === undefined || request.headers.origin === `http://${host}`)
    && (!request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(request.headers['sec-fetch-site']));
}

export function boundedRange(value, size, limit = MAX_RANGE_BYTES) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start
    && end < size && end - start + 1 <= limit && end - start + 1 < size ? { start, end } : null;
}

export async function createStreamingServer({ directory, webRoot } = {}) {
  await noSymlinks(directory);
  const load = async name => {
    const path = resolve(directory, name);
    await noSymlinks(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      assert(info.isFile() && info.size > 0 && info.size <= (name === 'streaming-index.json' ? INDEX_LIMIT_BYTES : 4 * 1024 ** 2), 'Metadata exceeds budget');
      const bytes = Buffer.alloc(info.size + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      assert.equal(bytesRead, info.size, 'Metadata changed');
      return bytes.subarray(0, bytesRead);
    } finally { await handle.close(); }
  };
  const manifestBytes = await load('manifest.json'), manifest = JSON.parse(manifestBytes);
  const indexBytes = await load('streaming-index.json'), index = JSON.parse(indexBytes);
  const local = JSON.parse(await load('streaming-local.json'));
  assert(manifest.runtimeSHA256 === RUNTIME_SHA256 && index.runtimeSHA256 === RUNTIME_SHA256, 'Runtime pin mismatch');
  assert(manifest.streaming?.version === 1 && manifest.streaming.index.file === 'streaming-index.json'
    && manifest.streaming.index.bytes === indexBytes.length && manifest.streaming.index.sha256 === sha256(indexBytes), 'Streaming index descriptor mismatch');
  assert(index.version === 1 && index.blockSize === BLOCK_SIZE && Object.keys(index.files).length === REQUIRED_FILES.length);
  await noSymlinks(local.baseDir);
  const baseManifestPath = resolve(local.baseDir, 'manifest.json');
  await noSymlinks(baseManifestPath);
  const base = JSON.parse(await readFile(baseManifestPath, 'utf8'));
  const { streaming, ...normalManifest } = manifest;
  normalManifest.packs = Object.fromEntries(Object.entries(manifest.packs).map(([room, pack]) => {
    const { streaming, ...normal } = pack;
    return [room, normal];
  }));
  assert.deepEqual(normalManifest, base, 'Streaming metadata must preserve the base release');
  const hdIndexes = new Map(), hdFiles = new Map();
  for (const [room, pack] of Object.entries(manifest.packs)) {
    if (!pack.streaming) continue;
    assert(/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(room), 'Unsafe HD room');
    const descriptor = pack.streaming.index;
    assert(descriptor?.file === `streamed-hd/${room}.json`, 'Unexpected HD index path');
    const bytes = await load(descriptor.file);
    assert(bytes.length === descriptor.bytes && sha256(bytes) === descriptor.sha256, 'HD index descriptor mismatch');
    hdIndexes.set(`/__private-demo/${descriptor.file}`, bytes);
    const path = resolve(local.baseDir, base.packs[room].file);
    assert(path.startsWith(local.baseDir + '/'), 'HD archive escaped base release');
    await noSymlinks(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat({ bigint: true });
      assert(info.isFile() && Number(info.size) === pack.bytes, 'HD archive size mismatch');
      hdFiles.set(`/__stream-hd/${room}.zip`, { path, bytes: pack.bytes,
        fingerprint: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') });
    } finally { await handle.close(); }
  }
  const fingerprints = {};
  for (const name of REQUIRED_FILES) {
    const expected = base.files.find(file => file.name === name), entry = index.files[name];
    assert(expected && entry.bytes === expected.bytes && entry.sha256 === expected.sha256 && entry.url === `/__stream-original/${name}`
      && entry.hashes.length === Math.ceil(entry.bytes / BLOCK_SIZE) && entry.hashes.every(hash => /^[a-f0-9]{64}$/.test(hash)), 'Invalid original index');
    await noSymlinks(local.sourcePaths[name]);
    const handle = await open(local.sourcePaths[name], constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat({ bigint: true });
      assert(info.isFile() && Number(info.size) === entry.bytes);
      fingerprints[name] = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
    } finally { await handle.close(); }
  }
  const server = createStaticServer({ privateDemoDir: local.baseDir, webRoot });
  const [fallback] = server.listeners('request'); server.removeAllListeners('request');
  const counters = () => ({ requests: 0, bytes: 0, completed: 0, rejected: 0 });
  const stats = { ...counters(), original: counters(), hd: counters(), ranges: [], droppedRanges: 0 };
  server.streamingStats = stats;
  server.on('request', async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    // The reference handler removes COEP for demo pages. Restore it at the final write boundary too.
    const writeHead = response.writeHead;
    response.writeHead = function (...args) {
      this.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      this.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      return writeHead.apply(this, args);
    };
    const raw = request.url.split('?')[0];
    let decoded;
    try { decoded = decodeURIComponent(raw); } catch { response.writeHead(400).end(); return; }
    const custom = ['/hd-demo/config.json', '/__private-demo/manifest.json', '/__private-demo/streaming-index.json', '/__stream-stats'].includes(decoded)
      || decoded.startsWith('/__stream-original') || decoded.startsWith('/__stream-hd')
      || decoded.startsWith('/__private-demo/streamed-hd');
    if (!custom) { fallback(request, response); return; }
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!permittedPeer(request) || request.url !== raw || decoded !== raw) { response.writeHead(403).end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const json = bytes => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    };
    if (raw === '/hd-demo/config.json') {
      json(Buffer.from(JSON.stringify({ version: 1, manifestURL: `http://${request.headers.host}/__private-demo/manifest.json` }) + '\n')); return;
    }
    if (raw === '/__private-demo/manifest.json') { json(manifestBytes); return; }
    if (raw === '/__private-demo/streaming-index.json') { json(indexBytes); return; }
    if (hdIndexes.has(raw)) { json(hdIndexes.get(raw)); return; }
    if (raw === '/__stream-stats') { json(Buffer.from(JSON.stringify(stats))); return; }
    const hd = hdFiles.get(raw), kind = hd ? 'hd' : 'original';
    const name = hd ? raw.slice('/__stream-hd/'.length) : raw.slice('/__stream-original/'.length);
    if (!hd && (!raw.startsWith('/__stream-original/') || !REQUIRED_FILES.includes(name))) { response.writeHead(404).end(); return; }
    const file = hd ?? index.files[name], range = boundedRange(request.headers.range, file.bytes, hd ? MAX_HD_RANGE_BYTES : MAX_RANGE_BYTES);
    if (!range) { stats.rejected++; stats[kind].rejected++; response.writeHead(416, { 'Content-Range': `bytes */${file.bytes}` }).end(); return; }
    let handle;
    try {
      const path = hd ? hd.path : local.sourcePaths[name];
      await noSymlinks(path);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat({ bigint: true });
      assert.equal([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'), hd ? hd.fingerprint : fingerprints[name], 'Archive changed');
      const { start, end } = range, bytes = end - start + 1;
      response.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes,
        'Content-Range': `bytes ${start}-${end}/${file.bytes}`, 'Accept-Ranges': 'bytes' });
      if (request.method === 'HEAD') { await handle.close(); handle = null; response.end(); return; }
      const record = { kind, name, start, end, bytes: 0, complete: false };
      stats.requests++; stats[kind].requests++;
      if (stats.ranges.length < 16384) stats.ranges.push(record); else stats.droppedRanges++;
      // Count flushed body writes, not requested lengths or browser transferSize.
      const stream = handle.createReadStream({ start, end }); handle = null;
      stream.on('data', chunk => {
        stream.pause();
        response.write(chunk, error => {
          if (error) { stream.destroy(); return; }
          record.bytes += chunk.length; stats.bytes += chunk.length; stats[kind].bytes += chunk.length;
          stream.resume();
        });
      });
      stream.on('end', () => response.end());
      response.on('finish', () => { record.complete = true; stats.completed++; stats[kind].completed++; });
      response.on('close', () => stream.destroy());
      stream.on('error', () => response.destroy());
    } catch {
      if (handle) await handle.close();
      if (response.headersSent) response.destroy(); else response.writeHead(409).end();
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await createStreamingServer({ directory: process.env.NEVERHOOD_STREAMING_DIR });
  const ports = process.env.PORT ? [Number(process.env.PORT)] : [4205, 4206];
  for (const port of ports) {
    assert(Number.isInteger(port) && port > 1024 && port <= 65535);
    try {
      await new Promise((done, reject) => {
        const error = value => { server.off('listening', ready); reject(value); };
        const ready = () => { server.off('error', error); done(); };
        server.once('error', error); server.once('listening', ready); server.listen(port, '127.0.0.1');
      });
      console.log(`Local streaming demo: http://127.0.0.1:${port}/hd-demo/`); break;
    } catch (error) { if (error.code !== 'EADDRINUSE' || port === ports.at(-1)) throw error; }
  }
}

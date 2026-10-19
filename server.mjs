import { constants, createReadStream } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PACK_LIMITS, validateReplacementManifest, validateImageHeader } from './web/prototype/replacement-pack.js';
import { DEMO_LIMITS, demoPath, validateDemoManifest } from './web/lib/demo-data.js';

const workspace = dirname(fileURLToPath(import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.dat': 'application/octet-stream',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8'
};

const inside = (root, path) => path === root || path.startsWith(root + sep);
const privatePrefix = '/__private-room-pack/';
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

async function noSymlinks(path) {
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Private pack symlinks are forbidden');
  }
  if (await realpath(path) !== path) throw new Error('Private pack canonical escape');
}

const fingerprint = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');

async function privateManifestInfo(directory, webRoot, name = 'room-pack.json') {
  if (!isAbsolute(directory)) throw new Error('Private pack requires an absolute directory');
  const root = resolve(directory);
  if (root !== directory) throw new Error('Private pack requires a canonical directory path');
  if (inside(resolve(webRoot), root) || inside(resolve(workspace, 'web'), root) ||
      inside(resolve(workspace, 'dist'), root)) throw new Error('Private pack must be outside public trees');
  await noSymlinks(root);
  const path = resolve(root, name);
  await noSymlinks(path);
  const info = await stat(path, { bigint: true });
  if (!info.isFile() || info.size < 1n || info.size > BigInt(PACK_LIMITS.manifest)) throw new Error('Invalid private manifest size');
  return { root, path, fingerprint: `${root}:${fingerprint(info)}` };
}

async function demoCatalog(directory, webRoot) {
  const info = await privateManifestInfo(directory, webRoot, 'manifest.json');
  const readJSON = async (file, limit) => {
    const path = resolve(info.root, file);
    if (!demoPath(file) || !inside(info.root, path)) throw new Error('Unsafe demo path');
    await noSymlinks(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error('Invalid demo manifest size');
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw new Error('Demo manifest changed');
      return { bytes: bytes.subarray(0, bytesRead), value: JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) };
    } finally { await handle.close(); }
  };
  const top = await readJSON('manifest.json', DEMO_LIMITS.manifest);
  const manifest = validateDemoManifest(top.value, top.value.sourceRuntimeSHA256);
  const files = new Map([['manifest.json', { bytes: top.bytes }]]);
  for (const name of ['room1-original-preview-v2.webp', 'room1-hd-preview-v2.webp']) files.set(name, { limit: 2 * 1024 ** 2 });
  for (const entry of manifest.files) files.set(entry.file, { size: entry.bytes });
  for (const [room, file] of Object.entries(manifest.packs)) {
    if (manifest.version === 2) { files.set(file.file, { size: file.bytes }); continue; }
    const pack = await readJSON(file, PACK_LIMITS.manifest);
    const { descriptors } = validateReplacementManifest(pack.value, manifest.sourceRuntimeSHA256);
    if (pack.value.room !== room || !pack.value.backgrounds.some(background => background.id === 'gemini')) throw new Error('Invalid demo room pack');
    files.set(file, { bytes: pack.bytes });
    for (const entry of descriptors) {
      const path = relative(info.root, resolve(info.root, dirname(file), entry.file));
      if (!demoPath(path)) throw new Error('Unsafe demo image path');
      files.set(path, { limit: PACK_LIMITS.fileBytes, image: entry });
    }
  }
  const cursor = await readJSON(manifest.cursor, DEMO_LIMITS.manifest);
  files.set(manifest.cursor, { bytes: cursor.bytes });
  const image = relative(info.root, resolve(info.root, dirname(manifest.cursor), 'sprite-sheet-128.png'));
  files.set(image, { limit: 1024 ** 2 });
  return { root: info.root, files };
}

async function privateCatalog({ root, path, fingerprint: expected }, room) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    await noSymlinks(path);
    const info = await handle.stat({ bigint: true });
    if (`${root}:${fingerprint(info)}` !== expected) throw new Error('Private manifest changed');
    const size = Number(info.size);
    // Bounded read even if the file grows after stat.
    bytes = Buffer.alloc(size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== size || `${root}:${fingerprint(await handle.stat({ bigint: true }))}` !== expected) throw new Error('Private manifest changed');
    bytes = bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
  const manifest = JSON.parse(bytes.toString('utf8'));
  const { descriptors } = validateReplacementManifest(manifest, manifest.runtimeSHA256);
  if (manifest.room !== room) throw new Error('Private manifest room does not match route');
  return { root, bytes, files: new Map(descriptors.map(entry => [entry.file, entry])) };
}

function privatePeer(request) {
  if (!loopback(request.socket.remoteAddress)) return false;
  const host = request.headers.host;
  if (typeof host !== 'string' || !/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) return false;
  if (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) return false;
  return !request.headers['sec-fetch-site'] || request.headers['sec-fetch-site'] === 'same-origin' || request.headers['sec-fetch-site'] === 'none';
}

export function createStaticServer({ webRoot = resolve(workspace, 'web'), bundlesInPublic = true,
  privateRoomPackDir = process.env.NEVERHOOD_ROOM_PACK_DIR,
  privateRoom2PackDir = process.env.NEVERHOOD_ROOM2_PACK_DIR,
  privateDemoDir = process.env.NEVERHOOD_DEMO_DIR } = {}) {
  const catalogs = new Map();
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', request.url.startsWith('/__private-room-pack') ? 'private, no-store' : 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    try {
      const rawPath = request.url.split('?')[0];
      if (['/hd-demo', '/hd-demo/', '/hd-demo/index.html'].includes(rawPath)) response.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
      if (rawPath.startsWith('/__private-demo') || decodeURIComponent(rawPath).startsWith('/__private-demo')) {
        response.setHeader('Cache-Control', 'private, no-store');
        if (!privateDemoDir || !bundlesInPublic) { response.writeHead(404).end(); return; }
        if (!privatePeer(request)) { response.writeHead(403).end(); return; }
        const prefix = '/__private-demo/', file = rawPath.slice(prefix.length);
        if (!rawPath.startsWith(prefix) || request.url !== rawPath || !demoPath(file)) { response.writeHead(403).end(); return; }
        const manifestInfo = await privateManifestInfo(privateDemoDir, webRoot, 'manifest.json');
        let catalog = catalogs.get(prefix);
        if (catalog?.fingerprint !== manifestInfo.fingerprint) {
          catalog = { fingerprint: manifestInfo.fingerprint, promise: demoCatalog(privateDemoDir, webRoot) };
          catalogs.set(prefix, catalog);
        }
        const pack = await catalog.promise, entry = pack.files.get(file);
        if (!entry) { response.writeHead(404).end(); return; }
        if (entry.bytes) {
          response.writeHead(200, { 'Content-Type': types['.json'], 'Content-Length': entry.bytes.length });
          response.end(request.method === 'HEAD' ? undefined : entry.bytes); return;
        }
        const path = resolve(pack.root, file);
        if (!inside(pack.root, path)) { response.writeHead(403).end(); return; }
        await noSymlinks(path);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size < 1 || entry.size !== undefined && info.size !== entry.size || entry.limit && info.size > entry.limit) throw new Error('Invalid demo asset size');
          if (entry.image) {
            const header = Buffer.alloc(33), { bytesRead } = await handle.read(header, 0, header.length, 0);
            validateImageHeader(header.subarray(0, bytesRead), entry.image, info.size);
          }
          response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': info.size });
          if (request.method === 'HEAD') { await handle.close(); response.end(); return; }
          const stream = handle.createReadStream({ start: 0, end: info.size - 1 });
          stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response); return;
        } catch (error) { await handle.close(); throw error; }
      }
      // Check before URL normalization, so dot segments and encoded separators never become allowed paths.
      if (rawPath.startsWith('/__private-room-pack') || decodeURIComponent(rawPath).startsWith('/__private-room-pack')) {
        response.setHeader('Cache-Control', 'private, no-store');
        const second = rawPath.startsWith(`${privatePrefix}room2/`);
        const prefix = second ? `${privatePrefix}room2/` : privatePrefix;
        const directory = second ? privateRoom2PackDir : privateRoomPackDir;
        if (!directory || !bundlesInPublic) { response.writeHead(404).end(); return; }
        if (!privatePeer(request)) { response.writeHead(403).end(); return; }
        const file = rawPath.slice(prefix.length);
        if (!rawPath.startsWith(privatePrefix) || /[\\%?#\x00-\x20\x7f]/.test(rawPath) ||
            request.url !== rawPath || file.split('/').some(part => !part || part === '.' || part === '..')) {
          response.writeHead(403).end(); return;
        }
        // Stat freshness on every request, but read/parse/validate only a changed manifest. Never cache PNGs.
        const manifestInfo = await privateManifestInfo(directory, webRoot);
        let catalog = catalogs.get(prefix);
        if (catalog?.fingerprint !== manifestInfo.fingerprint) {
          catalog = { fingerprint: manifestInfo.fingerprint, promise: privateCatalog(manifestInfo, second ? 'Scene1002' : 'Scene1001') };
          catalogs.set(prefix, catalog);
        }
        const pack = await catalog.promise;
        if (file === 'room-pack.json') {
          response.writeHead(200, { 'Content-Type': types['.json'], 'Content-Length': pack.bytes.length });
          response.end(request.method === 'HEAD' ? undefined : pack.bytes); return;
        }
        if (!pack.files.has(file)) { response.writeHead(404).end(); return; }
        const path = resolve(pack.root, file);
        if (!inside(pack.root, path)) { response.writeHead(403).end(); return; }
        await noSymlinks(path);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let info;
        try {
          await noSymlinks(path);
          info = await handle.stat();
          const header = Buffer.alloc(33), entry = pack.files.get(file);
          const { bytesRead } = await handle.read(header, 0, header.length, 0);
          let valid = info.isFile() && info.size > 0 && info.size <= PACK_LIMITS.fileBytes && bytesRead >= 25;
          try { if (valid) validateImageHeader(header.subarray(0, bytesRead), entry, info.size); } catch { valid = false; }
          if (!valid) {
            await handle.close(); response.writeHead(404).end(); return;
          }
        } catch (error) { await handle.close(); throw error; }
        response.writeHead(200, { 'Content-Type': types[extname(file)], 'Content-Length': info.size });
        if (request.method === 'HEAD') { await handle.close(); response.end(); return; }
        const stream = handle.createReadStream({ start: 0, end: info.size - 1 });
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        stream.pipe(response); return;
      }
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname.includes('\0') || pathname.includes('\\')) {
        response.writeHead(400).end();
        return;
      }
      if (pathname === '/hd-demo') { response.writeHead(308, { Location: '/hd-demo/' }).end(); return; }
      const bundle = bundlesInPublic && ['/runtime/', '/demo-runtime/', '/extractor/'].find(prefix => pathname.startsWith(prefix));
      const root = resolve(webRoot, bundle ? `public${bundle}` : '.');
      const relative = bundle ? pathname.slice(bundle.length) : pathname.slice(1);
      const candidate = resolve(root, relative === 'hd-demo/' ? 'hd-demo/index.html' : relative || 'index.html');
      if (!inside(root, candidate)) {
        response.writeHead(403).end();
        return;
      }

      // Resolve symlinks too: the private workspace must never be reachable.
      const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(candidate)]);
      if (!inside(actualRoot, actualFile) || /\.(blb|exe|bin|nhc)$/i.test(actualFile)) {
        response.writeHead(403).end();
        return;
      }
      const info = await stat(actualFile);
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }

      let start = 0;
      let end = info.size - 1;
      let status = 200;
      if (request.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!range || (!range[1] && !range[2])) {
          response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
          return;
        }
        if (!range[1]) {
          start = Math.max(0, info.size - Number(range[2]));
        } else {
          start = Number(range[1]);
          if (range[2]) end = Math.min(end, Number(range[2]));
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
          response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
          return;
        }
        status = 206;
        response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      }

      response.writeHead(status, {
        'Content-Type': types[extname(actualFile)] || 'application/octet-stream',
        'Content-Length': info.size ? end - start + 1 : 0,
        'Accept-Ranges': 'bytes'
      });
      if (request.method === 'HEAD' || !info.size) {
        response.end();
        return;
      }
      const stream = createReadStream(actualFile, { start, end });
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      response.writeHead(error instanceof URIError ? 400 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500).end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  const packaged = process.argv.includes('--dist');
  const server = createStaticServer({ webRoot: resolve(workspace, packaged ? 'dist' : 'web'), bundlesInPublic: !packaged });
  server.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`Neverhood Web Lab: http://${host}:${server.address().port}`));
}

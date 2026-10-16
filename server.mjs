import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = dirname(fileURLToPath(import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.dat': 'application/octet-stream',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8'
};

const inside = (root, path) => path === root || path.startsWith(root + sep);

export function createStaticServer({ webRoot = resolve(workspace, 'web'), bundlesInPublic = true } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname.includes('\0') || pathname.includes('\\')) {
        response.writeHead(400).end();
        return;
      }
      const bundle = bundlesInPublic && ['/runtime/', '/extractor/'].find(prefix => pathname.startsWith(prefix));
      const root = resolve(webRoot, bundle ? `public${bundle}` : '.');
      const relative = bundle ? pathname.slice(bundle.length) : pathname.slice(1);
      const candidate = resolve(root, relative || 'index.html');
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

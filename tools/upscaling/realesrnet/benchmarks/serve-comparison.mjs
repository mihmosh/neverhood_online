import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv[2]) throw new Error('Usage: node serve-comparison.mjs PRIVATE_ANALYSIS_DIRECTORY');
const directory = resolve(process.argv[2]), root = await realpath(directory);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const inside = (base, path) => path === base || path.startsWith(base + sep);
if (root !== directory || inside(repo, root) && !inside(resolve(repo, 'private-assets'), root)) throw new Error('Serve only canonical private analysis output, never a source/public tree.');
const port = Number(process.env.PORT || 4195);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };
createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const host = request.headers.host;
    if (request.socket.remoteAddress !== '127.0.0.1' || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) ||
        request.headers.origin && request.headers.origin !== `http://${host}` || request.headers['sec-fetch-site'] === 'cross-site') { response.writeHead(403).end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    if (/[\\%?#\0]/.test(request.url)) { response.writeHead(403).end(); return; }
    const relative = request.url === '/' ? 'index.html' : request.url.slice(1);
    if (relative.split('/').some(part => !part || part.startsWith('.'))) { response.writeHead(403).end(); return; }
    const path = resolve(root, relative), type = types[extname(path)];
    if (!type || !inside(root, path) || await realpath(path) !== path) { response.writeHead(403).end(); return; }
    const info = await stat(path);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    let start = 0, end = info.size - 1, status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!match || Number(match[1]) >= info.size || match[2] && Number(match[2]) < Number(match[1])) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; status = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    response.writeHead(status, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(path, { start, end });
    response.on('close', () => stream.destroy()); stream.on('error', () => response.destroy()); stream.pipe(response);
  } catch (error) { if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(); else response.destroy(); }
}).listen(port, '127.0.0.1', () => console.log(`Private comparison: http://127.0.0.1:${port}/`));

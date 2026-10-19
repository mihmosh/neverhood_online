import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inside = (base, path) => path === base || path.startsWith(base + sep);

export function findGameCrop(rgb, frame) {
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 640 || frame.height < 480 || rgb.length !== frame.width * frame.height * 3) throw new Error('Invalid screenshot pixels.');
  const black = (x, y) => { const at = (y * frame.width + x) * 3; return rgb[at] <= 4 && rgb[at + 1] <= 4 && rgb[at + 2] <= 4; };
  let y = 0;
  while (y < frame.height && !(black(0, y) && black(frame.width - 1, y) && !black(Math.floor(frame.width / 2), y))) y++;
  if (y === frame.height) throw new Error('Cannot locate the letterboxed game frame; provide an explicit crop.');
  const middle = Math.floor((y + frame.height) / 2);
  let left = 0, right = frame.width - 1;
  while (left < right && black(left, middle)) left++;
  while (right > left && black(right, middle)) right--;
  const units = Math.floor(Math.min((right - left + 1) / 4, (frame.height - y) / 3) / 2) * 2;
  if (units < 160) throw new Error('Cannot locate a complete 4:3 game frame.');
  return { x: left + Math.floor((right - left + 1 - units * 4) / 2), y, width: units * 4, height: units * 3 };
}

export async function prepareDemoPreviews({ input, output, crop }) {
  if (!isAbsolute(input) || !isAbsolute(output) || await realpath(input) !== input || await realpath(output) !== output || inside(root, output)) throw new Error('Preview input/output must be canonical directories; media output must stay outside the repository.');
  if (crop && (!['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(crop[key]) && crop[key] >= (key === 'x' || key === 'y' ? 0 : 1)) || crop.width * 3 !== crop.height * 4)) throw new Error('Preview crop must be a bounded 4:3 rectangle.');
  const temporary = await mkdtemp(join(output, '.preview-build-'));
  const result = [];
  try {
    for (const [id, source] of [['original', 'room1_original.png'], ['hd', 'room1_hd.png']]) {
      const sourcePath = join(input, source);
      if (await realpath(sourcePath) !== sourcePath) throw new Error('Preview sources must not be symlinks.');
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', sourcePath], { encoding: 'utf8' }));
      const frame = probe.streams?.[0];
      if (!frame || frame.width * frame.height > 16 * 1024 ** 2) throw new Error('Unsupported preview source dimensions.');
      if (!crop) {
        const rgb = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 64 * 1024 ** 2 });
        crop = findGameCrop(rgb, frame);
      }
      if (!frame || crop.x + crop.width > frame.width || crop.y + crop.height > frame.height) throw new Error('Preview crop exceeds its source screenshot.');
      const file = `room1-${id}-preview-v2.webp`, destination = join(temporary, file);
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=1416:1062:flags=lanczos`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '88', destination], { stdio: 'pipe' });
      const bytes = await readFile(destination);
      if (bytes.length > 2 * 1024 ** 2) throw new Error('Preview exceeds its 2 MiB delivery budget.');
      try { await writeFile(join(output, file), bytes, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST' || !(await readFile(join(output, file))).equals(bytes)) throw error;
      }
      result.push({ id, file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: 1416, height: 1062, crop });
    }
    return result;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') throw new Error('Usage: prepare-demo-previews.mjs --input SCREENSHOT_DIR --output PRIVATE_RELEASE_DIR');
  prepareDemoPreviews({ input: resolve(args[1]), output: resolve(args[3]) }).then(value => console.log(JSON.stringify(value, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

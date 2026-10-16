import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const url = 'https://registry.npmjs.org/fflate/-/fflate-0.8.2.tgz';
const sha256 = '61fd5061e2fc8e5e3e3129f7f2fec7bd78a313e1bf4becbf1cc1cc9998d141dc';
const destination = fileURLToPath(new URL('../web/vendor/', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'neverhood-zip-vendor-'));
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('fflate SHA256 mismatch.');
  const archive = join(temporary, 'fflate.tgz');
  await writeFile(archive, bytes);
  execFileSync('tar', ['-xzf', archive, '-C', temporary, 'package/esm/browser.js', 'package/LICENSE']);
  await mkdir(destination, { recursive: true });
  await copyFile(join(temporary, 'package/esm/browser.js'), join(destination, 'fflate-0.8.2.js'));
  await copyFile(join(temporary, 'package/LICENSE'), join(destination, 'fflate-LICENSE'));
  await writeFile(join(destination, 'fflate-provenance.json'), `${JSON.stringify({
    name: 'fflate', version: '0.8.2', url, sha256, license: 'MIT',
    source: 'https://github.com/101arrowz/fflate/tree/d3243651cb142e3e04f3e4bc037b9e985878f444',
    files: { 'fflate-0.8.2.js': 'package/esm/browser.js', 'fflate-LICENSE': 'package/LICENSE' },
    browserSHA256: createHash('sha256').update(await readFile(join(destination, 'fflate-0.8.2.js'))).digest('hex'),
  }, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

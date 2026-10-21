import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../../../..');
const script = await readFile(join(here, 'viewer-controls.js'));
for (const argument of process.argv.slice(2)) {
  const directory = resolve(argument);
  if (await realpath(directory) !== directory || directory.startsWith(repo + sep) && !directory.startsWith(join(repo, 'private-assets') + sep)) throw new Error('Only private generated comparisons may be refreshed');
  const file = join(directory, 'index.html');
  let html = await readFile(file, 'utf8');
  if (!/<title>[^<]*comparison[^<]*<\/title>/i.test(html)) throw new Error('Unrecognized generated comparison');
  if (!html.includes('src="viewer-controls.js"')) html += '\n<script src="viewer-controls.js"></script>\n';
  await writeFile(join(directory, 'viewer-controls.js'), script);
  await writeFile(file, html);
  await writeFile(join(directory, 'presentation.json'), JSON.stringify({ controllerSHA256: createHash('sha256').update(script).digest('hex'), metricsChanged: false }, null, 2) + '\n');
  const reportPath = join(directory, 'report.json'), report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.outputFiles = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.name === 'report.json' || entry.name.startsWith('.')) continue;
    const bytes = await readFile(join(directory, entry.name));
    report.outputFiles.push({ file: entry.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  report.hashPolicy = 'Delivered files hashed except report.json self-hash; presentation controls refreshed without changing model metrics.';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Animation controls refreshed: ${directory}`);
}

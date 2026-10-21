import { realpath, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const usage = 'Usage: node serve-seedvr2-probe.mjs --base PRIVATE_EXPERIMENT_DIRECTORY [--port PORT]';
const { values } = parseArgs({ args: process.argv.slice(2), options: { base: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log(`${usage}\n--base defaults only to NEVERHOOD_SEEDVR2_PROBE_DIR; serves BASE/analysis.\n--port overrides PORT (default 4195). --help opens no listener and reads no data.`);
  process.exit(0);
}
const configured = values.base || process.env.NEVERHOOD_SEEDVR2_PROBE_DIR;
if (!configured) throw new Error(usage);
const base = resolve(configured), directory = resolve(base, 'analysis');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const inside = (root, path) => path === root || path.startsWith(root + sep);
if (inside(repo, directory) || directory.split(sep).some(part => ['public', 'www', 'wwwroot', 'htdocs'].includes(part.toLowerCase())) || await realpath(directory) !== directory) throw new Error('Serve only canonical private analysis outside source/public trees.');
const metadata = JSON.parse(await readFile(resolve(base, 'input/source-metadata.json'), 'utf8'));
const sourceRoot = dirname(resolve(metadata.sourceManifest));
if (inside(sourceRoot, directory)) throw new Error('Do not serve the original source directory');
const port = values.port || process.env.PORT || '4195';
if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535) throw new Error('Invalid local port');
process.env.PORT = port;
process.argv = [process.argv[0], fileURLToPath(new URL('../../benchmarks/serve-comparison.mjs', import.meta.url)), directory];
await import('../../benchmarks/serve-comparison.mjs');

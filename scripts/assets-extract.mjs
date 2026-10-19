#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, associate } from '../tools/assets/catalog.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { repo, input: path.join(repo, 'extracted/app/DATA'), output: path.join(repo, 'private-assets') };
try {
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--init-private') options.initialize = true;
    else if (arg === '--no-probe') options.probe = false;
    else if (['--input', '--output', '--variant', '--max-resource-mib', '--associations'].includes(arg)) {
      const value = process.argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--max-resource-mib') {
        options.maxResource = Number(value) * 1024 * 1024;
        if (!Number.isSafeInteger(options.maxResource) || options.maxResource < 1 || options.maxResource > 1024 ** 3) throw new Error('Invalid resource memory limit');
      } else options[arg.slice(2)] = value;
    } else if (arg === '--help') {
      console.log('Private local BLB extractor (Node 22.13+ with node:sqlite)\nnode scripts/assets-extract.mjs --init-private [--input DIR] [--output PRIVATE_DIR] [--variant english] [--no-probe] [--max-resource-mib 64] [--associations FILE]\nRepeat the same command to resume with SHA-256 validation. Offline metadata can also be applied separately with scripts/assets-associate.mjs. No network calls.');
      process.exit(0);
    } else throw new Error(`Unknown argument ${arg}`);
  }
  const summary = extract(options);
  console.log(JSON.stringify(summary, null, 2));
  if (options.associations) console.log(JSON.stringify(associate({ ...options, file: options.associations }), null, 2));
  if (summary.errors) process.exitCode = 2;
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}

#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { associate } from '../tools/assets/catalog.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const args = process.argv.slice(2);
  if (!args[0] || args.length > 3 || (args.length > 1 && args[1] !== '--output'))
    throw new Error('Usage: node scripts/assets-associate.mjs ASSOCIATIONS.json [--output PRIVATE_DIR]');
  console.log(JSON.stringify(associate({ repo, output: args[2] ?? path.join(repo, 'private-assets'), file: args[0] }), null, 2));
} catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }

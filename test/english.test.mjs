import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('first-party interface and documentation use English only', async () => {
  const files = (await readdir('.')).filter(name => name.endsWith('.md'));
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !['public', 'node_modules'].includes(entry.name)) await collect(path);
      else if (entry.isFile() && /\.(js|mjs|html|md)$/.test(entry.name)) files.push(path);
    }
  }
  await collect('docs');
  await collect('web');
  for (const file of files) assert.doesNotMatch(await readFile(resolve(file), 'utf8'), /[\u0400-\u04ff]/, file);
  assert.match(await readFile('web/index.html', 'utf8'), /<html lang="en">/);
});

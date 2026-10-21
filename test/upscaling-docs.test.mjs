import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workspace = join(root, 'tools/upscaling');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const localOnly = /(^|\/)(?:\.env(?:\.[^/]*)?|\.venv|\.cache|\.pytest_cache|__pycache__|infra-state\.json|data|models|outputs|runs|results|cache)(\/|$)|\.(?:gguf|safetensors|ckpt|pth|pt|onnx)$/;
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (localOnly.test(relative(workspace, path))) continue;
    if (entry.isDirectory()) result.push(...await files(path));
    else { assert.ok(entry.isFile(), `No source symlinks: ${path}`); result.push(path); }
  }
  return result;
}

test('upscaling scaffold has valid links, original prompt, verified photo catalog and safe source inventory', async () => {
  const publicFiles = await files(workspace);
  for (const file of publicFiles.filter(path => path.endsWith('.md'))) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      await access(resolve(dirname(file), target));
    }
  }
  const prompt = await readFile(join(workspace, 'gemini/prompts/room-background-original.txt'));
  assert.equal(hash(prompt), 'f7c628491688fab249175ee75e8551ab60c16eba36f7e464b4043f7260db93b6');
  const catalog = JSON.parse(await readFile(join(workspace, 'references/backstage/catalog.json'), 'utf8'));
  assert.equal(catalog.files.length, 5);
  assert.equal(catalog.softwareLicenseDoesNotApply, true);
  let total = 0;
  for (const entry of catalog.files) {
    assert.match(entry.file, /^[a-zA-Z0-9]+\.jpeg$/);
    const bytes = await readFile(join(workspace, 'references/backstage', entry.file));
    assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
    assert.equal(bytes.readUInt16BE(0), 0xffd8); total += bytes.length;
  }
  assert.equal(total, catalog.totalBytes);
  const record = JSON.parse(await readFile(join(workspace, 'realesrnet/configs/seedvr2-probe-v1.json'), 'utf8'));
  assert.equal(record.runnable, false);
  assert.equal(record.runs.filter(run => run.status === 'succeeded').length, 2);
  assert.equal(record.runs.filter(run => run.status === 'failed').length, 2);
  assert.doesNotMatch(JSON.stringify(record), /r8_[a-zA-Z0-9_-]{20,}|data:video|Bearer\s|\/home\//);
  const inventory = JSON.parse(await readFile(join(root, 'web/public/sources/inventory.json'), 'utf8'));
  const entries = inventory.members.filter(entry => entry.component === 'project-build-sources');
  const archived = new Map(entries.map(entry => [entry.path, entry]));
  for (const file of publicFiles) {
    const path = relative(root, file), entry = archived.get(path);
    assert.ok(entry, `Public upscaling source omitted from archive: ${path}`);
    assert.equal(entry.sha256, hash(await readFile(file)), path);
  }
  for (const entry of entries.filter(entry => entry.path.startsWith('tools/upscaling/'))) {
    assert.equal(localOnly.test(entry.path.slice('tools/upscaling/'.length)), false, entry.path);
  }
});

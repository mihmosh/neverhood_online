import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inventoryResearch, verifyResearch } from '../tools/evaluation/manifest.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'neverhood-evaluation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, '.private-research-no-public'), JSON.stringify({ version: 1, private: true }));
  await mkdir(path.join(root, 'component/source'), { recursive: true });
  await writeFile(path.join(root, 'component/source/main.py'), '# synthetic source fixture\n');
  await writeFile(path.join(root, 'component/manifest.json'), JSON.stringify({ revision: 'test-fixture', weights: 'metadata-only' }));
  return root;
}

test('evaluation inventories exclude credentials/Git and verify immutable source files', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'component/source/.git'));
  await writeFile(path.join(root, 'component/source/.git/config'), 'PRIVATE');
  await writeFile(path.join(root, '.env'), 'PRIVATE');
  await writeFile(path.join(root, 'component/source/weights.safetensors'), 'version https://git-lfs.github.com/spec/v1\noid sha256:example\nsize 123\n');
  const manifest = await inventoryResearch({ root });
  assert.deepEqual(manifest.potentialWeightFiles, []);
  assert.ok(manifest.exclusions.includes('.env'));
  assert.ok(manifest.exclusions.includes('component/source/.git'));
  const index = await readFile(path.join(root, 'inventory.jsonl'), 'utf8');
  assert.ok(!index.includes('PRIVATE'));
  assert.match(index, /lfsPointerOnly/);
  assert.equal((await verifyResearch(root)).verifiedFiles, manifest.files);
  await writeFile(path.join(root, 'component/source/main.py'), '# changed\n');
  await assert.rejects(verifyResearch(root), /Evaluation file changed/);
});

test('private evaluation bundles verify and never include ignored credential files', async t => {
  const root = await fixture(t);
  const bundle = await inventoryResearch({ root, bundle: true });
  assert.ok(bundle.bytes > 0);
  assert.match(bundle.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await verifyResearch(root)).verifiedFiles, bundle.sourceFiles);
});

test('evaluation source links cannot escape the transferable workspace', async t => {
  const root = await fixture(t);
  await symlink('/etc/passwd', path.join(root, 'component/source/outside'));
  await assert.rejects(inventoryResearch({ root }), /outside symlink/);
});

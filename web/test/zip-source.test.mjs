import test from 'node:test';
import assert from 'node:assert/strict';
import { withZipFiles } from '../lib/zip-source.js';

function environment(t, response = 'done') {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousWorker = globalThis.Worker;
  const stages = new Map([['extract-abandoned', { kind: 'directory' }]]);
  const removed = [];
  const workers = [];
  const locks = [];
  let locked = false;
  const temporary = {
    async *entries() { yield* stages; },
    async removeEntry(name) { stages.delete(name); removed.push(name); },
    async getDirectoryHandle(name) {
      const stage = {
        kind: 'directory',
        async getFileHandle(stored) {
          assert.equal(stored, 'entry-0');
          return { async getFile() { return new File(['resource'], stored); } };
        },
      };
      stages.set(name, stage);
      return stage;
    },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    storage: { async getDirectory() { return { async getDirectoryHandle(name) {
      assert.equal(name, 'neverhood-zip-staging-v1');
      return temporary;
    } }; } },
    locks: { async request(name, options, callback) {
      options.signal?.throwIfAborted();
      locks.push(name);
      locked = true;
      try { return await callback(); } finally { locked = false; }
    } },
  } });
  globalThis.Worker = class {
    constructor(url, options) {
      assert.equal(options.type, 'module');
      assert.match(url.href, /zip-worker\.js$/);
      workers.push(this);
    }
    terminate() { this.terminated = true; }
    postMessage(data) {
      assert.equal(data.type, 'extract');
      if (response === 'wait') return;
      queueMicrotask(() => this.onmessage({ data: response === 'error'
        ? { type: 'error', name: 'QuotaExceededError', message: 'Disk is full.' }
        : { type: 'done', files: [{ path: 'Nested/Game/HD.BLB', stored: 'entry-0', size: 8 }] } }));
    }
  };
  t.after(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
    if (previousWorker) globalThis.Worker = previousWorker;
    else delete globalThis.Worker;
  });
  return { stages, workers, removed, locks, isLocked: () => locked };
}

const source = () => new File([new Uint8Array(30)], 'input.zip');

test('ZIP consumer sees normalized records within a dedicated lock and temporary lifetime', async t => {
  const state = environment(t);
  const result = await withZipFiles(source(), async records => {
    assert.equal(state.isLocked(), true);
    assert.equal(state.stages.size, 1);
    assert.equal(records[0].path, 'Nested/Game/HD.BLB');
    assert.equal(records[0].file.name, 'HD.BLB');
    assert.equal(await records[0].file.text(), 'resource');
    assert.equal(state.workers[0].terminated, true);
    return 'adopted';
  });
  assert.equal(result, 'adopted');
  assert.deepEqual(state.locks, ['neverhood-zip-import-v1']);
  assert.equal(state.removed[0], 'extract-abandoned');
  assert.equal(state.stages.size, 0);
});

test('consumer failure cleans staging without swallowing its error', async t => {
  const state = environment(t);
  await assert.rejects(withZipFiles(source(), async () => { throw new Error('Commit rejected.'); }), /Commit rejected/);
  assert.equal(state.stages.size, 0);
  assert.equal(state.workers[0].terminated, true);
});

test('worker storage failure never calls consumer and cleans staging', async t => {
  const state = environment(t, 'error');
  let consumed = false;
  await assert.rejects(withZipFiles(source(), () => { consumed = true; }), { name: 'QuotaExceededError' });
  assert.equal(consumed, false);
  assert.equal(state.stages.size, 0);
  assert.equal(state.workers[0].terminated, true);
});

test('abort terminates active worker and cleans temporary output', async t => {
  const state = environment(t, 'wait');
  const controller = new AbortController();
  const result = withZipFiles(source(), () => assert.fail('Aborted archive was adopted.'), { signal: controller.signal });
  // Let the queued storage/lock promises reach worker creation without a timer.
  for (let index = 0; index < 20 && !state.workers.length; index++) await Promise.resolve();
  assert.equal(state.workers.length, 1);
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(state.workers[0].terminated, true);
  assert.equal(state.stages.size, 0);
});

test('already-aborted imports create no worker or temporary files', async t => {
  const state = environment(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withZipFiles(source(), () => {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(state.workers.length, 0);
  assert.deepEqual(state.removed, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { splitJobs, submittedHistory, claimRequest, executeBulk } from '../tools/upscaling/gemini/bulk.mjs';
import { recoverJob, runJob } from '../tools/upscaling/gemini/experiment.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=', 'base64');
const job = i => ({ id: `test-${i}`, roomId: `Room-${i}`, requestHash: `hash-${i}`, model: 'synthetic', prompt: 'synthetic', attachments: [], settings: {} });

test('bulk deduplicates all prior submitted states including unknown, not just success', () => {
  const jobs = Array.from({ length: 4 }, (_, i) => ({ ...job(i), attachments: [{ path: '/synthetic' }] }));
  const result = splitJobs(jobs, [
    { ...jobs[0], status: 'succeeded', resultPath: '/private/old0' },
    { ...jobs[1], status: 'in-flight-outcome-unknown', resultPath: '/private/old1' },
    { ...jobs[2], status: 'failed', resultPath: '/private/old2' },
  ].map(item => ({ ...item, attachments: [{ path: '/synthetic' }] })));
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].id, 'test-3');
  assert.equal(result.reused.length, 3);
  assert.throws(() => splitJobs([jobs[0], jobs[0]], []), /Duplicate/);
});

test('history includes opaque pilot unknowns but excludes current bulk and unsubmitted plans', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bulk-history-'));
  try {
    const old = path.join(dir, 'opaque-pilot-v1');
    const current = path.join(dir, 'opaque-all-v1');
    await mkdir(path.join(old, 'jobs/test-0'), { recursive: true });
    await mkdir(current);
    await writeFile(path.join(old, 'experiment.json'), JSON.stringify({ jobs: [job(0), job(1)] }));
    await writeFile(path.join(old, 'jobs/test-0/result.json'), JSON.stringify({ requestHash: 'hash-0', status: 'in-flight-outcome-unknown' }));
    await writeFile(path.join(current, 'experiment.json'), JSON.stringify({ jobs: [job(2)] }));
    const history = await submittedHistory(dir, current);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'in-flight-outcome-unknown');
    assert.equal(history[0].id, 'test-0');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('global ledger is exclusive across run directories', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bulk-ledger-'));
  try {
    const results = await Promise.all([claimRequest(job(0), '/run/one', dir), claimRequest(job(0), '/run/two', dir)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'hash-0.json'), 'utf8')).requestHash, 'hash-0');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('durable raw response recovers without generation and still excludes thought final', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bulk-recover-'));
  try {
    const item = job(0);
    const jobDir = path.join(dir, 'jobs', item.id);
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, 'request.json'), JSON.stringify(item));
    await writeFile(path.join(jobDir, 'result.json'), JSON.stringify({ status: 'outcome-unknown', requestHash: item.requestHash }));
    await writeFile(path.join(jobDir, 'response-metadata.json'), JSON.stringify({ httpStatus: 200, durationMs: 7 }));
    await writeFile(path.join(jobDir, 'response-raw.json'), JSON.stringify({ responseId: 'recovered', modelVersion: 'synthetic', candidates: [{ finishReason: 'STOP', content: { parts: [
      { thought: true, inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
      { inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
    ] } }] }));
    assert.equal(await recoverJob(item, dir), true);
    const result = JSON.parse(await readFile(path.join(jobDir, 'result.json')));
    assert.equal(result.status, 'succeeded');
    assert.equal(result.recoveredFromSavedRawResponse, true);
    assert.equal(result.images[0].thought, true);
    assert.equal(result.images[1].sha256, sha(png));
    assert.equal(await recoverJob(item, dir), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bulk resume sends each fresh request once, skips historical and unknown reservations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bulk-execute-'));
  try {
    const jobs = Array.from({ length: 3 }, (_, i) => job(i));
    const plan = { schemaVersion: 1, experimentId: 'synthetic', project: 'synthetic', location: 'global', concurrency: 2, jobs, reused: [] };
    await writeFile(path.join(dir, 'experiment.json'), JSON.stringify(plan));
    const ledgerDir = path.join(dir, 'ledger');
    await claimRequest(jobs[1], '/other/run', ledgerDir);
    let calls = 0;
    const options = { ledgerDir, history: [{ ...jobs[2], resultPath: '/historical/result.json' }], dependencies: { token: 'synthetic', fetch: async () => {
      calls++;
      return { ok: false, status: 400, json: async () => ({ error: { message: 'synthetic failure' } }) };
    } } };
    const first = await executeBulk(plan, dir, options);
    assert.equal(calls, 1);
    assert.equal(first.counts.failed, 1);
    assert.equal(first.counts['blocked-prior-submission'], 2);
    assert.equal(first.complete, false);
    await executeBulk(plan, dir, options);
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('all common generation entry points share the request ledger despite stale bulk history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bulk-shared-ledger-'));
  try {
    const pilot = path.join(dir, 'pilot'), bulk = path.join(dir, 'bulk'), ledgerDir = path.join(dir, 'ledger');
    await mkdir(pilot); await mkdir(bulk);
    const item = job(0);
    let calls = 0;
    const dependencies = { token: 'synthetic', ledgerDir, fetch: async () => { calls++; throw Error('ambiguous timeout'); } };
    await runJob({ project: 'synthetic', location: 'global' }, item, pilot, dependencies);
    const plan = { experimentId: 'synthetic', project: 'synthetic', location: 'global', concurrency: 2, jobs: [item], reused: [] };
    await writeFile(path.join(bulk, 'experiment.json'), JSON.stringify(plan));
    const result = await executeBulk(plan, bulk, { history: [], ledgerDir, dependencies });
    assert.equal(calls, 1);
    assert.equal(result.counts['blocked-prior-submission'], 1);
    assert.equal(result.complete, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent same-directory bulk execution cannot overwrite owner state or suppress dispatch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bulk-owner-lock-'));
  try {
    const item = job(0);
    const plan = { experimentId: 'synthetic', project: 'synthetic', location: 'global', concurrency: 2, jobs: [item], reused: [] };
    await writeFile(path.join(dir, 'experiment.json'), JSON.stringify(plan));
    let calls = 0;
    const options = { history: [], ledgerDir: path.join(dir, 'ledger'), dependencies: { token: 'synthetic', fetch: async () => {
      calls++; return { ok: false, status: 400, json: async () => ({ error: { message: 'synthetic failure' } }) };
    } } };
    const results = await Promise.allSettled([executeBulk(plan, dir, options), executeBulk(plan, dir, options)]);
    assert.equal(calls, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'jobs', item.id, 'result.json'))).status, 'failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

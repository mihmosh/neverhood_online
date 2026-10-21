import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runJob, finalImage, freezeManifest, buildOpaquePlan, validatePilotJobs } from '../tools/upscaling/gemini/experiment.mjs';
import { summarize } from '../tools/upscaling/gemini/pilot-summary.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Synthetic 1x1 PNG; no private game data and no credentials/network.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=', 'base64');

test('manifest is immutable and deterministic, and pilot requires exactly ten originals', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opaque-manifest-'));
  try {
    const file = path.join(dir, 'manifest.json');
    await freezeManifest(file, { jobs: [1] });
    await freezeManifest(file, { jobs: [1] });
    await assert.rejects(freezeManifest(file, { jobs: [2] }), /differs/);
    await assert.rejects(buildOpaquePlan({ schemaVersion: 1, rooms: [] }), /Exactly 10/);
    const source = { path: '/private/none', sha256: 'same' };
    await assert.rejects(buildOpaquePlan({ schemaVersion: 1, rooms: Array.from({ length: 10 }, () => ({ id: 'Scene1001', sourcePath: source.path, source })) }), /Duplicate or control/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('final image excludes thought parts and nonimage parts', () => {
  const final = { mimeType: 'image/png', thought: false, partIndex: 2 };
  assert.equal(finalImage([{ mimeType: 'image/png', thought: true }, final, { mimeType: 'image/png', thought: true }, { mimeType: 'audio/wav' }]), final);
  assert.equal(finalImage([{ mimeType: 'image/png', thought: true }]), undefined);
});

test('pilot rejects duplicate requests/sources, extra jobs, model changes and reference attachments', () => {
  const jobs = Array.from({ length: 10 }, (_, i) => ({ requestHash: `hash-${i}`, attachments: [{ sha256: `source-${i}` }],
    model: 'gemini-nano-banana-2.1', referenceMode: 'none', promptVariant: 'preservation' }));
  validatePilotJobs(jobs);
  assert.throws(() => validatePilotJobs([...jobs, jobs[0]]));
  for (const change of [{ requestHash: jobs[0].requestHash }, { attachments: jobs[0].attachments },
    { model: 'gemini-3-pro-image' }, { attachments: [...jobs[1].attachments, { sha256: 'ref' }] }]) {
    assert.throws(() => validatePilotJobs(jobs.map((job, index) => index === 1 ? { ...job, ...change } : job)));
  }
});

test('resume, concurrent invocation, errors and unknown outcomes never resend', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opaque-job-'));
  try {
    const sourcePath = path.join(dir, 'source.png');
    await writeFile(sourcePath, png);
    const plan = { project: 'synthetic-test', location: 'global' };
    let calls = 0;
    const job = { id: 'one', model: 'synthetic-model', prompt: 'test', settings: {}, requestHash: 'frozen', attachments: [{ path: sourcePath, sha256: sha(png), role: 'source-composition', mimeType: 'image/png' }] };
    const dependencies = { token: 'synthetic', fetch: async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ responseId: 'test-response', modelVersion: 'test-version', usageMetadata: { promptTokenCount: 1 }, candidates: [{ finishReason: 'STOP', content: { parts: [
        { thought: true, inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
        { inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
      ] } }] }) };
    } };
    await Promise.all([runJob(plan, job, dir, dependencies), runJob(plan, job, dir, dependencies)]);
    await runJob(plan, job, dir, dependencies);
    assert.equal(calls, 1);
    const result = JSON.parse(await readFile(path.join(dir, 'jobs/one/result.json'), 'utf8'));
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.images[1].dimensions, [1, 1]);
    assert.equal(result.images[0].thought, true);
    assert.equal(result.responseId, 'test-response');
    assert.equal(result.images[1].sha256, sha(png));
    await assert.rejects(runJob(plan, { ...job, requestHash: 'changed' }, dir, dependencies), /hash mismatch/);
    const unknown = { ...job, id: 'unknown' };
    await runJob(plan, unknown, dir, { token: 'synthetic', fetch: async () => { calls++; throw Error('timeout'); } });
    await runJob(plan, unknown, dir, dependencies);
    assert.equal(calls, 2);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'jobs/unknown/result.json'))).status, 'outcome-unknown');
    const failed = { ...job, id: 'failed' };
    await runJob(plan, failed, dir, { token: 'synthetic', fetch: async () => { calls++; return { ok: false, status: 400, json: async () => ({ error: { message: 'unsupported' } }) }; } });
    await runJob(plan, failed, dir, dependencies);
    assert.equal(calls, 3);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'jobs/failed/result.json'))).status, 'failed');
    const inflight = { ...job, id: 'inflight' };
    await mkdir(path.join(dir, 'jobs/inflight'));
    await writeFile(path.join(dir, 'jobs/inflight/result.json'), JSON.stringify({ status: 'in-flight-outcome-unknown', requestHash: job.requestHash }));
    await runJob(plan, inflight, dir, dependencies);
    assert.equal(calls, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('aggregate distinguishes missing, unknown, blocked and separate judge cache usage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opaque-summary-'));
  try {
    await writeFile(path.join(dir, 'experiment.json'), JSON.stringify({ experimentId: 'test', transport: 'queue', jobs: [{ id: 'done' }, { id: 'unknown' }, { id: 'missing' }] }));
    await mkdir(path.join(dir, 'jobs/done'), { recursive: true });
    await mkdir(path.join(dir, 'jobs/unknown'));
    await writeFile(path.join(dir, 'jobs/done/result.json'), JSON.stringify({ id: 'done', status: 'succeeded', images: [{ thought: false, dimensions: [2400, 1792] }], usage: { promptTokenCount: 5 } }));
    await writeFile(path.join(dir, 'jobs/unknown/result.json'), JSON.stringify({ id: 'unknown', status: 'outcome-unknown' }));
    await writeFile(path.join(dir, 'jobs/done/judge-objects-v2.json'), JSON.stringify({ id: 'done', status: 'succeeded', response: { usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 20 } } }));
    const summary = await summarize(dir);
    assert.equal(summary.submitted, 2);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.unknown, 1);
    assert.equal(summary.structuralDecisions.blocked, 3);
    assert.equal(summary.generationUsage.totals.promptTokenCount, 5);
    assert.equal(summary.generationUsage.observedCacheHits, 0);
    assert.equal(summary.judgeUsage.totals.promptTokenCount, 100);
    assert.equal(summary.judgeUsage.observedCacheHits, 1);
    assert.equal(summary.cost.status, 'unverified');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

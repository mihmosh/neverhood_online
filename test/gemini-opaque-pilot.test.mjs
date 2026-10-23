import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runJob, finalImage, freezeManifest, buildOpaquePlan, validatePilotJobs, makeJobs } from '../tools/upscaling/gemini/experiment.mjs';
import { summarize } from '../tools/upscaling/gemini/pilot-summary.mjs';
import { png as encodePng } from '../tools/assets/formats.mjs';

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

test('opaque pilot builds from isolated synthetic sources and frozen evidence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opaque-plan-'));
  try {
    const assetRoot = path.join(dir, 'private-assets');
    await mkdir(assetRoot);
    const sources = Array.from({ length: 10 }, (_, i) => encodePng(Buffer.alloc(12), 4, 3, Buffer.alloc(1024, i)));
    const rooms = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const bytes = sources[i];
      const sourcePath = path.join(assetRoot, `source-${i}.png`);
      await writeFile(sourcePath, bytes);
      return { id: `SyntheticRoom-${i}`, sourcePath, provenance: 'generated test fixture', resourceId: `synthetic-${i}`,
        regions: [{ id: 'whole-image' }], source: { path: sourcePath, sha256: sha(bytes), mimeType: 'image/png', role: 'source-composition', dimensions: [4, 3] } };
    }));
    const preservation = 'Conservatively reconstruct the original stop-motion miniature at higher resolution. Preserve every silhouette, irregular edge, wall junction, doorway opening, button, ladder rung, ceiling feature and puzzle mark at the same normalized coordinates. Keep the original palette, illumination, shadow boundaries and dark areas. Preserve intentional asymmetry and handmade dents. Resolve compression and pixelation with plausible restrained clay texture only where supported by SOURCE; do not invent cracks, fingerprints, dust, fibers, props or markings. Do not beautify, straighten, smooth away original sculpting, relight or redesign. Retain negative space exactly. Fidelity takes priority over photographic detail.';
    const settings = { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '4:3', imageSize: '2K' } };
    const template = makeJobs([rooms[0]], { preservation }, [], settings, ['none'])[0];
    const templatePath = path.join(assetRoot, 'upscaling/gemini-experiments/static-pilot-v1-2096d1751ccd/jobs/Scene1001-gemini-nano-banana-2.1-preservation-none-7cbaffb18ab8/request.json');
    await mkdir(path.dirname(templatePath), { recursive: true });
    await writeFile(templatePath, JSON.stringify(template));
    const capabilityPath = path.join(assetRoot, 'upscaling/gemini-capabilities/capability.json');
    await mkdir(path.dirname(capabilityPath), { recursive: true });
    const capabilityBytes = JSON.stringify({ model: template.model, capabilities: { batch: { unsupportedOutputResolutions: ['2K'] } } });
    await writeFile(capabilityPath, capabilityBytes);
    const selection = { schemaVersion: 1, rooms, annotationsFrozenBeforeCandidates: true };
    const options = { assetRoot };
    const plan = await buildOpaquePlan(selection, [], options);
    assert.deepEqual(await buildOpaquePlan(selection, [], options), plan);
    assert.equal(plan.jobs.length, 10);
    assert.equal(plan.maximumRequests, 10);
    assert.equal(plan.concurrency, 2);
    assert(plan.jobs.every(job => job.prompt === template.prompt && job.attachments.length === 1));
    assert.deepEqual(plan.capabilityEvidence, { path: capabilityPath, sha256: sha(capabilityBytes) });
    assert.equal(plan.selectionSha256, sha(JSON.stringify(selection)));
    await assert.rejects(buildOpaquePlan(selection, [plan.jobs[0]], options), /already processed/);
    await assert.rejects(buildOpaquePlan({ ...selection, rooms: rooms.map((room, i) => i === 1 ? { ...room, source: rooms[0].source } : room) }, [], options), /Duplicate/);
    await assert.rejects(buildOpaquePlan({ ...selection, rooms: rooms.map((room, i) => i === 0 ? { ...room, sourcePath: '/outside/source.png', source: { ...room.source, path: '/outside/source.png' } } : room) }, [], options), /private original/);
    await writeFile(rooms[0].sourcePath, 'changed source');
    await assert.rejects(buildOpaquePlan(selection, [], options), /hash or type mismatch/);
    await writeFile(rooms[0].sourcePath, sources[0]);
    await writeFile(capabilityPath, JSON.stringify({ model: template.model, capabilities: {} }));
    await assert.rejects(buildOpaquePlan(selection, [], options), /capability evidence/);
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

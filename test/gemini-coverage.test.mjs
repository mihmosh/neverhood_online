import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageJob, inscriptionGuard, validateCoveragePlan } from '../tools/upscaling/gemini/coverage.mjs';
import { requestHashFor } from '../tools/upscaling/gemini/experiment.mjs';

const template = { model: 'gemini-nano-banana-2.1',
  prompt: 'SOURCE is the only authority. Return one restored background image, 4:3, without borders or text.\n\nPreserve every shape, color and puzzle mark.\n\nNo material reference photos are attached.',
  settings: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '4:3', imageSize: '2K' } } };
const room = (id, dimensions) => ({ id, source: { path: '/private/synthetic-original.png', sha256: 'synthetic',
  mimeType: 'image/png', role: 'source-composition', dimensions }, textInspection: { required: true, kind: 'source-inscriptions' } });

test('wall request preserves inscriptions without contradictory no-text instruction', () => {
  const original = room('HallOfRecordsScene-RESOURCE-RGB', [640, 480]);
  const job = coverageJob(original, template);
  assert.equal(job.model, 'gemini-nano-banana-2.1');
  assert.deepEqual(job.settings, template.settings);
  assert.equal(job.attachments.length, 1);
  assert.equal(job.attachments[0], original.source);
  assert(!job.prompt.includes('without borders or text.'));
  assert(job.prompt.includes('without borders or added text.'));
  assert(job.prompt.includes(inscriptionGuard));
  assert(job.prompt.includes('instead of guessing a word'));
  assert.equal(job.requestHash, requestHashFor(job));
  assert.equal(job.textInspection.required, true);
  assert.equal(job.authorizedAttempt, undefined);
});

test('native 640x500 input is not cropped padded stretched or forced into 4:3', () => {
  const original = room('Scene1402-RESOURCE-RGB', [640, 500]);
  const sourceBefore = structuredClone(original.source);
  const job = coverageJob(original, template);
  assert.equal(job.settings.imageConfig.imageSize, '2K');
  assert(!Object.hasOwn(job.settings.imageConfig, 'aspectRatio'));
  assert.equal(template.settings.imageConfig.aspectRatio, '4:3');
  assert.deepEqual(original.source, sourceBefore);
  assert.equal(job.attachments[0], original.source);
  assert(job.prompt.includes('32:25'));
  assert(job.prompt.includes('Do not crop the top or bottom'));
  assert(!job.prompt.includes('Return one restored background image, 4:3,'));
  assert.equal(job.sourceGeometryPolicy.mode, 'preserve-native-aspect');
  assert.deepEqual(job.sourceGeometryPolicy.sourceDimensions, [640, 500]);
  assert.equal(job.requestHash, requestHashFor(job));
});

test('nonlisted image classes and arbitrary dimensions are not substituted', () => {
  assert.throws(() => coverageJob(room('UI', [640, 480]), template), /not a listed/);
  assert.throws(() => coverageJob(room('HallOfRecordsScene-x', [320, 240]), template), /not a listed/);
  assert.throws(() => coverageJob(room('Scene1402-x', [640, 600]), template), /not a listed/);
});

test('coverage cap cannot expand beyond the exact thirty-nine authorized originals', async () => {
  const plan = { project: 'gen-lang-client-0665493034', location: 'global', concurrency: 2,
    authorizedSourceLimit: 40, maximumRequests: 40, jobs: Array(40).fill({}), rooms: Array(40).fill({}), reused: [] };
  await assert.rejects(validateCoveragePlan(plan, { rooms: [] }, template), /authorization\/budget/);
});

import { readFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestHashFor, freezeManifest } from './experiment.mjs';
import { executeBulk, submittedHistory } from './bulk.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = path.join(root, 'private-assets/upscaling/gemini-experiments');
const directory = path.join(base, 'opaque-coverage-v1');
const selectionPath = path.join(root, 'private-assets/upscaling/opaque-coverage-source-selection.json');
const templatePath = path.join(base, 'static-pilot-v1-2096d1751ccd/jobs/Scene1001-gemini-nano-banana-2.1-preservation-none-7cbaffb18ab8/request.json');
const authorizedPage = path.join(base, 'opaque-repair-v1/coverage-review.html');
const load = file => readFile(file, 'utf8').then(JSON.parse);
const exists = file => access(file).then(() => true, () => false);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export const inscriptionGuard = 'The existing inscriptions, glyphs, punctuation, line breaks, column spacing and carved drawings in SOURCE are original scene content. Preserve their visible shapes and exact normalized positions. Do not erase, rewrite, translate, paraphrase, correct, transcribe or invent text. Where a mark is unreadable in SOURCE, preserve its visible stroke pattern instead of guessing a word. Do not add labels, captions or commentary.';
export const nativeGeometryReason = 'User authorized the complete native 640x500 source; no crop, padding or stretch. aspectRatio is intentionally omitted to request source-native geometry.';

export function coverageJob(room, template) {
  const [width, height] = room.source.dimensions;
  const native = room.id.startsWith('Scene1402') && width === 640 && height === 500;
  const wall = room.id.startsWith('HallOfRecordsScene-');
  if (!native && (!wall || width !== 640 || height !== 480)) throw Error('Coverage source is not a listed text wall or full native Scene1402');
  const settings = structuredClone(template.settings);
  let prompt = template.prompt.replace('without borders or text.', 'without borders or added text.');
  if (wall) prompt += `\n\n${inscriptionGuard}`;
  else {
    delete settings.imageConfig.aspectRatio;
    prompt = prompt.replace('Return one restored background image, 4:3,', 'Return one restored background image matching the full original 640x500 field of view and its 32:25 aspect ratio,');
    prompt += '\n\nSOURCE has native dimensions 640x500 (32:25), not 640x480. Preserve its entire image rectangle and source proportions at higher resolution. Do not crop the top or bottom, stretch it to 4:3, pad it into a different canvas, or remove content to fit a standard ratio. Return the native generated image without borders.';
  }
  if (prompt === template.prompt || prompt.includes('without borders or text.')) throw Error('Text-preservation contradiction remains in coverage prompt');
  const job = { roomId: room.id, model: template.model, promptVariant: wall ? 'preservation-existing-inscriptions' : 'preservation-native-aspect',
    referenceMode: 'none', prompt, settings, attachments: [room.source],
    ...(wall ? { textInspection: room.textInspection } : { sourceGeometryPolicy: { mode: 'preserve-native-aspect', sourceDimensions: [width, height], reason: nativeGeometryReason } }) };
  job.requestHash = requestHashFor(job);
  job.id = `${room.id}-${job.model}-${job.promptVariant}-${job.requestHash.slice(0, 12)}`;
  return job;
}

function roomsFrom(selection) {
  return selection.rooms.map(room => ({ ...room, sourcePath: path.resolve(root, room.sourcePath),
    source: { ...room.source, path: path.resolve(root, room.source.path) },
    ...(room.id.startsWith('HallOfRecordsScene-') ? { textInspection: { required: true, kind: 'source-inscriptions',
      band: [0, 0.06, 1, 0.74], method: 'Source-defined text-wall band; no OCR transcription or correctness ground truth' } } : {}) }));
}

export async function buildCoveragePlan(selection, template, history) {
  const rooms = roomsFrom(selection);
  const jobs = [], reused = [];
  for (const room of rooms) {
    const job = coverageJob(room, template);
    const previous = history.find(item => item.requestHash === job.requestHash);
    if (previous) reused.push({ roomId: room.id, id: previous.id, requestHash: job.requestHash, sourcePath: room.sourcePath,
      resultPath: previous.resultPath, reason: 'Already submitted exact coverage request; never blindly repeat' });
    else jobs.push(job);
  }
  const plan = { schemaVersion: 1, experimentId: 'opaque-coverage-v1', project: 'gen-lang-client-0665493034', location: 'global', concurrency: 2,
    authorization: { userMessageTime: '2026-10-21T11:23:15Z', userInstruction: 'Process all originals on the supplied coverage-review.html page',
      sourcePage: selection.authorizationPage },
    sourceRegistry: selection, rooms, jobs, reused, maximumRequests: jobs.length, authorizedSourceLimit: 39,
    maximumAutomaticRetries: 0, requireAllNewJobs: true, transport: 'generateContent-limited-queue-not-official-batch', explicitCaching: false,
    selectionSha256: sha(JSON.stringify(selection)),
    design: 'Every unique original actually pictured on the authorized page; one original and one candidate per source; preserve inscriptions and full native field of view; manual review only.',
    relatedReview: path.join(base, 'opaque-repair-v1/review.html'),
    inputExceptions: [{ roomId: rooms.find(room => room.source.dimensions[1] === 500)?.id, sourceDimensions: [640, 500], aspectRatioRequest: 'omitted', reason: nativeGeometryReason }],
    implementation: await Promise.all(['coverage.mjs', 'experiment.mjs', 'bulk.mjs'].map(async name => ({ path: `tools/upscaling/gemini/${name}`, sha256: sha(await readFile(new URL(name, import.meta.url))) }))) };
  await validateCoveragePlan(plan, selection, template);
  return plan;
}

export async function validateCoveragePlan(plan, selection, template) {
  const rooms = roomsFrom(selection);
  if (plan.project !== 'gen-lang-client-0665493034' || plan.location !== 'global' || plan.concurrency !== 2 ||
      plan.authorizedSourceLimit !== 39 || plan.maximumRequests !== plan.jobs.length || plan.jobs.length > 39 ||
      rooms.length !== 39 || plan.rooms.length !== 39 || plan.jobs.length + plan.reused.length !== 39 ||
      template.model !== 'gemini-nano-banana-2.1' || !plan.requireAllNewJobs || plan.maximumAutomaticRetries !== 0 ||
      plan.authorization.userMessageTime !== '2026-10-21T11:23:15Z' || plan.authorization.sourcePage.sha256 !== selection.authorizationPage.sha256 ||
      plan.selectionSha256 !== sha(JSON.stringify(selection)) || new Set(plan.rooms.map(room => room.source.sha256)).size !== 39 ||
      new Set([...plan.jobs, ...plan.reused].map(job => job.roomId)).size !== 39) throw Error('Coverage authorization/budget/selection mismatch');
  const declaredPage = path.resolve(root, selection.authorizationPage.path);
  if (declaredPage !== authorizedPage || sha(await readFile(declaredPage)) !== selection.authorizationPage.sha256) throw Error('Authorized page changed; never expand the paid scope silently');
  if (JSON.stringify(plan.rooms) !== JSON.stringify(rooms)) throw Error('Coverage rooms differ from frozen page/source proofs');
  if (rooms.filter(room => room.id.startsWith('HallOfRecordsScene-')).length !== 38 || rooms.filter(room => JSON.stringify(room.source.dimensions) === '[640,500]').length !== 1) throw Error('Coverage source categories do not match actual page');
  for (const room of rooms) {
    if (!room.sourcePath.startsWith(path.join(root, 'private-assets') + path.sep) || room.source.path !== room.sourcePath || !room.provenance ||
        room.source.role !== 'source-composition' || room.source.mimeType !== 'image/png' || sha(await readFile(room.sourcePath)) !== room.source.sha256) throw Error('Coverage original hash/type/proof mismatch');
    const expected = coverageJob(room, template);
    const job = plan.jobs.find(job => job.roomId === room.id);
    if (job && JSON.stringify(job) !== JSON.stringify(expected)) throw Error('Coverage request/prompt/geometry differs from frozen authorized source');
    const previous = plan.reused.find(job => job.roomId === room.id);
    if (!job && previous?.requestHash !== expected.requestHash) throw Error('Coverage historical reuse does not match exact request');
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--execute')) throw Error('Usage: node coverage.mjs [--execute]');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'experiment.json');
  const [selection, template] = await Promise.all([load(selectionPath), load(templatePath)]);
  const plan = await exists(file) ? await load(file) : await buildCoveragePlan(selection, template, await submittedHistory(base, directory));
  await validateCoveragePlan(plan, selection, template);
  await freezeManifest(file, plan);
  console.log(JSON.stringify({ directory, originalImages: 39, jobs: plan.jobs.length, reused: plan.reused.length,
    originalDimensions: { '640x480': 38, '640x500': 1 }, manifestSha256: sha(await readFile(file)), execute: args.includes('--execute') }));
  if (args.includes('--execute')) {
    const summary = await executeBulk(plan, directory);
    if (!summary.complete) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

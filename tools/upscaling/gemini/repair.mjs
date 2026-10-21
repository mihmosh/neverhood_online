import { readFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeJobs, requestHashFor, validateAttempt, freezeManifest } from './experiment.mjs';
import { executeBulk, submittedHistory } from './bulk.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = path.join(root, 'private-assets/upscaling/gemini-experiments');
const runDir = path.join(base, 'opaque-repair-v1');
const load = file => readFile(file, 'utf8').then(JSON.parse);
const exists = file => access(file).then(() => true, () => false);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const retryRooms = ['Scene2101', 'Scene2201', 'Scene1201-4019A2C4', 'Scene1201-40206EC5'];
const authorizationId = 'repair-20261021T102254Z';
const instruction = 'Resend missed backgrounds and Scene1201 variants with color drift; inspect/add missing scenic halls, preserve all versions for manual review.';
export const colorClarification = 'Color fidelity is critical in this retry. Preserve the hue, saturation and relative brightness of each individual surface from SOURCE, including the reddish wall and pale platform; do not replace a surface color with a neutral, beige or globally harmonized interpretation. Keep the original lighting state and shadow boundaries. This is a color-preservation clarification, not permission to relight or change geometry.';

function sourceRoom(room) {
  return { ...room, sourcePath: path.resolve(root, room.sourcePath), source: { ...room.source, path: path.resolve(root, room.source.path) } };
}

export async function buildRepairPlan(previous, selection, history, template) {
  const rooms = [...previous.rooms.map(sourceRoom), ...selection.rooms.map(sourceRoom)];
  if (new Set(rooms.map(room => room.id)).size !== rooms.length || new Set(rooms.map(room => room.source.sha256)).size !== rooms.length) throw Error('Repair source list duplicates a prior room/source');
  const reused = previous.rooms.map(room => {
    const old = previous.jobs.find(job => job.roomId === room.id);
    return old ? { roomId: room.id, id: old.id, requestHash: old.requestHash, sourcePath: room.sourcePath,
      resultPath: path.join(base, previous.experimentId, 'jobs', old.id, 'result.json'), reason: 'Preserved earlier candidate; never overwrite user review artifact' }
      : { ...previous.reused.find(item => item.roomId === room.id), reason: 'Preserved earlier candidate/unknown outcome; explicit retry is a separate version' };
  });
  const text = template.prompt.slice(template.prompt.indexOf('\n\n') + 2, template.prompt.lastIndexOf('\n\n'));
  const jobs = [];
  const allowedAttempts = [];
  for (const id of retryRooms) {
    const room = rooms.find(room => room.id === id);
    const prior = reused.find(item => item.roomId === id);
    if (!room || !prior) throw Error(`Missing exact approved retry source/history: ${id}`);
    const oldRequest = await load(path.join(path.dirname(prior.resultPath), 'request.json'));
    const descriptor = makeJobs([room], { preservation: text }, [], template.settings, ['none']).find(job => job.model === template.model);
    const attemptId = `user-20261021-102254-${id}`;
    const approved = { id: attemptId, roomId: id, sourceSha256: room.source.sha256,
      priorRequestHash: prior.requestHash, priorResultPath: prior.resultPath };
    if (oldRequest.attachments[0].sha256 !== room.source.sha256) throw Error('Retry original differs from approved historical source');
    if (id.startsWith('Scene1201-')) {
      descriptor.prompt += `\n\n${colorClarification}`;
      descriptor.promptVariant = 'preservation-color-clarification';
      descriptor.requestHash = requestHashFor(descriptor);
    }
    descriptor.id = `${id}-${descriptor.model}-${descriptor.promptVariant}-none-${descriptor.requestHash.slice(0, 12)}-retry-20261021`;
    descriptor.retryOf = { id: prior.id, resultPath: prior.resultPath, requestHash: prior.requestHash };
    descriptor.authorizedAttempt = { id: approved.id, authorizationId, sourceSha256: approved.sourceSha256,
      priorRequestHash: approved.priorRequestHash, priorResultPath: approved.priorResultPath,
      reason: id.startsWith('Scene1201-') ? 'User-reported local surface color drift' : 'User explicitly authorizes another attempt after previously unknown outcome' };
    allowedAttempts.push(approved);
    jobs.push(descriptor);
  }
  const newRooms = rooms.slice(previous.rooms.length);
  for (const job of makeJobs(newRooms, { preservation: text }, [], template.settings, ['none']).filter(job => job.model === template.model)) {
    const prior = history.find(item => item.requestHash === job.requestHash);
    if (prior) reused.push({ roomId: job.roomId, id: prior.id, requestHash: job.requestHash, sourcePath: job.attachments[0].path,
      resultPath: prior.resultPath, reason: 'Additional source already submitted elsewhere; no blind duplicate' });
    else jobs.push(job);
  }
  const plan = { schemaVersion: 1, experimentId: 'opaque-repair-v1', project: 'gen-lang-client-0665493034', location: 'global', concurrency: 2,
    transport: 'generateContent-limited-queue-not-official-batch', explicitCaching: false,
    retryAuthorization: { id: authorizationId, userMessageTime: '2026-10-21T10:22:54Z',
      userInstruction: instruction, allowedAttempts },
    rooms, jobs, reused, maximumRequests: jobs.length, maximumAutomaticRetries: 0, requireAllNewJobs: true,
    sourceRegistry: { ...selection, priorRegistryPath: path.join(root, 'private-assets/upscaling/opaque-all-source-selection.json') },
    selectionSha256: sha(JSON.stringify(selection)),
    priorManifest: { path: path.join(base, previous.experimentId, 'experiment.json'), sha256: sha(await readFile(path.join(base, previous.experimentId, 'experiment.json'))) },
    promptChanges: { unchangedForNewSourcesAndUnknownRetries: true, scene1201Clarification: colorClarification },
    design: 'Explicitly authorized versioned retries plus newly resolved originals, with all previous candidates retained; no automatic approval.',
    implementation: await Promise.all(['repair.mjs', 'experiment.mjs', 'bulk.mjs'].map(async name => ({ path: `tools/upscaling/gemini/${name}`, sha256: sha(await readFile(new URL(name, import.meta.url))) }))) };
  await validateRepairPlan(plan, template, selection, previous);
  return plan;
}

export async function validateRepairPlan(plan, template, selection, previous) {
  const authorization = plan.retryAuthorization;
  const retries = plan.jobs?.filter(job => job.authorizedAttempt) ?? [];
  if (template.model !== 'gemini-nano-banana-2.1' || plan.project !== 'gen-lang-client-0665493034' || plan.location !== 'global' || plan.concurrency !== 2 ||
      plan.maximumRequests !== plan.jobs.length || authorization?.allowedAttempts?.length !== 4 ||
      authorization.id !== authorizationId || authorization.userMessageTime !== '2026-10-21T10:22:54Z' || authorization.userInstruction !== instruction ||
      !plan.requireAllNewJobs || plan.maximumAutomaticRetries !== 0 ||
      JSON.stringify(retries.map(job => job.roomId).sort()) !== JSON.stringify([...retryRooms].sort()) ||
      new Set(retries.map(job => job.authorizedAttempt.id)).size !== 4 ||
      new Set(plan.jobs.map(job => job.id)).size !== plan.jobs.length || !plan.rooms?.length) throw Error('Repair request budget/authorization mismatch');
  selection ??= await load(path.join(root, 'private-assets/upscaling/opaque-repair-source-selection.json'));
  previous ??= await load(path.join(base, 'opaque-all-v1/experiment.json'));
  const expectedRooms = [...previous.rooms.map(sourceRoom), ...selection.rooms.map(sourceRoom)];
  if (plan.selectionSha256 !== sha(JSON.stringify(selection)) || JSON.stringify(plan.rooms.map(room => room.id).sort()) !== JSON.stringify(expectedRooms.map(room => room.id).sort()) ||
      new Set(plan.rooms.map(room => room.id)).size !== plan.rooms.length) throw Error('Repair registry coverage mismatch');
  const selectedNewIds = new Set(selection.rooms.map(room => room.id));
  for (const room of plan.rooms) {
    const expected = expectedRooms.find(item => item.id === room.id);
    if (!room.sourcePath.startsWith(path.join(root, 'private-assets') + path.sep) || room.source.path !== room.sourcePath ||
        room.source.dimensions[0] * 3 !== room.source.dimensions[1] * 4 || !room.provenance ||
        room.source.sha256 !== expected.source.sha256 || room.sourcePath !== expected.sourcePath || room.resourceId !== expected.resourceId ||
        sha(JSON.stringify(room.provenance)) !== sha(JSON.stringify(expected.provenance)) ||
        sha(await readFile(room.sourcePath)) !== room.source.sha256) throw Error(`Invalid repair source: ${room.id}`);
  }
  for (const job of plan.jobs) {
    const room = plan.rooms.find(room => room.id === job.roomId);
    const isColorRetry = Boolean(job.authorizedAttempt && job.roomId.startsWith('Scene1201-'));
    if (job.model !== template.model || JSON.stringify(job.settings) !== JSON.stringify(template.settings) ||
        job.attachments.length !== 1 || job.referenceMode !== 'none' || requestHashFor(job) !== job.requestHash ||
        job.attachments[0].role !== 'source-composition' || job.attachments[0].mimeType !== 'image/png' || job.attachments[0].label !== undefined ||
        !room || job.attachments[0].sha256 !== room.source.sha256 || job.attachments[0].path !== room.sourcePath ||
        job.prompt !== template.prompt + (isColorRetry ? `\n\n${colorClarification}` : '')) throw Error('Repair request changed outside the authorized scope');
    validateAttempt(plan, job);
    if (job.authorizedAttempt) {
      const expectedId = `user-20261021-102254-${job.roomId}`;
      const priorJob = previous.jobs.find(item => item.roomId === job.roomId);
      const prior = priorJob ? { requestHash: priorJob.requestHash, resultPath: path.join(base, previous.experimentId, 'jobs', priorJob.id, 'result.json') }
        : previous.reused.find(item => item.roomId === job.roomId);
      if (job.authorizedAttempt.id !== expectedId || job.authorizedAttempt.priorRequestHash !== prior?.requestHash ||
          job.authorizedAttempt.priorResultPath !== prior?.resultPath || job.authorizedAttempt.sourceSha256 !== room.source.sha256) throw Error('Retry is not one of the exact four approved historical sources');
    } else if (!selectedNewIds.has(job.roomId)) throw Error('Additional job is not in the frozen verified-missed source registry');
  }
  if (plan.jobs.length !== 4 + selection.rooms.length - plan.reused.filter(item => selectedNewIds.has(item.roomId)).length ||
      new Set(plan.jobs.map(job => job.roomId)).size !== plan.jobs.length) throw Error('Repair job coverage does not match approved retries plus missed registry');
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--execute')) throw Error('Usage: node repair.mjs [--execute]');
  await mkdir(runDir, { recursive: true });
  const file = path.join(runDir, 'experiment.json');
  const template = await load(path.join(base, 'static-pilot-v1-2096d1751ccd/jobs/Scene1001-gemini-nano-banana-2.1-preservation-none-7cbaffb18ab8/request.json'));
  const plan = await exists(file) ? await load(file) : await buildRepairPlan(await load(path.join(base, 'opaque-all-v1/experiment.json')),
    await load(path.join(root, 'private-assets/upscaling/opaque-repair-source-selection.json')), await submittedHistory(base, runDir), template);
  await validateRepairPlan(plan, template);
  await freezeManifest(file, plan);
  console.log(JSON.stringify({ runDir, rooms: plan.rooms.length, newRequests: plan.jobs.length, approvedRetries: 4, preservedVersions: plan.reused.length, execute: args.includes('--execute') }));
  if (args.includes('--execute')) {
    const summary = await executeBulk(plan, runDir);
    if (!summary.complete) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

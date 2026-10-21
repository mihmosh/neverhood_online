import { readFile, readdir, mkdir, access, open, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeJobs, runJob, freezeManifest, atomicWrite, recoverJob } from './experiment.mjs';
export { claimRequest } from './experiment.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = path.join(root, 'private-assets/upscaling/gemini-experiments');
const ledgerDir = path.join(root, 'private-assets/upscaling/gemini-request-ledger');
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = file => access(file).then(() => true, () => false);
const load = file => readFile(file, 'utf8').then(JSON.parse);
const defaultRun = path.join(base, 'opaque-all-v1');
const templatePath = path.join(base, 'static-pilot-v1-2096d1751ccd/jobs/Scene1001-gemini-nano-banana-2.1-preservation-none-7cbaffb18ab8/request.json');

export async function submittedHistory(directory = base, exclude = defaultRun) {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const dir = path.join(directory, item.name);
    if (!item.isDirectory() || path.resolve(dir) === path.resolve(exclude) || !await exists(path.join(dir, 'experiment.json'))) continue;
    const plan = await load(path.join(dir, 'experiment.json'));
    for (const job of plan.jobs ?? []) {
      const resultPath = path.join(dir, 'jobs', job.id, 'result.json');
      const rawPath = path.join(dir, 'jobs', job.id, 'response-raw.json');
      if (!await exists(resultPath) && !await exists(rawPath)) continue;
      const result = await load(resultPath).catch(() => ({ status: 'outcome-unknown' }));
      if (result.requestHash && result.requestHash !== job.requestHash) throw Error(`Historical result hash mismatch: ${resultPath}`);
      entries.push({ ...job, resultPath, sourcePath: job.attachments?.[0]?.path, status: result.status });
    }
  }
  return entries;
}

export function splitJobs(jobs, history) {
  const seen = new Set();
  const fresh = [], reused = [];
  for (const job of jobs) {
    if (seen.has(job.requestHash)) throw Error('Duplicate source/request in bulk registry');
    seen.add(job.requestHash);
    const prior = history.find(old => old.requestHash === job.requestHash);
    if (prior) reused.push({ roomId: job.roomId, id: prior.id, requestHash: job.requestHash,
      sourcePath: job.attachments[0].path, resultPath: prior.resultPath, historicalStatus: prior.status,
      reason: 'Previously submitted selected-mode request; reuse or preserve unknown, never regenerate' });
    else fresh.push(job);
  }
  return { jobs: fresh, reused };
}

export async function validateBulkPlan(plan, template) {
  if (plan.schemaVersion !== 1 || plan.project !== 'gen-lang-client-0665493034' || plan.location !== 'global' ||
      plan.concurrency !== 2 || plan.maximumRequests !== plan.jobs.length || plan.maximumRequests > plan.rooms.length ||
      !plan.rooms.length || plan.jobs.length + plan.reused.length !== plan.rooms.length ||
      new Set(plan.rooms.map(room => room.id)).size !== plan.rooms.length ||
      new Set([...plan.jobs, ...plan.reused].map(job => job.requestHash)).size !== plan.jobs.length + plan.reused.length) throw Error('Invalid bulk budget/deduplication configuration');
  const privatePrefix = path.join(root, 'private-assets') + path.sep;
  for (const room of plan.rooms) {
    if (!path.resolve(room.sourcePath).startsWith(privatePrefix) || room.source.path !== room.sourcePath ||
        !room.provenance || !room.resourceId || room.source.role !== 'source-composition' ||
        room.source.mimeType !== 'image/png' || room.source.dimensions?.[0] * 3 !== room.source.dimensions?.[1] * 4 ||
        sha(await readFile(room.sourcePath)) !== room.source.sha256) throw Error(`Invalid original background: ${room.id}`);
  }
  for (const job of plan.jobs) {
    if (job.model !== 'gemini-nano-banana-2.1' || job.prompt !== template.prompt ||
        JSON.stringify(job.settings) !== JSON.stringify(template.settings) || job.attachments.length !== 1 ||
        job.referenceMode !== 'none' || job.promptVariant !== 'preservation') throw Error(`Selected-mode invariant failed: ${job.id}`);
    const room = plan.rooms.find(room => room.id === job.roomId);
    if (!room || job.attachments[0].sha256 !== room.source.sha256) throw Error('Job/source binding mismatch');
    const expected = makeJobs([room], { preservation: template.prompt.slice(template.prompt.indexOf('\n\n') + 2, template.prompt.lastIndexOf('\n\n')) }, [], template.settings, ['none']).find(item => item.model === template.model);
    if (job.requestHash !== expected.requestHash || job.id !== expected.id) throw Error('Job request hash mismatch');
  }
}

export async function buildBulkPlan(selection, history, template) {
  const rooms = selection.rooms.map(room => ({ ...room, sourcePath: path.resolve(root, room.sourcePath),
    source: { ...room.source, path: path.resolve(root, room.source.path) } }));
  if (!rooms.length || new Set(rooms.map(room => room.source.sha256)).size !== rooms.length) throw Error('Empty or duplicate source registry');
  const text = template.prompt.slice(template.prompt.indexOf('\n\n') + 2, template.prompt.lastIndexOf('\n\n'));
  const allJobs = makeJobs(rooms, { preservation: text }, [], template.settings, ['none']).filter(job => job.model === template.model);
  const split = splitJobs(allJobs, history);
  const plan = { schemaVersion: 1, experimentId: 'opaque-all-v1', project: 'gen-lang-client-0665493034', location: 'global',
    authorization: 'User 2026-10-21T09:02:08Z: generate all backgrounds in checked 2K mode; deterministically validate and analyze failures.',
    design: 'One selected-mode candidate per unique verified opaque original; deduplicate all historical submitted requests including unknowns.',
    transport: 'generateContent-limited-queue-not-official-batch', explicitCaching: false, concurrency: 2,
    rooms, ...split, maximumRequests: split.jobs.length,
    selectionSha256: sha(JSON.stringify(selection)), sourceRegistry: selection,
    implementation: { node: process.version, files: await Promise.all(['bulk.mjs', 'experiment.mjs'].map(async name => ({ path: `tools/upscaling/gemini/${name}`, sha256: sha(await readFile(new URL(name, import.meta.url))) }))) },
    caveats: ['Native output preserved, not a 2560x1920 runtime replacement.', 'Deterministic technical validity is not proof of structural fidelity.', 'No automatic paid retries, extra variants or runtime promotion.'] };
  await validateBulkPlan(plan, template);
  return plan;
}

async function acquireRunLock(runDir) {
  const file = path.join(runDir, 'execution-lock.json');
  const nonce = randomUUID();
  try {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(json({ pid: process.pid, nonce, startedAt: new Date().toISOString() })); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await load(file).catch(() => null);
    if (!prior?.pid) throw Error('Existing unreadable execution lock; no job state changed');
    try { process.kill(prior.pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      if ((await load(file)).nonce !== prior.nonce) throw Error('Execution lock changed');
      await unlink(file);
      return acquireRunLock(runDir);
    }
    throw Error(`Bulk runner already active with PID ${prior.pid}; no job state changed`);
  }
  return async () => { if ((await load(file).catch(() => null))?.nonce === nonce) await unlink(file); };
}

export async function executeBulk(plan, runDir, options = {}) {
  const release = await acquireRunLock(runDir);
  try { return await executeUnlocked(plan, runDir, options); }
  finally { await release(); }
}

async function executeUnlocked(plan, runDir, options) {
  const history = options.history ?? await submittedHistory(base, runDir);
  const reusedResults = [];
  for (const reused of plan.reused) {
    const oldRun = path.resolve(path.dirname(reused.resultPath), '../..');
    try {
      const descriptor = await load(path.join(path.dirname(reused.resultPath), 'request.json'));
      if (descriptor.requestHash !== reused.requestHash) throw Error('Reused request hash mismatch');
      await recoverJob(descriptor, oldRun);
    } catch (error) {
      // Missing raw responses are never grounds for a replacement generation.
      if (error.code !== 'ENOENT') console.error(JSON.stringify({ id: reused.id, action: 'historical-recovery-unavailable', error: error.message }));
    }
    reusedResults.push({ roomId: reused.roomId, ...await load(reused.resultPath).catch(() => ({ id: reused.id, status: 'outcome-unknown' })) });
  }
  let next = 0;
  const failures = [];
  await Promise.all(Array.from({ length: plan.concurrency }, async () => {
    while (next < plan.jobs.length) {
      const job = plan.jobs[next++];
      const dir = path.join(runDir, 'jobs', job.id);
      const resultPath = path.join(dir, 'result.json');
      try {
        await recoverJob(job, runDir);
        if (await exists(resultPath)) {
          await runJob(plan, job, runDir, options.dependencies);
          continue;
        }
        const prior = history.find(old => old.requestHash === job.requestHash);
        if (prior && !job.authorizedAttempt) {
          await mkdir(dir, { recursive: true });
          await atomicWrite(resultPath, json({ id: job.id, requestHash: job.requestHash, status: 'blocked-prior-submission', priorResultPath: prior.resultPath, images: [], error: 'Historical request submitted after manifest freeze; no new request sent' }));
          continue;
        }
        await runJob(plan, job, runDir, { ...options.dependencies, ledgerDir: options.ledgerDir ?? ledgerDir });
      } catch (error) {
        failures.push({ id: job.id, error: error.message });
        // A local preflight failure must not send a request on a later blind resume.
        if (!await exists(resultPath)) {
          await mkdir(dir, { recursive: true });
          await atomicWrite(resultPath, json({ id: job.id, requestHash: job.requestHash, status: 'blocked-local-error', images: [], error: error.message }));
        }
        console.error(JSON.stringify({ id: job.id, action: 'blocked-no-retry', error: error.message }));
      }
    }
  }));
  const results = await Promise.all(plan.jobs.map(job => load(path.join(runDir, 'jobs', job.id, 'result.json'))));
  const counts = results.reduce((counts, result) => { counts[result.status] = (counts[result.status] ?? 0) + 1; return counts; }, {});
  const reusedCounts = reusedResults.reduce((counts, result) => { counts[result.status] = (counts[result.status] ?? 0) + 1; return counts; }, {});
  const successfulRooms = new Set([
    ...results.filter(result => result.status === 'succeeded').map(result => plan.jobs.find(job => job.id === result.id)?.roomId),
    ...reusedResults.filter(result => result.status === 'succeeded').map(result => result.roomId),
  ]);
  const summary = { experimentId: plan.experimentId, manifestSha256: sha(await readFile(path.join(runDir, 'experiment.json'))), counts, reusedCounts,
    plannedNewRequests: plan.jobs.length, reusedHistorical: plan.reused.length, failures, results, reusedResults,
    queueTraversalFinished: true, allAttemptsSucceeded: [...results, ...reusedResults].every(result => result.status === 'succeeded'),
    complete: (!plan.requireAllNewJobs || results.every(result => result.status === 'succeeded')) &&
      (plan.rooms?.length ? plan.rooms.every(room => successfulRooms.has(room.id)) : [...results, ...reusedResults].every(result => result.status === 'succeeded')) };
  await atomicWrite(path.join(runDir, 'run-summary.json'), json(summary));
  console.log(JSON.stringify({ runDir, counts, reused: plan.reused.length }));
  return summary;
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--execute'].includes(arg))) throw Error('Usage: node bulk.mjs [--execute]');
  const runDir = defaultRun;
  await mkdir(runDir, { recursive: true });
  const file = path.join(runDir, 'experiment.json');
  const template = await load(templatePath);
  const plan = await exists(file) ? await load(file) : await buildBulkPlan(await load(path.join(root, 'private-assets/upscaling/opaque-all-source-selection.json')), await submittedHistory(), template);
  await validateBulkPlan(plan, template);
  await freezeManifest(file, plan);
  console.log(JSON.stringify({ runDir, sources: plan.rooms.length, jobs: plan.jobs.length, reused: plan.reused.length, execute: args.includes('--execute'), manifestSha256: sha(await readFile(file)) }));
  if (args.includes('--execute')) {
    const summary = await executeBulk(plan, runDir);
    if (!summary.complete) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

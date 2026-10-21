import { readFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { freezeManifest, requestHashFor, validateAttempt } from './experiment.mjs';
import { executeBulk } from './bulk.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const privateRoot = path.join(root, 'private-assets');
const run = path.join(privateRoot, 'upscaling/gemini-experiments/manual-rework-20261021');
const load = file => readFile(file, 'utf8').then(JSON.parse);
const sha = data => createHash('sha256').update(data).digest('hex');
const exists = file => access(file).then(() => true, () => false);
const reviewHash = 'edb0ae7286c7ebd4483a39526d110e030c8034f9271ba0d7797d019071791c81';
const authorizationId = 'manual-review-20261021T123623Z';
const selected = [
  { id: 'opaque-pilot-v1::Scene1308-gemini-nano-banana-2.1-preservation-none-a560e5bbd66e::0',
    sourceSha256: '2b104311fc1dc30e0a39fcc79b95062c9131ebfe7c676d1b73cfe8e754f36c22',
    outputSha256: '8f6805c6fa3b7afe20886387e9326892e6bea068f2d24bbd1afabd0bf7424ee3', decision: 'rework', notes: '' },
  { id: 'opaque-repair-v1::Scene2704-1080CF0C-bcca9817-gemini-nano-banana-2.1-preservation-none-df077cdc6000::0',
    sourceSha256: '11b7d82bc8d661f12cbb0285dca8bca54923467d1cce26460ac6b345212156da',
    outputSha256: '6ac5e14fcc6fd9855c42e809d1464a6c2f1d88f0fc4138cbf4900c33277b5902', decision: 'rework', notes: '' },
];

async function prepare() {
  const review = await load(path.join(privateRoot, 'upscaling/gemini-review-all/manual-review-data.json'));
  if (review.manifestSha256 !== reviewHash) throw Error('Review export does not match the current catalog');
  const jobs = [], rooms = [], allowedAttempts = [];
  for (const decision of selected) {
    const row = review.rooms.find(row => row.id === decision.id);
    if (!row || row.source.sha256 !== decision.sourceSha256 || row.output?.sha256 !== decision.outputSha256 || !row.canApprove) throw Error('Reviewed artifact identity mismatch');
    if (sha(await readFile(row.source.path)) !== decision.sourceSha256 || sha(await readFile(row.output.path)) !== decision.outputSha256) throw Error('Reviewed image bytes changed');
    const priorResultPath = path.resolve(privateRoot, row.provenance.result);
    if (!priorResultPath.startsWith(privateRoot + path.sep)) throw Error('Prior result escapes private assets');
    const previous = await load(path.join(path.dirname(priorResultPath), 'request.json'));
    if (previous.model !== 'gemini-nano-banana-2.1' || previous.attachments.length !== 1 || requestHashFor(previous) !== previous.requestHash) throw Error('Prior selected-mode request is invalid');
    const id = `review-20261021-123623-${previous.roomId}`;
    const approved = { id, roomId: previous.roomId, sourceSha256: decision.sourceSha256,
      priorRequestHash: previous.requestHash, priorResultPath };
    allowedAttempts.push(approved);
    jobs.push({ ...previous, id: previous.id + '-manual-rework-20261021-123623',
      authorizedAttempt: { id, authorizationId, sourceSha256: approved.sourceSha256,
        priorRequestHash: approved.priorRequestHash, priorResultPath,
        reason: 'User explicitly marked this exact source/output artifact rework in the supplied schema2 review export; one new candidate only' },
      reviewedOutputSha256: decision.outputSha256 });
    const priorPlan = await load(path.resolve(path.dirname(priorResultPath), '../../experiment.json'));
    const room = priorPlan.rooms.find(room => room.id === previous.roomId);
    if (!room) throw Error('Original room binding unavailable');
    rooms.push(room);
  }
  return { schemaVersion: 1, experimentId: 'manual-rework-20261021', project: 'gen-lang-client-0665493034', location: 'global',
    concurrency: 2, maximumRequests: 2, maximumAutomaticRetries: 0, requireAllNewJobs: true,
    transport: 'generateContent-limited-queue-not-official-batch', explicitCaching: false,
    retryAuthorization: { id: authorizationId, userMessageTime: '2026-10-21T12:36:23Z',
      userInstruction: 'Reprocess only the exact artifacts explicitly marked rework in the supplied review export; preserve all other results and older versions',
      allowedAttempts },
    reviewSelection: { schemaVersion: 2, manifestSha256: reviewHash, decisions: selected,
      note: 'Exact actionable rework subset of the user-provided export; other approvals/pending decisions remain in browser storage and are not changed here.' },
    jobs, rooms, reused: [] };
}

await mkdir(run, { recursive: true });
const manifest = path.join(run, 'experiment.json');
const plan = await exists(manifest) ? await load(manifest) : await prepare();
if (plan.maximumRequests !== 2 || plan.jobs.length !== 2 || plan.retryAuthorization.id !== authorizationId) throw Error('Manual rework request cap mismatch');
for (const job of plan.jobs) validateAttempt(plan, job);
await freezeManifest(manifest, plan);
console.log(JSON.stringify({ run, requests: 2, execute: process.argv.includes('--execute') }));
if (process.argv.includes('--execute')) {
  const summary = await executeBulk(plan, run);
  if (!summary.complete) process.exitCode = 1;
}

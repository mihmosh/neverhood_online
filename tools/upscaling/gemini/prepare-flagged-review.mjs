import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freezeManifest } from './experiment.mjs';
import { profileFingerprint } from './judge.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = file => readFile(file, 'utf8').then(JSON.parse);

export async function prepare(directory) {
  const run = path.resolve(directory);
  if (!run.includes(`${path.sep}private-assets${path.sep}`)) throw Error('Private run required');
  const checked = await load(path.join(run, 'bulk-check.json'));
  const original = await load(path.join(run, 'experiment.json'));
  const flags = checked.failures.filter(item => item.status === 'heuristic-review-flag' && item.judgingInputs?.fullPair?.source && item.judgingInputs?.fullPair?.candidate);
  const review = path.join(run, 'flagged-structural-review');
  await mkdir(review, { recursive: true });
  const jobs = flags.map(flag => original.jobs.find(job => job.id === flag.id)).filter(Boolean);
  if (jobs.length !== flags.length) throw Error('Flagged review is limited to new frozen generation jobs');
  const rooms = {}, evaluations = [];
  for (const flag of flags) {
    const pair = flag.judgingInputs;
    const regions = pair.crops.map(crop => ({ id: crop.id, label: `Fixed spatial cell ${crop.id}; not a hand-inventoried object`, box: crop.box }));
    rooms[flag.roomId] = regions;
    for (const image of [pair.fullPair.source, pair.fullPair.candidate, ...pair.crops.flatMap(crop => [crop.source, crop.candidate])]) {
      if (!image || sha(await readFile(image.path)) !== image.sha256) throw Error('Stale diagnostic image');
    }
    const dir = path.join(review, 'jobs', flag.id);
    await mkdir(dir, { recursive: true });
    await freezeManifest(path.join(dir, 'object-inputs.json'), {
      sourceSha256: pair.fullPair.source.sha256, candidateSha256: pair.fullPair.candidate.sha256,
      profileFingerprint: profileFingerprint(regions),
      regions: regions.map((region, i) => ({ ...region, sourcePath: pair.crops[i].source.path, candidatePath: pair.crops[i].candidate.path })),
      caveat: 'Frozen deterministic spatial grid, not source-only semantic inventories. Judge sees full originals and candidates plus every paired cell; no expected score or flag cause supplied.' });
    evaluations.push({ id: flag.roomId, entries: [{ kind: 'source', path: pair.fullPair.source.path },
      { kind: 'candidate', id: flag.id, path: pair.fullPair.candidate.path }] });
  }
  await freezeManifest(path.join(review, 'experiment.json'), { schemaVersion: 1, experimentId: 'opaque-all-v1-flagged-structural-review',
    project: original.project, location: original.location, jobs,
    regionProfiles: { schemaVersion: 1, rooms }, maximumJudgeRequests: jobs.length,
    generationRequestsAuthorized: 0,
    scope: 'One independent object/shape assessment per heuristic-flagged new result; no re-generation or automatic approval.' });
  await freezeManifest(path.join(review, 'eval.json'), { rooms: evaluations });
  console.log(JSON.stringify({ runDir: review, flaggedCandidates: jobs.length, paidRequestsSent: 0 }));
  return review;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}

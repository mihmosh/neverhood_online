import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = file => readFile(file, 'utf8').then(JSON.parse);
function usageTotal(records) {
  const totals = {};
  const actualCounters = [];
  for (const record of records) {
    const usage = record.usage ?? record.response?.usageMetadata;
    actualCounters.push({ id: record.id, usage: usage ?? null });
    for (const [key, value] of Object.entries(usage ?? {})) {
      if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return { totals, actualCounters, observedCacheHits: actualCounters.filter(item => item.usage?.cachedContentTokenCount > 0).length,
    note: 'Missing cachedContentTokenCount is not evidence of a cache hit. No measured savings claimed.' };
}

export async function summarize(directory) {
  const runDir = path.resolve(directory);
  const plan = await readJson(path.join(runDir, 'experiment.json'));
  const generation = [];
  const judges = [];
  const decisions = { reject: 0, review: 0, blocked: 0, 'no-structural-change-detected': 0 };
  const evaluation = await readJson(path.join(runDir, 'eval.json')).catch(() => ({ rooms: [] }));
  for (const job of plan.jobs) {
    const dir = path.join(runDir, 'jobs', job.id);
    generation.push(await readJson(path.join(dir, 'result.json')).catch(() => ({ id: job.id, status: 'not-submitted' })));
    const judge = await readJson(path.join(dir, 'judge-objects-v2.json')).catch(() => null);
    if (judge) judges.push(judge);
    const entry = evaluation.rooms.flatMap(room => room.entries).find(entry => entry.kind === 'candidate' && entry.id === job.id);
    const verdict = entry?.decision?.verdict ?? 'blocked';
    decisions[verdict] = (decisions[verdict] ?? 0) + 1;
  }
  const unknown = generation.filter(item => item.status.includes('unknown'));
  const summary = { schemaVersion: 1, experimentId: plan.experimentId,
    manifestSha256: createHash('sha256').update(await readFile(path.join(runDir, 'experiment.json'))).digest('hex'),
    planned: plan.jobs.length, submitted: generation.filter(item => item.status !== 'not-submitted').length,
    succeeded: generation.filter(item => item.status === 'succeeded').length,
    failed: generation.filter(item => item.status === 'failed').length,
    unknown: unknown.length, unknownJobIds: unknown.map(item => item.id),
    structuralDecisions: decisions, automaticApproval: false,
    transport: plan.transport, officialBatchId: null, explicitCaching: plan.explicitCaching,
    generationUsage: usageTotal(generation), judgeUsage: usageTotal(judges),
    judgeRequests: judges.length, judgeSucceeded: judges.filter(item => item.status === 'succeeded').length,
    judgeUnknownOrFailed: judges.filter(item => item.status !== 'succeeded').length,
    usageCoverage: { generationResponses: generation.filter(item => item.usage).length, generationSubmitted: generation.filter(item => item.status !== 'not-submitted').length,
      judgeResponses: judges.filter(item => item.response?.usageMetadata || item.usage).length, judgeSubmitted: judges.length,
      note: 'Usage totals cover returned responses only. Unknown outcomes can incur charges not represented here.' },
    actualModelVersions: { generation: [...new Set(generation.map(item => item.modelVersion).filter(Boolean))],
      judge: [...new Set(judges.map(item => item.response?.modelVersion).filter(Boolean))] },
    cost: { status: 'unverified', confirmedAmount: null, note: 'Usage is measured; billing invoice/cost export not verified. Do not interpret catalog prices as confirmed charges.' },
    nativeOutputDimensions: [...new Set(generation.flatMap(item => (item.images ?? []).filter(image => !image.thought).map(image => JSON.stringify(image.dimensions))))].map(JSON.parse),
    stoppedAfterPilot: true, runtimePromotion: false };
  await writeFile(path.join(runDir, 'pilot-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  summarize(process.argv[2]).then(summary => console.log(JSON.stringify(summary, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}

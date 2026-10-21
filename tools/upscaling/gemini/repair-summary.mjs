import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './experiment.mjs';

const load = file => readFile(file, 'utf8').then(JSON.parse);

export async function summarize(directory) {
  const run = path.resolve(directory);
  if (!run.includes(`${path.sep}private-assets${path.sep}`)) throw Error('Private repair directory required');
  const [plan, queue, check, review, colors, browser] = await Promise.all([
    'experiment.json', 'run-summary.json', 'bulk-check.json', 'manual-review-data.json',
    'repair-color-analysis.json', 'manual-review-verification.json',
  ].map(file => load(path.join(run, file))));
  const pairDir = path.join(run, '../paired-lighting-v1');
  const pairPlan = await load(path.join(pairDir, 'experiment.json'));
  const pair = await load(path.join(pairDir, 'pair-check.json'));
  const pairRecord = await load(path.join(pairDir, 'jobs', pairPlan.jobs[0].id, 'result.json'));
  const usage = pair.usage ?? {};
  const output = Object.fromEntries((usage.candidatesTokensDetails ?? []).map(item => [item.modality, item.tokenCount]));
  const rates = check.usage.generation.catalogPriceEstimate.ratesUsdPerMillionTokens;
  const cached = usage.cachedContentTokenCount ?? 0;
  const pairEstimate = (((usage.promptTokenCount ?? 0) - cached) * rates.input + cached * rates.cachedInput +
    (output.IMAGE ?? 0) * rates.imageOutput + ((output.TEXT ?? 0) + (usage.thoughtsTokenCount ?? 0)) * rates.textAndThoughtOutput) / 1e6;
  const availableRows = review.rooms.filter(room => room.available);
  const summary = { schemaVersion: 1, experimentId: plan.experimentId, manifestSha256: check.manifest.sha256,
    independentRequestsSubmitted: queue.results.filter(result => result.responseId || result.status.includes('unknown')).length,
    independentSucceeded: queue.counts.succeeded ?? 0,
    independentFailed: queue.counts.failed ?? 0,
    independentUnknown: queue.results.filter(result => result.status.includes('unknown')).length,
    requiredRepairsCompleted: queue.complete, approvedRetryAttempts: plan.jobs.filter(job => job.authorizedAttempt).length,
    additionalOriginalStates: plan.rooms.length - plan.reused.length,
    uniqueOriginalStates: new Set(review.rooms.map(room => room.roomId)).size,
    statesWithSavedResult: new Set(availableRows.map(room => room.roomId)).size,
    savedIndependentVersionsIncludingHistory: availableRows.length,
    archivedAttemptsWithoutImage: review.rooms.length - availableRows.length,
    archivedUnknownsAreNotMissingCurrentStates: true,
    nativeDimensions: check.nativeDimensions, imageValidity: check.counts.imageStatuses,
    provenance: check.counts.provenanceStatuses, visualReview: check.counts.visualReviewStatuses,
    automaticApproval: false, visualWarningsAreNotFailures: true,
    scene1201: colors.rooms.map(room => ({ roomId: room.roomId,
      oldWarningCells: room.old.localizedWarningPatchCount, newWarningCells: room.new.localizedWarningPatchCount,
      limitedConclusion: room.limitedConclusion })),
    pairedExperiment: { submitted: pairRecord.responseId ? 1 : null, transportStatus: pairRecord.status,
      protocolStatus: pair.status, requestedFinalImages: 2, actualFinalImages: pair.actualFinalImages,
      mapping: pair.mapping, issues: pair.issues, usage: pair.usage, catalogEstimateUsd: pairEstimate,
      conclusion: 'One continuous scene returned, not two separate backgrounds. No mapping or automatic retry; not adopted for bulk.' },
    generationUsage: check.usage.generation,
    newPassCatalogEstimateUsd: check.usage.generation.catalogPriceEstimate.usd + pairEstimate,
    billingVerified: false, confirmedBillingCost: null,
    confirmedCacheHits: check.usage.generation.observedCacheHits + (cached > 0 ? 1 : 0),
    cacheNote: 'Missing counters are not cache hits. No measured cache savings claimed.',
    manualReview: { path: 'review.html', verification: browser.results },
    coverage: { sourceRegistry: 'private-assets/upscaling/opaque-repair-source-selection.json',
      originalsNotGeneratedPage: 'coverage-review.html', remainingDispositions: plan.sourceRegistry.coverage?.dispositionCounts },
    additionalPaidJudgeRequests: 0, furtherGeneration: 'stopped-for-human-review', runtimePromotion: false };
  await atomicWrite(path.join(run, 'repair-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  summarize(process.argv[2]).then(summary => console.log(JSON.stringify({ independentSucceeded: summary.independentSucceeded,
    statesWithSavedResult: summary.statesWithSavedResult, independentVersions: summary.savedIndependentVersionsIncludingHistory,
    pairedProtocol: summary.pairedExperiment.protocolStatus, newPassCatalogEstimateUsd: summary.newPassCatalogEstimateUsd })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

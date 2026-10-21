import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, access, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const model = 'gemini-4-argon';
const evaluationVersion = 'objects-v2';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rubric = `You are a strict object/shape consistency inspector for restoration of a game background, not a pixel similarity scorer or an aesthetic judge. Image A is the ORIGINAL and sole authority for objects, geometry and composition. Image B is a restoration candidate. You are blind to the generator, its prompt and reference condition.
First inspect the two full frames for ADDED or REMOVED objects and changed scene composition. Then inspect EVERY registered region using the attached A/B detail crops. Compare object presence, OUTER SILHOUETTE, INTERNAL GEOMETRY (holes, recesses, internal divisions, ridges, cutouts), counts and arrangement. An object can still be the same category and occupy the same place while its internal form has been wrongly redesigned. A new hole, reshaped mechanism or altered rung arrangement is structural drift, even if the overall image is similar. Check negative space as well as solid forms.
Do not use pixel matching, MAE, PSNR, sharpness, photographic realism or color/lighting differences as evidence of shape preservation or as substitutes for inspecting shapes. Harmless material grain, denoising, compression cleanup, small fingerprints and highlight differences alone are NOT object hallucinations. A texture is an error only when it creates or removes a distinct object part, contour or opening. Do not invent structure hidden by the original's low resolution or partial visibility. If a shape cannot be verified, explicitly mark it uncertain instead of preserved. Only clear visible changes should be called changed.
Return ONLY JSON: {"global":{"addedObjects":["description, location and visible evidence"],"removedObjects":["description, location and visible evidence"],"composition":{"status":"preserved|changed|uncertain","evidence":"comparison evidence"}},"objects":[{"id":"EXACT registered region id","presence":"preserved|changed|uncertain","silhouette":"preserved|changed|uncertain","internalGeometry":"preserved|changed|uncertain","count":"preserved|changed|uncertain","evidence":"Specific visible A versus B observations for this object, including all changed/uncertain fields"}],"uncertainties":["specific unresolved observations"]}.
Return one object assessment per registered region, no missing or duplicate IDs. Do not return a score, ranking, final verdict or approval. The caller applies hard structural rejection rules.`;
const statuses = ['preserved', 'changed', 'uncertain'];
const properties = ['presence', 'silhouette', 'internalGeometry', 'count'];
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0);

export function validateProfiles(profile) {
  if (profile?.schemaVersion !== 1 || !profile.rooms || typeof profile.rooms !== 'object' || Array.isArray(profile.rooms)) throw Error('Invalid object region profiles');
  for (const regions of Object.values(profile.rooms)) {
    if (!Array.isArray(regions) || !regions.length) throw Error('Object regions must be a nonempty list');
    const ids = new Set();
    for (const region of regions) {
      const box = region?.box;
      if (typeof region?.id !== 'string' || !region.id || ids.has(region.id) || typeof region.label !== 'string'
        || !Array.isArray(box) || box.length !== 4 || box.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)
        || box[0] >= box[2] || box[1] >= box[3]) throw Error('Invalid object region');
      ids.add(region.id);
    }
  }
  return profile.rooms;
}

export function profileFingerprint(regions) {
  return hash(JSON.stringify(regions.map(region => [region.id, region.label, region.box.map(n => {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(n);
    return bytes.toString('hex');
  })])));
}

// The durable exclusive record is also the lock. Unknown outcomes are never retried.
export async function claimJudgment(output, record) {
  let handle;
  try {
    handle = await open(output, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(output), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return true;
}

export function parseJudgment(text, regionIds) {
  const result = JSON.parse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('Invalid object judgment');
  if (!strings(result.global?.addedObjects) || !strings(result.global?.removedObjects) || !strings(result.uncertainties)) throw Error('Missing object inventory or uncertainties');
  if (!statuses.includes(result.global?.composition?.status) || typeof result.global.composition.evidence !== 'string' || !result.global.composition.evidence.trim()) throw Error('Invalid composition assessment');
  if (!Array.isArray(result.objects) || result.objects.length !== regionIds.length || new Set(result.objects.map(item => item?.id)).size !== regionIds.length) throw Error('Missing or duplicate object assessment');
  for (const item of result.objects) {
    if (!regionIds.includes(item?.id) || properties.some(key => !statuses.includes(item[key])) || typeof item.evidence !== 'string' || !item.evidence.trim()) throw Error('Invalid object assessment');
  }
  return result;
}

export function decide(judgment) {
  const reject = [...judgment.global.addedObjects.map(item => `Added object: ${item}`),
    ...judgment.global.removedObjects.map(item => `Removed object: ${item}`)];
  const uncertain = [...judgment.uncertainties];
  if (judgment.global.composition.status === 'changed') reject.push(`Composition changed: ${judgment.global.composition.evidence}`);
  if (judgment.global.composition.status === 'uncertain') uncertain.push(`Composition uncertain: ${judgment.global.composition.evidence}`);
  for (const item of judgment.objects) {
    for (const key of properties) {
      if (item[key] === 'changed') reject.push(`${item.id}: ${key} changed. ${item.evidence}`);
      if (item[key] === 'uncertain') uncertain.push(`${item.id}: ${key} uncertain. ${item.evidence}`);
    }
  }
  return { verdict: reject.length ? 'reject' : uncertain.length ? 'review' : 'no-structural-change-detected',
    reasons: [...reject, ...uncertain], automaticApproval: false };
}

async function main() {
  const [directory, execute, ...rest] = process.argv.slice(2);
  if (!directory || (execute && execute !== '--execute') || rest.length) throw Error('Usage: node judge.mjs RUN_DIR [--execute]');
  const runDir = path.resolve(directory);
  const plan = JSON.parse(await readFile(path.join(runDir, 'experiment.json'), 'utf8'));
  if (plan.schemaVersion !== 1) throw Error('experiment.json must have schemaVersion 1');
  const evaluation = JSON.parse(await readFile(path.join(runDir, 'eval.json'), 'utf8'));
  const profiles = validateProfiles(Object.hasOwn(plan, 'regionProfiles')
    ? { schemaVersion: 1, ...plan.regionProfiles }
    : JSON.parse(await readFile(new URL('object-regions.json', import.meta.url), 'utf8')));
  const pairs = evaluation.rooms.flatMap(room => room.entries.filter(e => e.kind === 'candidate').map(candidate => ({ roomId: room.id, candidate, source: room.entries.find(e => e.kind === 'source') })));
  console.log(JSON.stringify({ model, evaluationVersion, pairs: pairs.length, execute: Boolean(execute) }));
  if (!execute) return;
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (next < pairs.length) {
      const { roomId, candidate, source } = pairs[next++];
       const expectedRegions = profiles[roomId];
      if (!expectedRegions?.length) throw Error(`No source-only object profile: ${roomId}`);
       if (typeof candidate.id !== 'string' || !candidate.id || ['.', '..'].includes(candidate.id) || path.basename(candidate.id) !== candidate.id) throw Error('Invalid candidate id');
       const dir = path.join(runDir, 'jobs', candidate.id);
      const cropInputs = JSON.parse(await readFile(path.join(dir, 'object-inputs.json'), 'utf8'));
      const sourceBytes = await readFile(source.path);
      const candidateBytes = await readFile(candidate.path);
      if (cropInputs.sourceSha256 !== hash(sourceBytes) || cropInputs.candidateSha256 !== hash(candidateBytes)) throw Error(`Stale object crops: ${candidate.id}`);
       if (cropInputs.regions.length !== expectedRegions.length || new Set(cropInputs.regions.map(r => r.id)).size !== expectedRegions.length
         || expectedRegions.some(region => !cropInputs.regions.some(c => c.id === region.id && c.label === region.label && JSON.stringify(c.box) === JSON.stringify(region.box)))
         || (cropInputs.profileFingerprint && cropInputs.profileFingerprint !== profileFingerprint(expectedRegions))) throw Error(`Incomplete or stale object crops: ${candidate.id}`);
      const output = path.join(dir, 'judge-objects-v2.json');
      const prompt = `${rubric}\nRegistered regions: ${JSON.stringify(expectedRegions)}`;
      const inputs = [];
      const parts = [{ text: prompt }];
      async function append(file, role, label) {
        const bytes = await readFile(file);
        inputs.push({ role, sha256: hash(bytes), path: file });
        const mimeType = path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
        parts.push({ text: label }, { inlineData: { mimeType, data: bytes.toString('base64') } });
      }
      await append(source.path, 'source', 'Image A: original full frame');
      await append(candidate.path, 'candidate', 'Image B: candidate full frame');
      for (const region of cropInputs.regions) {
        await append(region.sourcePath, `source-crop:${region.id}`, `Region ${region.id}, ORIGINAL A detail`);
        await append(region.candidatePath, `candidate-crop:${region.id}`, `Region ${region.id}, CANDIDATE B detail`);
      }
      const requestHash = hash(JSON.stringify({ model, prompt, inputs: inputs.map(({ role, sha256 }) => ({ role, sha256 })) }));
      if (await access(output).then(() => true, () => false)) {
        const existing = JSON.parse(await readFile(output, 'utf8'));
        if (existing.requestHash !== requestHash) throw Error(`Existing object judgment has a different request hash: ${candidate.id}`);
        if (existing.status !== 'succeeded') failed = true;
        console.log(JSON.stringify({ id: candidate.id, action: 'skip-existing', status: existing.status }));
        continue;
      }
       const record = { schemaVersion: 2, evaluationVersion, id: candidate.id, model, rubric: prompt, requestHash, inputs,
         profileFingerprint: profileFingerprint(expectedRegions), rubricFingerprint: hash(rubric),
         startedAt: new Date().toISOString(), status: 'in-flight-outcome-unknown',
         caveat: 'Model-assisted object inspection, not a validated detector or independent ground truth. No automatic approval.' };
       if (!await claimJudgment(output, record)) {
         failed = true;
         console.log(JSON.stringify({ id: candidate.id, action: 'blocked-concurrent-claim-no-retry' }));
         continue;
       }
       let body;
       try {
         const token = execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
         record.requestStartedAt = new Date().toISOString();
        const response = await fetch(`https://aiplatform.googleapis.com/v1/projects/${plan.project}/locations/global/publishers/google/models/${model}:generateContent`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': plan.project, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 6144 } }), signal: AbortSignal.timeout(240_000),
        });
         body = await response.json();
        record.httpStatus = response.status;
        record.response = body;
        if (!response.ok) throw Error(body.error?.message || `HTTP ${response.status}`);
        record.judgment = parseJudgment((body.candidates?.[0]?.content?.parts ?? []).filter(p => p.text && !p.thought).map(p => p.text).join(''), expectedRegions.map(r => r.id));
        record.decision = decide(record.judgment);
        record.status = 'succeeded';
      } catch (error) {
        record.status = 'failed-or-outcome-unknown-no-auto-retry';
        record.error = error.message;
        failed = true;
       }
       record.finishedAt = new Date().toISOString();
       const usage = { schemaVersion: 1, id: candidate.id, model, requestHash,
         status: record.status, startedAt: record.startedAt, requestStartedAt: record.requestStartedAt ?? null,
         finishedAt: record.finishedAt, responseId: body?.responseId ?? null, modelVersion: body?.modelVersion ?? null,
         finishReasons: (body?.candidates ?? []).map(c => c.finishReason ?? null),
         usageMetadata: body?.usageMetadata ?? null, httpStatus: record.httpStatus ?? null, error: record.error ?? null };
       await writeFile(path.join(dir, 'judge-objects-v2-usage.json'), `${JSON.stringify(usage, null, 2)}\n`, { mode: 0o600 });
       await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      console.log(JSON.stringify({ id: candidate.id, status: record.status, verdict: record.decision?.verdict, reasons: record.decision?.reasons, error: record.error }));
    }
  }));
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

import { readFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requestHashFor, freezeManifest, runJob, recoverJob, atomicWrite } from './experiment.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = path.join(root, 'private-assets/upscaling/gemini-experiments');
const directory = path.join(base, 'paired-lighting-v1');
const load = file => readFile(file, 'utf8').then(JSON.parse);
const exists = file => access(file).then(() => true, () => false);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export async function buildPairPlan(selection, previous, template) {
  const pair = selection.pairedExperiment;
  if (!pair?.evidence || !pair.stateA?.roomId || !pair.stateB?.roomId || pair.stateA.roomId === pair.stateB.roomId) throw Error('No verified same-view lighting pair supplied');
  const rooms = [pair.stateA, pair.stateB].map(state => {
    const room = [...selection.rooms, ...previous.rooms].find(room => room.id === state.roomId);
    if (!room) throw Error('Lighting source room missing');
    return { ...room, lightingState: state.lighting, sourcePath: path.resolve(root, room.sourcePath),
      source: { ...room.source, path: path.resolve(root, room.source.path) } };
  });
  if (rooms[0].source.sha256 === rooms[1].source.sha256) throw Error('Lighting originals must differ');
  const attachments = rooms.map((room, i) => ({ ...room.source, role: `source-state-${i ? 'B' : 'A'}`,
    label: `SOURCE ${i ? 'B' : 'A'} (STATE_${i ? 'B' : 'A'}): original room background; lighting state ${room.lightingState}` }));
  const preservation = template.prompt.slice(template.prompt.indexOf('\n\n') + 2, template.prompt.lastIndexOf('\n\n'));
  const prompt = `The two attached images are SOURCE A and SOURCE B: original game backgrounds of the SAME room in two different lighting states. Each SOURCE is the ONLY authority for its own composition, geometry, object inventory, colors and lighting. Restore each original, not a reference photo. Return exactly TWO SEPARATE restored background image parts, each 4:3, without borders or added text. Do not return a combined image, contact sheet, split screen or collage. Preserve each full field of view; no cropping, reframing, perspective correction, rotation or added characters.\n\n${preservation}\n\nUse both originals to keep shared room construction and supported material character consistent. Preserve each state's own illumination, palette, shadow boundaries and dark areas: do not average, homogenize, relight or transfer the other state's fixture appearance or state-specific details. Keep differently lit surfaces different where the originals differ.\n\nIn the TEXT response, write STATE_A immediately before the first restored IMAGE part corresponding only to SOURCE A. Then write STATE_B immediately before the second restored IMAGE part corresponding only to SOURCE B. State markers must remain outside the images. No material reference photos are attached.`;
  const job = { roomId: 'Scene2803-lighting-pair', model: template.model, promptVariant: 'paired-lighting-preservation', referenceMode: 'two-original-lighting-states', prompt,
    attachments, settings: template.settings, expectedFinalImages: 2 };
  job.requestHash = requestHashFor(job);
  job.id = `Scene2803-paired-lighting-${job.requestHash.slice(0, 12)}`;
  return { schemaVersion: 1, experimentId: 'paired-lighting-v1', project: 'gen-lang-client-0665493034', location: 'global',
    authorization: 'User 2026-10-21T10:22:54Z proposes joint input for differently lit originals and two outputs; one bounded pilot only.',
    maximumRequests: 1, concurrency: 1, transport: 'generateContent-single-request-not-official-batch', rooms, jobs: [job], evidence: pair.evidence,
    outputMapping: 'Require exactly two non-thought final image parts, unique adjacent STATE_A/STATE_B text markers, native independent images and manual inspection; never infer a second image from a collage.',
    automaticFallbackOrRetries: false, automaticMassAdoption: false };
}

export function checkPairProtocol(record, raw) {
  const finals = (record.images ?? []).filter(image => !image.thought && image.mimeType?.startsWith('image/'));
  const issues = [];
  if (record.status !== 'succeeded') issues.push('No saved successful generation response');
  if (finals.length !== 2) issues.push(`Expected two separate final image parts, received ${finals.length}`);
  if (raw.candidates?.length !== 1) issues.push('Cannot map alternative candidates to two lighting states');
  const mapped = {};
  let label;
  for (const [ci, candidate] of (raw.candidates ?? []).entries()) {
    if (candidate.finishReason !== 'STOP') issues.push(`Non-STOP finish reason: ${candidate.finishReason}`);
    for (const [pi, part] of (candidate.content?.parts ?? []).entries()) {
      if (part.thought) continue;
      if (part.text) {
        const markers = [...part.text.matchAll(/\bSTATE_([AB])\b/g)].map(match => match[1]);
        label = markers.length === 1 ? markers[0] : undefined;
        if (markers.length > 1) issues.push('Duplicate or multiple state markers in a text part');
      }
      if (!part.inlineData) { if (!part.text) label = undefined; continue; }
      const image = finals.find(image => image.candidateIndex === ci && image.partIndex === pi);
      if (!image) { label = undefined; continue; }
      if (!label || mapped[label]) issues.push('Missing or ambiguous adjacent state label');
      else mapped[label] = image;
      label = undefined;
    }
  }
  if (!mapped.A || !mapped.B) issues.push('Both explicit state mappings were not established');
  for (const image of finals) if (JSON.stringify(image.dimensions) !== '[2400,1792]') issues.push(`Unexpected native dimensions: ${JSON.stringify(image.dimensions)}; inspect for composite or size drift`);
  return { status: issues.length ? 'inconclusive-no-automatic-retry' : 'protocol-valid-pending-manual-review', issues, actualFinalImages: finals.length,
    mapping: mapped, automaticApproval: false, note: 'Two image parts and markers alone cannot prove shared geometry, correct lighting or absence of a collage. Manual source-pair inspection remains required.' };
}

async function report(plan, result) {
  const job = plan.jobs[0];
  const folder = path.join(directory, 'jobs', job.id);
  const raw = await load(path.join(folder, 'response-raw.json')).catch(() => ({}));
  const checked = checkPairProtocol(result, raw);
  checked.usage = result.usage ?? null;
  checked.responseId = result.responseId ?? null;
  checked.modelVersion = result.modelVersion ?? null;
  checked.sourceStates = plan.rooms;
  checked.verifiedImages = [];
  for (const image of result.images ?? []) {
    const bytes = await readFile(image.path);
    if (sha(bytes) !== image.sha256) throw Error('Paired artifact hash mismatch');
    if (image.thought || !image.mimeType?.startsWith('image/')) continue;
    const metadata = JSON.parse(execFileSync('python3', ['-c', 'import sys,io,json;from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read()));print(json.dumps({"dimensions":list(im.size),"opaque":im.convert("RGBA").getchannel("A").getextrema()==(255,255)}))'], { input: bytes, encoding: 'utf8' }));
    checked.verifiedImages.push({ ...image, ...metadata });
    if (!metadata.opaque) { checked.status = 'inconclusive-no-automatic-retry'; checked.issues.push('A returned image has transparency'); }
  }
  await atomicWrite(path.join(directory, 'pair-check.json'), json(checked));
  const imageHtml = image => image ? `<a href="${esc(pathToFileURL(image.path).href)}"><img src="${esc(pathToFileURL(image.path).href)}" alt="Saved original-size image"></a>` : '<p>No unambiguously mapped image. See all returned parts below.</p>';
  let html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paired Lighting Pilot</title><style>body{background:#151817;color:#e7e9df;font:15px Georgia,serif;margin:24px}a{color:#d1dc89}section{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}img{width:100%;height:auto;display:block}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px monospace}article{min-width:0;border:1px solid #384139;padding:12px}@media(max-width:700px){section{grid-template-columns:1fr}body{margin:12px}}</style><h1>Paired Lighting / Two Originals</h1><p>One experimental request, not mass adoption. No automatic approval or repeat. Native files unchanged.</p><p><a href="../opaque-repair-v1/review.html">Manual room review</a></p><pre>${esc(json({ status: checked.status, issues: checked.issues, actualFinalImages: checked.actualFinalImages, responseId: checked.responseId, usage: checked.usage }))}</pre>`;
  for (const [i, state] of ['A', 'B'].entries()) {
    html += `<h2>STATE_${state}: ${esc(plan.rooms[i].id)} / ${esc(plan.rooms[i].lightingState)}</h2><section><article><h3>Original</h3>${imageHtml(plan.rooms[i].source)}</article><article><h3>Joint-request result (mapping only)</h3>${imageHtml(checked.mapping[state])}</article></section>`;
  }
  html += '<h2>All Returned Final Image Parts</h2><section>' + checked.verifiedImages.map(image => `<article><h3>Candidate ${image.candidateIndex}, part ${image.partIndex}</h3>${imageHtml(image)}</article>`).join('') + '</section><p>State labels, consistency and light/color preservation must be checked visually. An inconclusive request does not trigger another paid call.</p></html>';
  await atomicWrite(path.join(directory, 'report.html'), html);
  console.log(JSON.stringify({ directory, status: checked.status, actualFinalImages: checked.actualFinalImages, issues: checked.issues }));
  return checked;
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--execute', '--report'].includes(arg))) throw Error('Usage: node paired-lighting.mjs [--execute|--report]');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'experiment.json');
  const template = await load(path.join(base, 'static-pilot-v1-2096d1751ccd/jobs/Scene1001-gemini-nano-banana-2.1-preservation-none-7cbaffb18ab8/request.json'));
  const selection = await load(path.join(root, 'private-assets/upscaling/opaque-repair-source-selection.json'));
  const previous = await load(path.join(base, 'opaque-all-v1/experiment.json'));
  const expected = await buildPairPlan(selection, previous, template);
  const plan = await exists(file) ? await load(file) : expected;
  const job = plan.jobs[0];
  if (template.model !== 'gemini-nano-banana-2.1' || JSON.stringify(plan) !== JSON.stringify(expected) || plan.project !== 'gen-lang-client-0665493034' || plan.location !== 'global' ||
      plan.maximumRequests !== 1 || plan.jobs.length !== 1 || job.attachments.length !== 2 || job.model !== template.model || job.authorizedAttempt ||
      job.expectedFinalImages !== 2 || JSON.stringify(job.settings) !== JSON.stringify(template.settings) ||
      requestHashFor(job, plan.project, plan.location) !== job.requestHash) throw Error('Paired pilot budget/model/settings/source scope mismatch');
  for (const image of job.attachments) {
    if (!image.path.startsWith(path.join(root, 'private-assets') + path.sep) || sha(await readFile(image.path)) !== image.sha256) throw Error('Paired original changed');
  }
  await freezeManifest(file, plan);
  console.log(JSON.stringify({ directory, maximumRequests: 1, execute: args.includes('--execute') }));
  if (args.includes('--execute')) { await recoverJob(job, directory); await runJob(plan, job, directory); }
  if (args.includes('--execute') || args.includes('--report')) {
    const checked = await report(plan, await load(path.join(directory, 'jobs', job.id, 'result.json')));
    if (checked.status !== 'protocol-valid-pending-manual-review') process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Explicit opt-in: running this file sends billable synthetic requests.
const project = 'gen-lang-client-0665493034';
const location = 'global';
const startedAt = new Date().toISOString();
const output = fileURLToPath(new URL(
  `../../../private-assets/upscaling/gemini-probes/${startedAt.replaceAll(':', '-')}/`,
  import.meta.url,
));
const gcloud = (...args) => execFileSync('gcloud', args, {
  encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const catalog = JSON.parse(gcloud('ai', 'model-garden', 'models', 'list',
  `--project=${project}`, `--billing-project=${project}`,
  '--filter=name:publishers/google/models/gemini',
  '--format=json(name,launchStage,versionId)', '--quiet'));
await mkdir(output, { recursive: true });
await writeFile(`${output}catalog.json`, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(JSON.stringify({ output, catalog }, null, 2));
const token = gcloud('auth', 'application-default', 'print-access-token');
const availableJobs = [
  { model: 'gemini-3.8-flash', image: false },
  { model: 'gemini-4-argon', image: false },
  { model: 'gemini-nano-banana-2.1', image: true },
  { model: 'gemini-3-pro-image', image: true },
];
const selectedModel = process.argv[2];
if (selectedModel && !availableJobs.some(job => job.model === selectedModel)) {
  throw new Error(`Unknown probe model: ${selectedModel}`);
}
const jobs = selectedModel ? availableJobs.filter(job => job.model === selectedModel) : availableJobs;
const results = [];
for (const { model, image } of jobs) {
  const request = {
    contents: [{ role: 'user', parts: [{ text: image
      ? 'Generate one image: a small handmade brown clay wall with a simple blue rectangular door, front view, no text, no people. This is a synthetic API connectivity test.'
      : 'Reply with only the word SUCCESS.' }] }],
    generationConfig: image
      ? { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '4:3', imageSize: '1K' } }
      : { maxOutputTokens: 1024 },
  };
  await writeFile(`${output}${model}.request.json`, `${JSON.stringify(request, null, 2)}\n`);
  const start = Date.now();
  try {
    const response = await fetch(`https://aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': project, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(180_000),
    });
    const body = await response.json();
    const images = [];
    for (const [ci, candidate] of (body.candidates ?? []).entries()) {
      for (const [pi, part] of (candidate.content?.parts ?? []).entries()) {
        if (!part.inlineData?.data) continue;
        const bytes = Buffer.from(part.inlineData.data, 'base64');
        const mime = part.inlineData.mimeType;
        const filename = `${model}-${ci}-${pi}.${mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'bin'}`;
        await writeFile(`${output}${filename}`, bytes);
        const record = { filename, mimeType: mime, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        images.push(record);
        part.inlineData = record;
      }
    }
    await writeFile(`${output}${model}.response.json`, `${JSON.stringify(body, null, 2)}\n`);
    const result = { model, httpStatus: response.status, durationMs: Date.now() - start,
      modelVersion: body.modelVersion, responseId: body.responseId, usage: body.usageMetadata,
      text: body.candidates?.flatMap(c => c.content?.parts ?? []).filter(p => p.text && !p.thought).map(p => p.text).join('\n'),
      images, error: body.error };
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const result = { model, durationMs: Date.now() - start, error: error.message, status: 'outcome-unknown-no-auto-retry' };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  await writeFile(`${output}summary.json`, `${JSON.stringify({ project, location, startedAt, results }, null, 2)}\n`);
}
if (results.some(r => r.httpStatus !== 200 || (jobs.find(j => j.model === r.model).image ? !r.images?.length : !r.text?.includes('SUCCESS')))) process.exitCode = 1;

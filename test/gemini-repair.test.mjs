import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { requestHashFor, validateAttempt, runJob } from '../tools/upscaling/gemini/experiment.mjs';
import { checkPairProtocol } from '../tools/upscaling/gemini/paired-lighting.mjs';
import { validateRepairPlan } from '../tools/upscaling/gemini/repair.mjs';
import { executeBulk } from '../tools/upscaling/gemini/bulk.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=', 'base64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('request identity preserves the historical single-source hash and binds paired labels', () => {
  const job = { model: 'synthetic', prompt: 'source only', attachments: [{ sha256: 'source', mimeType: 'image/png', role: 'source-composition' }], settings: { imageConfig: { imageSize: '2K' } } };
  const expected = sha(JSON.stringify({ project: 'gen-lang-client-0665493034', location: 'global', model: job.model, prompt: job.prompt,
    attachments: job.attachments, settings: job.settings }));
  assert.equal(requestHashFor(job), expected);
  assert.notEqual(requestHashFor({ ...job, attachments: [{ ...job.attachments[0], label: 'SOURCE STATE A' }] }), expected);
});

test('explicit retry coverage binds source, old result, room and one allowed attempt', () => {
  const attempt = { id: 'user-attempt-1', authorizationId: 'user-message', sourceSha256: 'original', priorRequestHash: 'old-hash', priorResultPath: '/private/old/result.json' };
  const job = { roomId: 'room', attachments: [{ sha256: 'original' }], authorizedAttempt: attempt };
  const allowed = { id: attempt.id, roomId: job.roomId, sourceSha256: attempt.sourceSha256, priorRequestHash: attempt.priorRequestHash, priorResultPath: attempt.priorResultPath };
  const plan = { retryAuthorization: { id: 'user-message', userMessageTime: 'synthetic', userInstruction: 'synthetic permission', allowedAttempts: [allowed] } };
  validateAttempt(plan, job);
  assert.throws(() => validateAttempt({}, job), /authorization/);
  for (const changes of [{ id: 'user-attempt-2' }, { sourceSha256: 'different' }, { priorResultPath: '/other/result.json' }, { authorizationId: 'not-approved' }]) {
    assert.throws(() => validateAttempt(plan, { ...job, authorizedAttempt: { ...attempt, ...changes } }), /authorization/);
  }
  assert.throws(() => validateAttempt(plan, { ...job, attachments: [...job.attachments, job.attachments[0]] }), /authorization/);
});

test('one authorized retry of an unknown request preserves old ledger and never repeats itself', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'repair-attempt-'));
  try {
    const oldDir = path.join(dir, 'old'), newDir = path.join(dir, 'new'), otherDir = path.join(dir, 'other');
    const ledgerDir = path.join(dir, 'ledger');
    await mkdir(oldDir); await mkdir(newDir); await mkdir(otherDir);
    const sourcePath = path.join(dir, 'synthetic.png');
    await writeFile(sourcePath, png);
    const original = { id: 'old-job', roomId: 'room', model: 'synthetic', prompt: 'synthetic', attachments: [{ path: sourcePath, sha256: sha(png), mimeType: 'image/png', role: 'source-composition' }], settings: {} };
    original.requestHash = requestHashFor(original);
    let calls = 0;
    const plan = { project: 'synthetic', location: 'global' };
    await runJob(plan, original, oldDir, { token: 'synthetic', ledgerDir, fetch: async () => { calls++; throw Error('unknown outcome'); } });
    const oldLedgerPath = path.join(ledgerDir, `${original.requestHash}.json`);
    const ledgerBefore = await readFile(oldLedgerPath);
    const oldResultPath = path.join(oldDir, 'jobs/old-job/result.json');
    const oldResultBefore = await readFile(oldResultPath);
    const allowed = { id: 'user-20261021-room-v2', roomId: 'room', sourceSha256: sha(png), priorRequestHash: original.requestHash, priorResultPath: oldResultPath };
    const authorization = { id: 'user-message-20261021', userMessageTime: 'synthetic', userInstruction: 'synthetic retry approval', allowedAttempts: [allowed] };
    const retry = { ...original, id: 'new-job', authorizedAttempt: { id: allowed.id, authorizationId: authorization.id,
      sourceSha256: allowed.sourceSha256, priorRequestHash: allowed.priorRequestHash, priorResultPath: allowed.priorResultPath, reason: 'approved retry' } };
    const dependencies = { token: 'synthetic', ledgerDir, fetch: async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ responseId: 'new-response', candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] }) };
    } };
    await runJob({ ...plan, retryAuthorization: authorization }, retry, newDir, dependencies);
    await runJob({ ...plan, retryAuthorization: authorization }, retry, newDir, dependencies);
    assert.equal(calls, 2);
    assert.deepEqual(await readFile(oldLedgerPath), ledgerBefore);
    assert.deepEqual(await readFile(oldResultPath), oldResultBefore);
    const result = JSON.parse(await readFile(path.join(newDir, 'jobs/new-job/result.json')));
    assert.equal(result.status, 'succeeded');
    assert.equal(result.authorizedAttempt.id, allowed.id);
    await runJob({ ...plan, retryAuthorization: authorization }, retry, otherDir, dependencies);
    assert.equal(calls, 2);
    assert.equal(JSON.parse(await readFile(path.join(otherDir, 'jobs/new-job/result.json'))).status, 'blocked-pre-submission');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('paired source attachments are labeled as originals, never backstage references', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'repair-pair-labels-'));
  try {
    const sourcePath = path.join(dir, 'synthetic.png');
    await writeFile(sourcePath, png);
    const source = { path: sourcePath, sha256: sha(png), mimeType: 'image/png' };
    const item = { id: 'pair', roomId: 'pair', model: 'synthetic', prompt: 'two original states', settings: {}, attachments: [
      { ...source, role: 'source-state-A', label: 'SOURCE STATE A: original game background' },
      { ...source, role: 'source-state-B', label: 'SOURCE STATE B: original game background' },
    ] };
    item.requestHash = requestHashFor(item);
    let request;
    await runJob({ project: 'synthetic', location: 'global' }, item, dir, { token: 'synthetic', fetch: async (_, options) => {
      request = JSON.parse(options.body); return { ok: false, status: 400, json: async () => ({ error: { message: 'synthetic' } }) };
    } });
    const labels = request.contents[0].parts.filter(part => part.text).map(part => part.text).join('\n');
    assert(labels.includes('SOURCE STATE A'));
    assert(labels.includes('SOURCE STATE B'));
    assert(!labels.includes('BACKSTAGE'));
    assert.equal(request.contents[0].parts.filter(part => part.inlineData).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('paired protocol needs two final images and unique adjacent state markers, never assumes mapping', () => {
  const image = (partIndex, thought = false) => ({ candidateIndex: 0, partIndex, thought, mimeType: 'image/png', dimensions: [2400, 1792] });
  const part = { inlineData: { mimeType: 'image/png', data: 'synthetic' } };
  const record = { status: 'succeeded', images: [image(1), image(3), image(4, true)] };
  const body = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'STATE_A' }, part, { text: 'STATE_B' }, part, { ...part, thought: true }] } }] };
  const valid = checkPairProtocol(record, body);
  assert.equal(valid.status, 'protocol-valid-pending-manual-review');
  assert.equal(valid.actualFinalImages, 2);
  assert.equal(valid.automaticApproval, false);
  assert.equal(valid.mapping.A.partIndex, 1);
  assert.equal(valid.mapping.B.partIndex, 3);
  const unlabeled = checkPairProtocol(record, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'STATE_A and STATE_B' }, part, {}, part] } }] });
  assert.equal(unlabeled.status, 'inconclusive-no-automatic-retry');
  assert.equal(Object.keys(unlabeled.mapping).length, 0);
  const duplicate = checkPairProtocol(record, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'STATE_A STATE_A' }, part, { text: 'STATE_B' }, part] } }] });
  assert.equal(duplicate.status, 'inconclusive-no-automatic-retry');
  const nonadjacent = checkPairProtocol({ ...record, images: [image(2), image(4)] }, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'STATE_A' }, { text: 'unrelated commentary' }, part, { text: 'STATE_B' }, part] } }] });
  assert.equal(nonadjacent.status, 'inconclusive-no-automatic-retry');
  const single = checkPairProtocol({ ...record, images: [image(1)] }, body);
  assert.equal(single.status, 'inconclusive-no-automatic-retry');
  assert(single.issues.some(issue => issue.includes('received 1')));
});

test('repair cap rejects arbitrary target rooms or invented permission before reading sources', async () => {
  const jobs = ['arbitrary-1', 'arbitrary-2', 'arbitrary-3', 'arbitrary-4'].map(roomId => ({ id: roomId, roomId, authorizedAttempt: { id: roomId } }));
  const plan = { project: 'gen-lang-client-0665493034', location: 'global', concurrency: 2, maximumRequests: 4,
    maximumAutomaticRetries: 0, requireAllNewJobs: true, jobs, rooms: [],
    retryAuthorization: { id: 'invented', userMessageTime: 'invented', userInstruction: 'invented', allowedAttempts: jobs } };
  await assert.rejects(validateRepairPlan(plan, { model: 'gemini-nano-banana-2.1' }, { rooms: [] }, { rooms: [] }), /authorization/);
});

test('successful old color-failed candidate cannot hide a required retry failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'repair-required-retry-'));
  try {
    const old = path.join(dir, 'old');
    await mkdir(old);
    await writeFile(path.join(old, 'request.json'), JSON.stringify({ id: 'old', roomId: 'room', requestHash: 'old-hash' }));
    await writeFile(path.join(old, 'result.json'), JSON.stringify({ id: 'old', requestHash: 'old-hash', status: 'succeeded', images: [] }));
    const fresh = { id: 'new', roomId: 'room', model: 'synthetic', prompt: 'synthetic', settings: {}, attachments: [], requestHash: 'new-hash' };
    const plan = { experimentId: 'synthetic', project: 'synthetic', location: 'global', concurrency: 2, rooms: [{ id: 'room' }],
      jobs: [fresh], reused: [{ id: 'old', roomId: 'room', requestHash: 'old-hash', resultPath: path.join(old, 'result.json') }], requireAllNewJobs: true };
    await writeFile(path.join(dir, 'experiment.json'), JSON.stringify(plan));
    const result = await executeBulk(plan, dir, { history: [], ledgerDir: path.join(dir, 'ledger'), dependencies: { token: 'synthetic', fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'synthetic failure' } }) }) } });
    assert.equal(result.counts.failed, 1);
    assert.equal(result.reusedCounts.succeeded, 1);
    assert.equal(result.complete, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pair does not count a collage-sized image or alternative candidates as successful state protocol', () => {
  const parts = [{ text: 'STATE_A' }, { inlineData: {} }, { text: 'STATE_B' }, { inlineData: {} }];
  const result = { status: 'succeeded', images: [1, 3].map(partIndex => ({ candidateIndex: 0, partIndex, thought: false, mimeType: 'image/png', dimensions: [4800, 1792] })) };
  const checked = checkPairProtocol(result, { candidates: [{ finishReason: 'STOP', content: { parts } }] });
  assert.equal(checked.status, 'inconclusive-no-automatic-retry');
  assert(checked.issues.some(issue => issue.includes('Unexpected native dimensions')));
  const alternatives = checkPairProtocol(result, { candidates: [{ finishReason: 'STOP', content: { parts } }, { finishReason: 'STOP', content: { parts: [] } }] });
  assert(alternatives.issues.some(issue => issue.includes('alternative candidates')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJobs } from '../tools/upscaling/gemini/experiment.mjs';
import { parseJudgment, decide } from '../tools/upscaling/gemini/judge.mjs';

test('factorial jobs attach source first and references only in treatment cells', () => {
  const source = { sha256: 'source', mimeType: 'image/png', role: 'source-composition' };
  const ref = { sha256: 'reference', mimeType: 'image/jpeg', role: 'material-reference' };
  const rooms = ['Scene1001', 'Scene1002'].map(id => ({ id, source }));
  const jobs = makeJobs(rooms, { historical: 'baseline', preservation: 'strict' }, [ref], {});
  assert.equal(jobs.length, 16);
  assert.equal(new Set(jobs.map(job => job.id)).size, 16);
  for (const job of jobs) {
    assert.equal(job.attachments[0], source);
    assert.equal(job.attachments.length, job.referenceMode === 'none' ? 1 : 2);
    assert.match(job.prompt, /ONLY authority/);
  }
  assert.deepEqual(makeJobs(rooms, { historical: 'baseline', preservation: 'strict' }, [ref], {}), jobs);
  const changed = makeJobs(rooms, { historical: 'changed', preservation: 'strict' }, [ref], {});
  assert.notEqual(changed[0].requestHash, jobs[0].requestHash);
  const changedRef = makeJobs(rooms, { historical: 'baseline', preservation: 'strict' }, [{ ...ref, sha256: 'other' }], {});
  assert.equal(changedRef[0].requestHash, jobs[0].requestHash);
  assert.notEqual(changedRef[1].requestHash, jobs[1].requestHash);
});

function assessment() {
  return { global: { addedObjects: [], removedObjects: [], composition: { status: 'preserved', evidence: 'Same room boundaries' } },
    objects: [{ id: 'fixture', presence: 'preserved', silhouette: 'preserved', internalGeometry: 'preserved', count: 'preserved', evidence: 'Same visible contours' }], uncertainties: [] };
}

test('object assessments require full valid coverage and never autoapprove', () => {
  const judgment = assessment();
  assert.deepEqual(parseJudgment(JSON.stringify(judgment), ['fixture']), judgment);
  assert.equal(decide(judgment).verdict, 'no-structural-change-detected');
  assert.equal(decide(judgment).automaticApproval, false);
  for (const objects of [[], [judgment.objects[0], judgment.objects[0]], [{ ...judgment.objects[0], id: 'other' }], [{ ...judgment.objects[0], internalGeometry: 'great' }]]) {
    assert.throws(() => parseJudgment(JSON.stringify({ ...judgment, objects }), ['fixture']));
  }
});

test('changed internal shape rejects even when presence and silhouette are preserved', () => {
  const judgment = assessment();
  judgment.objects[0].internalGeometry = 'changed';
  judgment.objects[0].evidence = 'A smooth division became concentric ridges';
  assert.equal(decide(judgment).verdict, 'reject');
  assert.match(decide(judgment).reasons[0], /internalGeometry changed/);
});

test('text-only reference variant attaches only the original, no backstage photographs', () => {
  const source = { sha256: 'source', mimeType: 'image/png', role: 'source-composition' };
  const jobs = makeJobs([{ id: 'Scene1001', source }, { id: 'Scene1002', source }],
    { 'text-material': 'Detailed static material description' }, [], {}, ['none']);
  assert.equal(jobs.length, 4);
  for (const job of jobs) {
    assert.deepEqual(job.attachments, [source]);
    assert.equal(job.referenceMode, 'none');
    assert.match(job.prompt, /Detailed static material description/);
  }
});

test('new ceiling fixture or missing object always rejects, uncertainty blocks clearance', () => {
  const judgment = assessment();
  judgment.global.addedObjects.push('New ceiling fixture at top center');
  assert.equal(decide(judgment).verdict, 'reject');
  judgment.global.addedObjects = [];
  judgment.global.removedObjects.push('Ladder rung missing');
  assert.equal(decide(judgment).verdict, 'reject');
  judgment.global.removedObjects = [];
  judgment.objects[0].internalGeometry = 'uncertain';
  assert.equal(decide(judgment).verdict, 'review');
  assert.equal(decide(judgment).automaticApproval, false);
});

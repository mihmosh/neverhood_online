import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(moduleDirectory, '../../../..');
const stateRoot = join(root, 'private-assets/upscaling/aws');
const profile = process.env.AWS_PROFILE || 'default';
const region = process.env.AWS_REGION || 'us-east-2';
const stack = process.env.NEVERHOOD_AWS_STACK || 'neverhood-upscaling-lab';
const template = join(moduleDirectory, 'cloudformation.json');
if (!/^[a-z][a-z0-9-]{2,80}$/.test(stack) || region !== 'us-east-2') throw new Error('Review stack/region before deploying this lab.');
await mkdir(stateRoot, { recursive: true, mode: 0o700 });
const json = path => readFile(path, 'utf8').then(JSON.parse);
const save = (name, value) => writeFile(join(stateRoot, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
function aws(args) {
  return JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--no-cli-pager', '--output', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 ** 2, timeout: 120000 }));
}
async function identity() {
  const caller = aws(['sts', 'get-caller-identity']);
  if (!/^\d{12}$/.test(caller.Account)) throw new Error('Invalid AWS account identity');
  return caller;
}
async function state(quiet = false) {
  const caller = await identity();
  const intent = await json(join(stateRoot, 'create-intent.json'));
  if (caller.Account !== intent.account) throw new Error('Refusing a different AWS account from this local deployment record');
  const data = aws(['cloudformation', 'describe-stacks', '--stack-name', stack]).Stacks[0];
  const outputs = Object.fromEntries((data.Outputs || []).map(entry => [entry.OutputKey, entry.OutputValue]));
  const resources = aws(['cloudformation', 'list-stack-resources', '--stack-name', stack]).StackResourceSummaries;
  const result = { stack, region, profile, status: data.StackStatus, id: data.StackId, outputs,
    resources: resources.map(entry => ({ logicalId: entry.LogicalResourceId, id: entry.PhysicalResourceId, type: entry.ResourceType, status: entry.ResourceStatus })), checkedAt: new Date().toISOString() };
  await save('stack-state.json', result);
  if (!quiet) console.log(JSON.stringify(result, null, 2));
  return result;
}
async function create() {
  const caller = await identity();
  aws(['cloudformation', 'validate-template', '--template-body', `file://${template}`]);
  const autoStopAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const intent = { stack, region, account: caller.Account, operatorArn: caller.Arn, autoStopAt, autoStopTimezone: 'UTC',
    initialComputeLimitHours: 2, createdAt: new Date().toISOString() };
  await writeFile(join(stateRoot, 'create-intent.json'), JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const request = aws(['cloudformation', 'create-stack', '--stack-name', stack, '--template-body', `file://${template}`,
    '--parameters', `ParameterKey=AutoStopAt,ParameterValue=${autoStopAt}`, '--capabilities', 'CAPABILITY_IAM',
    '--tags', 'Key=Project,Value=neverhood', 'Key=Purpose,Value=upscaling', '--timeout-in-minutes', '45']);
  await save('create-result.json', { ...intent, ...request });
  console.log(JSON.stringify({ ...request, autoStopAt, region }, null, 2));
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function put(bucket, path, key, { sha256, cache = 'private, no-store' } = {}) {
  if (!/^[a-z0-9][a-z0-9.-]+$/.test(bucket) || key.split('/').some(part => !part || part === '.' || part === '..') || /[\\%?#\x00-\x20]/.test(key)) throw new Error('Unsafe S3 destination');
  if (await realpath(path) !== path || !(await stat(path)).isFile()) throw new Error('Non-regular upload source');
  const actualHash = await digest(path), bytes = (await stat(path)).size;
  if (sha256 && sha256 !== actualHash) throw new Error(`Input hash mismatch: ${key}`);
  const contentType = { '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.zip': 'application/zip', '.sh': 'text/x-shellscript', '.ffconcat': 'text/plain' }[extname(path)] || 'application/octet-stream';
  if (process.env.NEVERHOOD_AWS_PLAN_ONLY === '1') return { path, key, bytes, sha256: actualHash, contentType, cacheControl: cache };
  let existing;
  try { existing = aws(['s3api', 'head-object', '--bucket', bucket, '--key', key]); }
  catch (error) { if (!/404|Not Found|NoSuchKey/.test(String(error.stderr))) throw error; }
  if (existing?.Metadata?.sha256 !== actualHash || existing.ContentLength !== bytes) {
    execFileSync('aws', ['s3', 'cp', path, `s3://${bucket}/${key}`, '--profile', profile, '--region', region,
      '--only-show-errors', '--no-progress', '--sse', 'AES256', '--content-type', contentType,
      '--cache-control', cache, '--metadata', `sha256=${actualHash}`], { stdio: 'inherit', timeout: 600000 });
  }
  const verified = aws(['s3api', 'head-object', '--bucket', bucket, '--key', key]);
  if (verified.ContentLength !== bytes || verified.Metadata?.sha256 !== actualHash || verified.ServerSideEncryption !== 'AES256') throw new Error(`Upload verification failed: ${key}`);
  return { key, bytes, sha256: actualHash, versionId: verified.VersionId };
}
async function upload() {
  const current = await state(true);
  const bucket = current.outputs.BucketName || current.resources.find(entry => entry.type === 'AWS::S3::Bucket')?.id;
  if (!bucket) throw new Error('Bucket not created yet');
  const uploaded = [];
  for (const name of ['install-runner.sh', 'run-probe.sh', 'run-probe-7b.sh']) uploaded.push(await put(bucket, join(moduleDirectory, name), `sources/tools/aws/${name}`));
  for (const name of ['probe.py', 'probe7b.py']) uploaded.push(await put(bucket, join(moduleDirectory, 'helper', name), `sources/tools/aws/helper/${name}`));
  console.log(`Reviewed worker scripts ${process.env.NEVERHOOD_AWS_PLAN_ONLY === '1' ? 'planned' : 'uploaded'}; continuing private data and approved release.`);
  for (const name of ['a.blb', 'c.blb', 'hd.blb', 'i.blb', 'm.blb', 's.blb', 't.blb']) {
    uploaded.push(await put(bucket, join(root, 'extracted/app/DATA', name), `sources/game/original-v1/${name}`));
  }
  const probe = resolve(root, '../neverhood-upscaling/data/seedvr2-probe-v1');
  async function uploadTree(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name), key = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await uploadTree(path, key);
      else if (entry.isFile() && ['.json', '.png', '.webp', '.mp4', '.html', '.css', '.js', '.ffconcat'].includes(extname(entry.name))) uploaded.push(await put(bucket, path, key));
      else throw new Error(`Unreviewed experiment upload entry: ${key}`);
    }
  }
  await uploadTree(join(probe, 'input'), 'sources/probes/seedvr2-probe-v1/input');
  await uploadTree(join(probe, 'analysis'), 'results/replicate-seedvr2-probe-v1/analysis');
  for (const name of ['A-3b', 'C-3b-colorfix']) uploaded.push(await put(bucket, join(probe, 'runs', name, 'output.mp4'), `results/replicate-seedvr2-probe-v1/${name}/output.mp4`));
  const release = resolve(root, '../neverhood-upscaling/data/hd-demo/nonvideo-zip-v2');
  const manifest = await json(join(release, 'manifest.json'));
  const releaseFiles = [...manifest.files, ...Object.values(manifest.packs), { file: manifest.cursor },
    { file: 'cursor/sprite-sheet-128.png' }, { file: 'room1-original-preview-v2.webp' }, { file: 'room1-hd-preview-v2.webp' }];
  for (const entry of releaseFiles) uploaded.push(await put(bucket, join(release, entry.file), `releases/hd-demo/v1/${entry.file}`, {
    sha256: entry.sha256, cache: 'public, max-age=31536000, immutable' }));
  uploaded.push(await put(bucket, join(release, 'manifest.json'), 'releases/hd-demo/v1/manifest.json', { cache: 'public, max-age=60, must-revalidate' }));
  const planOnly = process.env.NEVERHOOD_AWS_PLAN_ONLY === '1';
  await save(planOnly ? 'upload-plan.json' : 'uploaded-objects.json', { bucket, region, account: (await json(join(stateRoot, 'create-intent.json'))).account,
    [planOnly ? 'plannedAt' : 'uploadedAt']: new Date().toISOString(), objects: uploaded });
  console.log(JSON.stringify({ bucket, planOnly, objectCount: uploaded.length, totalBytes: uploaded.reduce((sum, file) => sum + file.bytes, 0) }, null, 2));
}
async function guard() {
  const current = await state(true);
  const name = current.outputs.AutoStopScheduleName;
  if (!name || !current.outputs.InstanceId) throw new Error('Cost-guard resources not ready');
  const schedule = aws(['scheduler', 'get-schedule', '--name', name]);
  if (JSON.parse(schedule.Target.Input).InstanceIds?.join(',') !== current.outputs.InstanceId ||
      !schedule.Target.Arn.endsWith(':aws-sdk:ec2:stopInstances')) throw new Error('Refusing an unexpected scheduler target');
  const update = {};
  for (const key of ['Name', 'GroupName', 'Description', 'ScheduleExpression', 'ScheduleExpressionTimezone', 'State', 'FlexibleTimeWindow', 'Target', 'StartDate', 'EndDate', 'KmsKeyArn']) {
    if (schedule[key] !== undefined) update[key] = schedule[key];
  }
  update.ActionAfterCompletion = 'DELETE';
  await save('scheduler-update.json', update);
  aws(['scheduler', 'update-schedule', '--cli-input-json', `file://${join(stateRoot, 'scheduler-update.json')}`]);
  const verified = aws(['scheduler', 'get-schedule', '--name', name]);
  if (verified.ActionAfterCompletion !== 'DELETE' || verified.State !== 'ENABLED') throw new Error('Auto-stop cleanup verification failed');
  await save('scheduler-state.json', verified);
  console.log(JSON.stringify({ schedule: name, expression: verified.ScheduleExpression, enabled: verified.State, afterCompletion: verified.ActionAfterCompletion }));
}
async function install(retryShell = false) {
  const current = await json(join(stateRoot, 'stack-state.json'));
  const caller = await identity(), intent = await json(join(stateRoot, 'create-intent.json'));
  if (caller.Account !== intent.account) throw new Error('Wrong AWS account');
  const bucket = current.outputs.BucketName, instance = current.outputs.InstanceId;
  if (!bucket || !instance) throw new Error('Worker not ready');
  let previous;
  try { previous = await json(join(stateRoot, 'install-command.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    if (!retryShell) throw new Error('Installation command already recorded; inspect it instead of launching another.');
    const failed = aws(['ssm', 'get-command-invocation', '--command-id', previous.CommandId, '--instance-id', instance]);
    if (failed.Status !== 'Failed' || failed.ResponseCode !== 2 || failed.StandardOutputContent || !failed.StandardErrorContent.includes('Illegal option -o pipefail')) throw new Error('Retry only allowed for the verified pre-install shell failure');
    await save(`install-shell-failure-${previous.CommandId}.json`, failed);
    await rename(join(stateRoot, 'install-command.json'), join(stateRoot, `install-command-${previous.CommandId}.json`));
  }
  const commands = [
    '#!/bin/bash', 'set -euo pipefail', 'nvidia-smi', 'install -d -m 0755 /opt/neverhood-upscaling/control/helper',
    ...['install-runner.sh', 'run-probe.sh', 'helper/probe.py'].map(file => `aws s3 cp s3://${bucket}/sources/tools/aws/${file} /opt/neverhood-upscaling/control/${file} --region us-east-2 --only-show-errors --no-progress`),
    'chmod -R a+rX /opt/neverhood-upscaling/control',
    'bash /opt/neverhood-upscaling/control/install-runner.sh',
  ];
  const result = aws(['ssm', 'send-command', '--document-name', 'AWS-RunShellScript', '--instance-ids', instance,
    '--parameters', JSON.stringify({ commands, executionTimeout: ['3600'] }), '--timeout-seconds', '600',
    '--comment', 'Install pinned SeedVR2 lab runner; no inference or model download']);
  await save('install-command.json', result.Command);
  console.log(JSON.stringify({ commandId: result.Command.CommandId, instance, status: result.Command.Status }));
}
async function harden() {
  const current = await state(true);
  if (current.status !== 'CREATE_COMPLETE') throw new Error('Only initial completed lab can receive the planned worker-policy tightening');
  const result = aws(['cloudformation', 'update-stack', '--stack-name', stack, '--template-body', `file://${template}`,
    '--parameters', ...['AutoStopAt', 'ImageId', 'RootDeviceName', 'AvailabilityZone'].map(key => `ParameterKey=${key},UsePreviousValue=true`),
    '--capabilities', 'CAPABILITY_IAM']);
  await save('hardening-update.json', { ...result, at: new Date().toISOString(), purpose: 'Remove Parameter Store reads from the new worker role only' });
  console.log(JSON.stringify(result));
}
async function probe() {
  const current = await json(join(stateRoot, 'stack-state.json'));
  const caller = await identity(), intent = await json(join(stateRoot, 'create-intent.json'));
  if (caller.Account !== intent.account) throw new Error('Wrong AWS account');
  const instance = current.outputs.InstanceId, bucket = current.outputs.BucketName;
  const installation = await json(join(stateRoot, 'install-command.json'));
  const installed = aws(['ssm', 'get-command-invocation', '--command-id', installation.CommandId, '--instance-id', instance]);
  if (installed.Status !== 'Success') throw new Error('Runner installation is not successfully completed');
  await save('install-invocation.json', installed);
  const input = aws(['s3api', 'head-object', '--bucket', bucket, '--key', 'sources/probes/seedvr2-probe-v1/input/input.mp4']);
  if (input.Metadata?.sha256 !== 'e2f9fdbeeadff553da72d1881dfdb01ec10fa682c7268abf3a409e2e614cb201') throw new Error('Source probe is not verified in S3');
  const file = join(stateRoot, 'probe-command.json');
  try { await stat(file); throw new Error('Probe command already recorded; do not start duplicate inference.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = aws(['ssm', 'send-command', '--document-name', 'AWS-RunShellScript', '--instance-ids', instance,
    '--parameters', JSON.stringify({ commands: ['#!/bin/bash', 'set -euo pipefail', `bash /opt/neverhood-upscaling/runner/bin/run-probe.sh ${bucket} ${stack}`], executionTimeout: ['3600'] }),
    '--timeout-seconds', '600', '--comment', 'One bounded SeedVR2 3B FP8 probe, private results only']);
  await save('probe-command.json', result.Command);
  console.log(JSON.stringify({ commandId: result.Command.CommandId, instance, maximumInferenceAttempts: 1, model: '3B FP8', resultPrefix: `s3://${bucket}/results/${stack}/` }));
}
async function probe7b() {
  const current = await json(join(stateRoot, 'stack-state.json'));
  const caller = await identity(), intent = await json(join(stateRoot, 'create-intent.json'));
  if (caller.Account !== intent.account) throw new Error('Wrong AWS account');
  const instance = current.outputs.InstanceId, bucket = current.outputs.BucketName;
  const previous = await json(join(stateRoot, 'probe-command.json'));
  const completed = aws(['ssm', 'get-command-invocation', '--command-id', previous.CommandId, '--instance-id', instance]);
  if (completed.Status !== 'Success') throw new Error('3B must finish successfully before starting the 7B comparison');
  await save('probe-invocation.json', completed);
  try { await stat(join(stateRoot, 'probe7b-command.json')); throw new Error('7B command already recorded; do not launch duplicate inference.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const commands = ['#!/bin/bash', 'set -euo pipefail', 'nvidia-smi',
    ...['helper/probe.py', 'helper/probe7b.py', 'run-probe-7b.sh'].map(file => `aws s3 cp s3://${bucket}/sources/tools/aws/${file} /opt/neverhood-upscaling/runner/bin/${file} --region us-east-2 --only-show-errors --no-progress`),
    'chmod -R a+rX /opt/neverhood-upscaling/runner/bin',
    `bash /opt/neverhood-upscaling/runner/bin/run-probe-7b.sh ${bucket} ${stack}`];
  const result = aws(['ssm', 'send-command', '--document-name', 'AWS-RunShellScript', '--instance-ids', instance,
    '--parameters', JSON.stringify({ commands, executionTimeout: ['3600'] }), '--timeout-seconds', '600',
    '--comment', 'One requested normal 7B FP8 comparison after completed 3B; no Sharp or automatic retry']);
  await save('probe7b-command.json', result.Command);
  console.log(JSON.stringify({ commandId: result.Command.CommandId, instance, maximumInferenceAttempts: 1, model: 'Normal 7B FP8 mixed block35 FP16', resultPrefix: `s3://${bucket}/results/${stack}/7b/` }));
}
async function planComparison() {
  if (process.env.NEVERHOOD_AWS_PLAN_ONLY !== '1') throw new Error('Comparison planning requires NEVERHOOD_AWS_PLAN_ONLY=1; SDK performs the explicit upload.');
  const current = await state(true), bucket = current.outputs.BucketName;
  const directory = process.env.NEVERHOOD_COMPARISON_DIR ? resolve(process.env.NEVERHOOD_COMPARISON_DIR) : resolve(root, '../neverhood-upscaling/data/aws-seedvr2-comparison-v1/analysis');
  const resultName = process.env.NEVERHOOD_COMPARISON_PREFIX || 'comparison-v1';
  if (!/^[a-z0-9][a-z0-9-]{0,70}$/.test(resultName)) throw new Error('Unsafe comparison result name');
  const objects = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && ['.json', '.html', '.png', '.jpg', '.mp4', '.js', '.css'].includes(extname(file))) {
        objects.push(await put(bucket, file, `results/${stack}/${resultName}/${relative(directory, file)}`));
      } else throw new Error('Unreviewed comparison output');
    }
  }
  await walk(directory);
  const planFile = resultName === 'comparison-v1' ? 'upload-comparison-plan.json' : `upload-${resultName}-plan.json`;
  await save(planFile, { bucket, region, account: (await json(join(stateRoot, 'create-intent.json'))).account, objects });
  console.log(JSON.stringify({ objects: objects.length, planFile, totalBytes: objects.reduce((sum, file) => sum + file.bytes, 0), prefix: `results/${stack}/${resultName}/` }));
}
async function planTriplicate() {
  if (process.env.NEVERHOOD_AWS_PLAN_ONLY !== '1') throw new Error('Triplicate upload must use an explicit SDK plan');
  const current = await state(true), bucket = current.outputs.BucketName, objects = [];
  const directory = resolve(root, '../neverhood-upscaling/data/seedvr2-triplicate-v1/input');
  for (const name of ['input.mp4', 'source-metadata.json', 'triplicate-mapping.json']) {
    objects.push(await put(bucket, join(directory, name), `sources/probes/seedvr2-triplicate-v1/input/${name}`,
      name === 'input.mp4' ? { sha256: '7848d6a64008e95e874c5f9c8e4b242aa81ad3018eedcf6acd00e7f203310f0a' } : {}));
  }
  for (const name of ['probe.py', 'probe7b.py', 'probe_triplicate.py']) objects.push(await put(bucket,
    join(moduleDirectory, 'helper', name), `sources/tools/aws/helper/${name}`));
  await save('upload-triplicate-plan.json', { bucket, region, account: (await json(join(stateRoot, 'create-intent.json'))).account, objects });
  console.log(JSON.stringify({ objects: objects.length, bytes: objects.reduce((sum, file) => sum + file.bytes, 0) }));
}
async function triplicate(variant) {
  const current = await state(true), bucket = current.outputs.BucketName, instance = current.outputs.InstanceId;
  const intent = await json(join(stateRoot, 'create-intent.json'));
  const requiredMinutes = variant === '3b' ? 12 : 18;
  if (new Date(`${intent.autoStopAt}Z`).getTime() - Date.now() < requiredMinutes * 60 * 1000) throw new Error(`Less than ${requiredMinutes} minutes remain before the fixed cost-guard stop`);
  const previous = await json(join(stateRoot, variant === '3b' ? 'probe7b-command.json' : 'triplicate3b-command.json'));
  const done = aws(['ssm', 'get-command-invocation', '--command-id', previous.CommandId, '--instance-id', instance]);
  if (done.Status !== 'Success') throw new Error('Prior GPU experiment must be complete before the next one');
  const record = `triplicate${variant}-command.json`;
  try { await stat(join(stateRoot, record)); throw new Error('Triplicate command already recorded'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(join(stateRoot, `triplicate${variant}-intent.json`), JSON.stringify({ variant, time: new Date().toISOString(), maximumAttempts: 1 }) + '\n', { flag: 'wx', mode: 0o600 });
  const commands = ['#!/bin/bash', 'set -euo pipefail',
    ...['probe.py', 'probe7b.py', 'probe_triplicate.py'].map(name => `aws s3 cp s3://${bucket}/sources/tools/aws/helper/${name} /opt/neverhood-upscaling/runner/bin/helper/${name} --region us-east-2 --only-show-errors --no-progress`),
    'chmod -R a+rX /opt/neverhood-upscaling/runner/bin/helper',
    `runuser -u ubuntu -- env -i HOME=/home/ubuntu USER=ubuntu LOGNAME=ubuntu PATH=/usr/local/bin:/usr/bin:/bin HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 PYTHONUNBUFFERED=1 CUDA_VISIBLE_DEVICES=0 /opt/neverhood-upscaling/runner/venv/bin/python /opt/neverhood-upscaling/runner/bin/helper/probe_triplicate.py ${bucket} ${stack} ${variant} 7848d6a64008e95e874c5f9c8e4b242aa81ad3018eedcf6acd00e7f203310f0a`];
  const result = aws(['ssm', 'send-command', '--document-name', 'AWS-RunShellScript', '--instance-ids', instance,
    '--parameters', JSON.stringify({ commands, executionTimeout: [variant === '3b' ? '900' : '1080'] }), '--timeout-seconds', '300',
    '--comment', `One requested ${variant} triple-frame hypothesis test; unchanged quality settings`]);
  await save(record, result.Command);
  console.log(JSON.stringify({ commandId: result.Command.CommandId, variant, frames: 149, fps: 45, maximumAttempts: 1, autoStopAt: intent.autoStopAt }));
}
async function extendTriplicateWindow() {
  const current = await state(true), intent = await json(join(stateRoot, 'create-intent.json'));
  const extensionFile = join(stateRoot, 'triplicate-window-extension.json');
  try { await stat(extensionFile); throw new Error('The single triplicate window extension is already recorded'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const schedule = aws(['scheduler', 'get-schedule', '--name', current.outputs.AutoStopScheduleName]);
  if (JSON.parse(schedule.Target.Input).InstanceIds?.join(',') !== current.outputs.InstanceId) throw new Error('Unexpected stop target');
  const next = new Date(new Date(`${intent.autoStopAt}Z`).getTime() + 30 * 60 * 1000).toISOString().slice(0, 19);
  const update = { Name: schedule.Name, GroupName: schedule.GroupName, Description: schedule.Description,
    ScheduleExpression: `at(${next})`, ScheduleExpressionTimezone: 'UTC', State: 'ENABLED',
    FlexibleTimeWindow: schedule.FlexibleTimeWindow, Target: schedule.Target, ActionAfterCompletion: 'DELETE' };
  await save('scheduler-triplicate-update.json', update);
  aws(['scheduler', 'update-schedule', '--cli-input-json', `file://${join(stateRoot, 'scheduler-triplicate-update.json')}`]);
  const result = aws(['cloudformation', 'update-stack', '--stack-name', stack, '--use-previous-template',
    '--parameters', `ParameterKey=AutoStopAt,ParameterValue=${next}`, ...['ImageId', 'RootDeviceName', 'AvailabilityZone'].map(key => `ParameterKey=${key},UsePreviousValue=true`), '--capabilities', 'CAPABILITY_IAM']);
  await save('triplicate-window-extension.json', { previous: intent.autoStopAt, next, additionalMinutes: 30,
    maximumAdditionalComputeUSD: 0.4888, reason: 'Additional user-requested triple-frame hypothesis tests', ...result });
  await save('create-intent-initial.json', intent);
  await save('create-intent.json', { ...intent, initialAutoStopAt: intent.initialAutoStopAt || intent.autoStopAt, autoStopAt: next, initialComputeLimitHours: 2, effectiveComputeLimitHours: 2.5 });
  console.log(JSON.stringify({ autoStopAt: next, additionalMinutes: 30, instance: current.outputs.InstanceId }));
}
const action = process.argv[2];
try {
  if (action === 'create') await create();
  else if (action === 'status') { const value = await state(true); console.log(JSON.stringify({ stack, status: value.status, outputs: value.outputs }, null, 2)); }
  else if (action === 'upload') await upload();
  else if (action === 'guard') await guard();
  else if (action === 'install') await install();
  else if (action === 'retry-install-shell') await install(true);
  else if (action === 'harden') await harden();
  else if (action === 'probe') await probe();
  else if (action === 'probe7b') await probe7b();
  else if (action === 'plan-comparison') await planComparison();
  else if (action === 'plan-triplicate') await planTriplicate();
  else if (action === 'triplicate3b') await triplicate('3b');
  else if (action === 'triplicate7b') await triplicate('7b');
  else if (action === 'extend-triplicate-window') await extendTriplicateWindow();
  else throw new Error('Unknown lab action');
} catch (error) { console.error(error.message); process.exitCode = 1; }

# Isolated AWS Upscaling Lab

This deployment is independent of other application instances. It uses EC2, S3
and CloudFront, not SageMaker, NAT gateways or a public inference API. Provisioning
is a paid operator action; normal tests and website builds never deploy it.

## Resources And Boundaries

- One `g6.2xlarge` worker in `us-east-2`: one full L4, 8 vCPU, 32 GiB host RAM.
- Separate VPC/public subnet. No inbound security-group rules or SSH key pair.
- Administration and batch execution through Systems Manager, over outbound TLS.
- The worker's SSM policy omits Parameter Store reads; no production application
  secrets are granted through the generic managed-instance policy.
- IMDSv2 required. The worker uses an instance role, never an operator/root key.
- Encrypted 150 GiB gp3 root disk, deleted when the instance is terminated.
- One versioned, AES256-encrypted S3 bucket with all public-access blocks enabled.
- CloudFront OAC can read only `releases/hd-demo/`, not private sources/results.
- An initial one-time UTC scheduler stops only this worker after two hours.

The bucket uses `DeletionPolicy: Retain` and survives stack deletion. Stopping the
worker is not deletion: EBS and stored objects can continue to cost money.

| S3 Prefix | Contents | Access |
| --- | --- | --- |
| `sources/game/original-v1/` | Seven deliberately selected original BLB archives | Operator write; worker read; no public delivery |
| `sources/probes/seedvr2-probe-v1/input/` | Reviewed clip, masks and frame metadata | Operator write; worker read |
| `sources/tools/aws/` | Reviewed runner control scripts | Operator write; worker read |
| `results/<stack-name>/` | New worker outputs and sanitized reports | Worker read/write in this prefix only |
| `results/replicate-seedvr2-probe-v1/` | Existing reviewed experiment results | Operator-managed private archive |
| `releases/hd-demo/v1/` | Historical selected two-room manifest, ZIPs, game subset, cursor and previews | Operator publish; CloudFront read |
| `releases/hd-demo/full-game-lossless-v1/` | Current 134 room/state PNG ZIPs, seven original BLBs with original videos, cursor and previews | Operator publish; CloudFront read |

The initial public release was the selected two-room bundle. The later full-game
prototype explicitly publishes copies of all seven originals in its release
prefix, retaining original cutscene/navigation videos; it does not open the
private `sources/` or `results/` prefixes. Selection is not legal clearance.
S3 CORS does not grant object access. The bucket policy grants CloudFront only
its release prefix and rejects non-TLS requests. The worker cannot publish or
modify releases.

## Reproducible Infrastructure

[cloudformation.json](cloudformation.json) creates the resources; [bootstrap.sh](bootstrap.sh)
mirrors the minimal SSM bootstrap. The deployable template is authoritative.
The template pins the reviewed Ohio Ubuntu 24.04 DLAMI by AMI ID. Review its owner,
architecture and `/dev/sda1` root mapping before reuse in a new environment.

Use an explicit operator profile with appropriate permissions. Do not store AWS
access keys here or reuse a production application's instance role.

```bash
AWS_PROFILE=YOUR_OPERATOR_PROFILE node tools/upscaling/realesrnet/aws/manage-lab.mjs create
AWS_PROFILE=YOUR_OPERATOR_PROFILE node tools/upscaling/realesrnet/aws/manage-lab.mjs status
```

The create command records intent before the API request and refuses an existing
intent file. A failed/uncertain creation must be reconciled with CloudFormation
before retrying, not bypassed by deleting the guard. IAM creation is explicit via
`CAPABILITY_IAM`. All actual account IDs, resource IDs and operator identity are
written to ignored `private-assets/upscaling/aws/`, not public configuration.
Status/upload commands reject a different account from the deployment record.

CloudFront may take several minutes to deploy. Check once after a suitable wait;
do not create another stack because the first distribution is still deploying.

## Uploads

```bash
AWS_PROFILE=YOUR_OPERATOR_PROFILE node tools/upscaling/realesrnet/aws/manage-lab.mjs upload
```

This is an explicit upload of selected original-game files and reviewed artifacts,
authorized by the maintainer for this lab. It is not a blanket sync of ignored
directories. The uploader verifies local SHA256, records it as S3 metadata and
checks byte counts/encryption afterwards. It skips an already-matching object.
The audit is saved as ignored `uploaded-objects.json`.

For bulk transfers, generate the same explicit plan and use the SDK uploader to
avoid starting a new AWS CLI process for every object:

```bash
AWS_PROFILE=YOUR_OPERATOR_PROFILE NEVERHOOD_AWS_PLAN_ONLY=1 node tools/upscaling/realesrnet/aws/manage-lab.mjs upload
python3 -m venv /tmp/neverhood-aws-sdk
/tmp/neverhood-aws-sdk/bin/pip install -r tools/upscaling/realesrnet/aws/requirements-operator.txt
AWS_PROFILE=YOUR_OPERATOR_PROFILE /tmp/neverhood-aws-sdk/bin/python tools/upscaling/realesrnet/aws/upload-plan.py private-assets/upscaling/aws/upload-plan.json
```

The SDK obtains temporary operator credentials through AWS CLI into process memory
only. It never logs or writes them, and checks the recorded account before access.
Matching uploaded hashes are skipped; the release manifest is last in the plan.

No `.env`, Replicate credentials, raw prediction responses, base64 API payloads,
SQLite catalog, unrelated game installations or model weights are uploaded by
this command. Models are downloaded separately on the worker for the probe.

This legacy uploader reads the external `nonvideo-zip-v2` fixture for its initial
two-room release. It does not automatically publish the current full-game release.
The current pipeline prepares room ZIPs from the private original-to-HD table,
uses the complete original-file inventory and publishes to
`releases/hd-demo/full-game-lossless-v1/`. All 551 original Smacker resources are
retained while video restoration is unfinished. Publish verified assets first
and the manifest last; do not replace changed assets under immutable keys.
See [current deployment](../../../../docs/DEPLOYMENT.md#current-hd-prototype-release).

## Worker Installation And Probe

Copy the three reviewed control files from `sources/tools/aws/` to
`/opt/neverhood-upscaling/control/`, preserving `helper/probe.py`, through an SSM
command. Files must be readable by `ubuntu`; no inbound port is needed.

```bash
bash /opt/neverhood-upscaling/control/install-runner.sh
bash /opt/neverhood-upscaling/runner/bin/run-probe.sh BUCKET_NAME neverhood-upscaling-lab
```

Use the actual stack name as RUNID: the worker can write only `results/<stack-name>/`.
The scripts drop to `ubuntu`, use an isolated Python 3.12 environment and pin NumZ
revision `4490bd1f482e026674543386bb2a4d176da245b9` plus direct dependencies.
Installation does not replace NVIDIA drivers or download weights. Ubuntu package
sources are used temporarily over HTTPS; system CUDA repository settings remain
unchanged. Resolved dependencies and CLI help are recorded on the VM.

The probe downloads the known input using instance-role credentials and runs one
3B FP8 inference: batch 5, seed 314159, SDPA, compilation off, zero added noise,
CPU offload, BlockSwap and tiled VAE. A 15-minute timeout bounds inference; no
automatic retry or 7B fallback occurs. The first run may also download model/VAE
weights. SSM command execution timeout must allow installation and those downloads.

Expected output: 49 ordered RGB PNGs, 1536x864, source processing cadence 15 fps.
Authoritative alpha and original game timing remain in the source manifest and
are not regenerated by the model. Results include hashes, settings, GPU/runtime
versions and failure reports. VM-local raw logs are not uploaded as public media.

## Requested 7B Comparison

`manage-lab.mjs probe7b` starts the separately requested normal 7B probe only after
the 3B SSM command succeeds. The wrapper installs the reviewed 7B control files
and never runs the two models concurrently. It uses the same seed, source,
resolution, temporal batch, zero added noise and mask-independent RGB output.

Normal 7B uses `seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors`, not a
Sharp model. It swaps 28 blocks versus 16 for 3B; performance therefore describes
these practical offload configurations, not only parameter count. Outputs go to
`results/<stack-name>/7b/`, without overwriting the initial 3B artifacts.

Fetch and verify model PNGs with `fetch-results.py --variant 3b|7b --destination
PRIVATE_RUNS_DIR`, then use the [offline analyzer](../benchmarks/compare-seedvr2-aws.py).
The analyzer provides raw and identically masked views. The original 3B run did
not measure peak VRAM; do not fabricate one from the device's total capacity.

Both initial AWS probes succeeded (49 PNGs each at 1536x864). 3B inference took
134.683s and 7B 183.163s, excluding setup/model downloads. Sampled 7B device-wide
peak memory was 7752 MiB. This does not establish that either output is suitable
for the game: [adjacent-pose ghosting](../benchmarks/issues/seedvr2-temporal-ghosting.md)
is visible before masking in both models.

## Online HD Demo

The template output `DemoManifestURL` is the CloudFront HTTPS address. Validate the
release hashes, GET/HEAD/CORS/preflight, range handling and rejection of private
paths before changing the website's `NEVERHOOD_DEMO_MANIFEST_URL`.

This deployment does not automatically modify Vercel or remove the working R2
release. S3 + CloudFront have different transfer/request pricing from R2. Keeping
private processing inputs in S3 does not require switching public delivery.

## Cost Guard And Operations

The checked Ohio Linux On-Demand price at provisioning was $0.9776/hour for this
worker, excluding EBS, public IPv4, CloudFront/S3 requests, transfer and taxes.
Stopping compute does not stop all storage charges. Versioning retains older
objects; review retention rather than silently deleting source material.

The initial `AutoStopAt` is a two-hour safety deadline, not a recurring stop policy.
After an intentional restart, set a new deadline. Do not assume the old one-time
schedule protects a later session. Native CloudFormation currently lacks Scheduler
`ActionAfterCompletion`; the operator sets it to `DELETE` after creation, retaining
the exact target and UTC expression. Never broaden its stop permission beyond
this stack's instance.

The maintainer subsequently requested a triple-frame hypothesis test. One extra
30-minute window was explicitly recorded, with a maximum additional worker price
of $0.4888; the effective stop became 2026-10-21 08:28:25 UTC. No further automatic
extension is permitted by the operator script. The 149-frame 3B and 7B probes
completed within that window; model results remain private and are not deployed
to the game. This historical deadline must not be reused for a later session.

For status/access, use the actual resource IDs in ignored `stack-state.json`:

```bash
aws ssm start-session --target INSTANCE_ID --region us-east-2 --profile YOUR_OPERATOR_PROFILE
aws ec2 stop-instances --instance-ids INSTANCE_ID --region us-east-2 --profile YOUR_OPERATOR_PROFILE
```

Before cleanup, verify required results in S3. Deleting the CloudFormation stack
removes its compute/network/distribution resources but retains the private bucket.
Bucket deletion, object-version deletion and changing public release access are
separate deliberate operations. Do not stop or modify pre-existing instances.

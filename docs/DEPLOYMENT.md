# Deployment And Security

## Static Vercel Build

The client must be deployed as static files, not by invoking `server.mjs` as a
serverless function. `vercel.json` selects framework Other (`null`), runs
`npm run build`, and publishes `dist/`. The Node server is a local development
and preview tool; it is not included in the static output. No catch-all rewrite
should turn missing WASM/JSON files into HTML.

```sh
npm run build
PORT=4174 npm run preview
```

Open `http://127.0.0.1:4174`. Build packaging allowlists the frontend, runtime,
extractor, vendor decoder and their notices. It excludes tests, installers,
original resources, SDKs and server code. `/runtime/` and `/extractor/` are real
directories in the output, rather than aliases that require a Node server.

## Artifact And Source Delivery

Reviewed `web/public/runtime/`, `web/public/extractor/` and `web/public/sources/`
artifacts are committed. Git-triggered Vercel deployments need only Node.js and
`npm run build`; they do not compile C++ or download private release assets.
Missing/incompatible artifacts fail the build instead of silently breaking Play.

Corresponding sources and build materials are served by the same public site.
The repository may remain private: users do not need GitHub credentials to open
`/sources/index.html`, `/sources/manifest.json` or the manifest-listed downloads.
There is no source URL environment variable. Build packaging checks revisions,
safe filenames, byte sizes and SHA-256 before publishing these downloads.

When updating binaries, run `npm run package:sources` and commit the regenerated
source bundles with the artifacts. The source manifest includes unpacking/rebuild
instructions and component details. Small archive chunks stay below GitHub's
regular-file size limit. This is source delivery, not permission to distribute
original game files or a substitute for reviewing third-party license terms.

Vercel project settings: repository root, framework Other (overridden by
`framework: null`), build command `npm run build`, output `dist`. Do not configure
`server.mjs` as an entrypoint, add a Node function, or use a catch-all HTML rewrite.

After a Git-triggered deployment, verify public files, worker headers, real 404s,
WASM validity and the complete SHA-256 of every source download:

```sh
npm run verify:deployment -- https://neverhood-online.vercel.app
```

This uses only public GET requests and does not upload game data. A successful
Vercel build status alone does not prove that the deployed requests work.

## Current HD Prototype Release

The selected release is now `room-streaming-v1`, including the approved static
window and seven-gesture cursor. The committed config and Vercel build command pin
`https://d3gutt3a0gjwwo.cloudfront.net/room-streaming-v1/manifest.json`; the command
overrides the older project environment value. The compiled runtime is unchanged.
Original BLBs use pinned 64 KiB ranges through the external sparse FS/Worker;
HD ZIP members use independent pinned ranges. Bootstrap, rooms, neighbors and
original navigation movies are described separately. No EC2/GPU processing is
needed for publication. Assets and metadata are verified in S3 before the manifest
is published last. Existing media is copied server-side into immutable versioned
keys; private catalogs, inputs and credentials are excluded.

Both parent and game iframe now require COOP/COEP for SharedArrayBuffer. The
CloudFront response policy additionally exposes `Content-Range`; CORS/CORP remain
enabled for authorized cross-origin assets. The YouTube iframe is credentialless
to preserve compatible embedding under the isolation policy. A browser without
the required isolation gets a clear error, never a hidden full-BLB download.

The following `full-game-lossless-v1` description is the preserved full-download
reference release, not the selected startup behavior.

The current source prototype uses the unchanged full-game runtime, not the
historical bounded two-room binary. `web/hd-demo/config.json` selects the existing
S3/CloudFront release. A Vercel build may explicitly select it with:

```text
NEVERHOOD_DEMO_MANIFEST_URL=https://d3gutt3a0gjwwo.cloudfront.net/full-game-lossless-v1/manifest.json
```

Use Node.js 22.x, `npm run build` and output `dist`; no AWS credentials belong in
Vercel. The environment setting was reported changed, but that alone does not
verify a new public frontend deployment. Deploy the updated sources, new
scripts/tests and regenerated corresponding-source artifacts together. Do not
deploy only the changed variable against old two-room frontend code.

This external release has 134 room/state lossless PNG ZIPs and all seven original
BLBs (638,122,574 bytes). The shared originals retain 551 Smacker resources,
including original cutscene and navigation media, without transcoding. HD video
work remains in progress; it must not cause those originals to be omitted.
Whole-original HTTPS verification is separate from a full playthrough or a check
of the public Vercel frontend:

```sh
node scripts/verify-demo-videos.mjs \
  --originals private-assets/upscaling/full-game-v1/original-files.json \
  --release https://d3gutt3a0gjwwo.cloudfront.net/full-game-lossless-v1/manifest.json
```

Publish only the explicitly prepared release under `releases/hd-demo/`, with
verified assets first and its manifest last. Do not expose private `sources/`,
`results/`, catalogs, model inputs or credentials. Keep immutable versioned keys
unchanged. The native BLBs are shared startup data; HD room ZIPs load on entry and
are cached. This is not original-game streaming or proof of complete HD coverage.

## Git Deployment Owner

Deployments for this project use the GitHub owner `mihmosh`. Vercel checks the
commit author's linked account, not only who pushed the branch. An unrelated
work-account identity can block a private-repository deployment before any build
starts, even when the source and static configuration are correct.

The following identity guidance is for the maintainer's own deployment commits,
not outside contributions. Contributors must use their own identities and must
never copy the owner's author or committer details. Maintainers can review and
merge contributions through the normal GitHub workflow.

For authorized maintainer commits, use the owner's verified GitHub identity. GitHub's
account-specific noreply address is `109215897+mihmosh@users.noreply.github.com`.
When a machine has another default identity, apply the correct author and committer
only to this project's commit command rather than changing global Git settings.

## Allowed Deployment Contents

Only the client, verified ScummVM/innoextract artifacts and vendored ZIP decoder, with required licenses
and corresponding source under the GPL. Review the runtime file allowlist before
publication: upstream build scripts can include demos and other data.
These exclusions apply to the static frontend deployment. The separate external
asset release intentionally distributes original game files and selected derived
media; this operational choice does not establish redistribution rights.

Never publish the entire workspace. `original game/`, `extracted/`, user packs
and saves stay outside the document root. Builds must not automatically copy
game `.blb` files or installer `.exe` and `.bin` files.

## Hosting

Use static HTTPS hosting or a VPS with Caddy/Nginx. A stable origin is required
to retain access to browser storage. The localhost secure-context exception
works without HTTPS; public addresses require HTTPS.

- Serve `.wasm` as `application/wasm`.
- Serve JavaScript modules with the correct JavaScript MIME type.
- Avoid long immutable caching for `index.html` and the runtime manifest.
- Enable artifact caching after introducing artifact versioning.
- If the runtime requires threads, use COOP `same-origin` and COEP `require-corp`
  and verify all dependencies. Headers alone do not complete worker integration.
- CORS is only needed for authorized artifacts loaded from a different origin.
- Do not add telemetry or game-data uploads without a separate user decision.

The included `server.mjs` is for development and listens only on
`127.0.0.1:4173` by default. It does not replace a production reverse proxy.

## Prepublication Checks

The 2026-10-21 cursor/static-window fixes are a local opt-in, not a change to the
CloudFront release or Vercel environment. `scripts/prepare-window-overlay.mjs`
creates only the approved window ZIP. `scripts/prepare-visual-demo.mjs` combines
that overlay with an explicitly supplied prepared cursor and a new private
manifest. It verifies every declared legacy asset and hardlinks it, rather than
copying or repacking several gigabytes. Never edit/chmod those linked files:
their inodes are shared with the reference release. New cursor/window files are
separate copies. The base manifest and compiled runtime are unchanged.

Serve such a prepared release on a separate loopback origin:

```sh
PORT=4204 NEVERHOOD_DEMO_DIR=/absolute/path/to/new/private-release \
  node scripts/serve-visual-demo.mjs
```

This wrapper overrides only the local `/hd-demo/config.json` endpoint; the normal
static server and public config are not edited. The current prepared local output
is `private-assets/upscaling/gemini-review-all/visual-demo-local-20261021T185526Z`.
Its assembly receipt records the input hashes, destination files, copied bytes
and shared inodes. This path remains the explicit full-original-download reference,
not a silently enabled original streaming implementation. Upload, publishing and
production selection require separate permission.

1. Static frontend deployment contains no original game resources or secrets; the separate authorized asset release contains only its explicitly selected files.
2. The exact upstream version, complete corresponding source and build instructions are available.
3. Required third-party runtime license notices have been reviewed.
4. Users can see that this is not an official release.
5. Import, relaunch, data clearing, quota denial and save export have been checked.
6. The site does not promise permanent storage or support for arbitrary installers.
7. Modified runtime publication complies with GPL requirements.
8. The current external release preserves the complete original BLBs and videos while HD cutscene/navigation work is unfinished; check hashes, CORS and room-cache behavior separately from frontend build success.

## Untrusted Files

Do not execute EXE files. Limit extraction to known formats and expected output
files. Validate names, sizes and paths, and prevent traversal. Header and signature
validation do not replace decoder audits. The WASM sandbox reduces some risks,
but does not eliminate hangs, memory exhaustion or bugs.
Folder and ZIP discovery plus Inno Setup 5.4.2 extraction were tested locally.
Only ZIP stored/deflated entries are accepted; encrypted ZIP, ZIP64, RAR and 7z
are not supported. Temporary files remain local OPFS data, never server uploads.
Serve `/runtime/*` from `web/public/runtime/*` and `/extractor/*` from
`web/public/extractor/*`, as the development server does. Keep vendor files local.

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
npm run verify:deployment -- https://nevehood-online.vercel.app
```

This uses only public GET requests and does not upload game data. A successful
Vercel build status alone does not prove that the deployed requests work.

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
This project does not distribute game files.

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

1. Deployment contains no original game resources or secrets.
2. The exact upstream version, complete corresponding source and build instructions are available.
3. Required third-party runtime license notices have been reviewed.
4. Users can see that this is not an official release.
5. Import, relaunch, data clearing, quota denial and save export have been checked.
6. The site does not promise permanent storage or support for arbitrary installers.
7. Modified runtime publication complies with GPL requirements.

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

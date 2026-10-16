# Contributing To Neverhood Online

Contributions to [Neverhood Online](https://github.com/mihmosh/neverhood_online)
are welcome. Keep public issues, pull requests, documentation and interface text
in English. This is an independent browser integration around ScummVM, not an
official ScummVM project or a replacement game engine.

## Report A Bug

Search [existing issues](https://github.com/mihmosh/neverhood_online/issues) first.
Include the browser and OS versions, whether you used the live site or a local
revision, the import format, reproduction steps and expected/actual behavior.
The live site may be behind the repository, particularly for ZIP filename fixes.
Redact local paths and personal information from logs.

Do not attach commercial game files, installers, saves containing private data,
credentials or links to pirated downloads. Small synthetic fixtures that you
created and are allowed to distribute are preferable. Interface-only screenshots
are useful; do not add original game artwork or gameplay screenshots to this
repository. Report sensitive vulnerabilities according to [SECURITY.md](SECURITY.md),
not in a public issue with exploit details.

## Develop And Test

Use Node.js 22 or later. No npm dependency installation is required for normal
development:

```sh
npm test
npm run build
npm run dev
```

The development server is at `http://127.0.0.1:4173`. Use
`PORT=4174 npm run preview` after building to test the static output. Those origins
have separate browser storage. See [testing](docs/TESTING.md) for optional
Playwright/Chrome checks and [architecture](docs/ARCHITECTURE.md) for import,
storage and player boundaries.

- Keep patches focused and include regression tests for behavior changes.
- For import changes, check cancellation, quota failures, path safety and preservation of an existing library. Never weaken limits just to accept one installer.
- For player changes, check startup cancellation, Return to site, in-game Quit, replay and resizing. Distinguish mocked tests from real-browser checks.
- State exactly what you tested and what remains unverified. Do not claim full-game, mobile, offline or save reliability from a UI smoke test.
- Do not add game downloads, bundled assets, telemetry or upload behavior as incidental changes.
- Keep generated artifacts, metadata, notices and corresponding-source packages synchronized. Follow [rebuild instructions](web/public/sources/README.txt) and the [deployment checklist](docs/DEPLOYMENT.md) when changing binaries.

## Pull Requests

Describe the problem, the change and validation results. Mention compatibility,
storage or licensing implications. Do not include private working directories,
toolchain caches, commercial resources or secrets. Contributions must be yours
to submit under the applicable license; preserve existing copyright and SPDX
notices. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

Bug reports and patches are reviewed as capacity allows. There is no guaranteed
response time, compatibility commitment or support service.

## AI Assistance And Upstream Boundaries

First-party code and documentation in this project have been developed with AI
assistance. AI-assisted contributions here must be described honestly, reviewed
by the submitter and tested like any other contribution. Contributors remain
responsible for correctness, provenance and licensing; generated output is not
evidence that a change works.

ScummVM has its own contribution rules, including `AGENTS.md` and
`AI-GUIDELINES.md` in its upstream source. Read the rules at the revision you are
working with before proposing changes there. This project's use of AI does not
imply upstream approval or endorsement, and this document does not promise that
an upstream pull request will be accepted. Do not submit this project's
AI-assisted work upstream without independently checking that it complies with
upstream's current policies. Upstream's restrictions on AI-generated media also
do not grant permission to create or distribute game-derived artwork here.

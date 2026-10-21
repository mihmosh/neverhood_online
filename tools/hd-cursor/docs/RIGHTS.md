# Rights And Publication

## Current Position

We do not own the original game's assets, and we have not established what
rights, if any, permit distributing the reconstructed cursor artwork. The
cursor research was informed by game assets. Rebuilding a shape in Blender,
rendering at higher resolution or changing its animation does not by itself
establish that the result is independent or distributable.

This document records a conservative project boundary. It is not legal advice,
a copyright determination, a fair-use analysis or a statement that an exception
applies in any jurisdiction. Private storage is not a claim that every private
use is lawful either.

## What Is Being Prepared For Source Publication

- Generic geometry operations: circular sections, rounded solids and curve-based stems.
- Blender scene processing, mesh checks, shape-key animation and rendering orchestration.
- Alpha-aware export, manifest construction, checksums and curated ZIP packaging.
- Tests using deliberately unrelated synthetic colored-disk images.
- Technical documentation without game screenshots, sprite previews or private scene files.

These materials follow the repository's software license. This classification
does not certify the legal status of every future contribution or guarantee
that publishing source alone resolves all legal concerns. Review the actual
staged files before publication.

## Materials Not Cleared For Publication

- Original game sprites, palettes, resource archives and extracted reference images.
- The preserved cursor `.blend` checkpoint and other modeled cursor scenes.
- Game-specific shape recipes, fitted parameters and masks that encode the modeled appearance.
- Masters, alpha exports, atlas images, screenshots, animated previews and cursor-pack ZIPs.
- Source bundles or release archives that accidentally include any of those files.

Do not label these materials GPL, MIT, CC0, Creative Commons or "free to reuse"
merely because the generating tool is open source. Do not attach the current
research pack to a public release without separately resolving the applicable
rights. Ownership and permission questions concerning these files are open.

## Before A Public Source Release

1. Inspect `git diff --cached --name-status` and the full staged diff, not just ignored-file rules.
2. Confirm the release includes only the intended tooling, documentation, tests and license text.
3. Check for embedded artwork parameters, base64 images, private paths, screenshots and binary assets, not just filename extensions.
4. Build tests only with synthetic fixtures for public CI. Do not upload private outputs or test logs containing private material.
5. Inspect the source archive's member list before uploading it. Do not ZIP the entire working directory.
6. Include the complete GPL text from the root and retain this rights distinction when splitting the repository.

The current generated `hd-cursor.zip` is an **asset pack**, not the open-source
release of this tool. Its creation or checksum verification does not clear it
for publication. The enclosing source packager includes the tooling but excludes
`tools/hd-cursor/outputs/`; it does not upload or publish anything by itself.

This separation does not clear any existing demo deployment, previously hosted
media or older release artifacts. Their distribution must be assessed separately;
moving the source code neither resolves nor changes those rights questions.

## Before Any Artwork Release

Establish provenance and applicable ownership/permission for the underlying
artwork, modeled designs and proposed distribution. Obtain appropriate legal
review and any necessary permissions. Record the outcome and the actual terms
before changing the private/public boundary. Do not assume noncommercial use,
fan-project status, access to a purchased game or a newly authored mesh resolves
these questions.

The Neverhood name and content belong to their respective rights holders. This
tool is not an official release or an endorsement by those rights holders or
ScummVM.

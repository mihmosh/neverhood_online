# Security

Neverhood Online processes user-selected game folders, ZIP files and supported
installers locally in a browser. Parsing untrusted files can still expose bugs,
denial of service, excessive memory/disk use or data loss. WebAssembly and browser
isolation are not guarantees of safety. Keep your browser current and only
import files from sources you trust.

Saved-game imports have size, CRC and structural checks, but are still input to
the original game engine. Prefer saves from your own trusted installations.
Exports contain your progress and descriptions; do not attach them to public
issues. Browser backup points share the same origin storage and can be lost when
site data is cleared, so download important backups.

## Reporting A Vulnerability

Do not post working exploits, sensitive reproduction details, private game files,
installers, saves, secrets or personal information in public issues or pull
requests.

GitHub Private Vulnerability Reporting is enabled for this repository. Prefer
[Report a vulnerability](https://github.com/mihmosh/neverhood_online/security/advisories/new)
to share a report privately with the maintainer, rather than opening a public
issue. If that channel is unavailable, consult the maintainer's
[GitHub profile](https://github.com/mihmosh) for an available contact method and
ask how to share a sensitive report privately. If no private method is listed,
do not publish the exploit to obtain attention. A public request for a private
contact route must contain no vulnerability specifics or sensitive attachments.

A private report should identify the affected revision or live URL, browser/OS,
impact and minimal reproduction steps. Prefer a small synthetic fixture that
you have permission to share, not commercial game data. Redact local paths and
credentials. Do not test against other users, third-party hosting infrastructure
or data you do not own.

## Scope And Expectations

Relevant areas include archive path traversal, extraction limits, worker/player
isolation, local storage integrity, unintended uploads and accidental publication
of private files. Dependencies such as ScummVM and innoextract have their own
security processes; a report here does not notify their maintainers automatically.

This early project has no maintained release support matrix, guaranteed response
or remediation timeline, security audit claim or bug bounty. The live deployment
may lag repository fixes. Normal bug reports can use
[GitHub issues](https://github.com/mihmosh/neverhood_online/issues) after sensitive
information is removed.

## Local Data And Hosting

Game imports are designed to stay local in OPFS; the runtime uses a separate
IDBFS save directory. These are origin-scoped browser storage, not encrypted
backups or a durability guarantee. Clearing site data can remove both, including
the three local pre-import backup points. Downloaded ZIP exports provide an
independent copy. One native migration and real in-game save/reload/load cycle
were tested in Chromium; broader platforms and crash recovery remain unverified.

Do not publish private game directories, installers, saves or secrets when
self-hosting. Use the allowlisted `npm run build` output rather than the whole
workspace. Keep matching source downloads and dependency notices with binaries.
See [deployment and security requirements](docs/DEPLOYMENT.md).

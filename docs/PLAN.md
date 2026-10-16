# Roadmap And Verification

Neverhood Online is an experimental browser client for a user's own copy of
The Neverhood. The game engine is ScummVM, not a new implementation. This is
neither an official release nor a remaster.

## Available Now

- Import an installed game folder, a supported installer folder, or a nested ZIP.
- Find the game installer even when a ZIP also contains runtime redistributables.
- Parse supported Inno Setup EXE + BIN files locally without executing Windows code.
- Store the seven game archives in OPFS and discover them after a page reload.
- Show one adaptive import/Play/storage/removal panel.
- Keep the launcher controls in the first viewport, without a separate hero section,
  and prominently credit the upstream ScummVM Neverhood engine authors.
- Run the original C++ Neverhood engine in WebAssembly, with a 4:3 high-DPI player.
- Return from in-game Quit or the page's Return to site button, then play again.
- Import/export native saves and save ZIPs, with explicit overwrite review,
  atomic pre-import backups and stale-confirmation protection.
- Build a self-contained static site from the repository without an SDK or secrets.
- Serve matching source archives, hashes, build materials and third-party notices.

## Verified Scope

The unit suite currently has 62 tests covering import transactions, ZIP framing,
legacy filename decoding, CRC and size checks, source discovery, static packaging,
public-source integrity, server isolation and related error handling.

Real desktop Chromium checks used the full English edition, with 638122574 bytes
of game archives. Tested scenarios include installed folders, nested installer ZIPs,
legacy-encoded names, bundled DirectX/Visual C++ installers, storage after reload,
the first room, Escape menu, live resizing, Quit/replay and removal. Missing BIN,
cancellation and quota failures preserved the preceding library in fault tests.
Browser checks observed no game upload requests or uncaught page errors.

Matching source archives were extracted and compiled. The extractor rebuild was
byte-identical; runtime exports were preserved without claiming byte-identical
runtime output. These checks do not constitute an independent security or legal audit.

## Known Limits

- No complete playthrough or comprehensive audible-sound test has been performed.
- Native save transfer and one full in-game save/load cycle passed Chromium tests;
  other engine versions, game editions and browser/native-platform combinations
  still need coverage. Browser data is not a substitute for external backups.
- Game launch copies the library into MEMFS; substantial RAM is needed.
- Installer and ZIP imports use temporary disk space in addition to the final library.
- Desktop Chromium is the primary tested target. Touch, Firefox and Safari need
  separate verification. Responsive onboarding is not proof of mobile gameplay.
- Only stored/deflated ZIP is supported; encrypted ZIP, ZIP64, RAR and 7z are not.
- Not every repack or installer format is supported.
- Offline operation, HD resources and widescreen scenes are not implemented.

## Next Milestones

1. Expand save/load coverage across editions and platforms, and test browser-crash recovery.
2. Replace complete MEMFS resource copies with bounded seekable access from OPFS.
3. Expand browser/device coverage and improve accessible input and touch handling.
4. Design versioned offline caching and safe runtime updates without losing saves.
5. Explore an optional one-room HD rendering prototype while keeping logic at
   640x480. This requires a renderer extension, not just larger replacement PNGs.

Any graphics experiment must respect game rights and upstream contribution rules.
No original or upscaled game asset pack is included or promised for distribution.

## Public Release Checklist

- Keep source, credits, licenses, limitations and reproducible build instructions visible.
- Include only client UI screenshots unless separate game-image rights are established.
- Keep original archives, installers, saves, credentials and build caches out of Git.
- Run tests and a fresh-checkout static build before publishing.
- Verify the actual hosted files, headers and source download hashes after deployment.
- Clearly separate a repository update from a Vercel Git connection or domain change.

Community announcements, videos, analytics and domain purchases are separate owner
decisions. No forum posts, telemetry or tracking are enabled by this roadmap.

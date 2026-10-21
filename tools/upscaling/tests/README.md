# Pipeline Test Scope

Use small synthetic RGB/indexed frames and binary masks in committed tests.
Do not require original game files, model weights, API keys, paid predictions or
GPU availability for the default source-level test suite.

As runners migrate here, cover frame order and holds, duration metadata, fixed
canvas placement, binary-alpha hashes, crop detection, failed-job reporting,
resume/no-duplicate-charge behavior and rejection of secrets in export records.

Put real-model integration tests behind an explicit command with input manifest,
compute/time budget and opt-in remote execution. A normal documentation or website
build must not start inference or provision infrastructure.

This directory currently contains the test contract only; existing external probe
self-tests have not been migrated. The repository-level documentation check
validates this scaffold, local links, prompt checksum and reference inventory.
